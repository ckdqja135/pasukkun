import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types.js';
import type { AppEnv } from '../config/env.js';
import { APP_ENV } from '../db/db.module.js';
import { PrismaService } from '../db/prisma.service.js';
import { computePriority } from '../domain/priority.js';
import type { Prisma } from '../generated/prisma/client.js';
import type {
  CreateReviewDto,
  FindingDetailDto,
  FindingListDto,
  FindingListItemDto,
  FindingQueryDto,
  UpdateStatusDto,
} from './finding.dto.js';

const include = {
  project: { select: { id: true, name: true } },
  package: { select: { name: true } },
  vulnerability: {
    select: {
      id: true,
      title: true,
      severity: true,
      cvssScore: true,
      kevAddedAt: true,
      epssScore: true,
      identifiers: { select: { type: true, value: true } },
    },
  },
} satisfies Prisma.FindingInclude;

type Row = Prisma.FindingGetPayload<{ include: typeof include }>;
const IDENTIFIER_ORDER = { CVE: 0, GHSA: 1, OSV: 2 };

@Injectable()
export class FindingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /**
   * 분석 결과 필터. 목록·개수·대시보드 카드가 모두 이 함수를 쓴다.
   * 항상 로그인한 사용자의 프로젝트로 한정한다.
   */
  async buildWhere(userId: string, query: FindingQueryDto): Promise<Prisma.FindingWhereInput> {
    const and: Prisma.FindingWhereInput[] = [{ project: { userId } }];
    if (query.projectId) {
      const owned = await this.prisma.project.findFirst({ where: { id: query.projectId, userId }, select: { id: true } });
      if (!owned) throw new NotFoundException('프로젝트를 찾을 수 없습니다.');
      and.push({ projectId: owned.id });
    }
    if (!query.includeResolved) and.push({ resolvedAt: null });
    if (query.versionMatch?.length) and.push({ versionMatch: { in: query.versionMatch } });
    if (query.priorities?.length) and.push({ priority: { in: query.priorities } });
    if (query.statuses?.length) and.push({ remediationStatus: { in: query.statuses } });
    if (query.exploitConditions?.length) and.push({ exploitCondition: { in: query.exploitConditions } });
    if (query.needsRecheck !== undefined) and.push({ needsRecheck: query.needsRecheck });
    if (query.reviewOverdue) and.push({ remediationStatus: 'RISK_ACCEPTED', reviewDueAt: { lt: new Date() } });
    if (query.q?.trim()) {
      const term = query.q.trim().toLowerCase();
      and.push({ OR: [{ package: { name: { contains: term } } }, { vulnerability: { searchText: { contains: term } } }] });
    }
    return { AND: and };
  }

  async count(userId: string, query: FindingQueryDto): Promise<number> {
    return this.prisma.finding.count({ where: await this.buildWhere(userId, query) });
  }

  async list(userId: string, query: FindingQueryDto): Promise<FindingListDto> {
    const where = await this.buildWhere(userId, query);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const orderBy: Prisma.FindingOrderByWithRelationInput[] =
      query.sort === 'analyzed'
        ? [{ analyzedAt: 'desc' }]
        : query.sort === 'severity'
          ? [{ vulnerability: { severityRank: 'desc' } }, { priorityRank: 'desc' }]
          : [{ priorityRank: 'desc' }, { vulnerability: { severityRank: 'desc' } }, { analyzedAt: 'desc' }];
    orderBy.push({ id: 'asc' });
    const [total, rows] = await Promise.all([
      this.prisma.finding.count({ where }),
      this.prisma.finding.findMany({ where, include, orderBy, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return { items: rows.map((row) => this.toItem(row)), total, page, pageSize };
  }

  private toItem(row: Row): FindingListItemDto {
    const evidence = (row.evidence ?? {}) as { isDirect?: boolean; devOnly?: boolean };
    return {
      id: row.id,
      projectId: row.project.id,
      projectName: row.project.name,
      vulnerabilityId: row.vulnerability.id,
      vulnerabilityTitle: row.vulnerability.title,
      identifiers: [...row.vulnerability.identifiers].sort((a, b) => IDENTIFIER_ORDER[a.type] - IDENTIFIER_ORDER[b.type]).map((id) => id.value),
      packageName: row.package.name,
      version: row.version,
      versionMatch: row.versionMatch,
      exploitCondition: row.exploitCondition,
      priority: row.priority,
      severity: row.vulnerability.severity,
      cvssScore: row.vulnerability.cvssScore,
      kevListed: row.vulnerability.kevAddedAt !== null,
      epssScore: row.vulnerability.epssScore,
      fixedVersion: row.fixedVersion,
      remediationStatus: row.remediationStatus,
      reviewDueAt: row.reviewDueAt?.toISOString() ?? null,
      plannedFixAt: row.plannedFixAt?.toISOString() ?? null,
      needsRecheck: row.needsRecheck,
      recheckReason: row.recheckReason,
      isDirect: evidence.isDirect ?? false,
      devOnly: evidence.devOnly ?? false,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolution: row.resolution,
      analyzedAt: row.analyzedAt.toISOString(),
    };
  }

  /** 소유권 확인을 겸한 조회. 다른 사용자의 결과는 404. */
  private async findOwned(userId: string, findingId: string) {
    const row = await this.prisma.finding.findFirst({ where: { id: findingId, project: { userId } }, include });
    if (!row) throw new NotFoundException('분석 결과를 찾을 수 없습니다.');
    return row;
  }

  async detail(userId: string, findingId: string): Promise<FindingDetailDto> {
    const row = await this.findOwned(userId, findingId);
    const [reviews, history] = await Promise.all([
      this.prisma.findingReview.findMany({ where: { findingId }, orderBy: { createdAt: 'desc' } }),
      this.prisma.findingStatusHistory.findMany({ where: { findingId }, orderBy: { createdAt: 'desc' } }),
    ]);
    return {
      ...this.toItem(row),
      evidence: (row.evidence ?? {}) as object,
      priorityReasons: (row.priorityReasons ?? {}) as object,
      ruleVersion: row.ruleVersion,
      acceptReason: row.acceptReason,
      reviews: reviews.map((review) => ({
        id: review.id,
        authorName: review.authorName,
        verdict: review.verdict,
        checks: (review.checks ?? []) as object[],
        rationale: review.rationale,
        basedOnSnapshotId: review.basedOnSnapshotId,
        createdAt: review.createdAt.toISOString(),
      })),
      history: history.map((entry) => ({
        id: entry.id,
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        authorName: entry.authorName,
        reason: entry.reason,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }

  /**
   * 수동 검토 기록. 악용 조건의 충족 여부는 이 기록으로만 정해진다.
   * 작성자·근거·시각과 검토 당시의 구성/영향 범위를 함께 남긴다.
   */
  async addReview(user: AuthUser, findingId: string, dto: CreateReviewDto): Promise<FindingDetailDto> {
    const finding = await this.findOwned(user.id, findingId);
    const [project, vulnerability, snapshot] = await Promise.all([
      this.prisma.project.findUniqueOrThrow({ where: { id: finding.projectId }, select: { exposure: true, environments: true } }),
      this.prisma.vulnerability.findUniqueOrThrow({
        where: { id: finding.vulnerabilityId },
        select: { kevAddedAt: true, cvssScore: true, severity: true, epssScore: true },
      }),
      this.prisma.projectSnapshot.findFirst({ where: { projectId: finding.projectId, isCurrent: true }, select: { id: true } }),
    ]);
    const evidence = (finding.evidence ?? {}) as { fix?: { kind?: string } };
    const priority = computePriority(
      {
        versionMatch: finding.versionMatch,
        exploitCondition: dto.verdict,
        needsRecheck: false,
        kevListed: vulnerability.kevAddedAt !== null,
        cvssScore: vulnerability.cvssScore,
        severityLabel: vulnerability.severity,
        epssScore: vulnerability.epssScore,
        exposure: project.exposure,
        environments: (project.environments ?? []) as string[],
        patchAvailable: Boolean(evidence.fix?.kind && evidence.fix.kind !== 'UNCONFIRMED'),
      },
      { epssThreshold: this.env.epssThreshold },
    );
    await this.prisma.$transaction([
      this.prisma.findingReview.create({
        data: {
          findingId,
          authorId: user.id,
          authorName: user.login,
          verdict: dto.verdict,
          checks: (dto.checks ?? []) as unknown as object[],
          rationale: dto.rationale.trim(),
          basedOnSnapshotId: snapshot?.id ?? null,
          basedOnRangeHash: finding.rangeHash,
        },
      }),
      this.prisma.finding.update({
        where: { id: findingId },
        data: {
          exploitCondition: dto.verdict,
          needsRecheck: false,
          recheckReason: null,
          priority: priority.priority,
          priorityRank: priority.rank,
          priorityReasons: priority as unknown as object,
          ruleVersion: priority.ruleVersion,
        },
      }),
    ]);
    return this.detail(user.id, findingId);
  }

  /**
   * 조치 상태 변경. 버전 매칭 결과는 건드리지 않는다 -
   * "조치 완료"로 바꿔도 영향 버전 일치 여부는 재검사로만 달라진다.
   */
  async updateStatus(user: AuthUser, findingId: string, dto: UpdateStatusDto): Promise<FindingDetailDto> {
    const finding = await this.findOwned(user.id, findingId);
    let reviewDueAt: Date | null = null;
    if (dto.status === 'RISK_ACCEPTED') {
      if (!dto.reason?.trim()) throw new BadRequestException('위험 수용에는 사유가 필요합니다.');
      if (!dto.reviewDueAt) throw new BadRequestException('위험 수용에는 재검토 기한이 필요합니다.');
      reviewDueAt = new Date(dto.reviewDueAt);
      if (Number.isNaN(reviewDueAt.getTime()) || reviewDueAt.getTime() <= Date.now()) {
        throw new BadRequestException('재검토 기한은 오늘 이후의 날짜여야 합니다.');
      }
    }
    let plannedFixAt: Date | null = null;
    if (dto.status === 'PLANNED' && dto.plannedFixAt) {
      plannedFixAt = new Date(dto.plannedFixAt);
      if (Number.isNaN(plannedFixAt.getTime())) throw new BadRequestException('조치 예정일이 올바르지 않습니다.');
    }
    // 조치 예정일이 바뀌면 이력에 날짜를 남긴다 (상태가 그대로여도 무엇이 바뀌었는지 알 수 있게).
    const settings = await this.prisma.userSettings.findUnique({ where: { userId: user.id }, select: { timezone: true } });
    const day = (value: Date | null) =>
      value ? new Intl.DateTimeFormat('en-CA', { timeZone: settings?.timezone || 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value) : null;
    const before = finding.remediationStatus === 'PLANNED' ? day(finding.plannedFixAt) : null;
    const after = day(plannedFixAt);
    const planNote = dto.status === 'PLANNED' && before !== after ? `조치 예정일 ${before ?? '없음'} → ${after ?? '없음'}` : '';
    const reasonText = [dto.reason?.trim() ?? '', planNote].filter(Boolean).join(' · ');
    await this.prisma.$transaction([
      this.prisma.findingStatusHistory.create({
        data: {
          findingId,
          fromStatus: finding.remediationStatus,
          toStatus: dto.status,
          authorId: user.id,
          authorName: user.login,
          reason: reasonText,
        },
      }),
      this.prisma.finding.update({
        where: { id: findingId },
        data: {
          remediationStatus: dto.status,
          acceptReason: dto.status === 'RISK_ACCEPTED' ? dto.reason!.trim() : null,
          reviewDueAt,
          plannedFixAt,
        },
      }),
    ]);
    return this.detail(user.id, findingId);
  }
}
