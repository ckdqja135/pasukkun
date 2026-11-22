import { Inject, Injectable, Logger } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service.js';
import { computeTechnologyTags } from '../catalog/tagging.js';
import type { AppEnv } from '../config/env.js';
import { APP_ENV } from '../db/db.module.js';
import { PrismaService } from '../db/prisma.service.js';
import { LockfileError } from '../domain/lockfile.js';
import { JobService } from '../jobs/job.service.js';
import { ProjectService } from '../project/project.service.js';
import { GithubAppClient, GithubAppError, siblingPackageJson } from './github-app.client.js';
import { syncJobKey } from './github-link.service.js';

const PACKAGE_JSON_MAX_BYTES = 2 * 1024 * 1024;
const DAY_MS = 24 * 3_600_000;
const MAX_ENQUEUE_PER_TICK = 200;

export type SyncOutcome = 'CREATED' | 'UNCHANGED' | 'ERROR' | 'DISCONNECTED' | 'SKIPPED';

const DISCONNECTED_MESSAGE = '저장소에 접근할 수 없습니다. GitHub 에서 앱 설치가 해제되었거나 저장소가 앱에서 빠졌습니다.';

/**
 * GitHub 연결 프로젝트의 lockfile 변경을 확인한다 (Worker).
 * blob sha 가 같으면 내려받지 않는다. 바뀌었으면 새 구성으로 등록하고 검사한다.
 */
@Injectable()
export class GithubSyncService {
  private readonly logger = new Logger(GithubSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: GithubAppClient,
    private readonly projects: ProjectService,
    private readonly catalog: CatalogService,
    private readonly jobs: JobService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /** 확인할 때가 된 연결을 대기열에 넣는다. 접근이 끊긴 연결은 하루에 한 번만 다시 본다. */
  async enqueueDue(now = new Date()): Promise<number> {
    if (!this.client.enabled()) return 0;
    const due = new Date(now.getTime() - this.env.githubSyncMinutes * 60_000);
    const dayAgo = new Date(now.getTime() - DAY_MS);
    const sources = await this.prisma.projectRepoSource.findMany({
      where: {
        OR: [
          { lastCheckedAt: null },
          { status: { not: 'DISCONNECTED' }, lastCheckedAt: { lt: due } },
          { status: 'DISCONNECTED', lastCheckedAt: { lt: dayAgo } },
        ],
      },
      orderBy: { lastCheckedAt: 'asc' },
      take: MAX_ENQUEUE_PER_TICK,
      select: { projectId: true },
    });
    for (const { projectId } of sources) {
      await this.jobs.enqueue('github-sync', { projectId }, { dedupeKey: syncJobKey(projectId), maxAttempts: 2 });
    }
    return sources.length;
  }

  async sync(projectId: string): Promise<SyncOutcome> {
    const source = await this.prisma.projectRepoSource.findUnique({ where: { projectId } });
    if (!source) return 'SKIPPED';
    const now = new Date();
    const mark = (data: { status: string; error: string | null; fullName?: string; defaultBranch?: string }) =>
      this.prisma.projectRepoSource.update({ where: { projectId }, data: { ...data, lastCheckedAt: now } });

    if (!this.client.enabled()) {
      await mark({ status: 'ERROR', error: '서비스의 GitHub 앱 설정이 없어 확인하지 못했습니다.' });
      return 'ERROR';
    }
    try {
      const token = await this.client.installationToken(source.installationId, [source.repoId]);
      const repo = (await this.client.installationRepos(token)).find((r) => r.repoId === source.repoId);
      if (!repo) {
        await mark({ status: 'DISCONNECTED', error: DISCONNECTED_MESSAGE });
        return 'DISCONNECTED';
      }
      const current = { fullName: repo.fullName, defaultBranch: repo.defaultBranch };
      const meta = await this.client.fileMeta(token, repo.fullName, source.lockfilePath, repo.defaultBranch);
      if (!meta) {
        await mark({ ...current, status: 'ERROR', error: `기본 브랜치(${repo.defaultBranch})에서 ${source.lockfilePath} 를 찾을 수 없습니다. 파일이 옮겨졌거나 삭제되었습니다.` });
        return 'ERROR';
      }
      if (meta.sha === source.lockfileSha) {
        await mark({ ...current, status: 'OK', error: null });
        return 'UNCHANGED';
      }
      if (meta.size > this.env.uploadMaxBytes) {
        await mark({ ...current, status: 'ERROR', error: `lockfile 이 너무 큽니다 (최대 ${Math.floor(this.env.uploadMaxBytes / 1024 / 1024)}MB).` });
        return 'ERROR';
      }
      const commitSha = await this.client.branchHead(token, repo.fullName, repo.defaultBranch).catch(() => null);
      const ref = commitSha ?? repo.defaultBranch;
      const content = await this.client.fileText(token, repo.fullName, source.lockfilePath, ref, this.env.uploadMaxBytes);
      if (content === null) {
        await mark({ ...current, status: 'ERROR', error: `${source.lockfilePath} 를 내려받지 못했습니다.` });
        return 'ERROR';
      }
      const packageJson = await this.client
        .fileText(token, repo.fullName, siblingPackageJson(source.lockfilePath), ref, PACKAGE_JSON_MAX_BYTES)
        .catch(() => null);

      await this.projects.createSnapshotFromSource(projectId, { content, packageJson, fileName: source.lockfilePath, sourceRef: commitSha });
      await this.prisma.projectRepoSource.update({
        where: { projectId },
        data: { ...current, lockfileSha: meta.sha, commitSha, status: 'OK', error: null, lastCheckedAt: now, lastChangedAt: now },
      });
      if (source.autoTech) await this.fillTechnologies(projectId);
      return 'CREATED';
    } catch (error) {
      if (error instanceof LockfileError) {
        await mark({ status: 'ERROR', error: `lockfile 을 해석하지 못했습니다: ${error.message}` });
        return 'ERROR';
      }
      if (error instanceof GithubAppError) {
        if (error.code === 'NOT_FOUND' || error.code === 'NO_ACCESS') {
          await mark({ status: 'DISCONNECTED', error: DISCONNECTED_MESSAGE });
          return 'DISCONNECTED';
        }
        await mark({ status: 'ERROR', error: `${error.message} 다음 확인 때 다시 시도합니다.` });
        return 'ERROR';
      }
      this.logger.warn(`GitHub 확인 실패 (${projectId}): ${error instanceof Error ? error.message : String(error)}`);
      await mark({ status: 'ERROR', error: '확인 중 오류가 났습니다. 다음 확인 때 다시 시도합니다.' });
      return 'ERROR';
    }
  }

  /** 처음 가져온 뒤 한 번: 사용 기술이 비어 있으면 직접 의존성으로 채운다. */
  private async fillTechnologies(projectId: string): Promise<void> {
    const existing = await this.prisma.projectTechnology.count({ where: { projectId } });
    if (existing === 0) {
      const snapshot = await this.prisma.projectSnapshot.findFirst({ where: { projectId, isCurrent: true }, select: { id: true } });
      if (snapshot) {
        const direct = await this.prisma.snapshotPackage.findMany({ where: { snapshotId: snapshot.id, isDirect: true }, select: { name: true } });
        const tags = computeTechnologyTags(
          { packages: [...new Set(direct.map((p) => p.name))].map((name) => ({ ecosystem: 'npm', name })), products: [] },
          await this.catalog.mappings(),
        );
        if (tags.size > 0) {
          await this.prisma.projectTechnology.createMany({ data: [...tags.keys()].map((technologyId) => ({ projectId, technologyId })) });
        }
      }
    }
    await this.prisma.projectRepoSource.update({ where: { projectId }, data: { autoTech: false } });
  }
}
