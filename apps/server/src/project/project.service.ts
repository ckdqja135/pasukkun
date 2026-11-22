import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sha256 } from '../common/crypto.js';
import type { AppEnv } from '../config/env.js';
import { APP_ENV } from '../db/db.module.js';
import { PrismaService, type Db } from '../db/prisma.service.js';
import { LOCKFILE_NAMES, LockfileError, parseLockfile, validateManualPackages, type LockfileFormat, type ParsedPackage, type LockfileWarning } from '../domain/lockfile.js';
import type { Prisma } from '../generated/prisma/client.js';
import { JobService } from '../jobs/job.service.js';
import type { ProjectGithubDto } from '../github/github.dto.js';
import type {
  ProjectCountsDto,
  ProjectDto,
  ProjectInputDto,
  ProjectUpdateDto,
  ScanSummaryDto,
  SnapshotCreatedDto,
  SnapshotDto,
  SnapshotInputDto,
  SnapshotPackageListDto,
  SnapshotPreviewDto,
} from './project.dto.js';

export const OSV_DISCLOSURE =
  '검사할 때 패키지명과 버전이 외부 공개 취약점 API(OSV, api.osv.dev)로 전송됩니다. 소스코드나 lockfile 원문은 전송하지 않습니다.';

type ScanRow = Prisma.ScanRunGetPayload<{ include: { snapshot: { select: { seq: true } } } }>;
type SnapshotRow = Prisma.ProjectSnapshotGetPayload<object>;
type RepoSourceRow = Prisma.ProjectRepoSourceGetPayload<object>;

type ParsedInput = { packages: ParsedPackage[]; warnings: LockfileWarning[]; lockfileVersion: number | null; format: LockfileFormat | null; sha: string | null };

export function toGithubDto(source: RepoSourceRow): ProjectGithubDto {
  const ref = source.commitSha ?? source.defaultBranch;
  return {
    fullName: source.fullName,
    lockfilePath: source.lockfilePath,
    branch: source.defaultBranch,
    status: source.status === 'DISCONNECTED' ? 'DISCONNECTED' : source.status === 'ERROR' ? 'ERROR' : 'OK',
    error: source.error,
    lastCheckedAt: source.lastCheckedAt?.toISOString() ?? null,
    lastChangedAt: source.lastChangedAt?.toISOString() ?? null,
    commitSha: source.commitSha,
    url: `https://github.com/${source.fullName}/blob/${encodeURIComponent(ref)}/${source.lockfilePath.split('/').map(encodeURIComponent).join('/')}`,
  };
}

export function toScanDto(scan: ScanRow): ScanSummaryDto {
  return {
    id: scan.id,
    projectId: scan.projectId,
    snapshotId: scan.snapshotId,
    snapshotSeq: scan.snapshot.seq,
    trigger: scan.trigger,
    status: scan.status,
    isInitial: scan.isInitial,
    packagesTotal: scan.packagesTotal,
    packagesScanned: scan.packagesScanned,
    scope: (scan.scope ?? {}) as object,
    sourceFreshness: (scan.sourceFreshness ?? {}) as object,
    summary: (scan.summary ?? {}) as object,
    error: scan.error,
    createdAt: scan.createdAt.toISOString(),
    startedAt: scan.startedAt?.toISOString() ?? null,
    finishedAt: scan.finishedAt?.toISOString() ?? null,
  };
}

export function toSnapshotDto(snapshot: SnapshotRow): SnapshotDto {
  return {
    id: snapshot.id,
    seq: snapshot.seq,
    inputType: snapshot.inputType,
    source: snapshot.source === 'GITHUB' ? 'GITHUB' : 'UPLOAD',
    lockfileFormat: (snapshot.lockfileFormat as LockfileFormat | null) ?? null,
    sourceRef: snapshot.sourceRef,
    fileName: snapshot.fileName,
    fileSha256: snapshot.fileSha256,
    lockfileVersion: snapshot.lockfileVersion,
    packageCount: snapshot.packageCount,
    scannableCount: snapshot.scannableCount,
    isCurrent: snapshot.isCurrent,
    warnings: (snapshot.warnings ?? []) as object[],
    projectConfig: (snapshot.projectConfig ?? {}) as object,
    createdAt: snapshot.createdAt.toISOString(),
  };
}

const CHUNK = 400;
/** 한 계정이 공유 자원(디스크, 쓰기 잠금, 검사 대기열, 외부 API 호출)을 독점하지 못하게 하는 한도 */
export const LIMITS = {
  projectsPerUser: 50,
  /** 프로젝트마다 보관하는 구성 스냅샷 수. 넘으면 오래된 것부터 지운다. */
  snapshotsKeptPerProject: 10,
  snapshotsPerHour: 30,
  /** 저장 없이 검증만 하는 요청도 해석 비용이 같으므로 따로 제한한다 */
  previewsPerHour: 60,
  manualScansPerHour: 60,
};

@Injectable()
export class ProjectService {
  /** 사용자별 최근 구성 등록·검증 시각 (시간당 한도 계산용) */
  private readonly uploads = new Map<string, number[]>();
  private readonly previews = new Map<string, number[]>();

  /** 최근 1시간 안의 횟수가 한도 미만이면 기록하고 true */
  private take(store: Map<string, number[]>, userId: string, limit: number): boolean {
    const now = Date.now();
    const recent = (store.get(userId) ?? []).filter((at) => now - at < 3_600_000);
    if (recent.length >= limit) {
      store.set(userId, recent);
      return false;
    }
    recent.push(now);
    store.set(userId, recent);
    return true;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /** 소유권 확인. 다른 사용자의 프로젝트는 존재 여부도 드러내지 않는다(404). */
  async findOwned(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, userId } });
    if (!project) throw new NotFoundException('프로젝트를 찾을 수 없습니다.');
    return project;
  }

  private async assertTechnologies(ids: string[] | undefined): Promise<string[]> {
    const unique = [...new Set(ids ?? [])];
    if (unique.length === 0) return [];
    const count = await this.prisma.technology.count({ where: { id: { in: unique } } });
    if (count !== unique.length) throw new BadRequestException('알 수 없는 기술 항목이 포함되어 있습니다.');
    return unique;
  }

  async list(userId: string): Promise<ProjectDto[]> {
    const projects = await this.prisma.project.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    return Promise.all(projects.map((project) => this.get(userId, project.id)));
  }

  async get(userId: string, projectId: string): Promise<ProjectDto> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
      include: {
        technologies: { select: { technologyId: true } },
        snapshots: { where: { isCurrent: true }, take: 1 },
        scans: { orderBy: { createdAt: 'desc' }, take: 1, include: { snapshot: { select: { seq: true } } } },
        repoSource: true,
      },
    });
    if (!project) throw new NotFoundException('프로젝트를 찾을 수 없습니다.');
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      environments: (project.environments ?? []) as string[],
      exposure: project.exposure,
      runtime: project.runtime,
      runtimeVersion: project.runtimeVersion,
      os: project.os,
      distro: project.distro,
      arch: project.arch,
      notes: project.notes,
      technologyIds: project.technologies.map((t) => t.technologyId),
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      currentSnapshot: project.snapshots[0] ? toSnapshotDto(project.snapshots[0]) : null,
      lastScan: project.scans[0] ? toScanDto(project.scans[0]) : null,
      github: project.repoSource ? toGithubDto(project.repoSource) : null,
      counts: await this.counts(project.id),
    };
  }

  async counts(projectId: string): Promise<ProjectCountsDto> {
    const active = { projectId, resolvedAt: null } as const;
    const relevant = { ...active, versionMatch: { in: ['AFFECTED', 'UNKNOWN'] as ('AFFECTED' | 'UNKNOWN')[] } };
    const [affected, unknown, urgent, high, open, needsRecheck] = await Promise.all([
      this.prisma.finding.count({ where: { ...active, versionMatch: 'AFFECTED' } }),
      this.prisma.finding.count({ where: { ...active, versionMatch: 'UNKNOWN' } }),
      this.prisma.finding.count({ where: { ...relevant, priority: 'URGENT' } }),
      this.prisma.finding.count({ where: { ...relevant, priority: 'HIGH' } }),
      this.prisma.finding.count({ where: { ...relevant, remediationStatus: { in: ['UNREVIEWED', 'IN_REVIEW', 'PLANNED'] } } }),
      this.prisma.finding.count({ where: { ...relevant, needsRecheck: true } }),
    ]);
    return { affected, unknown, urgent, high, open, needsRecheck };
  }

  async create(userId: string, dto: ProjectInputDto): Promise<ProjectDto> {
    if ((await this.prisma.project.count({ where: { userId } })) >= LIMITS.projectsPerUser) {
      throw new BadRequestException(`프로젝트는 계정당 ${LIMITS.projectsPerUser}개까지 등록할 수 있습니다.`);
    }
    const technologyIds = await this.assertTechnologies(dto.technologyIds);
    const project = await this.prisma.project.create({
      data: {
        userId,
        name: dto.name.trim(),
        description: dto.description ?? '',
        environments: dto.environments ?? [],
        exposure: dto.exposure ?? 'UNKNOWN',
        runtime: dto.runtime ?? '',
        runtimeVersion: dto.runtimeVersion ?? '',
        os: dto.os ?? '',
        distro: dto.distro ?? '',
        arch: dto.arch ?? '',
        notes: dto.notes ?? '',
        technologies: { create: technologyIds.map((technologyId) => ({ technologyId })) },
      },
    });
    return this.get(userId, project.id);
  }

  async update(userId: string, projectId: string, dto: ProjectUpdateDto): Promise<ProjectDto> {
    const project = await this.findOwned(userId, projectId);
    const technologyIds = dto.technologyIds === undefined ? undefined : await this.assertTechnologies(dto.technologyIds);
    const { technologyIds: _ignored, ...fields } = dto;
    void _ignored;
    const environmentChanged =
      (dto.exposure !== undefined && dto.exposure !== project.exposure) ||
      (dto.environments !== undefined && JSON.stringify([...dto.environments].sort()) !== JSON.stringify([...((project.environments ?? []) as string[])].sort()));
    const runtimeChanged = (['runtime', 'runtimeVersion', 'os', 'distro', 'arch'] as const).some(
      (key) => dto[key] !== undefined && dto[key] !== project[key],
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id: projectId }, data: { ...fields, name: fields.name?.trim() } });
      if (technologyIds) {
        await tx.projectTechnology.deleteMany({ where: { projectId } });
        for (const technologyId of technologyIds) await tx.projectTechnology.create({ data: { projectId, technologyId } });
      }
      // 노출·환경이 바뀌면 우선순위가 달라질 수 있고, 기존 수동 검토도 다시 확인해야 한다.
      if (environmentChanged || runtimeChanged) {
        await this.jobs.enqueue(
          'reprioritize-project',
          { projectId, reason: '프로젝트 환경 정보가 변경됨' },
          { dedupeKey: `reprioritize:${projectId}` },
          tx,
        );
      }
    });
    return this.get(userId, projectId);
  }

  async remove(userId: string, projectId: string): Promise<void> {
    await this.findOwned(userId, projectId);
    await this.prisma.project.delete({ where: { id: projectId } });
  }

  // - 구성 스냅샷 -

  private parseInput(dto: SnapshotInputDto): ParsedInput {
    if (dto.inputType === 'MANUAL') {
      return {
        packages: validateManualPackages(dto.packages ?? [], this.env.maxPackages),
        warnings: [],
        lockfileVersion: null,
        format: null,
        sha: null,
      };
    }
    return this.parseLockfileText(dto.lockfileContent, dto.packageJsonContent ?? null, dto.fileName ?? null);
  }

  private parseLockfileText(content: string | undefined, packageJson: string | null, fileName: string | null): ParsedInput {
    if (typeof content !== 'string' || content === '') {
      throw new LockfileError('NOT_A_LOCKFILE', 'lockfile 내용이 비어 있습니다.');
    }
    const parsed = parseLockfile(content, { maxBytes: this.env.uploadMaxBytes, maxPackages: this.env.maxPackages }, packageJson, fileName);
    return { packages: parsed.packages, warnings: parsed.warnings, lockfileVersion: parsed.lockfileVersion, format: parsed.format, sha: sha256(content) };
  }

  /** 저장하지 않고 업로드 내용을 검증만 한다. */
  async preview(userId: string, projectId: string, dto: SnapshotInputDto): Promise<SnapshotPreviewDto> {
    await this.findOwned(userId, projectId);
    if (!this.take(this.previews, userId, LIMITS.previewsPerHour)) {
      throw new HttpException(`구성 검증은 시간당 ${LIMITS.previewsPerHour}회까지 할 수 있습니다. 잠시 후 다시 시도해 주세요.`, HttpStatus.TOO_MANY_REQUESTS);
    }
    const empty = { lockfileVersion: null, lockfileFormat: null, packageCount: 0, scannableCount: 0, directCount: 0, devCount: 0, multiVersionCount: 0, warnings: [] };
    try {
      const parsed = this.parseInput(dto);
      const versions = new Map<string, Set<string>>();
      for (const pkg of parsed.packages) versions.set(pkg.name, (versions.get(pkg.name) ?? new Set()).add(pkg.version));
      return {
        valid: true,
        error: null,
        errorCode: null,
        lockfileVersion: parsed.lockfileVersion,
        lockfileFormat: parsed.format,
        packageCount: parsed.packages.length,
        scannableCount: parsed.packages.filter((p) => p.scannable).length,
        directCount: parsed.packages.filter((p) => p.isDirect).length,
        devCount: parsed.packages.filter((p) => p.isDev).length,
        multiVersionCount: [...versions.values()].filter((set) => set.size > 1).length,
        warnings: parsed.warnings,
        disclosure: OSV_DISCLOSURE,
      };
    } catch (error) {
      if (error instanceof LockfileError) {
        return { valid: false, error: error.message, errorCode: error.code, ...empty, disclosure: OSV_DISCLOSURE };
      }
      throw error;
    }
  }

  async createSnapshot(userId: string, projectId: string, dto: SnapshotInputDto): Promise<SnapshotCreatedDto> {
    const project = await this.findOwned(userId, projectId);
    // 저장된 행 수로 세면 오래된 스냅샷 정리 때문에 한도가 풀리므로, 등록 시각을 따로 기억한다.
    if (!this.take(this.uploads, userId, LIMITS.snapshotsPerHour)) {
      throw new HttpException(`구성 등록은 시간당 ${LIMITS.snapshotsPerHour}회까지 할 수 있습니다. 잠시 후 다시 시도해 주세요.`, HttpStatus.TOO_MANY_REQUESTS);
    }
    let parsed: ParsedInput;
    try {
      parsed = this.parseInput(dto);
    } catch (error) {
      if (error instanceof LockfileError) throw new BadRequestException({ message: error.message, code: error.code });
      throw error;
    }
    const fileName = dto.inputType === 'LOCKFILE' ? (dto.fileName ?? (parsed.format ? LOCKFILE_NAMES[parsed.format] : 'package-lock.json')).slice(0, 255) : null;
    return this.saveSnapshot(project, parsed, { inputType: dto.inputType, fileName, source: 'UPLOAD', sourceRef: null });
  }

  /**
   * 저장소에서 가져온 lockfile 로 구성을 등록한다 (GitHub 연결 프로젝트의 자동 확인).
   * 사용자 요청이 아니므로 시간당 등록 한도 대신 크기·패키지 수 제한만 적용한다. 해석 실패는 LockfileError 로 던진다.
   */
  async createSnapshotFromSource(
    projectId: string,
    input: { content: string; packageJson: string | null; fileName: string; sourceRef: string | null },
  ): Promise<SnapshotCreatedDto> {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const parsed = this.parseLockfileText(input.content, input.packageJson, input.fileName);
    return this.saveSnapshot(project, parsed, { inputType: 'LOCKFILE', fileName: input.fileName.slice(0, 255), source: 'GITHUB', sourceRef: input.sourceRef });
  }

  private async saveSnapshot(
    project: Prisma.ProjectGetPayload<object>,
    parsed: ParsedInput,
    meta: { inputType: 'LOCKFILE' | 'MANUAL'; fileName: string | null; source: 'UPLOAD' | 'GITHUB'; sourceRef: string | null },
  ): Promise<SnapshotCreatedDto> {
    const projectId = project.id;
    const result = await this.prisma.$transaction(
      async (tx) => {
        const last = await tx.projectSnapshot.findFirst({ where: { projectId }, orderBy: { seq: 'desc' }, select: { seq: true } });
        await tx.projectSnapshot.updateMany({ where: { projectId, isCurrent: true }, data: { isCurrent: false } });
        const snapshot = await tx.projectSnapshot.create({
          data: {
            projectId,
            seq: (last?.seq ?? 0) + 1,
            inputType: meta.inputType,
            source: meta.source,
            sourceRef: meta.sourceRef,
            fileName: meta.fileName,
            fileSha256: parsed.sha,
            lockfileVersion: parsed.lockfileVersion,
            lockfileFormat: parsed.format,
            warnings: parsed.warnings as unknown as object[],
            projectConfig: {
              runtime: project.runtime,
              runtimeVersion: project.runtimeVersion,
              os: project.os,
              distro: project.distro,
              arch: project.arch,
              exposure: project.exposure,
              environments: project.environments,
            },
            packageCount: parsed.packages.length,
            scannableCount: parsed.packages.filter((p) => p.scannable).length,
            isCurrent: true,
          },
        });

        const packageIds = await this.ensurePackages(tx, [...new Set(parsed.packages.filter((p) => p.scannable).map((p) => p.name))]);
        for (let offset = 0; offset < parsed.packages.length; offset += CHUNK) {
          await tx.snapshotPackage.createMany({
            data: parsed.packages.slice(offset, offset + CHUNK).map((pkg) => ({
              snapshotId: snapshot.id,
              packageId: pkg.scannable ? (packageIds.get(pkg.name.toLowerCase()) ?? null) : null,
              name: pkg.name,
              version: pkg.version,
              installPath: pkg.installPath,
              isDirect: pkg.isDirect,
              isDev: pkg.isDev,
              isOptional: pkg.isOptional,
              dependencyPath: pkg.dependencyPath,
              refKind: pkg.refKind,
              scannable: pkg.scannable,
              unsupportedReason: pkg.unsupportedReason,
            })),
          });
        }
        // 오래된 스냅샷은 정리한다 (패키지 목록과 검사 이력도 함께 지워진다. 분석 결과와 검토 이력은 남는다).
        const stale = await tx.projectSnapshot.findMany({
          where: { projectId },
          orderBy: { seq: 'desc' },
          skip: LIMITS.snapshotsKeptPerProject,
          select: { id: true },
        });
        if (stale.length > 0) await tx.projectSnapshot.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
        const scan = await this.createScan(tx, projectId, snapshot.id, 'SNAPSHOT_CREATED');
        return { snapshot, scan };
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
    return { snapshot: toSnapshotDto(result.snapshot), scan: toScanDto(result.scan) };
  }

  /** npm 패키지 행을 확보하고 이름(소문자) → ID 맵을 돌려준다. */
  private async ensurePackages(tx: Db, names: string[]): Promise<Map<string, string>> {
    const normalized = [...new Set(names.map((name) => name.toLowerCase()))];
    const map = new Map<string, string>();
    for (let offset = 0; offset < normalized.length; offset += CHUNK) {
      const slice = normalized.slice(offset, offset + CHUNK);
      const existing = await tx.package.findMany({ where: { ecosystem: 'npm', name: { in: slice } }, select: { id: true, name: true } });
      for (const row of existing) map.set(row.name, row.id);
      const missing = slice.filter((name) => !map.has(name));
      if (missing.length > 0) {
        await tx.package.createMany({ data: missing.map((name) => ({ ecosystem: 'npm', name })) });
        const created = await tx.package.findMany({ where: { ecosystem: 'npm', name: { in: missing } }, select: { id: true, name: true } });
        for (const row of created) map.set(row.name, row.id);
      }
    }
    return map;
  }

  /** 검사를 대기열에 넣는다. 이미 대기·실행 중인 검사가 있으면 그것을 돌려준다. */
  async createScan(tx: Db, projectId: string, snapshotId: string, trigger: 'MANUAL' | 'SNAPSHOT_CREATED' | 'SCHEDULED'): Promise<ScanRow> {
    const pending = await tx.scanRun.findFirst({
      where: { projectId, snapshotId, status: { in: ['QUEUED', 'RUNNING'] } },
      include: { snapshot: { select: { seq: true } } },
    });
    if (pending) return pending;
    const scan = await tx.scanRun.create({
      data: { projectId, snapshotId, trigger, scope: {}, sourceFreshness: {}, summary: {} },
      include: { snapshot: { select: { seq: true } } },
    });
    await this.jobs.enqueue('scan', { scanId: scan.id }, { maxAttempts: 2 }, tx);
    return scan;
  }

  async requestScan(userId: string, projectId: string): Promise<ScanSummaryDto> {
    await this.findOwned(userId, projectId);
    const snapshot = await this.prisma.projectSnapshot.findFirst({ where: { projectId, isCurrent: true }, select: { id: true } });
    if (!snapshot) throw new BadRequestException('검사할 구성이 없습니다. 먼저 lockfile 을 올리거나 패키지를 등록해 주세요.');
    const recent = await this.prisma.scanRun.count({ where: { project: { userId }, trigger: 'MANUAL', createdAt: { gt: new Date(Date.now() - 3_600_000) } } });
    if (recent >= LIMITS.manualScansPerHour) {
      throw new HttpException(`검사 요청은 시간당 ${LIMITS.manualScansPerHour}회까지 할 수 있습니다.`, HttpStatus.TOO_MANY_REQUESTS);
    }
    const scan = await this.prisma.$transaction((tx) => this.createScan(tx, projectId, snapshot.id, 'MANUAL'));
    return toScanDto(scan);
  }

  async listScans(userId: string, projectId: string): Promise<ScanSummaryDto[]> {
    await this.findOwned(userId, projectId);
    const scans = await this.prisma.scanRun.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: { snapshot: { select: { seq: true } } },
    });
    return scans.map(toScanDto);
  }

  async getScan(userId: string, scanId: string): Promise<ScanSummaryDto> {
    const scan = await this.prisma.scanRun.findFirst({
      where: { id: scanId, project: { userId } },
      include: { snapshot: { select: { seq: true } } },
    });
    if (!scan) throw new NotFoundException('검사를 찾을 수 없습니다.');
    return toScanDto(scan);
  }

  async listSnapshots(userId: string, projectId: string): Promise<SnapshotDto[]> {
    await this.findOwned(userId, projectId);
    const snapshots = await this.prisma.projectSnapshot.findMany({ where: { projectId }, orderBy: { seq: 'desc' }, take: 50 });
    return snapshots.map(toSnapshotDto);
  }

  async listSnapshotPackages(
    userId: string,
    snapshotId: string,
    options: { q?: string; filter?: string; page: number; pageSize: number },
  ): Promise<SnapshotPackageListDto> {
    const snapshot = await this.prisma.projectSnapshot.findFirst({ where: { id: snapshotId, project: { userId } }, select: { id: true } });
    if (!snapshot) throw new NotFoundException('구성 스냅샷을 찾을 수 없습니다.');
    const where: Prisma.SnapshotPackageWhereInput = { snapshotId };
    if (options.q?.trim()) where.name = { contains: options.q.trim().toLowerCase() };
    if (options.filter === 'unsupported') where.scannable = false;
    if (options.filter === 'direct') where.isDirect = true;
    if (options.filter === 'dev') where.isDev = true;
    const [total, rows] = await Promise.all([
      this.prisma.snapshotPackage.count({ where }),
      this.prisma.snapshotPackage.findMany({
        where,
        orderBy: [{ name: 'asc' }, { version: 'asc' }, { installPath: 'asc' }],
        skip: (options.page - 1) * options.pageSize,
        take: options.pageSize,
      }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        version: row.version,
        installPath: row.installPath,
        isDirect: row.isDirect,
        isDev: row.isDev,
        isOptional: row.isOptional,
        dependencyPath: (row.dependencyPath ?? []) as string[],
        refKind: row.refKind,
        scannable: row.scannable,
        unsupportedReason: row.unsupportedReason,
      })),
      total,
      page: options.page,
      pageSize: options.pageSize,
    };
  }
}
