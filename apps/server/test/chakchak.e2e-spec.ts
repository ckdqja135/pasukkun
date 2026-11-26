import { DeliveryService } from '../src/notification/delivery.service.js';
import { CHAKCHAK_BOT_URL, createTestContext, jsonResponse, type TestClient, type TestContext } from './harness.js';

describe('알림: 착착 봇이 초대된 채널', () => {
  let ctx: TestContext;
  let user: TestClient;
  let deliveries: DeliveryService;
  let channelId: string;
  const sent = () => ctx.bots.chakchakSent;
  const text = (index: number) => String(sent()[index].body.text);

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

  it('연결하면 서버 설정의 받는 주소로 확인 메시지를 보내고, 다시 연결해도 채널은 하나다', async () => {
    expect((await user.get('/channels/providers').expect(200)).body).toMatchObject({ chakchak: true });
    const channel = (await user.post('/channels/chakchak', { name: '착착' }).expect(200)).body;
    expect(channel).toMatchObject({ type: 'CHAKCHAK', name: '착착', label: '착착 · 봇이 초대된 채널', status: 'ACTIVE' });
    expect(sent()).toHaveLength(1);
    expect(sent()[0].url).toBe(CHAKCHAK_BOT_URL);
    expect(text(0)).toContain('연결 테스트');
    channelId = channel.id;

    await user.post('/channels/chakchak', { name: '착착 알림' }).expect(200);
    const channels = (await user.get('/channels').expect(200)).body as Array<{ id: string; type: string; name: string }>;
    expect(channels.filter((c) => c.type === 'CHAKCHAK')).toEqual([expect.objectContaining({ id: channelId, name: '착착 알림' })]);
    ctx.bots.reset();
  });

  it('받는 주소로 보내지 못하면 채널을 만들지 않는다', async () => {
    const other = await ctx.client('chakchak-other@example.com');
    ctx.bots.chakchakReply = () => jsonResponse({ success: false, code: 404, data: '존재하지 않는 받는 주소입니다.' }, { status: 404 });
    const response = await other.post('/channels/chakchak', { name: '착착' }).expect(400);
    expect(JSON.stringify(response.body)).not.toContain('c0ffeec0ffee');
    expect((await other.get('/channels').expect(200)).body).toEqual([]);
    ctx.bots.reset();
  });

  it('오전·오후 브리핑을 정한 시각에 착착 채널로 보낸다', async () => {
    await user
      .post('/rules', { name: 'briefing', kind: 'TECH_INTEREST', eventTypes: ['TECH_NEW_VULN'], schedule: { type: 'DAILY', times: ['09:00', '14:00'] }, digestFormat: 'BRIEFING', channelIds: [channelId] })
      .expect(201);
    expect(await deliveries.createDueDigests(new Date(Date.now() + 2 * 86_400_000))).toBe(1);
    await flush();
    expect(sent()).toHaveLength(1);
    expect(text(0)).toMatch(/^\*\*\[.*보안 브리핑.*\]/);
    const list = (await user.get('/briefings').expect(200)).body as { items: Array<{ id: number; channels: Array<{ type: string; status: string }> }> };
    expect(list.items[0].channels).toEqual([expect.objectContaining({ type: 'CHAKCHAK', status: 'SENT' })]);
    expect(text(0)).toContain(`/briefings?id=${list.items[0].id}`);
    ctx.bots.reset();
  });

  it('착착에서 받는 주소를 지우면(404) 다시 시도하지 않고 채널을 오류로 표시하며, 주소는 어디에도 남기지 않는다', async () => {
    ctx.bots.chakchakReply = () => jsonResponse({ success: false, code: 404, data: '존재하지 않는 받는 주소입니다.' }, { status: 404 });
    const result = (await user.post(`/channels/${channelId}/test`).expect(200)).body;
    expect(result).toMatchObject({ ok: false, channel: { status: 'ERROR' } });
    expect(result.channel.lastError).toContain('CHAKCHAK_BOT_URL');
    expect(JSON.stringify(result)).not.toContain('c0ffeec0ffee');
    const history = (await user.get('/deliveries?pageSize=100').expect(200)).body;
    expect(JSON.stringify(history)).not.toContain('c0ffeec0ffee');
    // 봇이 채널에서 빠지면(403) 착착이 알려 준 이유를 보여 준다.
    ctx.bots.chakchakReply = () => jsonResponse({ success: false, code: 403, data: '봇이 이 채널에 초대되지 않았어요. 먼저 봇을 채널에 초대해 주세요.' }, { status: 403 });
    const kicked = (await user.post(`/channels/${channelId}/test`).expect(200)).body;
    expect(kicked).toMatchObject({ ok: false, channel: { status: 'ERROR' } });
    expect(kicked.channel.lastError).toContain('봇이 이 채널에 초대되지 않았어요');
    // 다시 보내지면 복구된다.
    ctx.bots.reset();
    expect((await user.post(`/channels/${channelId}/test`).expect(200)).body.channel.status).toBe('ACTIVE');
  });
});
