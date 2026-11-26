import request from 'supertest';
import { APP_ENV } from '../src/db/db.module.js';
import { PrismaService } from '../src/db/prisma.service.js';
import { OsvClient } from '../src/ingestion/adapters/osv.client.js';
import { lockfileFixture, osvFixture } from './fixtures/advisories.js';
import { createTestContext, jsonResponse, type TestClient, type TestContext } from './harness.js';

/** 감사용 재현 테스트 (인증·세션·접근 제어). 실패하는 테스트는 결함을 뜻한다. */
describe('audit: 인증과 접근 제어', () => {
  let ctx: TestContext;
  let alice: TestClient;
  let bob: TestClient;
  let prisma: PrismaService;
  const env = () => ctx.app.get(APP_ENV) as { allowedGithubUsers: string[] };

  beforeAll(async () => {
    ctx = await createTestContext();
    prisma = ctx.get(PrismaService);
    alice = await ctx.client('audit-alice', 7001);
    bob = await ctx.client('audit-bob', 7002);
    ctx.get(OsvClient).fetchImpl = async (url, options) => {
      if (url.endsWith('/v1/querybatch')) {
        const queries = JSON.parse(options?.body ?? '{}').queries as Array<{ package: { name: string }; version: string }>;
        return jsonResponse({
          results: queries.map((q) => (q.package.name === 'fixture-lib' && q.version === '2.1.0' ? { vulns: [{ id: 'GHSA-f2f2-g3g3-h4h4', modified: new Date().toISOString() }] } : {})),
        });
      }
      return jsonResponse(osvFixture());
    };
  });
  afterAll(() => ctx.close());

  it('허용 목록에서 빠진 사용자의 기존 세션은 더 이상 쓸 수 없어야 한다', async () => {
    const mallory = await ctx.client('audit-mallory', 7101);
    env().allowedGithubUsers = ['audit-alice'];
    try {
      // 새 로그인은 막힌다
      expect((await ctx.githubLogin('user:audit-mallory:7101')).headers.location).toBe('http://localhost:5273/?login_error=not_allowed');
      // 이미 받은 세션은 계속 통한다면 결함
      await mallory.get('/projects').expect(401);
    } finally {
      env().allowedGithubUsers = [];
    }
  });

  it('허용 목록은 바뀔 수 있는 아이디가 아니라 처음 확인한 GitHub ID 로 사람을 가려야 한다', async () => {
    await ctx.client('audit-carol', 7201);
    env().allowedGithubUsers = ['audit-carol'];
    try {
      // 다른 GitHub 계정(7202)이 같은 아이디를 쓰면 (아이디 변경 후 재사용, 아직 없는 아이디 선점) 들어올 수 없어야 한다
      const impostor = await ctx.githubLogin('user:audit-carol:7202');
      expect(impostor.headers.location).toBe('http://localhost:5273/?login_error=not_allowed');
    } finally {
      env().allowedGithubUsers = [];
    }
  });

  it('로그아웃하면 서버 세션이 끝나고, 만료된 세션은 거부된다', async () => {
    const dave = await ctx.client('audit-dave');
    await dave.post('/auth/logout').expect(200);
    await dave.get('/projects').expect(401);
    const erin = await ctx.client('audit-erin');
    await prisma.session.updateMany({ where: { userId: erin.userId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await erin.get('/projects').expect(401);
    await erin.post('/projects', { name: 'x' }).expect(401);
  });

  it('다른 사용자의 분석 결과 상세·검토·상태 변경, 조치·달력 화면에 접근할 수 없다', async () => {
    const projectId = (await alice.post('/projects', { name: 'audit-app' }).expect(201)).body.id as string;
    await alice.post(`/projects/${projectId}/snapshots`, { inputType: 'LOCKFILE', fileName: 'package-lock.json', lockfileContent: lockfileFixture() }).expect(201);
    await ctx.drain();
    const items = (await alice.get(`/findings?projectId=${projectId}`).expect(200)).body.items as Array<{ id: string }>;
    expect(items.length).toBeGreaterThan(0);
    const findingId = items[0].id;

    await bob.get(`/findings/${findingId}`).expect(404);
    await bob.post(`/findings/${findingId}/reviews`, { verdict: 'NOT_MET', rationale: 'hijack review' }).expect(404);
    await bob.patch(`/findings/${findingId}/status`, { status: 'DONE' }).expect(404);
    expect((await alice.get(`/findings/${findingId}`).expect(200)).body).toMatchObject({ remediationStatus: 'UNREVIEWED', reviews: [] });

    expect((await bob.get(`/remediation/packages?projectId=${projectId}`).expect(200)).body.items).toEqual([]);
    expect((await bob.get('/findings').expect(200)).body.total).toBe(0);
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
    expect((await bob.get(`/calendar?from=${from}&to=${today}&view=PROJECT`).expect(200)).body.events).toEqual([]);
    const vulnId = (await alice.get(`/findings/${findingId}`).expect(200)).body.vulnerabilityId as string;
    expect((await bob.get(`/vulnerabilities/${vulnId}`).expect(200)).body.relatedFindings).toEqual([]);
    expect((await bob.get('/dashboard/summary').expect(200)).body.cards.every((card: { count: number }) => card.count === 0)).toBe(true);
  });

  it('다른 사용자의 규칙·발송 이력·브리핑에 접근할 수 없다', async () => {
    const aliceChannel = await ctx.linkTelegram(alice, 'audit-a', 8101);
    const bobChannel = await ctx.linkTelegram(bob, 'audit-b', 8102);
    const ruleBody = { name: 'r', kind: 'PROJECT_IMPACT', eventTypes: ['PROJECT_NEW_MATCH'], schedule: { type: 'IMMEDIATE' } };
    const rule = (await alice.post('/rules', { ...ruleBody, channelIds: [aliceChannel] }).expect(201)).body;
    const deliveryId = (await alice.post(`/channels/${aliceChannel}/test`).expect(200)).body.deliveryId as string;

    await bob.put(`/rules/${rule.id}`, { ...ruleBody, channelIds: [bobChannel] }).expect(404);
    await bob.delete(`/rules/${rule.id}`).expect(404);
    await bob.get(`/deliveries/${deliveryId}`).expect(404);
    expect((await bob.get(`/deliveries?channelId=${aliceChannel}`).expect(200)).body.total).toBe(0);
    await bob.post(`/channels/${aliceChannel}/resume`).expect(404);

    const briefing = await prisma.briefing.create({ data: { userId: alice.userId, ruleName: 'r', slotAt: new Date(), fromAt: new Date(), status: 'READY' } });
    await bob.get(`/briefings/${briefing.id}`).expect(404);
    expect((await bob.get('/briefings').expect(200)).body.items).toEqual([]);
    expect((await alice.get(`/rules`).expect(200)).body.map((r: { id: string }) => r.id)).toEqual([rule.id]);
  });

  it('로그인하지 않은 요청은 내부 정보를 드러내지 않는다', async () => {
    const server = ctx.app.getHttpServer();
    for (const path of ['/status/ingestion', '/status/summary', '/notices', '/technologies', '/github/status', '/channels/providers', '/priority-rules', '/briefings', '/calendar?from=2026-01-01&to=2026-01-02&view=PROJECT', '/remediation/packages']) {
      await request(server).get(`/api/v1${path}`).expect(401);
    }
  });
});
