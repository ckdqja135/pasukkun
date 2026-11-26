import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createGithubAppMock, type GithubAppMock } from './github-mock.js';

/**
 * e2e 테스트 환경.
 * - 파일마다 새 임시 SQLite DB 를 쓴다 (개발 DB·실제 수집 데이터를 건드리지 않는다).
 * - 외부 API 는 호출하지 않는다. OSV·Telegram·Discord 는 테스트가 응답을 주입한다.
 */
const ORIGIN = 'http://localhost:5273';
export const CHAKCHAK_URL = 'http://localhost:3095';
export const CHAKCHAK_BOT_TOKEN = `shb-${'c0ffee'.repeat(8)}`;

export interface TestClient {
  login: string;
  userId: string;
  /** 세션 쿠키 ("psk_session=...") */
  cookie: string;
  csrf: string;
  get(path: string): request.Test;
  post(path: string, body?: object): request.Test;
  put(path: string, body?: object): request.Test;
  patch(path: string, body?: object): request.Test;
  delete(path: string): request.Test;
}

export interface SentMessage {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface BotMock {
  telegramSent: SentMessage[];
  discordSent: SentMessage[];
  chakchakSent: SentMessage[];
  /** 텔레그램 sendMessage 응답 */
  telegramReply: (body: Record<string, unknown>) => Response;
  /** 디스코드 메시지 전송 응답 */
  discordReply: (channelId: string) => Response;
  /** 착착 봇 메시지 보내기 응답 */
  chakchakReply: (channel: string) => Response;
  /** 착착 봇 API 의 채널 목록 응답 */
  chakchakChannels: Array<{ name: string; private: boolean; archived: boolean; isMember: boolean }>;
  /** 디스코드 서버별 채널 (guildId → 채널 목록) */
  discordGuilds: Map<string, Array<{ id: string; name: string; type: number }>>;
  reset(): void;
}

export interface TestContext {
  app: INestApplication;
  /** GitHub 로그인(흉내)으로 계정을 만들고 그 세션으로 요청하는 클라이언트를 돌려준다 */
  client(login: string, githubId?: number): Promise<TestClient>;
  /** GitHub 로그인 흐름을 한 번 진행하고 마지막 응답을 돌려준다 */
  githubLogin(code: string, options?: { state?: string; oauthCookie?: string | null; error?: string }): Promise<request.Response>;
  /** GitHub 쪽 요청 기록 (토큰 교환 요청 본문 등) */
  githubCalls: Array<{ url: string; body: string | null }>;
  /** 서비스 봇 흉내. 보낸 메시지를 기록하고, 응답을 바꿔 끼울 수 있다. */
  bots: BotMock;
  /** 텔레그램에서 [시작]을 누른 것처럼 연결을 끝내고 채널 ID 를 돌려준다 */
  linkTelegram(client: TestClient, name: string, chatId: number, options?: { group?: boolean }): Promise<string>;
  /** 디스코드에서 서버를 고르고 채널을 고른 것처럼 연결을 끝내고 채널 ID 를 돌려준다 */
  linkDiscord(client: TestClient, name: string, channelId: string, guildId?: string): Promise<string>;
  /** 서비스 GitHub 앱 흉내 (설치, 저장소, 파일) */
  githubApp: GithubAppMock;
  /** [GitHub 저장소 가져오기] → GitHub 인증 → 돌아오기까지 진행하고, 돌아온 주소를 돌려준다 */
  githubAppLink(client: TestClient, options?: { code?: string; error?: string; cookie?: string | null; state?: string; as?: TestClient | null }): Promise<URL>;
  /** 대기 중인 백그라운드 작업(검사·재평가)을 모두 실행한다 */
  drain(): Promise<number>;
  close(): Promise<void>;
  get<T>(token: new (...args: never[]) => T): T;
}

export async function createTestContext(): Promise<TestContext> {
  const dir = mkdtempSync(join(tmpdir(), 'pasukkun-test-'));
  const appKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const appKeyPath = join(dir, 'github-app.pem');
  writeFileSync(appKeyPath, appKeys.privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 });
  Object.assign(process.env, {
    NODE_ENV: 'test',
    ENV_FILE: join(dir, 'no-such.env'),
    DATABASE_PATH: join(dir, 'test.db'),
    TELEGRAM_BOT_TOKEN: '123456789:AAfixturefixturefixturefixturefixture',
    DISCORD_BOT_TOKEN: 'fixture-discord-bot-token',
    DISCORD_CLIENT_ID: '111111111111111111',
    DISCORD_CLIENT_SECRET: 'fixture-discord-client-secret',
    CHAKCHAK_URL,
    CHAKCHAK_BOT_TOKEN,
    APP_ORIGIN: ORIGIN,
    DISABLE_INGESTION: '1',
    COOKIE_SECURE: 'false',
    GITHUB_OAUTH_CLIENT_ID: 'fixture-client-id',
    GITHUB_OAUTH_CLIENT_SECRET: 'fixture-client-secret',
    GITHUB_OAUTH_ALLOWED_USERS: '',
    NOTIFY_MAX_ATTEMPTS: '3',
    GITHUB_APP_CLIENT_ID: 'Iv23fixtureapp',
    GITHUB_APP_CLIENT_SECRET: 'fixture-app-secret',
    GITHUB_APP_SLUG: 'pasukkun-fixture',
    GITHUB_APP_PRIVATE_KEY_PATH: appKeyPath,
    // 셸에 키가 있어도 테스트에서는 실제 AI 를 부르지 않는다.
    ANTHROPIC_API_KEY: '',
  });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: join(import.meta.dirname, '..'), env: process.env, stdio: 'pipe' });

  // 환경변수를 정한 뒤에 모듈을 불러온다.
  const { resetEnvCache, loadEnv } = await import('../src/config/env.js');
  resetEnvCache();
  const { AppModule } = await import('../src/app.module.js');
  const { WorkerModule } = await import('../src/worker.module.js');
  const { WorkerService } = await import('../src/worker.service.js');
  const { JobRunner } = await import('../src/jobs/job-runner.service.js');
  const { configureApp, API_PREFIX } = await import('../src/app.setup.js');
  const { GithubOAuthClient } = await import('../src/auth/github-oauth.client.js');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule, WorkerModule] }).compile();
  const app = moduleRef.createNestApplication({ bodyParser: false, logger: false });
  configureApp(app, loadEnv());
  await app.init();
  app.get(WorkerService).registerHandlers();
  const server = app.getHttpServer();
  const base = `/${API_PREFIX}`;

  /**
   * GitHub 흉내: 인가 코드 "user:<login>:<id>" 를 받으면 그 사람의 공개 프로필을 돌려준다.
   * "bad..." 로 시작하는 코드는 GitHub 가 거절한 것으로 본다.
   */
  const githubCalls: Array<{ url: string; body: string | null }> = [];
  app.get(GithubOAuthClient).fetchImpl = async (url, init) => {
    githubCalls.push({ url, body: typeof init.body === 'string' ? init.body : null });
    if (url === 'https://github.com/login/oauth/access_token') {
      const code = new URLSearchParams(String(init.body)).get('code') ?? '';
      return code.startsWith('bad') ? jsonResponse({ error: 'bad_verification_code' }) : jsonResponse({ access_token: `gho_${code}`, token_type: 'bearer', scope: '' });
    }
    if (url === 'https://api.github.com/user') {
      const token = String((init.headers as Record<string, string>).Authorization ?? '').replace('Bearer gho_', '');
      const [, login, id] = token.split(':');
      return jsonResponse({ id: Number(id), login, name: `${login} name`, type: 'User' });
    }
    return jsonResponse({ message: 'Not Found' }, { status: 404 });
  };

  const cookieFrom = (response: request.Response, name: string): string | null =>
    ((response.headers['set-cookie'] as unknown as string[] | undefined) ?? []).map((value) => value.split(';')[0]).find((value) => value.startsWith(`${name}=`) && value.length > name.length + 1) ?? null;

  const githubLogin: TestContext['githubLogin'] = async (code, options = {}) => {
    const start = await request(server).get(`${base}/auth/github`).expect(302);
    const location = new URL(start.headers.location as string);
    const state = options.state ?? location.searchParams.get('state') ?? '';
    const oauthCookie = options.oauthCookie === undefined ? cookieFrom(start, 'psk_oauth') : options.oauthCookie;
    const query = new URLSearchParams({ state, ...(options.error ? { error: options.error } : { code }) });
    const callback = request(server).get(`${base}/auth/github/callback?${query.toString()}`);
    if (oauthCookie) callback.set('Cookie', oauthCookie);
    return callback;
  };

  let nextId = 1000;

  // - 서비스 봇 흉내 -
  const { TelegramProvider } = await import('../src/notification/providers/telegram.provider.js');
  const { DiscordProvider } = await import('../src/notification/providers/discord.provider.js');
  const { ChakchakProvider } = await import('../src/notification/providers/chakchak.provider.js');
  const { ChannelService } = await import('../src/notification/channel.service.js');
  const okTelegram = () => jsonResponse({ ok: true, result: { message_id: 1 } });
  const okDiscord = () => jsonResponse({ id: '1' });
  const okChakchak = (channel: string) => jsonResponse({ ok: true, messageId: 1, channel }, { status: 201 });
  const chakchakChannels = () => [
    { name: 'web-보안', private: false, archived: false, isMember: true },
    { name: 'api-보안', private: true, archived: false, isMember: true },
    { name: '일반', private: false, archived: false, isMember: false },
    { name: '옛-보안', private: false, archived: true, isMember: true },
  ];
  const bots: BotMock = {
    telegramSent: [],
    discordSent: [],
    chakchakSent: [],
    telegramReply: okTelegram,
    discordReply: okDiscord,
    chakchakReply: okChakchak,
    chakchakChannels: chakchakChannels(),
    discordGuilds: new Map([['222222222222222222', [{ id: '333333333333333333', name: 'alerts', type: 0 }, { id: '333333333333333334', name: 'voice', type: 2 }]]]),
    reset() {
      bots.telegramSent.length = 0;
      bots.discordSent.length = 0;
      bots.chakchakSent.length = 0;
      bots.telegramReply = okTelegram;
      bots.discordReply = okDiscord;
      bots.chakchakReply = okChakchak;
      bots.chakchakChannels = chakchakChannels();
    },
  };
  app.get(TelegramProvider).fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    if (method === 'getMe') return jsonResponse({ ok: true, result: { id: 123456789, is_bot: true, username: 'pasukkun_fixture_bot' } });
    if (method === 'sendMessage') {
      bots.telegramSent.push({ url, body, headers: {} });
      return bots.telegramReply(body);
    }
    if (method === 'getUpdates') return jsonResponse({ ok: true, result: [] });
    return jsonResponse({ ok: false, description: 'Not Found' }, { status: 404 });
  };
  app.get(ChakchakProvider).fetchImpl = async (url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (headers.Authorization !== `Bearer ${CHAKCHAK_BOT_TOKEN}`) return jsonResponse({ success: false, code: 401, data: '앱 토큰이 올바르지 않습니다.' }, { status: 401 });
    const path = url.replace(CHAKCHAK_URL, '');
    if (path === '/api/apps/v1/channels') return jsonResponse(bots.chakchakChannels);
    if (path === '/api/apps/v1/chat.postMessage') {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      bots.chakchakSent.push({ url, body, headers });
      return bots.chakchakReply(String(body.channel));
    }
    return jsonResponse({ success: false, code: 404, data: 'Not Found' }, { status: 404 });
  };
  app.get(DiscordProvider).fetchImpl = async (url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const path = url.replace('https://discord.com/api/v10', '');
    if (path === '/oauth2/token') {
      const code = new URLSearchParams(String(init.body)).get('code') ?? '';
      // 코드 "guild:<id>" → 그 서버에 봇이 들어간 것으로 본다
      const guildId = code.startsWith('guild:') ? code.slice(6) : '';
      return guildId ? jsonResponse({ access_token: 'fixture-user-token', scope: 'bot', guild: { id: guildId, name: `server-${guildId.slice(-3)}` } }) : jsonResponse({ error: 'invalid_grant' }, { status: 400 });
    }
    const guildChannels = /^\/guilds\/(\d+)\/channels$/.exec(path);
    if (guildChannels) return jsonResponse(bots.discordGuilds.get(guildChannels[1]) ?? [], { status: bots.discordGuilds.has(guildChannels[1]) ? 200 : 403 });
    const channelInfo = /^\/channels\/(\d+)$/.exec(path);
    if (channelInfo) {
      for (const [guildId, channels] of bots.discordGuilds) {
        const found = channels.find((channel) => channel.id === channelInfo[1]);
        if (found) return jsonResponse({ ...found, guild_id: guildId });
      }
      return jsonResponse({ message: 'Unknown Channel', code: 10003 }, { status: 404 });
    }
    const messages = /^\/channels\/(\d+)\/messages$/.exec(path);
    if (messages) {
      bots.discordSent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown>, headers });
      return bots.discordReply(messages[1]);
    }
    return jsonResponse({ message: 'Not Found' }, { status: 404 });
  };

  const linkTelegram: TestContext['linkTelegram'] = async (client, name, chatId, options = {}) => {
    const link = await client.post('/channels/telegram/link', { name });
    if (link.status !== 201) throw new Error(`telegram link failed: ${link.status} ${JSON.stringify(link.body)}`);
    const code = new URL((options.group ? link.body.groupUrl : link.body.url) as string).searchParams.get(options.group ? 'startgroup' : 'start') ?? '';
    await app.get(ChannelService).handleTelegramUpdate({
      update_id: (nextId += 1),
      message: {
        message_id: 1,
        text: options.group ? `/start@pasukkun_fixture_bot ${code}` : `/start ${code}`,
        chat: options.group ? { id: chatId, type: 'supergroup', title: 'fixture group' } : { id: chatId, type: 'private', first_name: 'fixture' },
        from: { id: 42, username: 'fixture_user' },
      },
    });
    const status = await client.get(`/channels/links/${link.body.requestId}`);
    if (status.body.status !== 'COMPLETED') throw new Error(`telegram link not completed: ${JSON.stringify(status.body)}`);
    return status.body.channelId as string;
  };

  // - 서비스 GitHub 앱 흉내 -
  const { GithubAppClient } = await import('../src/github/github-app.client.js');
  const githubAppFake = createGithubAppMock(appKeys.publicKey, 'Iv23fixtureapp');
  app.get(GithubAppClient).fetchImpl = githubAppFake.fetchImpl;

  const githubAppLink: TestContext['githubAppLink'] = async (client, options = {}) => {
    const start = await client.post('/github/link');
    if (start.status !== 201) throw new Error(`github link failed: ${start.status} ${JSON.stringify(start.body)}`);
    const verifierCookie = cookieFrom(start, 'psk_gh');
    const state = options.state ?? new URL(start.body.url as string).searchParams.get('state') ?? '';
    const query = new URLSearchParams({ state, ...(options.error ? { error: options.error } : { code: options.code ?? `gh:${client.login}` }) });
    const callback = request(server).get(`${base}/github/callback?${query.toString()}`);
    const finisher = options.as === undefined ? client : options.as;
    const cookies = [finisher?.cookie, options.cookie === undefined ? verifierCookie : options.cookie].filter(Boolean) as string[];
    if (cookies.length > 0) callback.set('Cookie', cookies.join('; '));
    const response = await callback;
    if (response.status !== 302) throw new Error(`github callback status ${response.status}`);
    return new URL(response.headers.location as string);
  };

  const linkDiscord: TestContext['linkDiscord'] = async (client, name, channelId, guildId = '222222222222222222') => {
    const link = await client.post('/channels/discord/link', { name });
    if (link.status !== 201) throw new Error(`discord link failed: ${link.status} ${JSON.stringify(link.body)}`);
    const state = new URL(link.body.url as string).searchParams.get('state') ?? '';
    const callback = await request(server).get(`${base}/channels/discord/callback?${new URLSearchParams({ code: `guild:${guildId}`, state, guild_id: guildId }).toString()}`).set('Cookie', client.cookie);
    const requestId = new URL(callback.headers.location as string).searchParams.get('discord_link');
    if (!requestId) throw new Error(`discord callback failed: ${callback.headers.location}`);
    const completed = await client.post(`/channels/links/${requestId}/discord-complete`, { channelId });
    if (completed.status !== 200) throw new Error(`discord complete failed: ${completed.status} ${JSON.stringify(completed.body)}`);
    return completed.body.id as string;
  };
  return {
    app,
    get: (token) => app.get(token as never),
    drain: () => app.get(JobRunner).drain(),
    async close() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
    githubCalls,
    githubLogin,
    bots,
    linkTelegram,
    linkDiscord,
    githubApp: githubAppFake.mock,
    githubAppLink,
    async client(name, githubId) {
      const login = name.split('@')[0];
      const callback = await githubLogin(`user:${login}:${githubId ?? (nextId += 1)}`);
      const cookie = cookieFrom(callback, 'psk_session');
      if (callback.status !== 302 || !cookie) throw new Error(`login failed: ${callback.status} ${callback.headers.location}`);
      const me = await request(server).get(`${base}/auth/me`).set('Cookie', cookie).expect(200);
      const csrf = me.body.csrfToken as string;
      const withAuth = (test: request.Test, unsafe: boolean) => {
        test.set('Cookie', cookie).set('Origin', ORIGIN);
        if (unsafe) test.set('X-CSRF-Token', csrf);
        return test;
      };
      return {
        login,
        userId: me.body.id as string,
        cookie,
        csrf,
        get: (path) => withAuth(request(server).get(`${base}${path}`), false),
        post: (path, body) => withAuth(request(server).post(`${base}${path}`).send(body ?? {}), true),
        put: (path, body) => withAuth(request(server).put(`${base}${path}`).send(body ?? {}), true),
        patch: (path, body) => withAuth(request(server).patch(`${base}${path}`).send(body ?? {}), true),
        delete: (path) => withAuth(request(server).delete(`${base}${path}`), true),
      };
    },
  };
}

/** fetch 응답을 흉내낸다 */
export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json', ...init.headers } });
}
