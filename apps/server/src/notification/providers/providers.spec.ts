import type { AppEnv } from '../../config/env.js';
import type { NotificationMessage } from '../message.js';
import { ChakchakProvider } from './chakchak.provider.js';
import { BOT_PERMISSIONS, DiscordProvider, neutralizeMentions } from './discord.provider.js';
import { escapeHtml, TelegramProvider } from './telegram.provider.js';

const env = {
  telegramBotToken: '123456789:AAfixturefixturefixturefixturefixture',
  discord: { botToken: 'fixture-bot-token', clientId: '111111111111111111', clientSecret: 'fixture-client-secret' },
} as unknown as AppEnv;

const message = (overrides: Partial<NotificationMessage> = {}): NotificationMessage => ({
  heading: '[프로젝트 영향] 신규 영향 버전 일치',
  title: 'fixture <script>alert(1)</script> & co',
  identifiers: ['CVE-2099-0001'],
  fields: [{ label: '프로젝트', value: 'a<b>c' }],
  links: [
    { label: '원문', url: 'https://example.com/a?x=1&y="2"' },
    { label: '위험', url: 'javascript:alert(1)' },
  ],
  tone: 'high',
  footer: 'pasukkun',
  ...overrides,
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

describe('TelegramProvider (서비스 봇)', () => {
  const provider = new TelegramProvider(env);
  const calls: Array<{ url: string; body: Record<string, unknown>; redirect?: RequestRedirect }> = [];
  const reply = (response: Response | (() => Response)) => {
    provider.fetchImpl = async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body ?? '{}')), redirect: init.redirect });
      return typeof response === 'function' ? response() : response;
    };
  };
  beforeEach(() => void (calls.length = 0));

  it('봇이 설정되어 있을 때만 켜진다', () => {
    expect(provider.enabled()).toBe(true);
    expect(new TelegramProvider({} as AppEnv).enabled()).toBe(false);
  });

  it('외부 문구의 HTML 을 이스케이프하고 위험한 링크는 버린다', () => {
    const { text, parse_mode } = provider.format(message());
    expect(parse_mode).toBe('HTML');
    expect(text).toContain('fixture &lt;script&gt;alert(1)&lt;/script&gt; &amp; co');
    expect(text).not.toContain('<script>');
    expect(text).toContain('<a href="https://example.com/a?x=1&amp;y=&quot;2&quot;">원문</a>');
    expect(text).not.toContain('javascript:');
    expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
  });

  it('사용자 문구는 전부 일반 텍스트로 다루고 길이 제한을 지킨다', () => {
    expect(provider.formatText('<b>굵게</b> & {x}', 'info').text).toBe('&lt;b&gt;굵게&lt;/b&gt; &amp; {x}');
    const long = provider.formatText('<'.repeat(5000), 'info').text;
    expect(long.length).toBeLessThanOrEqual(4096);
    expect(long.endsWith('…')).toBe(true);
  });

  it('기본 형식도 4096자 제한을 넘지 않고 태그를 중간에 자르지 않는다', () => {
    const { text } = provider.format(message({ fields: Array.from({ length: 60 }, (_, i) => ({ label: `항목 ${i}`, value: 'x'.repeat(200) })) }));
    expect(text.length).toBeLessThanOrEqual(4096);
    expect((text.match(/<b>/g) ?? []).length).toBe((text.match(/<\/b>/g) ?? []).length);
  });

  it('고정된 주소로 chat_id 에 보내고, 응답을 성공 / 재시도 / 영구 실패로 분류한다', async () => {
    const payload = provider.format(message());
    reply(json({ ok: true, result: { message_id: 7 } }));
    expect(await provider.send({ chatId: '42' }, payload)).toEqual({ status: 'SENT', providerMessageId: '7' });
    expect(calls[0]).toMatchObject({ url: `https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`, redirect: 'error', body: { chat_id: '42' } });

    reply(json({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 17 } }, 429));
    expect(await provider.send({ chatId: '42' }, payload)).toMatchObject({ status: 'RETRY', statusCode: 429, retryAfterMs: 17_000 });
    reply(json({ ok: false, description: 'Bad Gateway' }, 502));
    expect(await provider.send({ chatId: '42' }, payload)).toMatchObject({ status: 'RETRY', retryAfterMs: null });
    reply(json({ ok: false, description: 'Forbidden: bot was blocked by the user' }, 403));
    expect(await provider.send({ chatId: '42' }, payload)).toMatchObject({ status: 'PERMANENT', channelBroken: true });
    reply(json({ ok: false, description: 'Bad Request: chat not found' }, 400));
    expect(await provider.send({ chatId: '42' }, payload)).toMatchObject({ status: 'PERMANENT', channelBroken: true });
    reply(json({ ok: false, description: 'Bad Request: group chat was upgraded', parameters: { migrate_to_chat_id: -100123 } }, 400));
    expect(await provider.send({ chatId: '42' }, payload)).toMatchObject({ status: 'PERMANENT', channelBroken: true });
  });

  it('긴 폴링으로 업데이트를 받고, 봇 아이디는 한 번만 묻는다', async () => {
    reply(() => json({ ok: true, result: [{ update_id: 5 }] }));
    expect(await provider.getUpdates(3, 25)).toEqual([{ update_id: 5 }]);
    expect(calls[0].body).toEqual({ offset: 3, timeout: 25, allowed_updates: ['message', 'my_chat_member'] });
    const fresh = new TelegramProvider(env);
    let asked = 0;
    fresh.fetchImpl = async () => {
      asked += 1;
      return json({ ok: true, result: { username: 'pasukkun_bot' } });
    };
    expect(await fresh.botUsername()).toBe('pasukkun_bot');
    expect(await fresh.botUsername()).toBe('pasukkun_bot');
    expect(asked).toBe(1);
  });

  it('네트워크 오류 메시지에 봇 토큰이 섞이지 않는다', async () => {
    provider.fetchImpl = async (url) => {
      throw new TypeError(`fetch failed for ${url}`);
    };
    const result = await provider.send({ chatId: '42' }, provider.format(message()));
    expect(result.status).toBe('RETRY');
    expect(JSON.stringify(result)).not.toContain(env.telegramBotToken as string);
  });
});

describe('DiscordProvider (서비스 봇)', () => {
  const provider = new DiscordProvider(env);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const reply = (response: Response) => {
    provider.fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return response;
    };
  };
  beforeEach(() => void (calls.length = 0));

  it('봇을 서버에 넣는 주소: 필요한 최소 권한만 요청한다', () => {
    const url = new URL(provider.authorizeUrl({ state: 'st', redirectUri: 'http://localhost:5273/api/v1/channels/discord/callback' }));
    expect(`${url.origin}${url.pathname}`).toBe('https://discord.com/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: '111111111111111111',
      scope: 'bot',
      permissions: BOT_PERMISSIONS,
      response_type: 'code',
      redirect_uri: 'http://localhost:5273/api/v1/channels/discord/callback',
      state: 'st',
    });
    // 채널 보기 + 메시지 보내기 + 링크 미리보기
    expect(BOT_PERMISSIONS).toBe('19456');
  });

  it('코드 교환 응답의 guild 로 서버를 확인하고, client secret 은 Basic 인증으로만 보낸다', async () => {
    reply(json({ access_token: 'x', guild: { id: '222222222222222222', name: '내 서버' } }));
    expect(await provider.exchangeCode('code', 'http://cb')).toEqual({ id: '222222222222222222', name: '내 서버' });
    const init = calls[0].init;
    expect(calls[0].url).toBe('https://discord.com/api/v10/oauth2/token');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('111111111111111111:fixture-client-secret').toString('base64')}`);
    expect(String(init.body)).not.toContain('fixture-client-secret');
    expect(init.redirect).toBe('error');
    reply(json({ access_token: 'x' }));
    await expect(provider.exchangeCode('code', 'http://cb')).rejects.toThrow();
  });

  it('텍스트·공지 채널만 고를 수 있게 한다', async () => {
    reply(json([
      { id: '1000001', name: 'general', type: 0, position: 2 },
      { id: '1000002', name: 'voice', type: 2, position: 1 },
      { id: '1000003', name: 'news', type: 5, position: 1 },
    ]));
    expect((await provider.listTextChannels('222222222222222222')).map((c) => c.name)).toEqual(['news', 'general']);
    expect(await provider.listTextChannels('../../users/@me')).toEqual([]);
  });

  it('멘션 문법과 숨은 링크를 무력화하고 allowed_mentions 를 비운다', () => {
    expect(neutralizeMentions('@everyone @here <@123> <@&456> <#789> [x](https://e)')).toBe('@​everyone @​here <@​123> <@&​456> <#​789> [x]​(https://e)');
    const payload = provider.format(message({ title: 'ping @everyone and <@&1234567>' }));
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(JSON.stringify(payload.embeds)).not.toMatch(/@everyone|<@&1234567>/);
    const custom = provider.formatText('[가짜 패치](https://evil.example) @here', 'urgent');
    expect(custom.embeds[0].description).not.toContain('](');
    expect(custom.embeds[0].description).not.toContain('@here');
    expect(custom.allowed_mentions).toEqual({ parse: [] });
  });

  it('Embed 길이 제한을 지킨다', () => {
    const embed = provider.format(message({ title: 't'.repeat(600), lead: 'l'.repeat(9000), fields: Array.from({ length: 40 }, (_, i) => ({ label: `f${i}`.repeat(200), value: 'v'.repeat(3000) })) })).embeds[0];
    expect((embed.title ?? '').length).toBeLessThanOrEqual(256);
    expect(embed.description.length).toBeLessThanOrEqual(4096);
    expect(embed.fields.length).toBeLessThanOrEqual(25);
    const total = (embed.title ?? '').length + embed.description.length + (embed.footer?.text.length ?? 0) + embed.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
    expect(provider.formatText('x'.repeat(9000), 'info').embeds[0].description.length).toBeLessThanOrEqual(4096);
  });

  it('봇 토큰으로 고정된 주소에 보내고 응답을 분류한다', async () => {
    const payload = provider.format(message());
    reply(json({ id: '55' }));
    expect(await provider.send({ channelId: '333333333333333333' }, payload)).toEqual({ status: 'SENT', providerMessageId: '55' });
    expect(calls[0].url).toBe('https://discord.com/api/v10/channels/333333333333333333/messages');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bot fixture-bot-token');
    expect(calls[0].init.redirect).toBe('error');

    reply(json({ message: 'You are being rate limited.', retry_after: 1.25, global: false }, 429));
    expect(await provider.send({ channelId: '333333333333333333' }, payload)).toMatchObject({ status: 'RETRY', retryAfterMs: 1250 });
    reply(json({}, 503));
    expect(await provider.send({ channelId: '333333333333333333' }, payload)).toMatchObject({ status: 'RETRY' });
    reply(json({ message: 'Missing Permissions', code: 50013 }, 403));
    expect(await provider.send({ channelId: '333333333333333333' }, payload)).toMatchObject({ status: 'PERMANENT', channelBroken: true });
    reply(json({ message: 'Unknown Channel', code: 10003 }, 404));
    expect(await provider.send({ channelId: '333333333333333333' }, payload)).toMatchObject({ status: 'PERMANENT', channelBroken: true });
    reply(json({ message: 'Invalid Form Body', code: 50035 }, 400));
    expect(await provider.send({ channelId: '333333333333333333' }, payload)).toMatchObject({ status: 'PERMANENT', channelBroken: false });
    // 채널 번호가 아닌 값으로는 요청하지 않는다.
    calls.length = 0;
    expect(await provider.send({ channelId: '../../users/@me' }, payload)).toMatchObject({ status: 'PERMANENT' });
    expect(calls).toEqual([]);
  });
});

describe('ChakchakProvider (착착 커스텀 봇)', () => {
  const token = `shb-${'c0ffee'.repeat(8)}`;
  const provider = new ChakchakProvider({ chakchak: { url: 'http://localhost:3095', botToken: token } } as AppEnv);
  const calls: Array<{ url: string; method?: string; body: Record<string, unknown>; headers: Record<string, string>; redirect?: RequestRedirect }> = [];
  const reply = (response: Response | (() => Response)) => {
    provider.fetchImpl = async (target, init) => {
      calls.push({ url: target, method: init.method, body: JSON.parse(String(init.body ?? '{}')), headers: init.headers as Record<string, string>, redirect: init.redirect });
      return typeof response === 'function' ? response() : response;
    };
  };
  beforeEach(() => void (calls.length = 0));

  it('서버 주소와 봇 토큰이 설정되어 있을 때만 켜진다', () => {
    expect(provider.enabled()).toBe(true);
    expect(new ChakchakProvider({ chakchak: null } as AppEnv).enabled()).toBe(false);
  });

  it('봇이 들어가 있고 보관되지 않은 채널만 고를 수 있게 돌려준다', async () => {
    reply(
      json([
        { name: 'web-보안', private: false, archived: false, isMember: true },
        { name: '일반', private: false, archived: false, isMember: false },
        { name: '옛-보안', private: false, archived: true, isMember: true },
        { name: 'api-보안', private: true, archived: false, isMember: true },
      ]),
    );
    expect(await provider.listChannels()).toEqual([
      { name: 'web-보안', private: false },
      { name: 'api-보안', private: true },
    ]);
    expect(calls[0]).toMatchObject({ url: 'http://localhost:3095/api/apps/v1/channels', method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
    reply(json({ success: false, code: 401, data: '앱 토큰이 올바르지 않습니다.' }, 401));
    await expect(provider.listChannels()).rejects.toThrow('CHAKCHAK_BOT_TOKEN');
  });

  it('외부 문구가 멘션·숨은 링크·굵게 문법으로 동작하지 않는다', () => {
    const { text } = provider.format(
      message({ title: '@[모두](channel) [여기](https://evil.example) **x**', fields: [{ label: '설명', value: '@[홍길동](12) 안내' }] }),
    );
    expect(text).not.toMatch(/@\[/);
    expect(text).not.toContain('](https://evil');
    expect(text).not.toContain('**x**');
    expect(text).toContain('[원문](https://example.com/a?x=1&y="2")');
    expect(text).not.toContain('javascript:');
    expect(provider.formatText('@[모두](here) 안녕', 'info').text).not.toMatch(/@\[/);
  });

  it('길면 한도 안으로 줄인다', () => {
    const fields = Array.from({ length: 200 }, (_, i) => ({ label: `필드${i}`, value: 'x'.repeat(100) }));
    expect(provider.format(message({ fields })).text.length).toBeLessThanOrEqual(8000);
    expect(provider.formatText('y'.repeat(20000), 'info').text.length).toBeLessThanOrEqual(8000);
  });

  it('고른 채널로 보내고 결과를 나눈다 (토큰은 오류에 남기지 않는다)', async () => {
    reply(json({ ok: true, messageId: 7, channel: 'web-보안' }, 201));
    expect(await provider.send({ channel: 'web-보안' }, { text: 'a' })).toEqual({ status: 'SENT', providerMessageId: '7' });
    expect(calls[0]).toMatchObject({ url: 'http://localhost:3095/api/apps/v1/chat.postMessage', method: 'POST', body: { channel: 'web-보안', text: 'a' } });

    reply(json({ success: false, code: 429, data: 'ThrottlerException: Too Many Requests' }, 429, { 'Retry-After': '30' }));
    expect(await provider.send({ channel: 'web-보안' }, { text: 'a' })).toMatchObject({ status: 'RETRY', retryAfterMs: 30_000 });
    reply(json({}, 502));
    expect(await provider.send({ channel: 'web-보안' }, { text: 'a' })).toMatchObject({ status: 'RETRY' });
    reply(json({ success: false, code: 404, data: '존재하지 않는 채널입니다.' }, 404));
    expect(await provider.send({ channel: 'web-보안' }, { text: 'a' })).toMatchObject({ status: 'PERMANENT', channelBroken: true, error: '착착: 존재하지 않는 채널입니다. 고친 뒤 다시 연결해 주세요.' });
    reply(json({ success: false, code: 403, data: '보관된 채널에는 쓸 수 없습니다.' }, 403));
    expect(await provider.send({ channel: 'web-보안' }, { text: 'a' })).toMatchObject({ status: 'PERMANENT', channelBroken: true });
    reply(json({ success: false, code: 401, data: '앱 토큰이 올바르지 않습니다.' }, 401));
    expect(await provider.send({ channel: 'web-보안' }, { text: 'a' })).toMatchObject({ status: 'PERMANENT', channelBroken: true });
    reply(json({ success: false, code: 400, data: ['text must be shorter'] }, 400));
    expect(await provider.send({ channel: 'web-보안' }, { text: 'a' })).toMatchObject({ status: 'PERMANENT', channelBroken: false, error: 'text must be shorter' });
    expect(await provider.send({} as never, { text: 'a' })).toMatchObject({ status: 'PERMANENT', channelBroken: true });

    provider.fetchImpl = async () => {
      throw new TypeError(`fetch failed ${token}`);
    };
    const failed = await provider.send({ channel: 'web-보안' }, { text: 'a' });
    expect(failed).toMatchObject({ status: 'RETRY' });
    expect(JSON.stringify(failed)).not.toContain('c0ffeec0ffee');
  });
});

describe('꼬리 줄', () => {
  it('꼬리 줄이 없는 알림(보안 브리핑)은 세 채널 모두 붙이지 않고, 있는 알림은 그대로 붙인다', () => {
    const noFooter = { ...message(), footer: undefined };
    const telegram = new TelegramProvider(env);
    expect(telegram.format(noFooter).text).not.toContain('<i>');
    expect(telegram.format(noFooter).text.split('\n').pop()).toContain('<a href=');
    expect(telegram.format(message()).text).toMatch(/<i>pasukkun<\/i>$/);
    const discord = new DiscordProvider(env);
    expect(discord.format(noFooter).embeds[0].footer).toBeUndefined();
    expect(discord.format(message()).embeds[0].footer).toEqual({ text: 'pasukkun' });
    const chakchak = new ChakchakProvider({ chakchak: { url: 'http://localhost:3095', botToken: 'x' } } as AppEnv);
    expect(chakchak.format(noFooter).text.split('\n').pop()).toMatch(/^\[원문\]/);
    expect(chakchak.format(message()).text.endsWith('\npasukkun')).toBe(true);
  });
});
