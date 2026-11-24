import { PrismaService } from '../src/db/prisma.service.js';
import { normalizeGhsa } from '../src/ingestion/adapters/ghsa.adapter.js';
import { normalizeNvd } from '../src/ingestion/adapters/nvd.adapter.js';
import { normalizeOsv, OsvClient } from '../src/ingestion/adapters/osv.client.js';
import { VulnerabilityUpsertService } from '../src/ingestion/upsert.service.js';
import { DeliveryService } from '../src/notification/delivery.service.js';
import { ghsaFixture, lockfileFixture, nvdFixture, osvFixture } from './fixtures/advisories.js';
import { createTestContext, jsonResponse, type TestClient, type TestContext } from './harness.js';

describe('알림: Outbox 중계, 중복 억제, 재시도', () => {
  let ctx: TestContext;
  let user: TestClient;
  let other: TestClient;
  let deliveries: DeliveryService;
  let prisma: PrismaService;
  let projectId: string;
  let telegramId: string;
  let discordId: string;
  const telegram = () => ctx.bots.telegramSent;
  const discord = () => ctx.bots.discordSent;

  const flush = async (at?: Date) => {
    await ctx.drain();
    await deliveries.relayPending();
    // 발송 건이 만들어진 뒤의 시각을 기준으로 한다. 채널당 한 번에 한 건씩 보내므로 남은 건이 없을 때까지 돌린다.
    const now = at ?? new Date(Date.now() + 1000);
    for (let i = 0; i < 20 && (await deliveries.processDue(now)) > 0; i += 1);
  };
  const history = async (query = ''): Promise<Array<{ status: string; eventType: string | null; kind: string; channelName: string; attempts: number; lastError: string | null; title: string }>> =>
    (await user.get(`/deliveries?pageSize=100${query}`).expect(200)).body.items;
  const counts = async () => {
    const out: Record<string, number> = {};
    for (const item of await history()) {
      const key = `${item.channelName}:${item.eventType ?? item.kind}:${item.status}`;
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    deliveries = ctx.get(DeliveryService);
    prisma = ctx.get(PrismaService);
    user = await ctx.client('notify@example.com');
    other = await ctx.client('other@example.com');

    ctx.get(OsvClient).fetchImpl = async (url, options) => {
      if (url.endsWith('/v1/querybatch')) {
        const queries = JSON.parse(options?.body ?? '{}').queries as Array<{ package: { name: string }; version: string }>;
        return jsonResponse({ results: queries.map((q) => (q.package.name === 'fixture-old' ? { vulns: [{ id: 'GHSA-8888-8888-8888', modified: '2020-01-01T00:00:00Z' }] } : {})) });
      }
      // 오래전에 공개된 공지 - 프로젝트 검사에서만 발견된다.
      return jsonResponse(
        osvFixture({
          id: 'GHSA-8888-8888-8888',
          aliases: ['CVE-2099-0888'],
          summary: 'fixture-old: old issue',
          published: '2020-01-01T00:00:00Z',
          modified: '2020-01-01T00:00:00Z',
          affected: [{ package: { ecosystem: 'npm', name: 'fixture-old' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '9.0.0' }] }] }],
        }),
      );
    };

    const tech = Object.fromEntries(((await user.get('/technologies').expect(200)).body as Array<{ id: string; slug: string }>).map((t) => [t.slug, t.id]));
    await user.put('/me/interests', { technologyIds: [tech.javascript] }).expect(200);
    telegramId = await ctx.linkTelegram(user, 'tg', -1001234567890, { group: true });
    discordId = await ctx.linkDiscord(user, 'dc', '333333333333333333');
    await user.post('/rules', { name: 'tech', kind: 'TECH_INTEREST', eventTypes: ['TECH_NEW_VULN', 'KEV_ADDED'], schedule: { type: 'IMMEDIATE' }, channelIds: [discordId] }).expect(201);
    await user
      .post('/rules', { name: 'project', kind: 'PROJECT_IMPACT', eventTypes: ['PROJECT_NEW_MATCH', 'PRIORITY_RAISED', 'INITIAL_SCAN_SUMMARY'], schedule: { type: 'IMMEDIATE' }, channelIds: [telegramId] })
      .expect(201);

    // 다른 사용자: 관심 기술도 프로젝트도 없지만 규칙은 있다.
    const otherChannel = await ctx.linkTelegram(other, 'other-tg', 42);
    await other.post('/rules', { name: 'o-tech', kind: 'TECH_INTEREST', eventTypes: ['TECH_NEW_VULN'], schedule: { type: 'IMMEDIATE' }, channelIds: [otherChannel] }).expect(201);
    await other.post('/rules', { name: 'o-proj', kind: 'PROJECT_IMPACT', eventTypes: ['PROJECT_NEW_MATCH', 'INITIAL_SCAN_SUMMARY'], schedule: { type: 'IMMEDIATE' }, channelIds: [otherChannel] }).expect(201);
    // 연결할 때 보낸 확인 메시지는 지운다.
    ctx.bots.reset();
  });
  afterAll(() => ctx.close());

  it('연결 테스트는 실제로 한 건 보내고 이력에 남는다', async () => {
    const result = (await user.post(`/channels/${telegramId}/test`).expect(200)).body;
    expect(result).toMatchObject({ ok: true, channel: { status: 'ACTIVE', label: '텔레그램 · fixture group (그룹)' } });
    expect(telegram().length).toBe(1);
    expect(telegram()[0].body).toMatchObject({ chat_id: '-1001234567890', parse_mode: 'HTML' });
    expect((await history()).filter((d) => d.kind === 'TEST').length).toBe(1);
    ctx.bots.telegramSent.length = 0;
  });

  it('프로젝트를 처음 검사하면 과거 항목을 하나씩 보내지 않고 요약 한 건만 보낸다', async () => {
    projectId = (await user.post('/projects', { name: 'notify-app', environments: ['PRODUCTION'], exposure: 'PUBLIC' }).expect(201)).body.id;
    const lock = JSON.parse(lockfileFixture()) as { packages: Record<string, unknown> };
    lock.packages['node_modules/fixture-old'] = { version: '1.0.0', resolved: 'https://registry.npmjs.org/fixture-old/-/fixture-old-1.0.0.tgz' };
    await user.post(`/projects/${projectId}/snapshots`, { inputType: 'LOCKFILE', lockfileContent: JSON.stringify(lock) }).expect(201);
    await flush();

    expect((await user.get(`/findings?projectId=${projectId}`).expect(200)).body.total).toBe(1);
    expect(await counts()).toEqual({ 'tg:TEST:SENT': 1, 'tg:INITIAL_SCAN_SUMMARY:SENT': 1 });
    expect(telegram().length).toBe(1);
    expect(String(telegram()[0].body.text)).toContain('최초 분석 요약');
    // 검사 중 조회한 과거 공지는 "신규 취약점" 알림을 만들지 않는다.
    expect(discord().length).toBe(0);
    ctx.bots.telegramSent.length = 0;
  });

  it('같은 취약점이 여러 출처에서 들어와도 알림은 한 번만 간다', async () => {
    const upserts = ctx.get(VulnerabilityUpsertService);
    // 제목에 멘션·HTML 이 섞인 공지
    const hostile = { summary: 'fixture-lib <b>@everyone</b> prototype pollution <@123456789>' };
    await upserts.upsert(normalizeGhsa(ghsaFixture(hostile)), { emitEvents: true });
    await flush();
    await upserts.upsert(normalizeNvd(nvdFixture()), { emitEvents: true });
    await upserts.upsert(normalizeOsv(osvFixture()), { emitEvents: true });
    await flush();

    const now = await counts();
    expect(now['dc:TECH_NEW_VULN:SENT']).toBe(1);
    expect(now['tg:PROJECT_NEW_MATCH:SENT']).toBe(1);
    expect(discord().length).toBe(1);
    expect(telegram().filter((m) => String(m.body.text).includes('신규 영향 버전 일치')).length).toBe(1);
    expect(await prisma.vulnerability.count({ where: { identifiers: { some: { value: 'CVE-2099-0001' } } } })).toBe(1);
  });

  it('알림에는 필요한 내용이 담기고 외부 문구가 멘션·HTML 로 동작하지 않는다', async () => {
    const embed = (discord()[0].body.embeds as Array<{ title: string; fields: Array<{ name: string; value: string }> }>)[0];
    expect(discord()[0].body.allowed_mentions).toEqual({ parse: [] });
    expect(embed.title).not.toContain('@everyone');
    expect(embed.title).toContain('@​everyone');
    expect(embed.title).not.toContain('<@123456789>');
    expect(embed.fields.map((f) => f.name)).toEqual(expect.arrayContaining(['관련 기술', '영향 패키지', '심각도', '프로젝트 영향', '링크']));
    expect(embed.fields.find((f) => f.name === '프로젝트 영향')?.value).toContain('확정되지 않음');
    expect(discord()[0].url).toBe('https://discord.com/api/v10/channels/333333333333333333/messages');
    expect(discord()[0].headers.Authorization).toBe('Bot fixture-discord-bot-token');

    const text = String(telegram().find((m) => String(m.body.text).includes('신규 영향 버전 일치'))?.body.text);
    expect(text).toContain('&lt;b&gt;@everyone&lt;/b&gt;');
    expect(text).not.toContain('<b>@everyone</b>');
    expect(text).toContain('fixture-lib@2.1.0');
    expect(text).toContain('수정 버전 2.3.1');
    expect(text).toContain('CVE-2099-0001');
    expect(text).toMatch(/대응 우선순위<\/b>: (긴급|높음)/);
    expect(text).toContain('http://localhost:5273/findings/');
    ctx.bots.telegramSent.length = 0;
    ctx.bots.discordSent.length = 0;
  });

  it('재수집으로 수정 시각만 바뀌면 다시 알리지 않는다', async () => {
    await ctx.get(VulnerabilityUpsertService).upsert(normalizeGhsa(ghsaFixture({ summary: 'fixture-lib <b>@everyone</b> prototype pollution <@123456789>', updated_at: new Date().toISOString() })), { emitEvents: true });
    await flush();
    expect(telegram().length + discord().length).toBe(0);
  });

  it('다른 사용자에게는 내 프로젝트 알림이 가지 않고, 관심 기술이 없으면 기술 알림도 가지 않는다', async () => {
    expect((await other.get('/deliveries').expect(200)).body.total).toBe(0);
    expect(telegram().some((m) => m.body.chat_id === '42')).toBe(false);
  });

  it('KEV 등재처럼 의미 있는 변경은 새 알림이 되고 우선순위가 올라간다', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.kevEntry.create({ data: { cve: 'CVE-2099-0001', dateAdded: new Date(), ransomwareUse: 'Unknown' } });
      const id = (await tx.vulnerabilityIdentifier.findUniqueOrThrow({ where: { value: 'CVE-2099-0001' } })).vulnerabilityId;
      await ctx.get(VulnerabilityUpsertService).recompute(tx, id);
      await tx.notificationEvent.create({ data: { type: 'KEV_ADDED', vulnerabilityId: id, payload: {}, changeFingerprint: 'kev:fixture' } });
      await tx.job.create({ data: { type: 'reassess-vulnerability', payload: { vulnerabilityId: id, silent: false } } });
    });
    await flush();
    const now = await counts();
    expect(now['dc:KEV_ADDED:SENT']).toBe(1);
    expect((await user.get(`/findings?projectId=${projectId}`).expect(200)).body.items[0].priority).toBe('URGENT');
    ctx.bots.telegramSent.length = 0;
    ctx.bots.discordSent.length = 0;
  });

  it('429 는 Retry-After 만큼 기다렸다가 다시 보낸다', async () => {
    ctx.bots.discordReply = () => jsonResponse({ message: 'You are being rate limited.', retry_after: 90, global: false }, { status: 429 });
    await prisma.notificationEvent.create({
      data: { type: 'TECH_NEW_VULN', vulnerabilityId: (await prisma.vulnerabilityIdentifier.findUniqueOrThrow({ where: { value: 'CVE-2099-0001' } })).vulnerabilityId, payload: {}, changeFingerprint: 'fixture-429' },
    });
    await flush();
    const retrying = (await prisma.notificationDelivery.findFirstOrThrow({ where: { status: 'RETRYING' } }))!;
    expect(retrying.attempts).toBe(1);
    expect(retrying.lastStatusCode).toBe(429);
    const wait = retrying.nextAttemptAt.getTime() - Date.now();
    expect(wait).toBeGreaterThan(85_000);
    expect(wait).toBeLessThan(95_000);

    // 대기 시간이 지나기 전에는 다시 보내지 않는다.
    ctx.bots.discordSent.length = 0;
    await deliveries.processDue(new Date(Date.now() + 30_000));
    expect(discord().length).toBe(0);
    ctx.bots.discordReply = () => jsonResponse({ id: '2' });
    await deliveries.processDue(new Date(Date.now() + 91_000));
    expect(discord().length).toBe(1);
    expect((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: retrying.id } })).status).toBe('SENT');
    ctx.bots.discordSent.length = 0;
  });

  it('계속 실패하면 재시도 한도에서 멈추고 최종 실패로 남는다', async () => {
    ctx.bots.telegramReply = () => jsonResponse({ ok: false, error_code: 502, description: 'Bad Gateway' }, { status: 502 });
    await prisma.notificationEvent.create({ data: { type: 'PROJECT_NEW_MATCH', projectId, vulnerabilityId: (await prisma.vulnerabilityIdentifier.findUniqueOrThrow({ where: { value: 'CVE-2099-0001' } })).vulnerabilityId, payload: {}, changeFingerprint: 'fixture-fail' } });
    await deliveries.relayPending();
    ctx.bots.telegramSent.length = 0;
    for (let i = 1; i <= 5; i += 1) await deliveries.processDue(new Date(Date.now() + i * 3_600_000));
    expect(telegram().length).toBe(3); // NOTIFY_MAX_ATTEMPTS=3
    const failed = (await history('&statuses=FAILED')).find((d) => d.eventType === 'PROJECT_NEW_MATCH');
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 3 });
    expect(failed?.lastError).toContain('재시도 한도');
    // 일시적 오류였으므로 채널 자체는 오류 상태로 바꾸지 않는다.
    expect((await user.get('/channels').expect(200)).body.find((c: { id: string }) => c.id === telegramId).status).toBe('ACTIVE');
    ctx.bots.telegramReply = () => jsonResponse({ ok: true, result: { message_id: 2 } });
  });

  it('채널이 사라졌거나 봇이 쫓겨나면(404) 재시도하지 않고 채널을 오류 상태로 표시한다', async () => {
    ctx.bots.discordReply = () => jsonResponse({ message: 'Unknown Channel', code: 10003 }, { status: 404 });
    const vulnerabilityId = (await prisma.vulnerabilityIdentifier.findUniqueOrThrow({ where: { value: 'CVE-2099-0001' } })).vulnerabilityId;
    await prisma.notificationEvent.create({ data: { type: 'TECH_NEW_VULN', vulnerabilityId, payload: {}, changeFingerprint: 'fixture-404' } });
    ctx.bots.discordSent.length = 0;
    await flush();
    expect(discord().length).toBe(1);
    const channel = (await user.get('/channels').expect(200)).body.find((c: { id: string }) => c.id === discordId);
    expect(channel).toMatchObject({ status: 'ERROR', lastError: '채널을 찾을 수 없습니다. 삭제되었거나 봇이 서버에서 나갔습니다.' });
    // 오류 상태인 채널로는 더 보내지 않고, 보내지 못했다는 사실을 이력에 남긴다.
    await prisma.notificationEvent.create({ data: { type: 'TECH_NEW_VULN', vulnerabilityId, payload: {}, changeFingerprint: 'fixture-after-404' } });
    await flush(new Date(Date.now() + 3_600_000));
    expect(discord().length).toBe(1);
    expect((await history('&statuses=FAILED')).some((d) => d.lastError?.includes('연결이 끊긴'))).toBe(true);
    // 다시 테스트해 성공하면 복구된다.
    ctx.bots.discordReply = () => jsonResponse({ id: '3' });
    expect((await user.post(`/channels/${discordId}/test`).expect(200)).body.channel.status).toBe('ACTIVE');
    ctx.bots.discordSent.length = 0;
  });

  it('일시 중지한 채널로는 발송 건을 만들지 않는다', async () => {
    await user.post(`/channels/${discordId}/pause`).expect(200);
    const vulnerabilityId = (await prisma.vulnerabilityIdentifier.findUniqueOrThrow({ where: { value: 'CVE-2099-0001' } })).vulnerabilityId;
    const before = await prisma.notificationDelivery.count({ where: { channelId: discordId } });
    await prisma.notificationEvent.create({ data: { type: 'TECH_NEW_VULN', vulnerabilityId, payload: {}, changeFingerprint: 'fixture-paused' } });
    await flush();
    expect(await prisma.notificationDelivery.count({ where: { channelId: discordId } })).toBe(before);
    expect(discord().length).toBe(0);
    expect((await user.post(`/channels/${discordId}/resume`).expect(200)).body.status).toBe('ACTIVE');
  });

  it('방해 금지 시간에는 보류했다가 끝나면 보낸다', async () => {
    const zone = 'Asia/Seoul';
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    const [hour, minute] = clock.split(':').map(Number);
    const nowMinute = hour * 60 + minute;
    await user.patch('/me/settings', { timezone: zone, quietHoursEnabled: true, quietStartMinute: (nowMinute + 1439) % 1440, quietEndMinute: (nowMinute + 120) % 1440 }).expect(200);
    const vulnerabilityId = (await prisma.vulnerabilityIdentifier.findUniqueOrThrow({ where: { value: 'CVE-2099-0001' } })).vulnerabilityId;
    await prisma.notificationEvent.create({ data: { type: 'TECH_NEW_VULN', vulnerabilityId, payload: {}, changeFingerprint: 'fixture-quiet' } });
    ctx.bots.discordSent.length = 0;
    await flush();
    expect(discord().length).toBe(0);
    const held = await prisma.notificationDelivery.findFirstOrThrow({ where: { status: 'HELD' } });
    const waitMinutes = (held.nextAttemptAt.getTime() - Date.now()) / 60_000;
    expect(waitMinutes).toBeGreaterThan(118);
    expect(waitMinutes).toBeLessThan(121);
    await user.patch('/me/settings', { quietHoursEnabled: false }).expect(200);
    await deliveries.processDue(new Date(held.nextAttemptAt.getTime() + 1000));
    expect(discord().length).toBe(1);
    ctx.bots.discordSent.length = 0;
  });

  it('요약 규칙은 정한 시각에 모아서 한 번 보낸다', async () => {
    const rules = (await user.get('/rules').expect(200)).body as Array<{ id: string; name: string }>;
    const tech = rules.find((r) => r.name === 'tech')!;
    await user.put(`/rules/${tech.id}`, { name: 'tech', kind: 'TECH_INTEREST', eventTypes: ['TECH_NEW_VULN'], schedule: { type: 'DAILY', times: ['09:00', '18:00'] }, channelIds: [discordId] }).expect(200);
    const upserts = ctx.get(VulnerabilityUpsertService);
    for (const [index, id] of ['GHSA-6666-6666-6666', 'GHSA-7777-7777-7777'].entries()) {
      await upserts.upsert(
        normalizeGhsa(ghsaFixture({ ghsa_id: id, cve_id: `CVE-2099-070${index}`, identifiers: [], summary: `digest item ${index}`, vulnerabilities: [{ package: { ecosystem: 'npm', name: `fixture-digest-${index}` }, vulnerable_version_range: '< 1.0.0', first_patched_version: '1.0.0' }] })),
        { emitEvents: true },
      );
    }
    ctx.bots.discordSent.length = 0;
    await flush();
    expect(discord().length).toBe(0);
    expect((await history('&statuses=DIGEST_PENDING')).length).toBe(2);

    // 지금은 아직 예정 시각이 지나지 않았을 수 있으니, 하루 뒤 시점으로 확인한다 (그 사이 09:00·18:00 이 반드시 지난다).
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect(await deliveries.createDueDigests(tomorrow)).toBe(1);
    await flush();
    expect(discord().length).toBe(1);
    const embed = (discord()[0].body.embeds as Array<{ title: string; fields: Array<{ value: string }> }>)[0];
    expect(embed.title).toContain('알림 요약');
    expect(embed.fields[0].value).toContain('digest item 0');
    expect(embed.fields[0].value).toContain('digest item 1');
    // 같은 예정 시각으로는 다시 만들지 않는다.
    expect(await deliveries.createDueDigests(tomorrow)).toBe(0);
  });

  it('보안 브리핑은 새 항목이 없어도 정한 시각에 현황을 보낸다', async () => {
    const tech = ((await user.get('/rules').expect(200)).body as Array<{ id: string; name: string }>).find((r) => r.name === 'tech')!;
    const input = { name: 'tech', kind: 'TECH_INTEREST', eventTypes: ['TECH_NEW_VULN'], channelIds: [discordId] };
    await user.put(`/rules/${tech.id}`, { ...input, schedule: { type: 'IMMEDIATE' }, digestFormat: 'BRIEFING' }).expect(400);
    const saved = await user.put(`/rules/${tech.id}`, { ...input, schedule: { type: 'DAILY', times: ['09:00', '18:00'], weekendTimes: ['12:00'] }, digestFormat: 'BRIEFING' }).expect(200);
    expect(saved.body.scheduleText).toBe('평일 09:00, 18:00 · 주말 12:00');
    ctx.bots.discordSent.length = 0;
    expect(await deliveries.createDueDigests(new Date(Date.now() + 2 * 86_400_000))).toBe(1);
    await flush();
    const embed = (discord()[0].body.embeds as Array<{ title: string; description: string; fields: Array<{ name: string }> }>)[0];
    expect(embed.title).toMatch(/^\[.*보안 브리핑.*\] - 새 이슈 없음$/);
    expect(embed.description).toContain('패치 0건');
    expect(embed.fields.map((field) => field.name)).toContain('패치 확인 (지난 브리핑 이후 점검)');
    // 보낸 브리핑은 저장되어 화면에서 다시 볼 수 있다.
    const list = (await user.get('/briefings').expect(200)).body as { items: Array<{ id: number; headline: string; channels: Array<{ status: string }> }> };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ headline: '새 이슈 없음', channels: [{ status: 'SENT' }] });
    expect(JSON.stringify(discord()[0].body)).toContain(`/briefings?id=${list.items[0].id}`);
    await user.get(`/briefings/${list.items[0].id}`).expect(200);
    const overview = (await user.get('/briefings/overview').expect(200)).body;
    expect(overview).toMatchObject({ ruleCount: 1, ai: { enabled: false } });
    expect(overview.nextSendAt).not.toBeNull();
    await user.put(`/rules/${tech.id}`, { ...input, schedule: { type: 'DAILY', times: ['09:00', '18:00'] } }).expect(200);
    ctx.bots.discordSent.length = 0;
  });

  it('규칙 유형에 맞지 않는 이벤트는 받을 수 없다', async () => {
    await user.post('/rules', { name: 'bad', kind: 'TECH_INTEREST', eventTypes: ['PROJECT_NEW_MATCH'], schedule: { type: 'IMMEDIATE' }, channelIds: [discordId] }).expect(400);
    await user.post('/rules', { name: 'bad', kind: 'PROJECT_IMPACT', eventTypes: ['TECH_NEW_VULN'], schedule: { type: 'IMMEDIATE' }, channelIds: [discordId] }).expect(400);
  });

  it('받는 시간과 문구 틀이 잘못되면 저장하지 않는다', async () => {
    const base = { name: 'bad', kind: 'PROJECT_IMPACT', eventTypes: ['PROJECT_NEW_MATCH'], channelIds: [telegramId] };
    await user.post('/rules', { ...base, schedule: { type: 'DAILY', times: ['25:00'] } }).expect(400);
    await user.post('/rules', { ...base, schedule: { type: 'INTERVAL', hours: 5 } }).expect(400);
    await user.post('/rules', { ...base, schedule: { type: 'WEEKLY', days: [], time: '09:00' } }).expect(400);
    const unknown = await user.post('/rules', { ...base, schedule: { type: 'IMMEDIATE' }, template: '{제목} {담당자}' }).expect(400);
    expect(unknown.body.message).toContain('{담당자}');
  });

  it('문구 틀 정보와 미리보기를 제공한다', async () => {
    const info = (await user.get('/rules/template-info').expect(200)).body;
    expect(info.placeholders.map((p: { key: string }) => p.key)).toEqual(expect.arrayContaining(['제목', '패키지', '현재버전', '수정버전', '우선순위', '링크']));
    expect(info.defaults.PROJECT_IMPACT).toContain('{제목}');
    const preview = (await user.post('/rules/template-preview', { kind: 'PROJECT_IMPACT', template: '[{우선순위}] {패키지}@{현재버전} → {수정버전}' }).expect(200)).body;
    expect(preview.text).toBe('[긴급] lodash@4.17.20 → 4.18.0');
    await user.post('/rules/template-preview', { kind: 'PROJECT_IMPACT', template: '{없는값}' }).expect(400);
  });

  it('규칙의 문구 틀대로 보내고, 사용자 문구도 HTML·멘션으로 동작하지 않는다 (텔레그램)', async () => {
    const rules = (await user.get('/rules').expect(200)).body as Array<{ id: string; name: string; eventTypes: string[] }>;
    const project = rules.find((rule) => rule.name === 'project')!;
    await user
      .put(`/rules/${project.id}`, {
        name: 'project',
        kind: 'PROJECT_IMPACT',
        eventTypes: project.eventTypes,
        schedule: { type: 'IMMEDIATE' },
        template: '[{우선순위}] {제목}\n{패키지}@{현재버전} → {수정버전}\n<b>프로젝트</b> {프로젝트} {담당없음}',
        channelIds: [telegramId],
      })
      .expect(400);
    const saved = await user
      .put(`/rules/${project.id}`, {
        name: 'project',
        kind: 'PROJECT_IMPACT',
        eventTypes: project.eventTypes,
        schedule: { type: 'IMMEDIATE' },
        template: '[{우선순위}] {제목}\n{패키지}@{현재버전} → {수정버전}\n<b>프로젝트</b> {프로젝트}',
        channelIds: [telegramId],
      })
      .expect(200);
    expect(saved.body).toMatchObject({ scheduleText: '즉시', template: expect.stringContaining('{우선순위}') });

    const vulnerabilityId = (await prisma.vulnerabilityIdentifier.findUniqueOrThrow({ where: { value: 'CVE-2099-0001' } })).vulnerabilityId;
    await prisma.notificationEvent.create({ data: { type: 'PROJECT_NEW_MATCH', projectId, vulnerabilityId, payload: {}, changeFingerprint: 'fixture-template' } });
    ctx.bots.telegramSent.length = 0;
    await flush();
    expect(telegram().length).toBe(1);
    const text = String(telegram()[0].body.text);
    expect(text.startsWith('[긴급] fixture-lib &lt;b&gt;@everyone&lt;/b&gt;')).toBe(true);
    expect(text).toContain('fixture-lib@2.1.0 → 2.3.1');
    expect(text).toContain('&lt;b&gt;프로젝트&lt;/b&gt; notify-app');
    expect(text).not.toMatch(/<[a-z]/);
  });

  it('요약에서 즉시로 바꾸면 기다리던 알림을 바로 보내고, 디스코드에도 문구 틀을 쓴다', async () => {
    const rules = (await user.get('/rules').expect(200)).body as Array<{ id: string; name: string }>;
    const tech = rules.find((rule) => rule.name === 'tech')!;
    const vulnerabilityId = (await prisma.vulnerabilityIdentifier.findUniqueOrThrow({ where: { value: 'CVE-2099-0001' } })).vulnerabilityId;
    await prisma.notificationEvent.create({ data: { type: 'TECH_NEW_VULN', vulnerabilityId, payload: {}, changeFingerprint: 'fixture-switch' } });
    await flush();
    expect(await prisma.notificationDelivery.count({ where: { ruleId: tech.id, status: 'DIGEST_PENDING' } })).toBe(1);

    ctx.bots.discordSent.length = 0;
    await user
      .put(`/rules/${tech.id}`, {
        name: 'tech',
        kind: 'TECH_INTEREST',
        eventTypes: ['TECH_NEW_VULN'],
        schedule: { type: 'IMMEDIATE' },
        template: '{이벤트}: {제목} @everyone [가짜](https://evil.example)',
        channelIds: [discordId],
      })
      .expect(200);
    expect(await prisma.notificationDelivery.count({ where: { ruleId: tech.id, status: 'DIGEST_PENDING' } })).toBe(0);
    await flush();
    expect(discord().length).toBe(1);
    const embed = (discord()[0].body.embeds as Array<{ description: string }>)[0];
    expect(embed.description.startsWith('신규 취약점: fixture-lib')).toBe(true);
    expect(embed.description).not.toContain('@everyone');
    expect(embed.description).not.toContain('](');
    expect(discord()[0].body.allowed_mentions).toEqual({ parse: [] });
  });
});
