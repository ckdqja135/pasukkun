import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AppEnv } from '../../config/env.js';
import { APP_ENV } from '../../db/db.module.js';
import type { NotificationMessage } from '../message.js';
import { truncateText, type FetchLike, type NotificationProvider, type SendResult, type Tone } from './provider.js';

/**
 * 서비스 디스코드 봇 (https://docs.discord.com/developers).
 * - 봇 토큰·Client Secret 은 서버 설정에만 있다. 이용자는 봇을 자기 서버에 넣고 알림 받을 채널을 고른다.
 * - 저장하는 것은 서버·채널 번호뿐이다 (비밀값 아님).
 * - 봇을 넣은 서버는 OAuth2 코드 교환 응답의 guild 로 확인한다 (redirect 의 guild_id 는 믿지 않는다).
 */
export interface DiscordTarget {
  channelId: string;
}

export interface DiscordEmbed {
  title?: string;
  description: string;
  url?: string;
  color: number;
  fields: Array<{ name: string; value: string; inline: boolean }>;
  footer: { text: string };
}

export interface DiscordPayload {
  embeds: DiscordEmbed[];
  /** 어떤 멘션도 알림을 일으키지 않게 한다 */
  allowed_mentions: { parse: [] };
}

export interface DiscordGuild {
  id: string;
  name: string;
}

export interface DiscordChannelInfo {
  id: string;
  name: string;
  guildId: string | null;
  type: number;
}

const API_BASE = 'https://discord.com/api/v10';
const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const USER_AGENT = 'DiscordBot (https://github.com/pasukkun, 0.1.0)';
/** VIEW_CHANNEL(1024) + SEND_MESSAGES(2048) + EMBED_LINKS(16384) */
export const BOT_PERMISSIONS = String(1024 + 2048 + 16384);
/** GUILD_TEXT, GUILD_ANNOUNCEMENT */
const SENDABLE_TYPES = new Set([0, 5]);
const SNOWFLAKE = /^\d{5,25}$/;

export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

const LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footer: 2048, fields: 25, total: 6000 };
const COLORS = { urgent: 0xd92d20, high: 0xf79009, medium: 0xeaaa08, low: 0x667085, info: 0x2e90fa };

/**
 * @everyone, @here, <@id> 같은 멘션 문법이 외부 공지 문구에 섞여 있어도 동작하지 않게 한다.
 * (allowed_mentions 로 이미 막지만 표시상으로도 멘션처럼 보이지 않게 이중으로 처리한다.)
 */
export function neutralizeMentions(text: string): string {
  return (
    text
      .replace(/@(?=everyone|here)/gi, '@\u200b')
      .replace(/<(@[!&]?|#)(\d+)>/g, '<$1\u200b$2>')
      // [보이는 글자](주소) 형태의 숨은 링크: 공지 문구가 다른 곳으로 가는 링크를 만들 수 없게 한다.
      .replace(/\]\(/g, ']\u200b(')
  );
}

function clean(text: string, max: number): string {
  return truncateText(neutralizeMentions(text).trim(), max) || '-';
}

@Injectable()
export class DiscordProvider implements NotificationProvider<DiscordTarget, DiscordPayload> {
  readonly type = 'DISCORD' as const;
  private readonly logger = new Logger(DiscordProvider.name);
  /** 테스트에서 네트워크를 대체하기 위한 주입점 */
  fetchImpl: FetchLike = (url, init) => fetch(url, init);

  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  enabled(): boolean {
    return this.env.discord !== null;
  }

  private get config() {
    if (!this.env.discord) throw new DiscordApiError(0, null, '디스코드 봇이 설정되지 않았습니다.');
    return this.env.discord;
  }

  /** 봇 토큰으로 REST 호출 */
  private async request<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${API_BASE}${path}`, {
        method,
        headers: { Authorization: `Bot ${this.config.botToken}`, 'User-Agent': USER_AGENT, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new DiscordApiError(0, null, `디스코드에 연결하지 못했습니다 (${error instanceof Error ? error.name : 'unknown'}).`);
    }
    const data = (await response.json().catch(() => ({}))) as T & { message?: string; code?: number };
    if (!response.ok) throw new DiscordApiError(response.status, typeof data.code === 'number' ? data.code : null, truncateText(data.message ?? `HTTP ${response.status}`, 200));
    return data;
  }

  /** 봇을 서버에 넣는 화면 주소. 돌아올 때 코드를 교환해 어느 서버인지 확인한다. */
  authorizeUrl(params: { state: string; redirectUri: string }): string {
    const query = new URLSearchParams({
      client_id: this.config.clientId,
      scope: 'bot',
      permissions: BOT_PERMISSIONS,
      response_type: 'code',
      redirect_uri: params.redirectUri,
      state: params.state,
    });
    return `${AUTHORIZE_URL}?${query.toString()}`;
  }

  /** 코드 교환 응답의 guild 가 봇이 실제로 들어간 서버다. 받은 사용자 토큰은 저장하지 않는다. */
  async exchangeCode(code: string, redirectUri: string): Promise<DiscordGuild> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${API_BASE}/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`,
          'User-Agent': USER_AGENT,
        },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new DiscordApiError(0, null, '디스코드에 연결하지 못했습니다.');
    }
    const data = (await response.json().catch(() => ({}))) as { guild?: { id?: unknown; name?: unknown } };
    const id = data.guild?.id;
    const name = data.guild?.name;
    if (!response.ok || typeof id !== 'string' || !SNOWFLAKE.test(id)) {
      throw new DiscordApiError(response.status, null, '디스코드에서 봇을 넣은 서버를 확인하지 못했습니다.');
    }
    return { id, name: typeof name === 'string' ? truncateText(name, 100) : '디스코드 서버' };
  }

  /** 봇이 볼 수 있는 텍스트·공지 채널 (볼 수 없는 채널은 디스코드가 아예 빼고 준다) */
  async listTextChannels(guildId: string): Promise<DiscordChannelInfo[]> {
    if (!SNOWFLAKE.test(guildId)) return [];
    const channels = await this.request<Array<{ id: string; name?: string; type: number; position?: number }>>('GET', `/guilds/${guildId}/channels`);
    return channels
      .filter((channel) => SENDABLE_TYPES.has(channel.type))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((channel) => ({ id: channel.id, name: channel.name ?? channel.id, guildId, type: channel.type }));
  }

  async getChannel(channelId: string): Promise<DiscordChannelInfo | null> {
    if (!SNOWFLAKE.test(channelId)) return null;
    try {
      const channel = await this.request<{ id: string; name?: string; type: number; guild_id?: string }>('GET', `/channels/${channelId}`);
      return { id: channel.id, name: channel.name ?? channel.id, guildId: channel.guild_id ?? null, type: channel.type };
    } catch (error) {
      if (error instanceof DiscordApiError && (error.status === 403 || error.status === 404)) return null;
      throw error;
    }
  }

  /**
   * 예전 문서에는 "메시지를 보내기 전에 게이트웨이에 한 번은 접속해야 한다"는 조건이 있었다.
   * 지금 문서에는 없지만, 안전하게 처음 한 번 접속(Identify)했다가 바로 끊는다.
   */
  async identifyOnce(timeoutMs = 15_000): Promise<boolean> {
    const token = this.config.botToken;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let socket: WebSocket;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket?.close(1000);
        } catch {
          // 이미 닫힘
        }
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      try {
        socket = new WebSocket(GATEWAY_URL);
      } catch {
        finish(false);
        return;
      }
      socket.addEventListener('message', (event) => {
        let packet: { op?: number; t?: string };
        try {
          packet = JSON.parse(String(event.data)) as { op?: number; t?: string };
        } catch {
          return;
        }
        if (packet.op === 10) {
          socket.send(JSON.stringify({ op: 2, d: { token, intents: 0, properties: { os: 'linux', browser: 'pasukkun', device: 'pasukkun' } } }));
        } else if (packet.op === 0 && packet.t === 'READY') {
          finish(true);
        } else if (packet.op === 9) {
          finish(false);
        }
      });
      socket.addEventListener('close', (event) => {
        if (event.code === 4004) this.logger.warn('디스코드 봇 토큰이 올바르지 않습니다 (게이트웨이 인증 실패).');
        finish(false);
      });
      socket.addEventListener('error', () => finish(false));
    });
  }

  format(message: NotificationMessage): DiscordPayload {
    const description = [message.identifiers.join(' · '), message.lead ?? ''].filter(Boolean).join('\n\n');
    const links = message.links.filter((link) => /^https?:\/\//i.test(link.url));
    const fields = message.fields.slice(0, LIMITS.fields - 1).map((field) => ({
      name: clean(field.label, LIMITS.fieldName),
      value: clean(field.value, LIMITS.fieldValue),
      inline: field.value.length <= 30,
    }));
    if (links.length > 0) {
      fields.push({
        name: '링크',
        // 링크 문구에 Markdown 을 끊는 문자가 들어가지 않게 한다.
        value: truncateText(links.map((link) => `[${link.label.replace(/[[\]()]/g, '')}](${link.url.replace(/[()\s]/g, encodeURIComponent)})`).join(' · '), LIMITS.fieldValue),
        inline: false,
      });
    }
    const embed: DiscordEmbed = {
      title: clean(`${message.heading} - ${message.title}`, LIMITS.title),
      description: clean(description, LIMITS.description),
      color: COLORS[message.tone],
      fields,
      footer: { text: clean(message.footer, LIMITS.footer) },
    };
    if (links[0]) embed.url = links[0].url;

    // 합계 6000자 제한: 넘으면 뒤쪽 필드부터 덜어낸다.
    const total = () => (embed.title ?? '').length + embed.description.length + embed.footer.text.length + embed.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
    while (total() > LIMITS.total && embed.fields.length > 0) embed.fields.pop();
    if (total() > LIMITS.total) embed.description = truncateText(embed.description, Math.max(100, embed.description.length - (total() - LIMITS.total)));
    return { embeds: [embed], allowed_mentions: { parse: [] } };
  }

  /** 사용자 문구는 그대로 본문에 넣되 멘션·숨은 링크는 무력화한다. */
  formatText(text: string, tone: Tone): DiscordPayload {
    return {
      embeds: [{ description: clean(text, LIMITS.description), color: COLORS[tone], fields: [], footer: { text: 'pasukkun' } }],
      allowed_mentions: { parse: [] },
    };
  }

  async send(target: DiscordTarget, payload: DiscordPayload): Promise<SendResult> {
    if (!SNOWFLAKE.test(target.channelId)) return { status: 'PERMANENT', error: '채널 정보가 올바르지 않습니다.', statusCode: null, channelBroken: true };
    let response: Response;
    try {
      response = await this.fetchImpl(`${API_BASE}/channels/${target.channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${this.config.botToken}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (error instanceof DiscordApiError) return { status: 'PERMANENT', error: error.message, statusCode: null, channelBroken: false };
      return { status: 'RETRY', error: `네트워크 오류: ${error instanceof Error ? error.name : 'unknown'}`, statusCode: null, retryAfterMs: null };
    }
    const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string; retry_after?: number; code?: number };
    if (response.ok) return { status: 'SENT', providerMessageId: body.id ?? null };

    const description = truncateText(body.message ?? `HTTP ${response.status}`, 300);
    if (response.status === 429) {
      // retry_after 는 초 단위(소수 가능). 헤더보다 본문 값을 우선한다.
      const header = Number(response.headers.get('retry-after'));
      const seconds = typeof body.retry_after === 'number' ? body.retry_after : Number.isFinite(header) && header > 0 ? header : null;
      return { status: 'RETRY', error: `요청 제한(429): ${description}`, statusCode: 429, retryAfterMs: seconds === null ? null : Math.ceil(seconds * 1000) };
    }
    if (response.status >= 500) return { status: 'RETRY', error: description, statusCode: response.status, retryAfterMs: null };
    // 봇이 서버에서 나갔거나(50001), 채널 권한이 없거나(50013), 채널이 사라짐(10003): 다시 연결해야 한다.
    const brokenCodes = new Set([10003, 10004, 50001, 50013]);
    const channelBroken = response.status === 403 || response.status === 404 || (body.code !== undefined && brokenCodes.has(body.code));
    const reason =
      body.code === 50013 || body.code === 50001
        ? '봇에게 이 채널에 메시지를 보낼 권한이 없습니다. 채널 권한을 확인하거나 다시 연결해 주세요.'
        : body.code === 10003
          ? '채널을 찾을 수 없습니다. 삭제되었거나 봇이 서버에서 나갔습니다.'
          : description;
    return { status: 'PERMANENT', error: reason, statusCode: response.status, channelBroken };
  }
}
