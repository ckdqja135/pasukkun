import { Inject, Injectable, Logger } from '@nestjs/common';
import { fetchWithRetry } from '../common/http.js';
import type { AppEnv } from '../config/env.js';
import { APP_ENV } from '../db/db.module.js';
import { PrismaService } from '../db/prisma.service.js';
import { JobService } from '../jobs/job.service.js';
import { EpssAdapter } from './adapters/epss.adapter.js';
import { GhsaAdapter } from './adapters/ghsa.adapter.js';
import { KevAdapter } from './adapters/kev.adapter.js';
import { KisaAdapter } from './adapters/kisa.adapter.js';
import { NvdAdapter } from './adapters/nvd.adapter.js';
import type { IngestContext, ScheduledSource, SourceAdapter } from './context.js';
import { VulnerabilityUpsertService } from './upsert.service.js';

export const INGEST_LEASE_MS = 20 * 60_000;
/** 실패 중인 소스는 원래 주기보다 짧게 다시 시도하되 이 간격보다 자주 하지는 않는다. */
const FAILURE_RETRY_MINUTES = 15;

export interface SourceStatusView {
  key: string;
  enabled: boolean;
  intervalMinutes: number;
  status: 'NEVER_RUN' | 'OK' | 'FAILING';
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  backfillDone: boolean;
  /** 마지막 성공이 주기의 2배보다 오래되었거나 아직 성공한 적이 없음 */
  lagging: boolean;
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);
  private readonly adapters: Map<ScheduledSource, SourceAdapter>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly upserts: VulnerabilityUpsertService,
    private readonly jobs: JobService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    ghsa: GhsaAdapter,
    nvd: NvdAdapter,
    kev: KevAdapter,
    epss: EpssAdapter,
    kisa: KisaAdapter,
  ) {
    this.adapters = new Map<ScheduledSource, SourceAdapter>([
      ['GHSA', ghsa],
      ['NVD', nvd],
      ['KEV', kev],
      ['EPSS', epss],
      ['KISA', kisa],
    ]);
  }

  /** 소스 상태 행을 만들고 설정된 주기를 반영한다. */
  async ensureSources(): Promise<void> {
    for (const key of ['GHSA', 'NVD', 'KEV', 'EPSS', 'KISA', 'OSV'] as const) {
      const intervalMinutes = this.env.intervals[key];
      await this.prisma.ingestionSource.upsert({
        where: { key },
        update: { intervalMinutes },
        // OSV 는 주기 수집 대상이 아니라 프로젝트 검사 때 조회된다. 초기 적재 개념이 없다.
        create: { key, intervalMinutes, backfillDone: key === 'OSV' },
      });
    }
  }

  /** 실행 시점이 된 정기 수집 소스를 작업 큐에 넣는다. */
  async enqueueDue(now = new Date()): Promise<string[]> {
    if (this.env.disableIngestion) return [];
    const sources = await this.prisma.ingestionSource.findMany({ where: { enabled: true, key: { in: ['GHSA', 'NVD', 'KEV', 'EPSS', 'KISA'] } } });
    const queued: string[] = [];
    // 공지를 먼저 받고 보강 데이터(KEV, EPSS)를 나중에 받는다.
    const order = ['GHSA', 'NVD', 'KEV', 'EPSS', 'KISA'];
    sources.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    for (const source of sources) {
      const waitMinutes = source.status === 'FAILING' ? Math.min(source.intervalMinutes, FAILURE_RETRY_MINUTES) : source.intervalMinutes;
      const due = !source.lastAttemptAt || now.getTime() - source.lastAttemptAt.getTime() >= waitMinutes * 60_000;
      if (!due) continue;
      const id = await this.jobs.enqueue(
        'ingest',
        { source: source.key },
        { dedupeKey: `ingest:${source.key}`, maxAttempts: 1, runAt: new Date(now.getTime() + order.indexOf(source.key) * 1000) },
      );
      if (id) queued.push(source.key);
    }
    return queued;
  }

  async run(key: ScheduledSource, jobId?: string): Promise<void> {
    const adapter = this.adapters.get(key);
    if (!adapter) throw new Error(`알 수 없는 수집 소스: ${key}`);
    const source = await this.prisma.ingestionSource.findUniqueOrThrow({ where: { key } });
    const run = await this.prisma.ingestionRun.create({ data: { source: key } });
    await this.prisma.ingestionSource.update({ where: { key }, data: { lastAttemptAt: new Date() } });

    const counts = { fetched: 0, upserted: 0, changed: 0 };
    let windowFrom: Date | null = null;
    let windowTo: Date | null = null;
    const context: IngestContext = {
      env: this.env,
      emitEvents: source.backfillDone,
      fetch: (url, options) => fetchWithRetry(url, options),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      getCheckpoint: async <T>(stream: string) => {
        const row = await this.prisma.ingestionCheckpoint.findUnique({ where: { source_stream: { source: key, stream } } });
        return (row?.cursor as T | undefined) ?? null;
      },
      setCheckpoint: async (stream, cursor) => {
        await this.prisma.ingestionCheckpoint.upsert({
          where: { source_stream: { source: key, stream } },
          update: { cursor },
          create: { source: key, stream, cursor },
        });
      },
      upsert: (advisory) => this.upserts.upsert(advisory, { emitEvents: source.backfillDone }),
      hasIdentifier: async (value) =>
        (await this.prisma.vulnerabilityIdentifier.findUnique({ where: { value: value.toUpperCase() }, select: { id: true } })) !== null,
      setWindow: (from, to) => {
        windowFrom = from;
        windowTo = to;
      },
      count: (kind, amount = 1) => {
        counts[kind] += amount;
      },
      heartbeat: async () => {
        if (jobId) await this.jobs.extendLease(jobId, INGEST_LEASE_MS);
        await this.prisma.ingestionRun.update({ where: { id: run.id }, data: counts });
      },
    };

    try {
      await adapter.run(context);
      await this.prisma.$transaction([
        this.prisma.ingestionRun.update({
          where: { id: run.id },
          data: { ...counts, status: 'SUCCEEDED', windowFrom, windowTo, finishedAt: new Date() },
        }),
        this.prisma.ingestionSource.update({
          where: { key },
          data: { status: 'OK', lastSuccessAt: new Date(), lastError: null, consecutiveFailures: 0, backfillDone: true },
        }),
      ]);
      this.logger.log(`${key} 수집 완료: 조회 ${counts.fetched}, 저장 ${counts.upserted}, 변경 ${counts.changed}`);
      // 초기 적재로 CVE 가 새로 들어왔으면 EPSS 를 바로 한 번 더 받아 점수를 채운다.
      if (!source.backfillDone && (key === 'GHSA' || key === 'NVD')) {
        await this.jobs.enqueue('ingest', { source: 'EPSS' }, { dedupeKey: 'ingest:EPSS', maxAttempts: 1 });
      }
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      // 실패는 실패로 남긴다. 체크포인트는 저장을 마친 범위까지만 전진해 있다.
      await this.prisma.$transaction([
        this.prisma.ingestionRun.update({
          where: { id: run.id },
          data: { ...counts, status: 'FAILED', windowFrom, windowTo, error: message, finishedAt: new Date() },
        }),
        this.prisma.ingestionSource.update({
          where: { key },
          data: { status: 'FAILING', lastError: message, consecutiveFailures: { increment: 1 } },
        }),
      ]);
      this.logger.warn(`${key} 수집 실패: ${message}`);
      throw error;
    }
  }

  /** OSV 는 검사 때 호출되므로 그 성공·실패를 여기서 기록한다. */
  async recordOsv(ok: boolean, error?: string): Promise<void> {
    await this.prisma.ingestionSource.update({
      where: { key: 'OSV' },
      data: ok
        ? { status: 'OK', lastAttemptAt: new Date(), lastSuccessAt: new Date(), lastError: null, consecutiveFailures: 0 }
        : { status: 'FAILING', lastAttemptAt: new Date(), lastError: (error ?? '').slice(0, 1000), consecutiveFailures: { increment: 1 } },
    });
  }

  async status(now = new Date()): Promise<SourceStatusView[]> {
    const rows = await this.prisma.ingestionSource.findMany({ orderBy: { key: 'asc' } });
    return rows.map((row) => ({
      key: row.key,
      enabled: row.enabled,
      intervalMinutes: row.intervalMinutes,
      status: row.status,
      lastAttemptAt: row.lastAttemptAt,
      lastSuccessAt: row.lastSuccessAt,
      lastError: row.lastError,
      consecutiveFailures: row.consecutiveFailures,
      backfillDone: row.backfillDone,
      lagging: row.lastSuccessAt === null || now.getTime() - row.lastSuccessAt.getTime() > row.intervalMinutes * 2 * 60_000,
    }));
  }
}
