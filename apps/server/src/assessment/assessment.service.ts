import { Inject, Injectable } from '@nestjs/common';
import { stableHash } from '../common/crypto.js';
import type { AppEnv } from '../config/env.js';
import { APP_ENV } from '../db/db.module.js';
import { PrismaService } from '../db/prisma.service.js';
import { deriveConditions } from '../domain/conditions.js';
import { isMaliciousAdvisory } from '../domain/malicious.js';
import { computePriority, PRIORITY_RANK, type PriorityLevel } from '../domain/priority.js';
import {
  combineEvaluations,
  describeInterval,
  evaluateSpec,
  suggestFix,
  type AffectedSpec,
  type Interval,
} from '../domain/version-match.js';

export interface AssessParams {
  projectId: string;
  snapshotId: string;
  scanId: string | null;
  /**
   * OSV 조회 결과: "이름@버전" → 일치로 보고된 취약점 ID 집합.
   * null 이면 OSV 를 조회하지 않았거나 조회에 실패한 것이다 (로컬 범위 평가만 사용).
   */
  osvHits: Map<string, Set<string>> | null;
  /** true 면 알림 이벤트를 만들지 않는다 (최초 검사, 초기 적재) */
  silent: boolean;
  /** 지정하면 이 취약점만 다시 평가한다 */
  onlyVulnerabilityId?: string;
}

export interface AssessResult {
  affected: number;
  unknown: number;
  newFindings: number;
  newMatches: number;
  resolved: number;
  priorityRaised: number;
  byPriority: Record<string, number>;
}

interface InstalledVersion {
  packageId: string;
  name: string;
  version: string;
  paths: Array<{ installPath: string; isDirect: boolean; isDev: boolean; isOptional: boolean; dependencyPath: string[] }>;
}

const CHUNK = 400;
const GROUPS_PER_TX = 25;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * 프로젝트 영향도 분석.
 * 버전 매칭은 결정적인 범위 비교로만 하고, 악용 조건의 충족 여부는 판정하지 않는다.
 */
@Injectable()
export class AssessmentService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async assessSnapshot(params: AssessParams): Promise<AssessResult> {
    const { projectId, snapshotId, onlyVulnerabilityId } = params;
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { exposure: true, environments: true },
    });
    const environments = (project.environments ?? []) as string[];

    // 1) 현재 구성의 (패키지, 설치 버전) - 같은 패키지의 여러 버전을 각각 평가한다.
    const rows = await this.prisma.snapshotPackage.findMany({
      where: { snapshotId, scannable: true, packageId: { not: null } },
      select: { packageId: true, name: true, version: true, installPath: true, isDirect: true, isDev: true, isOptional: true, dependencyPath: true },
    });
    const installed = new Map<string, InstalledVersion>();
    for (const row of rows) {
      const key = `${row.packageId}|${row.version}`;
      const entry = installed.get(key) ?? { packageId: row.packageId!, name: row.name.toLowerCase(), version: row.version, paths: [] };
      entry.paths.push({
        installPath: row.installPath,
        isDirect: row.isDirect,
        isDev: row.isDev,
        isOptional: row.isOptional,
        dependencyPath: (row.dependencyPath ?? []) as string[],
      });
      installed.set(key, entry);
    }
    const packageIds = [...new Set([...installed.values()].map((entry) => entry.packageId))];

    // 2) 설치된 패키지를 언급하는 공지의 영향 범위 (출처별)
    type AffectedRow = {
      vulnerabilityId: string;
      packageId: string;
      intervals: unknown;
      versions: unknown;
      unparsed: unknown;
      functions: unknown;
      rangeHash: string;
      sourceRecord: { source: string; withdrawn: boolean };
    };
    const affectedByPackage = new Map<string, Map<string, AffectedRow[]>>();
    for (const ids of chunk(packageIds, CHUNK)) {
      const found: AffectedRow[] = await this.prisma.affectedPackage.findMany({
        where: { packageId: { in: ids }, ...(onlyVulnerabilityId ? { vulnerabilityId: onlyVulnerabilityId } : {}) },
        select: {
          vulnerabilityId: true,
          packageId: true,
          intervals: true,
          versions: true,
          unparsed: true,
          functions: true,
          rangeHash: true,
          sourceRecord: { select: { source: true, withdrawn: true } },
        },
      });
      for (const row of found) {
        const byVuln = affectedByPackage.get(row.packageId) ?? new Map<string, AffectedRow[]>();
        byVuln.set(row.vulnerabilityId, [...(byVuln.get(row.vulnerabilityId) ?? []), row]);
        affectedByPackage.set(row.packageId, byVuln);
      }
    }

    // 3) 평가 대상 목록: 로컬 범위 데이터가 있는 조합 + OSV 가 일치로 보고한 조합
    interface WorkItem {
      vulnerabilityId: string;
      target: InstalledVersion;
      rows: AffectedRow[];
      osvReported: boolean | null;
    }
    const work: WorkItem[] = [];
    for (const target of installed.values()) {
      const byVuln = affectedByPackage.get(target.packageId) ?? new Map<string, AffectedRow[]>();
      const hits = params.osvHits ? (params.osvHits.get(`${target.name}@${target.version}`) ?? new Set<string>()) : null;
      const vulnIds = new Set<string>([...byVuln.keys(), ...(hits ?? [])]);
      for (const vulnerabilityId of vulnIds) {
        if (onlyVulnerabilityId && vulnerabilityId !== onlyVulnerabilityId) continue;
        work.push({ vulnerabilityId, target, rows: byVuln.get(vulnerabilityId) ?? [], osvReported: hits ? hits.has(vulnerabilityId) : null });
      }
    }

    const vulnerabilityIds = [...new Set(work.map((item) => item.vulnerabilityId))];
    const vulnerabilities = new Map<
      string,
      {
        id: string;
        withdrawnAt: Date | null;
        kevAddedAt: Date | null;
        malicious: boolean;
        /** OSV 레코드를 마지막으로 저장한 시각 (없으면 null) */
        osvFetchedAt: Date | null;
        cvssScore: number | null;
        cvssVector: string | null;
        severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
        epssScore: number | null;
      }
    >();
    for (const ids of chunk(vulnerabilityIds, CHUNK)) {
      const found = await this.prisma.vulnerability.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          withdrawnAt: true,
          kevAddedAt: true,
          cvssScore: true,
          cvssVector: true,
          severity: true,
          epssScore: true,
          identifiers: { select: { value: true } },
          sources: { where: { source: 'OSV' }, select: { fetchedAt: true } },
        },
      });
      for (const { identifiers, sources, ...row } of found) {
        const osvFetchedAt = sources.length ? new Date(Math.max(...sources.map((source) => source.fetchedAt.getTime()))) : null;
        vulnerabilities.set(row.id, { ...row, malicious: isMaliciousAdvisory(identifiers), osvFetchedAt });
      }
    }

    const existingRows = await this.prisma.finding.findMany({
      where: { projectId, ...(onlyVulnerabilityId ? { vulnerabilityId: onlyVulnerabilityId } : {}) },
      include: { reviews: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    const existing = new Map(existingRows.map((row) => [`${row.vulnerabilityId}|${row.packageId}|${row.version}`, row]));

    const result: AssessResult = { affected: 0, unknown: 0, newFindings: 0, newMatches: 0, resolved: 0, priorityRaised: 0, byPriority: {} };
    const touched = new Set<string>();
    const now = new Date();

    const groups = new Map<string, WorkItem[]>();
    for (const item of work) groups.set(item.vulnerabilityId, [...(groups.get(item.vulnerabilityId) ?? []), item]);

    for (const batch of chunk([...groups.entries()], GROUPS_PER_TX)) {
      await this.prisma.$transaction(
        async (tx) => {
          for (const [vulnerabilityId, items] of batch) {
            const vulnerability = vulnerabilities.get(vulnerabilityId);
            if (!vulnerability) continue;
            const newMatches: Array<{ findingId: string; label: string; reopenedAfter: string | null }> = [];
            let raised: { findingId: string; from: string; to: PriorityLevel; since: string } | null = null;

            for (const item of items) {
              const key = `${vulnerabilityId}|${item.target.packageId}|${item.target.version}`;
              const before = existing.get(key);
              touched.add(key);

              // 공지 전체가 철회되면 일치로 보지 않는다. 기존 결과는 지우지 않고 닫는다.
              if (vulnerability.withdrawnAt) {
                if (before && before.resolvedAt === null) {
                  await tx.finding.update({ where: { id: before.id }, data: { resolvedAt: now, resolution: 'ADVISORY_WITHDRAWN', lastSeenScanId: params.scanId ?? before.lastSeenScanId } });
                  result.resolved += 1;
                }
                continue;
              }

              const activeRows = item.rows.filter((row) => !row.sourceRecord.withdrawn);
              const specs: AffectedSpec[] = activeRows.map((row) => ({
                source: row.sourceRecord.source,
                intervals: (row.intervals ?? []) as Interval[],
                versions: (row.versions ?? []) as string[],
                unparsed: (row.unparsed ?? []) as string[],
              }));
              const evaluations = specs.map((spec) => evaluateSpec(item.target.version, spec));
              // 이번 평가에서 OSV 를 조회하지 않았으면 마지막 검사의 OSV 보고를 쓴다. 조회하지 않은 것을 "보고 없음"으로 바꾸지 않는다.
              // 단, 그 검사 뒤에 바뀐 OSV 공지(철회·범위 변경 포함)가 저장됐다면 당시 보고는 지난 정보이므로 쓰지 않는다 (다음 검사에서 다시 조회한다).
              const lastScan = (before?.evidence as { lastScan?: { osvReported?: unknown; at?: unknown } } | null)?.lastScan;
              const lastScanAt = typeof lastScan?.at === 'string' ? Date.parse(lastScan.at) : Number.NaN;
              const osvChangedSince = vulnerability.osvFetchedAt !== null && !(vulnerability.osvFetchedAt.getTime() <= lastScanAt);
              const osvReported = item.osvReported ?? (typeof lastScan?.osvReported === 'boolean' && !osvChangedSince ? lastScan.osvReported : null);
              const combined = combineEvaluations(evaluations, osvReported);

              if (combined.result === 'NOT_AFFECTED') {
                // 일치한 적 없는 조합은 행을 만들지 않는다. 일치했던 조합은 이력을 남기고 닫는다.
                if (before && (before.versionMatch !== 'NOT_AFFECTED' || before.resolvedAt === null)) {
                  await tx.finding.update({
                    where: { id: before.id },
                    data: {
                      versionMatch: 'NOT_AFFECTED',
                      resolvedAt: before.resolvedAt ?? now,
                      resolution: 'RANGE_NO_LONGER_MATCHES',
                      analyzedAt: now,
                      lastSeenScanId: params.scanId ?? before.lastSeenScanId,
                      evidence: { reason: combined.reason, evaluations: combined.evaluations, snapshotId, analyzedAt: now.toISOString() } as object,
                    },
                  });
                  if (before.resolvedAt === null) result.resolved += 1;
                }
                continue;
              }

              const fix = suggestFix(item.target.version, specs);
              const functions = [...new Set(activeRows.flatMap((row) => (row.functions ?? []) as string[]))];
              const conditions = deriveConditions(vulnerability.cvssVector, functions);
              const rangeHash = stableHash(activeRows.map((row) => `${row.sourceRecord.source}:${row.rangeHash}`).sort());
              const review = before?.reviews[0] ?? null;

              // 수동 검토가 있으면 그 판정을 유지한다. 없으면 공지에서 확인할 조건이 있는지만 표시한다.
              const exploitCondition = review ? before!.exploitCondition : conditions.needsCheck ? 'NEEDS_CHECK' : 'NOT_ANALYZED';

              let needsRecheck = before?.needsRecheck ?? false;
              let recheckReason = before?.recheckReason ?? null;
              if (review && !needsRecheck) {
                if (review.basedOnRangeHash !== rangeHash) {
                  needsRecheck = true;
                  recheckReason = '검토 이후 공지의 영향 범위가 변경됨';
                } else if (review.basedOnSnapshotId !== snapshotId) {
                  needsRecheck = true;
                  recheckReason = '검토 이후 프로젝트 구성이 변경됨';
                }
              }

              const priority = computePriority(
                {
                  versionMatch: combined.result,
                  exploitCondition,
                  needsRecheck,
                  kevListed: vulnerability.kevAddedAt !== null,
                  malicious: vulnerability.malicious,
                  cvssScore: vulnerability.cvssScore,
                  severityLabel: vulnerability.severity,
                  epssScore: vulnerability.epssScore,
                  exposure: project.exposure,
                  environments,
                  patchAvailable: fix.kind !== 'UNCONFIRMED',
                },
                { epssThreshold: this.env.epssThreshold },
              );

              const evidence = {
                reason: combined.reason,
                osvReported: item.osvReported,
                evaluations: combined.evaluations.map((evaluation) => ({
                  source: evaluation.source,
                  result: evaluation.result,
                  reason: evaluation.reason,
                  matchedRange: evaluation.matchedInterval ? describeInterval(evaluation.matchedInterval) : (evaluation.matchedExactVersion ?? null),
                })),
                ranges: specs.map((spec) => ({ source: spec.source, ranges: spec.intervals.map(describeInterval), versions: spec.versions.slice(0, 20), unparsed: spec.unparsed })),
                fix,
                conditionChecks: conditions.checks,
                installCount: item.target.paths.length,
                installPaths: item.target.paths.slice(0, 10),
                isDirect: item.target.paths.some((path) => path.isDirect),
                devOnly: item.target.paths.every((path) => path.isDev),
                sources: [...new Set(specs.map((spec) => spec.source)), ...(item.osvReported !== null ? ['OSV querybatch'] : [])],
                // 가장 최근 검사에서 OSV 가 이 설치 버전을 어떻게 보고했는지 (공지 변경에 따른 재평가에서는 OSV 를 다시 조회하지 않는다)
                lastScan:
                  item.osvReported !== null
                    ? { osvReported: item.osvReported, scanId: params.scanId, at: now.toISOString() }
                    : ((before?.evidence as { lastScan?: object } | null)?.lastScan ?? null),
                snapshotId,
                scanId: params.scanId,
                analyzedAt: now.toISOString(),
              };

              const data = {
                versionMatch: combined.result,
                exploitCondition,
                priority: priority.priority,
                priorityRank: priority.rank,
                priorityReasons: priority as unknown as object,
                ruleVersion: priority.ruleVersion,
                evidence: evidence as unknown as object,
                fixedVersion: fix.kind === 'FIXED' ? fix.version : null,
                needsRecheck,
                recheckReason,
                resolvedAt: null,
                resolution: null,
                rangeHash,
                analyzedAt: now,
                lastSeenScanId: params.scanId ?? before?.lastSeenScanId ?? null,
              } as const;

              let findingId: string;
              if (before) {
                await tx.finding.update({ where: { id: before.id }, data });
                findingId = before.id;
              } else {
                const created = await tx.finding.create({
                  data: {
                    projectId,
                    vulnerabilityId,
                    packageId: item.target.packageId,
                    version: item.target.version,
                    firstSeenScanId: params.scanId,
                    ...data,
                  },
                });
                findingId = created.id;
                result.newFindings += 1;
              }

              if (combined.result === 'AFFECTED') result.affected += 1;
              else result.unknown += 1;
              result.byPriority[priority.priority] = (result.byPriority[priority.priority] ?? 0) + 1;

              const wasActiveMatch = before !== undefined && before.resolvedAt === null && before.versionMatch === 'AFFECTED';
              if (combined.result === 'AFFECTED' && !wasActiveMatch) {
                newMatches.push({ findingId, label: `${item.target.name}@${item.target.version}`, reopenedAfter: before?.resolvedAt?.toISOString() ?? null });
              } else if (combined.result === 'AFFECTED' && wasActiveMatch && priority.rank > before!.priorityRank) {
                if (!raised || PRIORITY_RANK[priority.priority] > PRIORITY_RANK[raised.to]) {
                  raised = { findingId, from: before!.priority, to: priority.priority, since: before!.analyzedAt.toISOString() };
                }
              }
            }

            result.newMatches += newMatches.length;
            if (raised) result.priorityRaised += 1;
            if (params.silent) continue;
            // 같은 (프로젝트, 취약점) 의 변화는 이벤트 하나로 묶는다. (Outbox: 분석 결과와 같은 트랜잭션)
            if (newMatches.length > 0) {
              const labels = newMatches.map((match) => match.label).sort();
              // 해소됐다가 다시 생긴 일치는 새 알림이다. 해소 시각을 지문에 넣어 이전 알림과 구분한다.
              const occurrences = newMatches.map((match) => (match.reopenedAfter ? `${match.label}#reopened:${match.reopenedAfter}` : match.label)).sort();
              await tx.notificationEvent.create({
                data: {
                  type: 'PROJECT_NEW_MATCH',
                  projectId,
                  vulnerabilityId,
                  findingId: newMatches[0].findingId,
                  payload: { packages: labels },
                  changeFingerprint: `match:${stableHash(occurrences)}`,
                },
              });
            }
            if (raised) {
              await tx.notificationEvent.create({
                data: {
                  type: 'PRIORITY_RAISED',
                  projectId,
                  vulnerabilityId,
                  findingId: raised.findingId,
                  payload: { from: raised.from, to: raised.to },
                  // 내려갔다가 다시 오른 경우도 새 알림이다. 직전 평가 시각으로 이전 상승과 구분한다.
                  changeFingerprint: `priority:${raised.to}:${raised.since}`,
                },
              });
            }
          }
        },
        { timeout: 120_000, maxWait: 30_000 },
      );
    }

    // 4) 이번 평가에서 다루지 않은 기존 결과 정리.
    //    조치 완료 버튼이 아니라 재검사 결과로만 "현재 구성에서 미검출"이 된다.
    const stale = existingRows.filter((row) => {
      if (row.resolvedAt !== null || touched.has(`${row.vulnerabilityId}|${row.packageId}|${row.version}`)) return false;
      // OSV 를 조회하지 않은 평가에서는, OSV 보고만으로 남아 있던 "판단 불가" 항목을 닫지 않는다.
      const osvOnly = (row.evidence as { lastScan?: { osvReported?: boolean } } | null)?.lastScan?.osvReported === true;
      if (params.osvHits === null && osvOnly && installed.has(`${row.packageId}|${row.version}`)) return false;
      return true;
    });
    for (const batch of chunk(stale, 200)) {
      await this.prisma.$transaction(
        batch.map((row) =>
          this.prisma.finding.update({
            where: { id: row.id },
            data: {
              resolvedAt: now,
              resolution: installed.has(`${row.packageId}|${row.version}`) ? 'NO_LONGER_LISTED' : 'NOT_IN_CURRENT_SNAPSHOT',
              lastSeenScanId: params.scanId ?? row.lastSeenScanId,
            },
          }),
        ),
      );
      result.resolved += batch.length;
    }
    return result;
  }

  /** 공지가 바뀐 취약점 하나를, 해당 패키지를 쓰는 모든 프로젝트의 현재 구성에 대해 다시 평가한다. */
  async reassessVulnerability(vulnerabilityId: string, silent: boolean): Promise<number> {
    const affected = await this.prisma.affectedPackage.findMany({ where: { vulnerabilityId }, select: { packageId: true }, distinct: ['packageId'] });
    const packageIds = affected.map((row) => row.packageId);
    const snapshots = new Map<string, string>();
    for (const ids of chunk(packageIds, CHUNK)) {
      const rows = await this.prisma.snapshotPackage.findMany({
        where: { packageId: { in: ids }, snapshot: { isCurrent: true } },
        select: { snapshot: { select: { id: true, projectId: true } } },
        distinct: ['snapshotId'],
      });
      for (const row of rows) snapshots.set(row.snapshot.projectId, row.snapshot.id);
    }
    // 이미 결과가 있는 프로젝트도 포함한다 (범위에서 빠진 경우를 닫기 위해).
    const withFindings = await this.prisma.finding.findMany({
      where: { vulnerabilityId, resolvedAt: null },
      select: { projectId: true },
      distinct: ['projectId'],
    });
    for (const row of withFindings) {
      if (snapshots.has(row.projectId)) continue;
      const current = await this.prisma.projectSnapshot.findFirst({ where: { projectId: row.projectId, isCurrent: true }, select: { id: true } });
      if (current) snapshots.set(row.projectId, current.id);
    }
    for (const [projectId, snapshotId] of snapshots) {
      await this.assessSnapshot({ projectId, snapshotId, scanId: null, osvHits: null, silent, onlyVulnerabilityId: vulnerabilityId });
    }
    return snapshots.size;
  }

  /** 프로젝트 환경 정보가 바뀌었을 때: 기존 검토에 재확인 표시를 하고 우선순위를 다시 계산한다. */
  async reprioritizeProject(projectId: string, reason: string): Promise<void> {
    const snapshot = await this.prisma.projectSnapshot.findFirst({ where: { projectId, isCurrent: true }, select: { id: true } });
    if (!snapshot) return;
    await this.prisma.finding.updateMany({
      where: { projectId, resolvedAt: null, reviews: { some: {} } },
      data: { needsRecheck: true, recheckReason: reason },
    });
    await this.assessSnapshot({ projectId, snapshotId: snapshot.id, scanId: null, osvHits: null, silent: false });
  }
}
