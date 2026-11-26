import request from 'supertest';
import { pkceChallenge } from '../src/common/crypto.js';
import { PrismaService } from '../src/db/prisma.service.js';
import { ChannelService } from '../src/notification/channel.service.js';
import { createTestContext, type TestClient, type TestContext } from './harness.js';
import { lockfileFixture } from './fixtures/advisories.js';

describe('인증과 접근 제어', () => {
  let ctx: TestContext;
  let alice: TestClient;
  let bob: TestClient;
  let projectId: string;
  let channelId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    alice = await ctx.client('alice@example.com');
    bob = await ctx.client('bob@example.com');
    projectId = (await alice.post('/projects', { name: 'alice-app' }).expect(201)).body.id;
    channelId = await ctx.linkDiscord(alice, 'alice-discord', '333333333333333333');
  });
  afterAll(() => ctx.close());

  it('로그인하지 않으면 보호된 API 에 접근할 수 없다', async () => {
    const server = ctx.app.getHttpServer();
    for (const path of ['/projects', '/vulnerabilities', '/findings', '/channels', '/rules', '/deliveries', '/dashboard/summary', '/me/interests']) {
      await request(server).get(`/api/v1${path}`).expect(401);
    }
  });

  it('CSRF 토큰이 없거나 출처가 다르면 상태 변경 요청을 거부한다', async () => {
    const server = ctx.app.getHttpServer();
    await request(server).post('/api/v1/projects').set('Cookie', alice.cookie).send({ name: 'no-csrf' }).expect(403);
    await request(server).post('/api/v1/projects').set('Cookie', alice.cookie).set('X-CSRF-Token', 'wrong').send({ name: 'bad-csrf' }).expect(403);
    await request(server)
      .post('/api/v1/projects')
      .set('Cookie', alice.cookie)
      .set('X-CSRF-Token', alice.csrf)
      .set('Origin', 'https://evil.example')
      .send({ name: 'cross-origin' })
      .expect(403);
  });

  it('이메일·비밀번호 가입과 로그인은 없다', async () => {
    const server = ctx.app.getHttpServer();
    await request(server).post('/api/v1/auth/register').set('Origin', 'http://localhost:5273').send({ email: 'x@example.com', password: 'fixture-password-123' }).expect(404);
    await request(server).post('/api/v1/auth/login').set('Origin', 'http://localhost:5273').send({ email: 'x@example.com', password: 'fixture-password-123' }).expect(404);
    expect((await request(server).get('/api/v1/auth/status').expect(200)).body).toEqual({ githubEnabled: true });
  });

  it('다른 사용자의 프로젝트·구성·검사·분석 결과에 접근할 수 없다', async () => {
    const created = await alice.post(`/projects/${projectId}/snapshots`, { inputType: 'LOCKFILE', fileName: 'package-lock.json', lockfileContent: lockfileFixture() }).expect(201);
    const snapshotId = created.body.snapshot.id as string;
    const scanId = created.body.scan.id as string;

    await bob.get(`/projects/${projectId}`).expect(404);
    await bob.patch(`/projects/${projectId}`, { name: 'hijack' }).expect(404);
    await bob.delete(`/projects/${projectId}`).expect(404);
    await bob.get(`/projects/${projectId}/snapshots`).expect(404);
    await bob.post(`/projects/${projectId}/snapshots`, { inputType: 'MANUAL', packages: [{ name: 'x', version: '1.0.0' }] }).expect(404);
    await bob.post(`/projects/${projectId}/scans`).expect(404);
    await bob.get(`/projects/${projectId}/scans`).expect(404);
    await bob.get(`/snapshots/${snapshotId}/packages`).expect(404);
    await bob.get(`/scans/${scanId}`).expect(404);
    await bob.get(`/findings?projectId=${projectId}`).expect(404);
    await bob.get(`/vulnerabilities?projectId=${projectId}`).expect(404);
    expect((await bob.get('/projects').expect(200)).body).toEqual([]);
    expect((await alice.get(`/projects/${projectId}`).expect(200)).body.name).toBe('alice-app');
  });

  it('다른 사용자의 알림 채널·규칙에 접근할 수 없다', async () => {
    await bob.patch(`/channels/${channelId}`, { name: 'x' }).expect(404);
    await bob.post(`/channels/${channelId}/test`).expect(404);
    await bob.post(`/channels/${channelId}/pause`).expect(404);
    await bob.delete(`/channels/${channelId}`).expect(404);
    // 남의 채널이나 프로젝트를 자기 규칙에 끼워 넣을 수 없다.
    const rule = { name: 'r', kind: 'PROJECT_IMPACT', eventTypes: ['PROJECT_NEW_MATCH'], schedule: { type: 'IMMEDIATE' } };
    await bob.post('/rules', { ...rule, channelIds: [channelId] }).expect(400);
    const bobChannel = await ctx.linkTelegram(bob, 'bob', 5005);
    await bob.post('/rules', { ...rule, channelIds: [bobChannel], projectIds: [projectId] }).expect(400);
    expect((await bob.get('/channels').expect(200)).body.map((c: { id: string }) => c.id)).toEqual([bobChannel]);
  });

  it('봇 키는 DB·응답 어디에도 남지 않고, 채널에는 보낼 곳 번호만 저장한다', async () => {
    const prisma = ctx.get(PrismaService);
    const row = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: channelId } });
    expect(row.target).toEqual({ guildId: '222222222222222222', guildName: 'server-222', channelId: '333333333333333333', channelName: 'alerts' });
    const secrets = /fixture-discord-bot-token|fixture-discord-client-secret|AAfixturefixture|fixture-user-token|c0ffeec0ffee/;
    const dump = JSON.stringify([await prisma.notificationChannel.findMany(), await prisma.channelLinkRequest.findMany(), await prisma.appState.findMany()]);
    expect(dump).not.toMatch(secrets);
    for (const response of [await alice.get('/channels'), await alice.get('/channels/providers'), await alice.post(`/channels/${channelId}/test`), await alice.get('/deliveries'), await alice.get('/rules')]) {
      expect(response.status).toBeLessThan(300);
      expect(JSON.stringify(response.body)).not.toMatch(secrets);
    }
    expect((await alice.get('/channels/providers').expect(200)).body).toEqual({ telegram: true, telegramBotUsername: 'pasukkun_fixture_bot', discord: true, chakchak: true });
  });

  describe('채널 연결 흐름', () => {
    const server = () => ctx.app.getHttpServer();

    it('텔레그램 연결 코드는 한 번만 쓸 수 있고, 만료되면 쓸 수 없다', async () => {
      const link = (await alice.post('/channels/telegram/link', { name: 'tg' }).expect(201)).body;
      expect(link.url).toMatch(/^https:\/\/t\.me\/pasukkun_fixture_bot\?start=[A-Za-z0-9_-]{20,64}$/);
      const code = new URL(link.url).searchParams.get('start');
      const update = (id: number, chatId: number) => ({ update_id: id, message: { message_id: 1, text: `/start ${code}`, chat: { id: chatId, type: 'private' as const, first_name: 'a' } } });
      const channels = ctx.get(ChannelService);
      await channels.handleTelegramUpdate(update(1, 7001));
      expect((await alice.get(`/channels/links/${link.requestId}`).expect(200)).body.status).toBe('COMPLETED');
      // 같은 코드를 다른 대화방에서 다시 쓰면 연결되지 않는다.
      ctx.bots.telegramSent.length = 0;
      await channels.handleTelegramUpdate(update(2, 7002));
      expect(String(ctx.bots.telegramSent[0].body.text)).toContain('만료되었거나 이미 사용');
      const chats = (await ctx.get(PrismaService).notificationChannel.findMany({ where: { userId: alice.userId, type: 'TELEGRAM' } })).map((row) => (row.target as { chatId: string }).chatId);
      expect(chats).toEqual(['7001']);

      const old = (await alice.post('/channels/telegram/link', { name: 'late' }).expect(201)).body;
      await ctx.get(PrismaService).channelLinkRequest.update({ where: { id: old.requestId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await channels.handleTelegramUpdate({ update_id: 3, message: { message_id: 1, text: `/start ${new URL(old.url).searchParams.get('start')}`, chat: { id: 7003, type: 'private', first_name: 'a' } } });
      expect((await alice.get(`/channels/links/${old.requestId}`).expect(200)).body.status).toBe('EXPIRED');
    });

    it('봇이 차단되면 채널을 연결 끊김으로 표시하고, 다시 허용하면 되살린다', async () => {
      const id = await ctx.linkTelegram(alice, 'block-me', 7100);
      const channels = ctx.get(ChannelService);
      await channels.handleTelegramUpdate({ update_id: 10, my_chat_member: { chat: { id: 7100, type: 'private' }, new_chat_member: { status: 'kicked' } } });
      expect((await alice.get('/channels').expect(200)).body.find((c: { id: string }) => c.id === id)).toMatchObject({ status: 'ERROR' });
      await channels.handleTelegramUpdate({ update_id: 11, my_chat_member: { chat: { id: 7100, type: 'private' }, new_chat_member: { status: 'member' } } });
      expect((await alice.get('/channels').expect(200)).body.find((c: { id: string }) => c.id === id)).toMatchObject({ status: 'ACTIVE' });
    });

    it('다른 사람의 연결 요청은 보거나 끝낼 수 없다', async () => {
      const link = (await alice.post('/channels/discord/link', { name: 'dc2' }).expect(201)).body;
      await bob.get(`/channels/links/${link.requestId}`).expect(404);
      await bob.get(`/channels/links/${link.requestId}/discord-channels`).expect(404);
      await bob.post(`/channels/links/${link.requestId}/discord-complete`, { channelId: '333333333333333333' }).expect(404);
      // 앨리스가 시작한 디스코드 연결을 밥의 브라우저(세션)로 끝낼 수 없다.
      const state = new URL(link.url).searchParams.get('state') ?? '';
      const hijack = await request(server()).get(`/api/v1/channels/discord/callback?code=guild:222222222222222222&state=${state}`).set('Cookie', bob.cookie);
      expect(hijack.headers.location).toBe('http://localhost:5273/notifications?discord_error=session');
      const anonymous = await request(server()).get(`/api/v1/channels/discord/callback?code=guild:222222222222222222&state=${state}`);
      expect(anonymous.headers.location).toBe('http://localhost:5273/notifications?discord_error=session');
      const forged = await request(server()).get('/api/v1/channels/discord/callback?code=guild:222222222222222222&state=forged').set('Cookie', alice.cookie);
      expect(forged.headers.location).toBe('http://localhost:5273/notifications?discord_error=expired');
    });

    it('디스코드: 봇을 넣은 서버의 텍스트 채널로만 연결할 수 있다', async () => {
      ctx.bots.discordGuilds.set('444444444444444444', [{ id: '555555555555555555', name: 'other-server-channel', type: 0 }]);
      const link = (await alice.post('/channels/discord/link', { name: 'dc3' }).expect(201)).body;
      const authorize = new URL(link.url);
      expect(`${authorize.origin}${authorize.pathname}`).toBe('https://discord.com/oauth2/authorize');
      expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
        client_id: '111111111111111111',
        scope: 'bot',
        permissions: '19456',
        response_type: 'code',
        redirect_uri: 'http://localhost:5273/api/v1/channels/discord/callback',
      });
      const state = authorize.searchParams.get('state') ?? '';
      // 돌아온 주소의 guild_id 는 믿지 않고, 코드 교환으로 확인한 서버(222…)를 쓴다.
      const callback = await request(server()).get(`/api/v1/channels/discord/callback?code=guild:222222222222222222&state=${state}&guild_id=444444444444444444`).set('Cookie', alice.cookie);
      const requestId = new URL(callback.headers.location as string).searchParams.get('discord_link');
      expect((await alice.get(`/channels/links/${requestId}`).expect(200)).body).toMatchObject({ status: 'GUILD_SELECTED', guildName: 'server-222' });
      const options = (await alice.get(`/channels/links/${requestId}/discord-channels`).expect(200)).body;
      expect(options).toEqual([{ id: '333333333333333333', name: 'alerts' }]);
      // 다른 서버의 채널, 음성 채널은 거부한다.
      await alice.post(`/channels/links/${requestId}/discord-complete`, { channelId: '555555555555555555' }).expect(400);
      await alice.post(`/channels/links/${requestId}/discord-complete`, { channelId: '333333333333333334' }).expect(400);
      // 권한이 없으면 연결하지 않는다.
      ctx.bots.discordReply = () => new Response(JSON.stringify({ message: 'Missing Permissions', code: 50013 }), { status: 403 });
      const denied = await alice.post(`/channels/links/${requestId}/discord-complete`, { channelId: '333333333333333333' }).expect(400);
      expect(denied.body.message).toContain('권한이 없습니다');
      ctx.bots.reset();
    });

    it('디스코드에서 취소하면 연결하지 않는다', async () => {
      const link = (await alice.post('/channels/discord/link', { name: 'dc4' }).expect(201)).body;
      const state = new URL(link.url).searchParams.get('state') ?? '';
      const denied = await request(server()).get(`/api/v1/channels/discord/callback?error=access_denied&state=${state}`).set('Cookie', alice.cookie);
      expect(denied.headers.location).toBe('http://localhost:5273/notifications?discord_error=denied');
      expect((await alice.get(`/channels/links/${link.requestId}`).expect(200)).body.status).toBe('FAILED');
    });

    it('토큰을 직접 넣어 채널을 만드는 옛 방식은 없다', async () => {
      await alice.post('/channels', { type: 'TELEGRAM', name: 'x', botToken: '1:x', chatId: '1' }).expect(404);
    });
  });

  it('알 수 없는 필드가 섞인 요청을 거부한다', async () => {
    await alice.post('/projects', { name: 'x', userId: bob.userId }).expect(400);
  });

  it('큰 본문을 받는 경로는 로그인 확인 전에 본문을 해석하지 않는다', async () => {
    // 본문이 JSON 이 아니어도 400(해석 오류)이 아니라 401 이 먼저 나와야 한다.
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/snapshots`)
      .set('Content-Type', 'application/json')
      .send('{"lockfileContent": "' + 'x'.repeat(300_000))
      .expect(401);
    await request(ctx.app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/snapshots/validate`)
      .set('Cookie', 'psk_session=not-a-real-session')
      .set('Content-Type', 'application/json')
      .send('{broken')
      .expect(401);
  });

  it('쿼리 값이 배열로 와도 오류 없이 처리한다', async () => {
    const snapshots = (await alice.get(`/projects/${projectId}/snapshots`).expect(200)).body;
    await alice.get(`/snapshots/${snapshots[0].id}/packages?q=a&q=b`).expect(200);
    await alice.get('/vulnerabilities?q=a&q=b').expect(400);
  });

  it('외부 공지의 javascript: 주소는 링크로 저장되지 않는다', async () => {
    const { VulnerabilityUpsertService } = await import('../src/ingestion/upsert.service.js');
    const { normalizeGhsa } = await import('../src/ingestion/adapters/ghsa.adapter.js');
    const { ghsaFixture } = await import('./fixtures/advisories.js');
    await ctx.get(VulnerabilityUpsertService).upsert(
      normalizeGhsa(ghsaFixture({ html_url: 'javascript:alert(document.cookie)', references: ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'https://example.com/ok'] })),
      { emitEvents: false },
    );
    const list = (await alice.get('/vulnerabilities?q=CVE-2099-0001').expect(200)).body;
    const detail = (await alice.get(`/vulnerabilities/${list.items[0].id}`).expect(200)).body;
    expect(detail.sources.map((s: { url: string | null }) => s.url)).toEqual([null]);
    expect(detail.references.map((r: { url: string }) => r.url)).toEqual(['https://example.com/ok']);
    expect(JSON.stringify(detail)).not.toContain('javascript:');
  });

  it('계정당 한도를 넘는 등록을 거부하고 오래된 구성 스냅샷을 정리한다', async () => {
    const { LIMITS } = await import('../src/project/project.service.js');
    const original = { ...LIMITS };
    Object.assign(LIMITS, { projectsPerUser: 2, snapshotsKeptPerProject: 2, snapshotsPerHour: 4, previewsPerHour: 2 });
    try {
      const dave = await ctx.client('dave@example.com');
      const first = (await dave.post('/projects', { name: 'p1' }).expect(201)).body.id;
      await dave.post('/projects', { name: 'p2' }).expect(201);
      await dave.post('/projects', { name: 'p3' }).expect(400);
      const manual = (version: string) => dave.post(`/projects/${first}/snapshots`, { inputType: 'MANUAL', packages: [{ name: 'fixture-quota', version }] });
      for (const version of ['1.0.0', '1.0.1', '1.0.2', '1.0.3']) await manual(version).expect(201);
      // 최근 2개만 남는다.
      expect((await dave.get(`/projects/${first}/snapshots`).expect(200)).body.map((s: { seq: number }) => s.seq)).toEqual([4, 3]);
      // 시간당 등록 한도
      await manual('1.0.4').expect(429);
      // 저장하지 않는 검증 요청도 계정별로 제한한다.
      const validate = () => dave.post(`/projects/${first}/snapshots/validate`, { inputType: 'MANUAL', packages: [{ name: 'fixture-quota', version: '1.0.0' }] });
      await validate().expect(200);
      await validate().expect(200);
      await validate().expect(429);
    } finally {
      Object.assign(LIMITS, original);
    }
  });

  describe('GitHub 로그인', () => {
    const server = () => ctx.app.getHttpServer();
    const cookieNamed = (response: request.Response, name: string) =>
      ((response.headers['set-cookie'] as unknown as string[] | undefined) ?? []).find((value) => value.startsWith(`${name}=`));

    it('GitHub 로 보낼 때 state 와 PKCE(S256)를 쓰고 권한을 요청하지 않는다', async () => {
      const start = await request(server()).get('/api/v1/auth/github').expect(302);
      const location = new URL(start.headers.location as string);
      expect(`${location.origin}${location.pathname}`).toBe('https://github.com/login/oauth/authorize');
      expect(location.searchParams.get('client_id')).toBe('fixture-client-id');
      expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:5273/api/v1/auth/github/callback');
      expect(location.searchParams.get('code_challenge_method')).toBe('S256');
      expect(location.searchParams.has('scope')).toBe(false);
      expect(location.toString()).not.toContain('fixture-client-secret');
      const cookie = cookieNamed(start, 'psk_oauth') ?? '';
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth\/github/);
      // 쿠키의 state 가 주소의 state 와 같고, 쿠키의 verifier 로 주소의 challenge 가 만들어진다.
      const [state, verifier] = decodeURIComponent(cookie.split(';')[0].split('=')[1]).split('.');
      expect(location.searchParams.get('state')).toBe(state);
      expect(location.searchParams.get('code_challenge')).toBe(pkceChallenge(verifier));
    });

    it('돌아올 때 GitHub 에 client secret·code_verifier·같은 redirect_uri 를 보낸다', async () => {
      ctx.githubCalls.length = 0;
      expect((await ctx.githubLogin('user:carol:4242')).status).toBe(302);
      const exchange = new URLSearchParams(ctx.githubCalls[0].body ?? '');
      expect(exchange.get('client_secret')).toBe('fixture-client-secret');
      expect(exchange.get('redirect_uri')).toBe('http://localhost:5273/api/v1/auth/github/callback');
      expect(exchange.get('code_verifier')?.length).toBeGreaterThanOrEqual(43);
      expect(ctx.githubCalls[1].url).toBe('https://api.github.com/user');
    });

    it('로그인하면 세션 쿠키를 발급하고 프론트의 정해진 주소로만 돌려보낸다', async () => {
      const callback = await ctx.githubLogin('user:dan:5151');
      expect(callback.status).toBe(302);
      expect(callback.headers.location).toBe('http://localhost:5273/');
      const cookie = cookieNamed(callback, 'psk_session') ?? '';
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      // OAuth 진행용 쿠키는 지운다.
      expect(cookieNamed(callback, 'psk_oauth')).toMatch(/Expires=Thu, 01 Jan 1970/);
      // 돌아갈 주소를 바깥에서 정할 수 없다.
      const sneaky = await request(server()).get('/api/v1/auth/github/callback?state=x&code=y&next=https://evil.example').expect(302);
      expect(sneaky.headers.location.startsWith('http://localhost:5273/')).toBe(true);
    });

    it('처음 오면 가입되고, 아이디가 바뀌어도 같은 GitHub 계정이면 같은 사용자다', async () => {
      const first = await ctx.client('erin', 777);
      const renamed = await ctx.client('erin-renamed', 777);
      expect(renamed.userId).toBe(first.userId);
      const user = await ctx.get(PrismaService).user.findUniqueOrThrow({ where: { githubId: '777' } });
      expect(user).toMatchObject({ githubLogin: 'erin-renamed', name: 'erin-renamed name' });
      expect((await renamed.get('/auth/me').expect(200)).body).toMatchObject({ githubLogin: 'erin-renamed' });
      // GitHub ID 가 다르면 아이디가 같아도 다른 사람이다.
      const impostor = await ctx.client('erin-renamed', 778);
      expect(impostor.userId).not.toBe(first.userId);
    });

    it('state 가 맞지 않거나 진행용 쿠키가 없으면 로그인하지 않는다', async () => {
      const users = await ctx.get(PrismaService).user.count();
      for (const response of [
        await ctx.githubLogin('user:mallory:9001', { state: 'forged-state' }),
        await ctx.githubLogin('user:mallory:9001', { oauthCookie: null }),
        await request(server()).get('/api/v1/auth/github/callback?code=user:mallory:9001'),
      ]) {
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe('http://localhost:5273/?login_error=state_mismatch');
        expect(cookieNamed(response, 'psk_session')).toBeUndefined();
      }
      expect(await ctx.get(PrismaService).user.count()).toBe(users);
    });

    it('사용자가 거절했거나 GitHub 가 코드를 거부하면 로그인하지 않는다', async () => {
      const denied = await ctx.githubLogin('', { error: 'access_denied' });
      expect(denied.headers.location).toBe('http://localhost:5273/?login_error=denied');
      const bad = await ctx.githubLogin('bad-code');
      expect(bad.headers.location).toBe('http://localhost:5273/?login_error=github_error');
      expect(cookieNamed(bad, 'psk_session')).toBeUndefined();
    });

    it('허용 목록을 정하면 그 GitHub 아이디만 들어올 수 있다', async () => {
      const { APP_ENV } = await import('../src/db/db.module.js');
      const env = ctx.app.get(APP_ENV) as { allowedGithubUsers: string[] };
      env.allowedGithubUsers = ['alice'];
      try {
        const rejected = await ctx.githubLogin('user:outsider:6000');
        expect(rejected.headers.location).toBe('http://localhost:5273/?login_error=not_allowed');
        expect(cookieNamed(rejected, 'psk_session')).toBeUndefined();
        expect(await ctx.get(PrismaService).user.count({ where: { githubLogin: 'outsider' } })).toBe(0);
        // 대소문자는 구분하지 않는다. (같은 아이디의 다른 GitHub 계정은 막으므로, 이미 가입한 alice 의 GitHub ID 로 들어온다.)
        const aliceGithubId = (await ctx.get(PrismaService).user.findFirstOrThrow({ where: { githubLogin: 'alice' } })).githubId;
        const allowed = await ctx.githubLogin(`user:Alice:${aliceGithubId}`);
        expect(allowed.headers.location).toBe('http://localhost:5273/');
      } finally {
        env.allowedGithubUsers = [];
      }
    });

    it('GitHub 로그인이 설정되지 않았으면 안내하고 GitHub 로 보내지 않는다', async () => {
      const { APP_ENV } = await import('../src/db/db.module.js');
      const env = ctx.app.get(APP_ENV) as { githubOAuth: unknown };
      const saved = env.githubOAuth;
      env.githubOAuth = null;
      try {
        expect((await request(server()).get('/api/v1/auth/status').expect(200)).body).toEqual({ githubEnabled: false });
        const start = await request(server()).get('/api/v1/auth/github').expect(302);
        expect(start.headers.location).toBe('http://localhost:5273/?login_error=not_configured');
      } finally {
        env.githubOAuth = saved;
      }
    });

    it('비밀값(client secret·access token)이 응답이나 DB 에 남지 않는다', async () => {
      const callback = await ctx.githubLogin('user:frank:8080');
      expect(JSON.stringify(callback.headers)).not.toMatch(/fixture-client-secret|gho_/);
      const prisma = ctx.get(PrismaService);
      const dump = JSON.stringify([await prisma.user.findMany(), await prisma.session.findMany()]);
      expect(dump).not.toMatch(/fixture-client-secret|gho_/);
    });
  });
});
