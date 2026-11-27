import { PrismaService } from '../src/db/prisma.service.js';
import { normalizeNvd } from '../src/ingestion/adapters/nvd.adapter.js';
import { VulnerabilityUpsertService } from '../src/ingestion/upsert.service.js';
import { DeliveryService } from '../src/notification/delivery.service.js';
import { nvdFixture } from './fixtures/advisories.js';
import { createTestContext, type TestClient, type TestContext } from './harness.js';

describe('알림: 전체 신규 취약점 브리핑', () => {
  let ctx: TestContext;
  let user: TestClient;
  let deliveries: DeliveryService;
  let prisma: PrismaService;
  let upserts: VulnerabilityUpsertService;
  let channelId: string;
  const DAY = 86_400_000;
  const start = Date.now();

  const briefingAt = async (at: Date) => {
    expect(await deliveries.createDueDigests(at)).toBe(1);
    await ctx.drain();
    for (let i = 0; i < 20 && (await deliveries.processDue(new Date(at.getTime() + 1000))) > 0; i += 1);
    const list = (await user.get('/briefings').expect(200)).body as { items: Array<{ headline: string; totalItems: number; items: Array<{ text: string }> }> };
    return list.items[0];
  };
  const iso = (ms: number) => new Date(ms).toISOString().replace('Z', '');
  const metric = (score: number) => ({ cvssMetricV31: [{ source: 'nvd@nist.gov', type: 'Primary', cvssData: { version: '3.1', vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', baseScore: score } }] });
  /** 기술 카탈로그와 이어지지 않는 NVD 공지 (CPE 없음) */
  const nvd = (id: string, text: string, options: { score?: number | null; published?: number; status?: string; modified?: number } = {}) =>
    upserts.upsert(
      normalizeNvd(
        nvdFixture({
          id,
          vulnStatus: options.status ?? 'Received',
          published: iso(options.published ?? Date.now() - 3_600_000),
          lastModified: iso(options.modified ?? Date.now() - 60_000),
          descriptions: [{ lang: 'en', value: text }],
          metrics: options.score === null ? {} : metric(options.score ?? 9.8),
          configurations: [],
        }),
      ),
      { emitEvents: true },
    );

  beforeAll(async () => {
    ctx = await createTestContext();
    deliveries = ctx.get(DeliveryService);
    prisma = ctx.get(PrismaService);
    upserts = ctx.get(VulnerabilityUpsertService);
    user = await ctx.client('all-new@example.com');
    channelId = (await user.post('/channels/chakchak', { name: '보안', channel: 'web-보안' }).expect(200)).body.id;
    ctx.bots.reset();
  });
  afterAll(() => ctx.close());

  const base = () => ({ name: '전체', kind: 'ALL_NEW', eventTypes: ['TECH_NEW_VULN', 'KEV_ADDED'], minSeverity: 'CRITICAL', schedule: { type: 'DAILY', times: ['09:00', '14:00'] }, digestFormat: 'BRIEFING', channelIds: [channelId] });

  it('받는 시각을 정한 보안 브리핑으로만, 심각도 기준을 골라야 만들 수 있다', async () => {
    await user.post('/rules', { ...base(), schedule: { type: 'IMMEDIATE' }, digestFormat: undefined }).expect(400);
    await user.post('/rules', { ...base(), digestFormat: 'LIST' }).expect(400);
    await user.post('/rules', { ...base(), minSeverity: null }).expect(400);
    await user.post('/rules', { ...base(), eventTypes: ['PROJECT_NEW_MATCH'] }).expect(400);
    expect((await user.post('/rules', base()).expect(201)).body).toMatchObject({ kind: 'ALL_NEW', template: null, warnings: [] });
  });

  it('기술과 상관없이 새 공지를 담고, 넣은 공지는 다시 넣지 않으며, 점수가 늦게 나온 공지는 다음에 넣는다', async () => {
    await nvd('CVE-2099-1001', 'TOTOLINK N350RT authentication bypass.', { score: 9.8 });
    await nvd('CVE-2099-1002', 'Budibase prototype pollution.', { score: 10 });
    await nvd('CVE-2099-1003', 'High only issue.', { score: 7.5 });
    await nvd('CVE-2099-1004', 'Not yet scored issue.', { score: null });
    await nvd('CVE-2099-1005', 'Old issue collected late.', { published: Date.now() - 400 * DAY });
    await nvd('CVE-2099-1006', 'Rejected issue.', { status: 'Rejected' });
    await prisma.kevEntry.create({ data: { cve: 'CVE-2099-1007', dateAdded: new Date() } });
    await nvd('CVE-2099-1007', 'Exploited issue.', { score: 5.3, published: Date.now() - 400 * DAY });
    expect(await prisma.vulnerabilityTechnology.count()).toBe(0);

    const first = await briefingAt(new Date(start + DAY));
    expect(first.totalItems).toBe(3);
    expect(first.items.map((item) => item.text)).toEqual([
      'CVE-2099-1007 Exploited issue., 실제 악용(KEV), 영향 자산 없음',
      'CVE-2099-1002 Budibase prototype pollution., 영향 자산 없음',
      'CVE-2099-1001 TOTOLINK N350RT authentication bypass., 영향 자산 없음',
    ]);
    expect(first.headline).toContain('우리 자산 영향은 없습니다');
    const text = String(ctx.bots.chakchakSent.at(-1)?.body.text);
    expect(text).toContain('TOTOLINK N350RT');
    expect(text).not.toContain('High only issue');

    // 점수가 늦게 매겨지면 다음 브리핑에 들어가고, 이미 넣은 공지는 다시 넣지 않는다.
    await nvd('CVE-2099-1004', 'Not yet scored issue.', { score: 9.1 });
    const second = await briefingAt(new Date(start + 2 * DAY));
    expect(second.items.map((item) => item.text)).toEqual(['CVE-2099-1004 Not yet scored issue., 영향 자산 없음']);
  });
});
