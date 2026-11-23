import { Injectable, Logger } from '@nestjs/common';
import { AssessmentService } from '../assessment/assessment.service.js';
import { HttpError } from '../common/http.js';
import { PrismaService } from '../db/prisma.service.js';
import { normalizeOsv, OsvClient, type BatchHit } from '../ingestion/adapters/osv.client.js';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { normalizeIdentifier } from '../ingestion/normalized.js';
import { VulnerabilityUpsertService } from '../ingestion/upsert.service.js';
import { JobService } from '../jobs/job.service.js';

const DETAIL_CONCURRENCY = 6;
const CHUNK = 400;

async function pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length) {
        const current = items[index];
        index += 1;
        await worker(current);
      }
    }),
  );
}

@Injectable()
export class ScanService {
  private readonly logger = new Logger(ScanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly osv: OsvClient,
    private readonly upserts: VulnerabilityUpsertService,
    private readonly ingestion: IngestionService,
    private readonly assessment: AssessmentService,
    private readonly jobs: JobService,
  ) {}

  /**
   * 검사 1회 실행.
   * - 공개 시점과 무관하게 설치된 (패키지, 버전) 전부를 OSV 에 조회한다.
   * - 외부 조회가 실패하면 검사를 PARTIAL/FAILED 로 남긴다. "일치 없음"으로 바꾸지 않는다.
   */
  async run(scanId: string, jobId?: string): Promise<void> {
    const scan = await this.prisma.scanRun.findUnique({ where: { id: scanId }, include: { snapshot: true } });
    if (!scan) return;
    if (scan.status === 'SUCCEEDED' || scan.status === 'PARTIAL') return;

    const previous = await this.prisma.scanRun.count({
      where: { projectId: scan.projectId, id: { not: scanId }, status: { in: ['SUCCEEDED', 'PARTIAL'] } },
    });
    const isInitial = previous === 0;
    await this.prisma.scanRun.update({ where: { id: scanId }, data: { status: 'RUNNING', startedAt: new Date(), isInitial, error: null } });

    try {
      const all = await this.prisma.snapshotPackage.findMany({
        where: { snapshotId: scan.snapshotId },
        select: { name: true, version: true, scannable: true, unsupportedReason: true },
      });
      const distinct = new Map<string, { name: string; version: string }>();
      const skipped = new Map<string, number>();
      for (const pkg of all) {
        if (!pkg.scannable) {
          const reason = pkg.unsupportedReason ?? '검사 불가';
          skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
          continue;
        }
        const name = pkg.name.toLowerCase();
        distinct.set(`${name}@${pkg.version}`, { name, version: pkg.version });
      }
      const queries = [...distinct.values()];
      await this.prisma.scanRun.update({ where: { id: scanId }, data: { packagesTotal: queries.length } });

      // 1) OSV 조회
      const problems: string[] = [];
      let batch: BatchHit[][] | null = null;
      try {
        batch = queries.length > 0 ? await this.osv.queryBatch(queries) : [];
        await this.ingestion.recordOsv(true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 모든 사용자가 보는 소스 상태에는 오류의 종류만 남긴다. 자세한 내용은 이 검사 기록에만 둔다.
        await this.ingestion.recordOsv(false, error instanceof HttpError ? `OSV 응답 오류 (HTTP ${error.status})` : 'OSV 에 연결하지 못함');
        problems.push(`OSV 조회 실패: ${message}. 이미 수집된 공지로만 비교했으므로 결과에 없는 항목을 "일치 없음"으로 볼 수 없습니다.`);
      }
      if (jobId) await this.jobs.extendLease(jobId, 10 * 60_000);

      // 2) 필요한 상세만 조회해 캐시(SourceRecord) 를 갱신
      let osvHits: Map<string, Set<string>> | null = null;
      const unresolvedIds: string[] = [];
      if (batch) {
        const modifiedById = new Map<string, string | null>();
        for (const hits of batch) for (const hit of hits) modifiedById.set(hit.id, hit.modified);
        const ids = [...modifiedById.keys()];
        const cached = new Map<string, Date | null>();
        for (let offset = 0; offset < ids.length; offset += CHUNK) {
          const rows = await this.prisma.sourceRecord.findMany({
            where: { source: 'OSV', sourceId: { in: ids.slice(offset, offset + CHUNK) } },
            select: { sourceId: true, sourceModifiedAt: true },
          });
          for (const row of rows) cached.set(row.sourceId, row.sourceModifiedAt);
        }
        const toFetch = ids.filter((id) => {
          if (!cached.has(id)) return true;
          const modified = modifiedById.get(id);
          const known = cached.get(id);
          return Boolean(modified) && (!known || new Date(modified as string).getTime() > known.getTime());
        });
        const failed: string[] = [];
        await pool(toFetch, DETAIL_CONCURRENCY, async (id) => {
          try {
            const record = await this.osv.getVulnerability(id);
            // 검사 중 조회한 과거 공지는 "신규 취약점" 알림 대상이 아니다.
            await this.upserts.upsert(normalizeOsv(record), { emitEvents: false });
          } catch (error) {
            failed.push(id);
            this.logger.warn(`OSV 상세 조회 실패 ${id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
        if (failed.length > 0) problems.push(`OSV 상세 조회 실패 ${failed.length}건 (${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ' 외' : ''})`);

        // OSV ID → 내부 취약점 ID
        const idMap = new Map<string, string>();
        const normalized = ids.map((id) => ({ id, value: normalizeIdentifier(id)?.value })).filter((entry): entry is { id: string; value: string } => Boolean(entry.value));
        for (let offset = 0; offset < normalized.length; offset += CHUNK) {
          const slice = normalized.slice(offset, offset + CHUNK);
          const rows = await this.prisma.vulnerabilityIdentifier.findMany({
            where: { value: { in: slice.map((entry) => entry.value) } },
            select: { value: true, vulnerabilityId: true },
          });
          const byValue = new Map(rows.map((row) => [row.value, row.vulnerabilityId]));
          for (const entry of slice) {
            const vulnerabilityId = byValue.get(entry.value);
            if (vulnerabilityId) idMap.set(entry.id, vulnerabilityId);
          }
        }
        osvHits = new Map();
        batch.forEach((hits, index) => {
          const query = queries[index];
          const set = new Set<string>();
          for (const hit of hits) {
            const vulnerabilityId = idMap.get(hit.id);
            if (vulnerabilityId) set.add(vulnerabilityId);
            else if (!unresolvedIds.includes(hit.id)) unresolvedIds.push(hit.id);
          }
          osvHits!.set(`${query.name}@${query.version}`, set);
        });
        if (unresolvedIds.length > 0) {
          problems.push(`상세를 확인하지 못해 결과에 반영되지 않은 OSV 항목 ${unresolvedIds.length}건 (${unresolvedIds.slice(0, 5).join(', ')})`);
        }
      }
      if (jobId) await this.jobs.extendLease(jobId, 10 * 60_000);

      // 3) 로컬 범위 비교로 재검증하며 분석 결과 기록 (최초 검사는 개별 알림 없이 요약 1건)
      const result = await this.assessment.assessSnapshot({
        projectId: scan.projectId,
        snapshotId: scan.snapshotId,
        scanId,
        osvHits,
        silent: isInitial,
      });

      const freshness = Object.fromEntries(
        (await this.ingestion.status()).filter((source) => source.key !== 'KISA').map((source) => [
          source.key,
          { status: source.status, lastSuccessAt: source.lastSuccessAt?.toISOString() ?? null, lagging: source.lagging },
        ]),
      );
      const status = problems.length > 0 ? 'PARTIAL' : 'SUCCEEDED';
      const summary = { ...result, unresolvedOsvIds: unresolvedIds, problems };
      const scope = {
        ecosystem: 'npm',
        packagesInSnapshot: all.length,
        distinctVersionsQueried: queries.length,
        skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })),
        sources: ['OSV querybatch (설치 버전 조회)', '수집된 공지의 영향 범위 (GitHub Advisory, OSV)'],
        notCovered: [
          '런타임·OS 버전의 자동 매칭 (관련 공지는 수동 검토 대상)',
          '코드 도달 가능성 - 취약 기능을 실제로 호출하는지는 판정하지 않음',
          'npm 외 생태계',
        ],
      };

      await this.prisma.$transaction(async (tx) => {
        await tx.scanRun.update({
          where: { id: scanId },
          data: {
            status,
            packagesScanned: batch ? queries.length : 0,
            scope,
            sourceFreshness: freshness,
            summary,
            error: problems.length ? problems.join(' / ') : null,
            finishedAt: new Date(),
          },
        });
        if (isInitial) {
          await tx.notificationEvent.create({
            data: {
              type: 'INITIAL_SCAN_SUMMARY',
              projectId: scan.projectId,
              payload: { scanId, status, affected: result.affected, unknown: result.unknown, byPriority: result.byPriority, packages: queries.length },
              changeFingerprint: `initial:${scan.projectId}`,
            },
          });
        }
      });
      // 과거 공지가 새로 저장되었으면 EPSS 를 채우도록 다음 수집을 앞당긴다.
      if (result.newFindings > 0) await this.jobs.enqueue('ingest', { source: 'EPSS' }, { dedupeKey: 'ingest:EPSS', maxAttempts: 1 });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      await this.prisma.scanRun.update({ where: { id: scanId }, data: { status: 'FAILED', error: message, finishedAt: new Date() } });
      throw error;
    }
  }

  /** 마지막 검사가 주기보다 오래된 프로젝트를 다시 검사 대기열에 넣는다. */
  async enqueueDueRescans(rescanMinutes: number, createScan: (projectId: string, snapshotId: string) => Promise<unknown>): Promise<number> {
    const threshold = new Date(Date.now() - rescanMinutes * 60_000);
    const snapshots = await this.prisma.projectSnapshot.findMany({
      where: { isCurrent: true, scans: { none: { createdAt: { gt: threshold } } } },
      select: { id: true, projectId: true },
    });
    for (const snapshot of snapshots) await createScan(snapshot.projectId, snapshot.id);
    return snapshots.length;
  }
}
