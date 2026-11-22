import { loadEnv } from '../src/config/env.js';
import { PrismaService } from '../src/db/prisma.service.js';
import { GhsaAdapter, type GhsaAdvisory } from '../src/ingestion/adapters/ghsa.adapter.js';
import { KevAdapter } from '../src/ingestion/adapters/kev.adapter.js';
import { NvdAdapter } from '../src/ingestion/adapters/nvd.adapter.js';
import type { IngestContext } from '../src/ingestion/context.js';
import { IngestionService } from '../src/ingestion/ingestion.service.js';
import { VulnerabilityUpsertService } from '../src/ingestion/upsert.service.js';
import { ghsaFixture, nvdFixture } from './fixtures/advisories.js';
import { createTestContext, jsonResponse, type TestContext } from './harness.js';

describe('수집: 체크포인트, 장애 후 재개, 중복 방지', () => {
  let ctx: TestContext;
  let prisma: PrismaService;
  const checkpoints = new Map<string, object>();
  const requested: string[] = [];

  /** 어댑터에 넘길 실행 환경. 저장은 실제 서비스를 쓰고 네트워크만 주입한다. */
  const makeContext = (fetchImpl: (url: string) => Promise<Response>, emitEvents = true): IngestContext => ({
    env: loadEnv(),
    emitEvents,
    fetch: async (url) => {
      requested.push(url);
      return fetchImpl(url);
    },
    sleep: async () => undefined,
    getCheckpoint: async <T>(stream: string) => (checkpoints.get(stream) as T | undefined) ?? null,
    setCheckpoint: async (stream, cursor) => void checkpoints.set(stream, cursor),
    upsert: (advisory) => ctx.get(VulnerabilityUpsertService).upsert(advisory, { emitEvents }),
    hasIdentifier: async (value) => (await prisma.vulnerabilityIdentifier.findUnique({ where: { value } })) !== null,
    setWindow: () => undefined,
    count: () => undefined,
    heartbeat: async () => undefined,
  });

  const advisory = (n: number, minutesAgo: number): GhsaAdvisory =>
    ghsaFixture({
      ghsa_id: `GHSA-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}`,
      cve_id: `CVE-2099-200${n}`,
      identifiers: [],
      summary: `page item ${n}`,
      updated_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      vulnerabilities: [{ package: { ecosystem: 'npm', name: `fixture-page-${n}` }, vulnerable_version_range: '< 1.0.0', first_patched_version: '1.0.0' }],
    });

  beforeAll(async () => {
    ctx = await createTestContext();
    prisma = ctx.get(PrismaService);
    await ctx.get(IngestionService).ensureSources();
  });
  afterAll(() => ctx.close());

  it('페이지 중간에 실패하면 저장을 마친 범위까지만 체크포인트가 전진한다', async () => {
    const page1 = [advisory(2, 50), advisory(3, 40)];
    const page2 = [advisory(4, 30), advisory(5, 20)];
    const next = 'https://api.github.com/advisories?after=cursor2';
    let failSecondPage = true;
    const fetchImpl = async (url: string) => {
      if (url.includes('after=cursor2')) {
        if (failSecondPage) throw new Error('fixture: connection reset');
        return jsonResponse(page2);
      }
      return jsonResponse(page1, { headers: { link: `<${next}>; rel="next"` } });
    };

    const adapter = ctx.get(GhsaAdapter);
    await expect(adapter.run(makeContext(fetchImpl))).rejects.toThrow('connection reset');
    expect(await prisma.sourceRecord.count({ where: { source: 'GHSA' } })).toBe(2);
    // 체크포인트는 1페이지 마지막 항목의 수정 시각이다 (실패한 2페이지 범위로 넘어가지 않았다).
    expect(checkpoints.get('reviewed')).toEqual({ modifiedSince: page1[1].updated_at });

    // 재개: 체크포인트에서 겹치는 구간을 두고 다시 읽는다 → 유실도 중복도 없다.
    failSecondPage = false;
    requested.length = 0;
    await adapter.run(makeContext(fetchImpl));
    const window = decodeURIComponent(new URL(requested[0]).searchParams.get('modified') ?? '');
    expect(Date.parse(window.split('..')[0])).toBeLessThan(Date.parse(page1[1].updated_at as string));
    expect(await prisma.sourceRecord.count({ where: { source: 'GHSA' } })).toBe(4);
    expect(await prisma.vulnerability.count()).toBe(4);
    expect(Date.parse((checkpoints.get('reviewed') as { modifiedSince: string }).modifiedSince)).toBeGreaterThan(Date.parse(page2[1].updated_at as string));
  });

  it('같은 구간을 다시 수집해도 행이 늘지 않고 알림 이벤트도 다시 생기지 않는다', async () => {
    const before = { vulnerabilities: await prisma.vulnerability.count(), events: await prisma.notificationEvent.count(), jobs: await prisma.job.count() };
    checkpoints.delete('reviewed');
    await ctx.get(GhsaAdapter).run(makeContext(async () => jsonResponse([advisory(2, 50), advisory(3, 40), advisory(4, 30), advisory(5, 20)])));
    expect({ vulnerabilities: await prisma.vulnerability.count(), events: await prisma.notificationEvent.count(), jobs: await prisma.job.count() }).toEqual(before);
  });

  it('다른 호스트를 가리키는 다음 페이지 링크는 따라가지 않는다', async () => {
    requested.length = 0;
    checkpoints.delete('reviewed');
    await ctx.get(GhsaAdapter).run(makeContext(async () => jsonResponse([advisory(2, 50)], { headers: { link: '<https://evil.example/advisories?after=x>; rel="next"' } })));
    expect(requested.length).toBe(1);
    expect(requested.every((url) => url.startsWith('https://api.github.com/advisories?'))).toBe(true);
  });

  it('NVD 는 구간의 모든 페이지를 저장한 뒤에만 체크포인트를 옮기고, 범위 밖의 모르는 CVE 는 저장하지 않는다', async () => {
    checkpoints.clear();
    const old = '2015-01-01T00:00:00.000';
    const body = (items: object[], total: number, startIndex: number) => jsonResponse({ resultsPerPage: 2, startIndex, totalResults: total, vulnerabilities: items.map((cve) => ({ cve })) });
    let failAt: number | null = 2;
    const fetchImpl = async (url: string) => {
      const start = Number(new URL(url).searchParams.get('startIndex'));
      if (failAt !== null && start === failAt) throw new Error('fixture: NVD 503');
      if (start === 0) return body([nvdFixture({ id: 'CVE-2099-3001' }), nvdFixture({ id: 'CVE-2015-9001', published: old })], 3, 0);
      return body([nvdFixture({ id: 'CVE-2099-2002', published: old })], 3, 2);
    };
    const adapter = ctx.get(NvdAdapter);
    await expect(adapter.run(makeContext(fetchImpl))).rejects.toThrow('NVD 503');
    expect(checkpoints.has('cves')).toBe(false);

    failAt = null;
    await adapter.run(makeContext(fetchImpl));
    expect(checkpoints.has('cves')).toBe(true);
    const stored = (await prisma.sourceRecord.findMany({ where: { source: 'NVD' }, select: { sourceId: true }, orderBy: { sourceId: 'asc' } })).map((r) => r.sourceId);
    // 최근 공개분(3001)과, 오래되었지만 이미 알고 있는 CVE(2002 - GHSA 로 수집됨)만 저장한다. 모르는 과거 CVE(2015-9001)는 건너뛴다.
    expect(stored).toEqual(['CVE-2099-2002', 'CVE-2099-3001']);
    // 알고 있던 CVE 는 새 취약점이 아니라 기존 취약점에 출처로 붙는다.
    expect(await prisma.vulnerability.count()).toBe(5);
  });

  it('수집 실행기는 실패를 실패로 기록하고 지연 여부를 알려준다', async () => {
    const service = ctx.get(IngestionService);
    const adapter = ctx.get(KevAdapter);
    const original = adapter.run.bind(adapter);
    adapter.run = async () => {
      throw new Error('fixture: KEV feed unavailable');
    };
    await expect(service.run('KEV')).rejects.toThrow('KEV feed unavailable');
    let kev = (await service.status()).find((s) => s.key === 'KEV')!;
    expect(kev).toMatchObject({ status: 'FAILING', consecutiveFailures: 1, lagging: true, backfillDone: false });
    expect(kev.lastError).toContain('KEV feed unavailable');
    expect(await prisma.kevEntry.count()).toBe(0);

    // 복구되면 정상으로 돌아오고, 초기 적재분은 알림을 만들지 않는다.
    adapter.run = async (context) => {
      expect(context.emitEvents).toBe(false);
      return original({
        ...context,
        fetch: async () => jsonResponse({ catalogVersion: 'fixture', count: 1, vulnerabilities: [{ cveID: 'CVE-2099-3001', dateAdded: '2099-01-02', dueDate: '2099-01-23', knownRansomwareCampaignUse: 'Known' }] }),
      });
    };
    const eventsBefore = await prisma.notificationEvent.count();
    await service.run('KEV');
    kev = (await service.status()).find((s) => s.key === 'KEV')!;
    expect(kev).toMatchObject({ status: 'OK', consecutiveFailures: 0, lagging: false, backfillDone: true });
    expect(await prisma.notificationEvent.count()).toBe(eventsBefore);
    const flagged = await prisma.vulnerability.findFirstOrThrow({ where: { identifiers: { some: { value: 'CVE-2099-3001' } } } });
    expect(flagged.kevAddedAt?.toISOString().slice(0, 10)).toBe('2099-01-02');
    expect(flagged.kevRansomware).toBe('Known');
    adapter.run = original;
  });

  it('원본은 압축해 보존하고 정규화 결과와 함께 남긴다', async () => {
    const { gunzipSync } = await import('node:zlib');
    const record = await prisma.sourceRecord.findFirstOrThrow({ where: { source: 'GHSA', sourceId: 'GHSA-2222-2222-2222' } });
    const raw = JSON.parse(gunzipSync(Buffer.from(record.raw)).toString('utf8')) as GhsaAdvisory;
    expect(raw.ghsa_id).toBe('GHSA-2222-2222-2222');
    expect(record.title).toBe('page item 2');
  });
});
