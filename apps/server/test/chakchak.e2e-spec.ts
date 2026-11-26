import { DeliveryService } from '../src/notification/delivery.service.js';
import { CHAKCHAK_BOT_TOKEN, CHAKCHAK_URL, createTestContext, jsonResponse, type TestClient, type TestContext } from './harness.js';

describe('알림: 착착 봇 (채널마다 따로)', () => {
  let ctx: TestContext;
  let user: TestClient;
  let deliveries: DeliveryService;
  let webChannel: string;
  let apiChannel: string;
  const sent = () => ctx.bots.chakchakSent;
  const sentTo = (channel: string) => sent().filter((message) => message.body.channel === channel);
  const secret = CHAKCHAK_BOT_TOKEN.slice(4, 16);

  const flush = async (at?: Date) => {
    await ctx.drain();
    await deliveries.relayPending();
    const now = at ?? new Date(Date.now() + 1000);
    for (let i = 0; i < 20 && (await deliveries.processDue(now)) > 0; i += 1);
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    deliveries = ctx.get(DeliveryService);
    user = await ctx.client('chakchak@example.com');
  });
  afterAll(() => ctx.close());

  it('봇이 들어가 있고 보관되지 않은 채널만 고를 수 있다', async () => {
    expect((await user.get('/channels/providers').expect(200)).body).toMatchObject({ chakchak: true });
    expect((await user.get('/channels/chakchak/channels').expect(200)).body).toEqual([
      { name: 'web-보안', private: false },
      { name: 'api-보안', private: true },
    ]);
    await user.post('/channels/chakchak', { name: '일반', channel: '일반' }).expect(400);
    await user.post('/channels/chakchak', { name: '옛', channel: '옛-보안' }).expect(400);
    expect(sent()).toHaveLength(0);
  });

  it('한 봇으로 여러 채널을 따로 연결하고, 같은 채널을 다시 연결해도 하나로 남는다', async () => {
    const web = (await user.post('/channels/chakchak', { name: 'web 보안', channel: 'web-보안' }).expect(200)).body;
    expect(web).toMatchObject({ type: 'CHAKCHAK', name: 'web 보안', label: '착착 · #web-보안', status: 'ACTIVE' });
    const api = (await user.post('/channels/chakchak', { name: 'api 보안', channel: 'api-보안' }).expect(200)).body;
    webChannel = web.id;
    apiChannel = api.id;
    expect(sent().map((message) => [message.url, message.body.channel])).toEqual([
      [`${CHAKCHAK_URL}/api/apps/v1/chat.postMessage`, 'web-보안'],
      [`${CHAKCHAK_URL}/api/apps/v1/chat.postMessage`, 'api-보안'],
    ]);
    expect(String(sent()[0].body.text)).toContain('연결 테스트');

    await user.post('/channels/chakchak', { name: 'web 보안 알림', channel: 'web-보안' }).expect(200);
    const channels = (await user.get('/channels').expect(200)).body as Array<{ id: string; type: string; name: string }>;
    expect(channels.filter((c) => c.type === 'CHAKCHAK').map((c) => [c.id, c.name])).toEqual([
      [webChannel, 'web 보안 알림'],
      [apiChannel, 'api 보안'],
    ]);
    ctx.bots.reset();
  });

  it('프로젝트마다 정한 채널로 오전·오후 브리핑을 보낸다', async () => {
    const project = async (name: string) => (await user.post('/projects', { name, environments: ['PRODUCTION'], exposure: 'PUBLIC' }).expect(201)).body.id as string;
    const rule = async (projectId: string, channelId: string, name: string) =>
      user
        .post('/rules', {
          name,
          kind: 'PROJECT_IMPACT',
          eventTypes: ['PROJECT_NEW_MATCH'],
          projectIds: [projectId],
          schedule: { type: 'DAILY', times: ['09:00', '14:00'] },
          digestFormat: 'BRIEFING',
          channelIds: [channelId],
        })
        .expect(201);
    await rule(await project('web'), webChannel, 'web 브리핑');
    await rule(await project('api'), apiChannel, 'api 브리핑');

    expect(await deliveries.createDueDigests(new Date(Date.now() + 2 * 86_400_000))).toBe(2);
    await flush();
    expect(sentTo('web-보안')).toHaveLength(1);
    expect(sentTo('api-보안')).toHaveLength(1);
    expect(String(sentTo('web-보안')[0].body.text)).toMatch(/^\*\*\[.*보안 브리핑.*\]/);
    const list = (await user.get('/briefings').expect(200)).body as { items: Array<{ channels: Array<{ type: string; status: string }> }> };
    expect(list.items.flatMap((item) => item.channels)).toEqual([
      expect.objectContaining({ type: 'CHAKCHAK', status: 'SENT' }),
      expect.objectContaining({ type: 'CHAKCHAK', status: 'SENT' }),
    ]);
    ctx.bots.reset();
  });

  it('한 채널이 끊겨도 다른 채널은 그대로 받고, 토큰은 어디에도 남지 않는다', async () => {
    ctx.bots.chakchakReply = (channel) =>
      channel === 'web-보안'
        ? jsonResponse({ success: false, code: 403, data: '봇이 이 채널에 초대되지 않았어요.' }, { status: 403 })
        : jsonResponse({ ok: true, messageId: 2, channel }, { status: 201 });
    const web = (await user.post(`/channels/${webChannel}/test`).expect(200)).body;
    expect(web).toMatchObject({ ok: false, channel: { status: 'ERROR' } });
    expect(web.channel.lastError).toContain('봇이 이 채널에 초대되지 않았어요.');
    const api = (await user.post(`/channels/${apiChannel}/test`).expect(200)).body;
    expect(api).toMatchObject({ ok: true, channel: { status: 'ACTIVE' } });

    for (const path of ['/channels', '/deliveries?pageSize=100', '/channels/chakchak/channels']) {
      expect(JSON.stringify((await user.get(path).expect(200)).body)).not.toContain(secret);
    }
    ctx.bots.reset();
    expect((await user.post(`/channels/${webChannel}/test`).expect(200)).body.channel.status).toBe('ACTIVE');
  });
});
