import { PrismaService } from '../src/db/prisma.service.js';
import { normalizeGhsa } from '../src/ingestion/adapters/ghsa.adapter.js';
import { OsvClient } from '../src/ingestion/adapters/osv.client.js';
import { VulnerabilityUpsertService } from '../src/ingestion/upsert.service.js';
import { BriefingService } from '../src/notification/briefing.service.js';
import { DeliveryService } from '../src/notification/delivery.service.js';
import { ghsaFixture, osvFixture } from './fixtures/advisories.js';
import { createTestContext, jsonResponse, type TestClient, type TestContext } from './harness.js';

/** Audit tests for notification delivery. Fixture data only (fake IDs/packages). */
const OLD = osvFixture({
  id: 'GHSA-8888-8888-8888',
  aliases: ['CVE-2099-0888'],
  summary: 'fixture-old: old issue',
  published: '2020-01-01T00:00:00Z',
  modified: '2020-01-01T00:00:00Z',
  severity: [],
  database_specific: {},
  affected: [{ package: { ecosystem: 'npm', name: 'fixture-old' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '9.0.0' }] }] }],
});
const MAL = {
  id: 'MAL-2026-0001',
  summary: 'Malicious code in fixture-evil (npm)',
  details: 'This package contains malicious code.',
  modified: '2026-11-20T00:00:00Z',
  published: '2026-11-20T00:00:00Z',
  affected: [{ package: { ecosystem: 'npm', name: 'fixture-evil' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }] }],
  database_specific: { 'malicious-packages-origins': [{ source: 'fixture' }] },
};

const lock = (deps: Record<string, string>) =>
  JSON.stringify({
    name: 'audit-app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'audit-app', version: '1.0.0', dependencies: Object.fromEntries(Object.entries(deps).map(([n, v]) => [n, `^${v}`])) },
      ...Object.fromEntries(Object.entries(deps).map(([n, v]) => [`node_modules/${n}`, { version: v, resolved: `https://registry.npmjs.org/${n}/-/${n}-${v}.tgz` }])),
    },
  });

describe('audit: notifications', () => {
  let ctx: TestContext;
  let prisma: PrismaService;
  let deliveries: DeliveryService;
  const tgTo = (chatId: string) => ctx.bots.telegramSent.filter((m) => m.body.chat_id === chatId).map((m) => String(m.body.text));

  const flush = async (at?: Date) => {
    await ctx.drain();
    await deliveries.relayPending();
    const now = at ?? new Date(Date.now() + 1000);
    for (let i = 0; i < 30 && (await deliveries.processDue(now)) > 0; i += 1);
  };
  const snapshot = async (user: TestClient, projectId: string, deps: Record<string, string>) => {
    await user.post(`/projects/${projectId}/snapshots`, { inputType: 'LOCKFILE', fileName: 'package-lock.json', lockfileContent: lock(deps) }).expect(201);
    await flush();
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    prisma = ctx.get(PrismaService);
    deliveries = ctx.get(DeliveryService);
    ctx.get(OsvClient).fetchImpl = async (url, options) => {
      if (url.endsWith('/v1/querybatch')) {
        const queries = JSON.parse(options?.body ?? '{}').queries as Array<{ package: { name: string } }>;
        return jsonResponse({
          results: queries.map((q) =>
            q.package.name === 'fixture-old'
              ? { vulns: [{ id: OLD.id, modified: OLD.modified }] }
              : q.package.name === 'fixture-evil'
                ? { vulns: [{ id: MAL.id, modified: MAL.modified }] }
                : {},
          ),
        });
      }
      return jsonResponse(url.includes('MAL-') ? MAL : OLD);
    };
  });
  afterAll(() => ctx.close());

  describe('project alerts: malicious field, quiet-hours bypass, re-introduced version', () => {
    let user: TestClient;
    let projectId: string;

    beforeAll(async () => {
      user = await ctx.client('audit-project@example.com');
      const plain = await ctx.linkTelegram(user, 'plain', 5001);
      const custom = await ctx.linkTelegram(user, 'custom', 5002);
      await user
        .post('/rules', { name: 'p-default', kind: 'PROJECT_IMPACT', eventTypes: ['PROJECT_NEW_MATCH', 'PRIORITY_RAISED', 'INITIAL_SCAN_SUMMARY'], schedule: { type: 'IMMEDIATE' }, channelIds: [plain] })
        .expect(201);
      await user
        .post('/rules', {
          name: 'p-custom',
          kind: 'PROJECT_IMPACT',
          eventTypes: ['PROJECT_NEW_MATCH'],
          schedule: { type: 'IMMEDIATE' },
          template: '[{우선순위}] {패키지}@{현재버전} → {수정버전}\n{링크}',
          channelIds: [custom],
        })
        .expect(201);
      projectId = (await user.post('/projects', { name: 'audit-app', environments: ['PRODUCTION'], exposure: 'PUBLIC' }).expect(201)).body.id;
      ctx.bots.reset();
      await snapshot(user, projectId, { 'fixture-clean': '1.0.0' });
      expect(tgTo('5001').filter((t) => t.includes('최초 분석 요약'))).toHaveLength(1);
      ctx.bots.reset();
    });

    it('non-initial scan adding a MAL- package: urgent alert bypasses quiet hours and carries the malicious field', async () => {
      const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
      const [h, m] = clock.split(':').map(Number);
      const nowMinute = h * 60 + m;
      await user
        .patch('/me/settings', { timezone: 'UTC', quietHoursEnabled: true, quietStartMinute: (nowMinute + 1430) % 1440, quietEndMinute: (nowMinute + 120) % 1440, urgentBypassQuiet: true })
        .expect(200);
      await snapshot(user, projectId, { 'fixture-clean': '1.0.0', 'fixture-old': '1.0.0', 'fixture-evil': '1.0.1' });
      const evil = tgTo('5001').find((t) => t.includes('fixture-evil@1.0.1'));
      expect(evil).toBeDefined();
      expect(evil).toContain('<b>악성 패키지</b>');
      // release anything held, then turn quiet hours off
      await user.patch('/me/settings', { quietHoursEnabled: false }).expect(200);
      const held = await prisma.notificationDelivery.findMany({ where: { userId: user.userId, status: 'HELD' } });
      for (const row of held) await flush(new Date(row.nextAttemptAt.getTime() + 1000));
    });

    it('custom template: a MAL- match still tells the user it is malware', async () => {
      const evil = tgTo('5002').find((t) => t.includes('fixture-evil@1.0.1'));
      expect(evil).toBeDefined();
      expect(evil).toMatch(/악성|[Mm]alicious/);
    });

    it('a vulnerable version that was removed and later re-introduced is alerted again', async () => {
      await snapshot(user, projectId, { 'fixture-clean': '1.0.0' });
      const finding = await prisma.finding.findFirstOrThrow({ where: { projectId, package: { name: 'fixture-old' } } });
      expect(finding.resolvedAt).not.toBeNull();
      ctx.bots.reset();
      await snapshot(user, projectId, { 'fixture-clean': '1.0.0', 'fixture-old': '1.0.0' });
      expect((await prisma.finding.findUniqueOrThrow({ where: { id: finding.id } })).resolvedAt).toBeNull();
      const event = await prisma.notificationEvent.findFirstOrThrow({ where: { projectId, type: 'PROJECT_NEW_MATCH' }, orderBy: { createdAt: 'desc' } });
      const rows = await prisma.notificationDelivery.findMany({ where: { eventId: event.id }, select: { status: true, lastError: true } });
      expect(rows.map((r) => r.status)).toContain('SENT');
    });
  });

  describe('priority that drops and rises again', () => {
    it('a second rise after a drop is alerted again', async () => {
      const user = await ctx.client('audit-reraise@example.com');
      const chat = await ctx.linkTelegram(user, 'reraise', 5201);
      await user.post('/rules', { name: 'raise', kind: 'PROJECT_IMPACT', eventTypes: ['PRIORITY_RAISED'], schedule: { type: 'IMMEDIATE' }, channelIds: [chat] }).expect(201);
      const projectId = (await user.post('/projects', { name: 'reraise-app', environments: ['PRODUCTION'], exposure: 'PUBLIC' }).expect(201)).body.id;
      await snapshot(user, projectId, { 'fixture-old': '1.0.0' });
      // 점수 없음(R4 높음) → 내부·개발 전용이면 A2 로 보통 → 다시 운영·공개로 바꾸면 높음
      const lower = () => user.patch(`/projects/${projectId}`, { environments: ['DEVELOPMENT'], exposure: 'INTERNAL' }).expect(200).then(() => flush());
      const raise = () => user.patch(`/projects/${projectId}`, { environments: ['PRODUCTION'], exposure: 'PUBLIC' }).expect(200).then(() => flush());
      await lower();
      await raise();
      await lower();
      ctx.bots.reset();
      await raise();
      const events = await prisma.notificationEvent.findMany({ where: { projectId, type: 'PRIORITY_RAISED' }, orderBy: { createdAt: 'asc' } });
      expect(events).toHaveLength(2);
      const statuses = await prisma.notificationDelivery.findMany({ where: { eventId: events[1].id }, select: { status: true } });
      expect(statuses.map((row) => row.status)).toEqual(['SENT']);
      expect(tgTo('5201')).toHaveLength(1);
    });
  });

  describe('initial scan with a malicious package', () => {
    it('the only alert the user gets (initial summary) mentions malware', async () => {
      const user = await ctx.client('audit-initial-mal@example.com');
      const chat = await ctx.linkTelegram(user, 'init', 5101);
      await user.post('/rules', { name: 'init', kind: 'PROJECT_IMPACT', eventTypes: ['PROJECT_NEW_MATCH', 'PRIORITY_RAISED', 'INITIAL_SCAN_SUMMARY'], schedule: { type: 'IMMEDIATE' }, channelIds: [chat] }).expect(201);
      const projectId = (await user.post('/projects', { name: 'init-app', environments: ['PRODUCTION'], exposure: 'PUBLIC' }).expect(201)).body.id;
      ctx.bots.reset();
      await snapshot(user, projectId, { 'fixture-clean': '1.0.0', 'fixture-evil': '1.0.1' });
      const texts = tgTo('5101');
      expect(texts).toHaveLength(1);
      expect(texts[0]).toMatch(/악성|[Mm]alicious/);
    });
  });

  describe('two rules of one user on the same channel (digest + immediate)', () => {
    it('the immediate rule still sends immediately even if a digest rule was created first', async () => {
      const user = await ctx.client('audit-rules@example.com');
      const tech = Object.fromEntries(((await user.get('/technologies').expect(200)).body as Array<{ id: string; slug: string }>).map((t) => [t.slug, t.id]));
      await user.put('/me/interests', { technologyIds: [tech.javascript] }).expect(200);
      const channel = await ctx.linkTelegram(user, 'one', 6001);
      const digestRule = (
        await user.post('/rules', { name: 'weekly', kind: 'TECH_INTEREST', eventTypes: ['TECH_NEW_VULN'], schedule: { type: 'WEEKLY', days: [1], time: '09:00' }, channelIds: [channel] }).expect(201)
      ).body.id as string;
      await user.post('/rules', { name: 'now', kind: 'TECH_INTEREST', eventTypes: ['TECH_NEW_VULN'], schedule: { type: 'IMMEDIATE' }, channelIds: [channel] }).expect(201);
      ctx.bots.reset();
      await ctx.get(VulnerabilityUpsertService).upsert(normalizeGhsa(ghsaFixture()), { emitEvents: true });
      await flush();
      const statuses = (await prisma.notificationDelivery.findMany({ where: { userId: user.userId, kind: 'EVENT' }, include: { rule: { select: { name: true } } } })).map(
        (d) => `${d.rule?.name}:${d.status}`,
      );
      // deleting the digest rule must not lose the alert either
      await user.delete(`/rules/${digestRule}`).expect(204);
      const after = (await prisma.notificationDelivery.findMany({ where: { userId: user.userId, kind: 'EVENT' } })).map((d) => d.status);
      expect({ statuses, after, sent: tgTo('6001').length }).toEqual({ statuses: expect.arrayContaining(['now:SENT']), after: expect.arrayContaining(['SENT']), sent: 1 });
    });
  });

  describe('security briefing', () => {
    it('AI output is escaped in Telegram and Discord, and an AI failure falls back to the template', async () => {
      const user = await ctx.client('audit-ai@example.com');
      await user.patch('/me/settings', { timezone: 'UTC' }).expect(200);
      const tg = await ctx.linkTelegram(user, 'ai-tg', 9001);
      const dc = await ctx.linkDiscord(user, 'ai-dc', '333333333333333333');
      const rule = (
        await user
          .post('/rules', { name: 'brief', kind: 'TECH_INTEREST', eventTypes: ['TECH_NEW_VULN'], schedule: { type: 'DAILY', times: ['09:00'] }, digestFormat: 'BRIEFING', channelIds: [tg, dc] })
          .expect(201)
      ).body.id as string;
      const service = ctx.get(BriefingService) as unknown as { ai: unknown };
      const hostile = '<b>@everyone</b> <a href="https://evil.example">x</a> [click](https://evil.example) <@&123456>';
      service.ai = { model: 'fake-model', refine: async () => ({ headline: hostile, summary: hostile, items: new Map() }) };
      ctx.bots.reset();
      try {
        expect(await deliveries.createDueDigests(new Date(Date.now() + 2 * 86_400_000))).toBeGreaterThanOrEqual(1);
        await flush();
        const text = tgTo('9001')[0];
        expect(text).toBeDefined();
        expect(text).not.toContain('<b>@everyone');
        expect(text).not.toContain('<a href="https://evil');
        const embed = JSON.stringify(ctx.bots.discordSent.at(-1)?.body);
        expect(embed).not.toContain('](https://evil');
        expect(embed).not.toMatch(/@everyone/);
        expect(ctx.bots.discordSent.at(-1)?.body.allowed_mentions).toEqual({ parse: [] });

        service.ai = { model: 'fake-model', refine: async () => Promise.reject(new TypeError('boom')) };
        ctx.bots.reset();
        await deliveries.createDueDigests(new Date(Date.now() + 4 * 86_400_000));
        await flush();
        const latest = await prisma.briefing.findFirstOrThrow({ where: { userId: user.userId }, orderBy: { id: 'desc' } });
        expect(latest).toMatchObject({ status: 'READY', aiModel: null, aiError: 'AI 요약 실패' });
        expect(tgTo('9001')).toHaveLength(1);
      } finally {
        service.ai = null;
        await user
          .put(`/rules/${rule}`, { name: 'brief', kind: 'TECH_INTEREST', eventTypes: ['TECH_NEW_VULN'], schedule: { type: 'DAILY', times: ['09:00'] }, digestFormat: 'BRIEFING', channelIds: [tg, dc], enabled: false })
          .expect(200);
      }
    });
  });
});
