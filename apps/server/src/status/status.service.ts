import type { SourceKey } from '../generated/prisma/client.js';
import { Inject, Injectable } from '@nestjs/common';
import type { FindingQueryDto } from '../assessment/finding.dto.js';
import { FindingService } from '../assessment/finding.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import type { AppEnv } from '../config/env.js';
import { APP_ENV } from '../db/db.module.js';
import { PrismaService } from '../db/prisma.service.js';
import { PRIORITY_ADJUSTMENTS, PRIORITY_RULE_VERSION, PRIORITY_RULES } from '../domain/priority.js';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { ProjectService } from '../project/project.service.js';
import type { VulnerabilityQueryDto } from '../vulnerability/vulnerability.dto.js';
import { VulnerabilityService } from '../vulnerability/vulnerability.service.js';
import type { DashboardCardDto, DashboardDto, IngestionStatusDto, PriorityRulesDto, SourceStatusDto, StatusSummaryDto } from './status.dto.js';

const SOURCE_ROLES: Record<string, string> = {
  GHSA: 'GitHub Advisory Database - 오픈소스 패키지 보안 공지와 영향 버전',
  OSV: 'OSV - 설치된 패키지 버전에 대한 취약점 조회 (프로젝트 검사 때 호출)',
  NVD: 'NVD - CVE 정보, CVSS, 제품(CPE) 정보 보완',
  KEV: 'CISA KEV - 실제 악용이 확인된 취약점 여부',
  EPSS: 'FIRST EPSS - 30일 내 악용 활동 관측 확률 추정',
  KISA: 'KISA 보호나라 보안공지 - 국내 공공 보안 권고 (관련 공지로만 표시)',
  AWS: 'AWS 보안 공지 - AWS 서비스와 도구의 공식 보안 공지 (관련 공지로만 표시)',
};

const OPEN_STATUSES = ['UNREVIEWED', 'IN_REVIEW', 'PLANNED'] as const;

@Injectable()
export class StatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: IngestionService,
    private readonly findings: FindingService,
    private readonly vulnerabilities: VulnerabilityService,
    private readonly catalog: CatalogService,
    private readonly projects: ProjectService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async sources(): Promise<SourceStatusDto[]> {
    const active = await this.prisma.ingestionRun.findMany({ where: { status: 'RUNNING' }, select: { source: true }, distinct: ['source'] });
    const running = new Set(active.map((run) => run.source as string));
    const views = await this.ingestion.status();
    // 출처마다 마지막으로 끝난 수집 1건만 읽는다 (source, startedAt 인덱스 사용).
    const lastRuns = await Promise.all(
      views.map((view) =>
        this.prisma.ingestionRun.findFirst({ where: { source: view.key as SourceKey, status: { not: 'RUNNING' } }, orderBy: { startedAt: 'desc' }, select: { source: true, changed: true } }),
      ),
    );
    const recent = new Map(lastRuns.filter((run) => run !== null).map((run) => [run.source as string, run.changed]));
    const [ghsa, nvd, osv, kev, epss, kisa, aws] = await Promise.all([
      this.prisma.sourceRecord.count({ where: { source: 'GHSA' } }),
      this.prisma.sourceRecord.count({ where: { source: 'NVD' } }),
      this.prisma.sourceRecord.count({ where: { source: 'OSV' } }),
      this.prisma.kevEntry.count(),
      this.prisma.vulnerability.count({ where: { epssScore: { not: null } } }),
      this.prisma.publicNotice.count({ where: { source: 'KISA' } }),
      this.prisma.publicNotice.count({ where: { source: 'AWS' } }),
    ]);
    const totals: Record<string, number> = { GHSA: ghsa, NVD: nvd, OSV: osv, KEV: kev, EPSS: epss, KISA: kisa, AWS: aws };
    return views.map((source) => ({
      ...source,
      running: running.has(source.key),
      recentChanged: recent.get(source.key) ?? null,
      totalItems: totals[source.key] ?? 0,
      role: SOURCE_ROLES[source.key] ?? source.key,
      lastAttemptAt: source.lastAttemptAt?.toISOString() ?? null,
      lastSuccessAt: source.lastSuccessAt?.toISOString() ?? null,
    }));
  }

  /** 상단 표시용 가벼운 요약: 정기 수집 출처의 실패·지연·수집 전 수와 마지막 성공 시각 */
  async summary(): Promise<StatusSummaryDto> {
    const sources = (await this.ingestion.status()).filter((source) => source.key !== 'OSV');
    const failing = sources.filter((source) => source.status === 'FAILING').length;
    const neverRun = sources.filter((source) => source.status === 'NEVER_RUN').length;
    const stale = sources.filter((source) => source.status === 'OK' && source.lagging).length;
    const latest = sources.map((source) => source.lastSuccessAt).filter((value): value is Date => value !== null).sort((a, b) => b.getTime() - a.getTime())[0];
    return { total: sources.length, failing, stale, neverRun, lastSuccessAt: latest?.toISOString() ?? null };
  }

  async ingestionStatus(): Promise<IngestionStatusDto> {
    const [sources, runs, vulnerabilityCount, pendingJobs] = await Promise.all([
      this.sources(),
      this.prisma.ingestionRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 }),
      this.prisma.vulnerability.count(),
      this.prisma.job.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } }),
    ]);
    return {
      sources,
      recentRuns: runs.map((run) => ({
        id: run.id,
        source: run.source,
        status: run.status,
        windowFrom: run.windowFrom?.toISOString() ?? null,
        windowTo: run.windowTo?.toISOString() ?? null,
        fetched: run.fetched,
        upserted: run.upserted,
        changed: run.changed,
        error: run.error,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
      })),
      vulnerabilityCount,
      initialFeedDays: this.env.initialFeedDays,
      pendingJobs,
    };
  }

  async dashboard(userId: string): Promise<DashboardDto> {
    // 카드의 숫자와 목록 화면이 같은 필터를 쓰도록, 필터 객체를 그대로 응답에 싣는다.
    const definitions: Array<{ key: string; label: string; description: string; query: FindingQueryDto }> = [
      { key: 'urgent', label: '긴급 검토', description: '대응 우선순위가 긴급이고 아직 조치되지 않은 항목', query: { priorities: ['URGENT'], statuses: [...OPEN_STATUSES] } },
      { key: 'open', label: '미조치', description: '미검토·검토 중·조치 예정 상태의 항목', query: { statuses: [...OPEN_STATUSES] } },
      { key: 'affected', label: '영향 버전 일치', description: '현재 구성의 설치 버전이 공지의 영향 범위에 포함된 항목', query: { versionMatch: ['AFFECTED'] } },
      { key: 'unknown', label: '판단 불가', description: '버전이나 데이터가 부족해 영향 여부를 확정하지 못한 항목', query: { versionMatch: ['UNKNOWN'] } },
      { key: 'recheck', label: '재확인 필요', description: '검토 이후 구성이나 공지가 바뀐 항목', query: { needsRecheck: true } },
      { key: 'overdue', label: '재검토 기한 경과', description: '위험 수용의 재검토 기한이 지난 항목', query: { reviewOverdue: true } },
    ];
    const cards: DashboardCardDto[] = await Promise.all(
      definitions.map(async (definition) => ({ ...definition, count: await this.findings.count(userId, definition.query) })),
    );

    const urgent = await this.findings.list(userId, { ...definitions[0].query, pageSize: 8 });

    const interests = await this.catalog.getInterests(userId);
    const settings = await this.prisma.userSettings.findUnique({ where: { userId }, select: { interestMatchMode: true } });
    const recentQuery: VulnerabilityQueryDto = {
      sort: 'published',
      order: 'desc',
      ...(interests.length ? { technologyIds: interests, groupMode: settings?.interestMatchMode ?? 'ALL_GROUPS' } : {}),
    };
    const recent = await this.vulnerabilities.list(userId, { ...recentQuery, pageSize: 8 });

    const projectRows = await this.prisma.project.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        snapshots: { where: { isCurrent: true }, select: { id: true }, take: 1 },
        scans: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, createdAt: true, finishedAt: true } },
      },
    });
    const projects = await Promise.all(
      projectRows.map(async (project) => {
        const counts = await this.projects.counts(project.id);
        const scan = project.scans[0];
        return {
          id: project.id,
          name: project.name,
          lastScanStatus: scan?.status ?? null,
          lastScanAt: (scan?.finishedAt ?? scan?.createdAt)?.toISOString() ?? null,
          hasSnapshot: project.snapshots.length > 0,
          urgent: counts.urgent,
          open: counts.open,
        };
      }),
    );

    return {
      cards,
      urgentFindings: urgent.items,
      recentVulnerabilities: recent.items,
      recentQuery,
      recentUsesInterests: interests.length > 0,
      projects,
      sources: await this.sources(),
      activeScans: await this.prisma.scanRun.count({ where: { project: { userId }, status: { in: ['QUEUED', 'RUNNING'] } } }),
    };
  }

  priorityRules(): PriorityRulesDto {
    return {
      version: PRIORITY_RULE_VERSION,
      rules: PRIORITY_RULES,
      adjustments: PRIORITY_ADJUSTMENTS,
      epssThreshold: this.env.epssThreshold,
      notes: [
        '대응 우선순위는 취약점 자체의 심각도와 별개로, 영향 버전 일치 항목을 프로젝트 관점에서 얼마나 먼저 볼지 정한 값입니다.',
        'CVSS 가 제공되지 않은 항목을 낮은 위험으로 처리하지 않습니다.',
        'KEV 미등재는 실제 악용이 없다는 뜻이 아닙니다.',
        'EPSS 는 30일 내 악용 활동이 관측될 확률의 추정치이며, 우리 프로젝트가 공격받을 확률이 아닙니다.',
        '인터넷 노출이 "알 수 없음"이면 "공개"와 같게 취급합니다.',
        '출처마다 CVSS 가 다르면 가장 높은 값을 사용합니다.',
        '패치 제공 여부는 등급이 아니라 조치 유형(업데이트 가능 / 완화책 필요)으로 표시합니다.',
      ],
    };
  }
}
