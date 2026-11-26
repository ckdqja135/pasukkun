import { Inject, Injectable } from '@nestjs/common';
import type { AppEnv } from '../../config/env.js';
import { APP_ENV } from '../../db/db.module.js';
import type { NotificationMessage } from '../message.js';
import { truncateText, type FetchLike, type NotificationProvider, type SendResult, type Tone } from './provider.js';

/**
 * 착착 커스텀 봇 (착착 앱 API, Authorization: Bearer <봇 토큰>).
 * 서버 주소와 봇 토큰은 서버 설정(CHAKCHAK_URL, CHAKCHAK_BOT_TOKEN)에만 있다.
 * 착착에서 봇을 여러 채널에 초대해 두면 이용자는 그중 하나를 골라 연결하고, 우리는 채널 이름만 저장한다.
 * 채널마다 따로 보내므로 한 채널이 끊겨도 다른 채널은 그대로 받는다.
 */
export interface ChakchakTarget {
  channel: string;
}

export interface ChakchakPayload {
  text: string;
}

export interface ChakchakChannel {
  name: string;
  private: boolean;
}

export class ChakchakApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 착착이 받는 글의 한도 */
const MAX_TEXT = 8000;

/**
 * 외부 공지 문구가 착착 마크다운의 멘션(@[이름](id), @channel·@here 포함)이나 숨은 링크([보이는 글자](주소))로 바뀌지 않게 한다.
 * 링크 주소는 그대로 보이게 둔다 (주소 자체는 자동 링크가 되어도 무엇으로 가는지 보인다).
 */
export function neutralizeMarkdown(text: string): string {
  return text.replace(/@\[/g, '@​[').replace(/\]\(/g, ']​(');
}

/** 실패하면 착착은 { success: false, code, data: 이유 } 로 답한다 (data 는 글자 또는 글자 목록). */
function reasonOf(status: number, body: { data?: unknown }): string {
  const reason = Array.isArray(body.data) ? body.data.join(', ') : typeof body.data === 'string' ? body.data : `HTTP ${status}`;
  return truncateText(reason, 300);
}

@Injectable()
export class ChakchakProvider implements NotificationProvider<ChakchakTarget, ChakchakPayload> {
  readonly type = 'CHAKCHAK' as const;
  /** 테스트에서 네트워크를 대체하기 위한 주입점 */
  fetchImpl: FetchLike = (url, init) => fetch(url, init);

  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  enabled(): boolean {
    return Boolean(this.env.chakchak);
  }

  private async call(path: string, body?: object): Promise<{ status: number; headers: Headers; data: Record<string, unknown> }> {
    const config = this.env.chakchak;
    if (!config) throw new ChakchakApiError(0, '착착 봇이 설정되지 않았습니다.');
    const response = await this.fetchImpl(`${config.url}/api/apps/v1/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${config.botToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, headers: response.headers, data };
  }

  /** 봇이 들어가 있어 글을 올릴 수 있는 채널 (보관된 채널 제외) */
  async listChannels(): Promise<ChakchakChannel[]> {
    let result: Awaited<ReturnType<ChakchakProvider['call']>>;
    try {
      result = await this.call('channels');
    } catch (error) {
      if (error instanceof ChakchakApiError) throw error;
      throw new ChakchakApiError(0, '착착 서버에 연결하지 못했습니다.');
    }
    const { status, data } = result;
    if (status === 401) throw new ChakchakApiError(401, '착착 봇 토큰이 올바르지 않습니다. 서버 설정(CHAKCHAK_BOT_TOKEN)을 확인해 주세요.');
    if (status !== 200 || !Array.isArray(data)) throw new ChakchakApiError(status, reasonOf(status, data));
    return (data as Array<{ name?: unknown; private?: unknown; archived?: unknown; isMember?: unknown }>)
      .filter((row) => typeof row.name === 'string' && row.isMember === true && row.archived !== true)
      .map((row) => ({ name: row.name as string, private: row.private === true }));
  }

  format(message: NotificationMessage): ChakchakPayload {
    const plain = (text: string) => neutralizeMarkdown(text.replace(/\*\*/g, '*​*'));
    const lines: string[] = [`**${plain(message.heading)}**`, `**${plain(message.title)}**`];
    if (message.identifiers.length) lines.push(plain(message.identifiers.join(' · ')));
    if (message.lead) lines.push('', plain(message.lead));
    lines.push('');
    for (const field of message.fields) lines.push(`**${plain(field.label)}**: ${plain(field.value)}`);
    const links = message.links
      .filter((link) => /^https?:\/\/[^\s)]+$/i.test(link.url))
      .map((link) => `[${plain(link.label).replace(/[[\]]/g, '')}](${link.url})`);
    const tail = [...(links.length ? ['', links.join(' | ')] : []), ...(message.footer ? ['', plain(message.footer)] : [])];

    // 길이 제한을 넘으면 필드 본문부터 줄인다 (줄 단위로 잘라 꾸밈 문법이 중간에 끊기지 않게).
    let body = lines;
    const size = (parts: string[]) => [...parts, ...tail].join('\n').length;
    while (size(body) > MAX_TEXT && body.length > 3) body = body.slice(0, -1);
    let text = [...body, ...tail].join('\n');
    if (text.length > MAX_TEXT) text = `**${plain(truncateText(message.heading, 100))}**\n${plain(truncateText(message.title, 500))}`;
    return { text };
  }

  /** 사용자 문구는 꾸밈 없이 보낸다 (멘션·숨은 링크만 막는다). */
  formatText(text: string, _tone: Tone): ChakchakPayload {
    void _tone;
    return { text: neutralizeMarkdown(truncateText(text, MAX_TEXT)) || '-' };
  }

  async send(target: ChakchakTarget, payload: ChakchakPayload): Promise<SendResult> {
    if (typeof target?.channel !== 'string' || target.channel === '') {
      return { status: 'PERMANENT', error: '채널 정보가 올바르지 않습니다.', statusCode: null, channelBroken: true };
    }
    let result: Awaited<ReturnType<ChakchakProvider['call']>>;
    try {
      result = await this.call('chat.postMessage', { channel: target.channel, text: payload.text });
    } catch (error) {
      if (error instanceof ChakchakApiError) return { status: 'PERMANENT', error: error.message, statusCode: null, channelBroken: false };
      // 예외 메시지에 요청 정보가 섞이지 않도록 종류만 남긴다.
      return { status: 'RETRY', error: `네트워크 오류: ${error instanceof Error ? error.name : 'unknown'}`, statusCode: null, retryAfterMs: null };
    }
    const { status, headers, data } = result;
    if (status >= 200 && status < 300) {
      const id = data.messageId;
      return { status: 'SENT', providerMessageId: typeof id === 'number' || typeof id === 'string' ? String(id) : null };
    }
    const reason = reasonOf(status, data);
    if (status === 429) {
      const seconds = Number(headers.get('retry-after'));
      return { status: 'RETRY', error: `요청 제한(429): ${reason}`, statusCode: 429, retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null };
    }
    if (status >= 500) return { status: 'RETRY', error: reason, statusCode: status, retryAfterMs: null };
    if (status === 401) {
      return { status: 'PERMANENT', error: '착착 봇 토큰이 올바르지 않습니다. 서버 설정(CHAKCHAK_BOT_TOKEN)을 고친 뒤 다시 연결해 주세요.', statusCode: 401, channelBroken: true };
    }
    // 403: 봇이 채널에서 빠졌거나 채널이 보관됨. 404: 채널이 지워졌거나 이름이 바뀜. 착착에서 고친 뒤 다시 연결한다.
    if (status === 403 || status === 404) return { status: 'PERMANENT', error: `착착: ${reason} 고친 뒤 다시 연결해 주세요.`, statusCode: status, channelBroken: true };
    return { status: 'PERMANENT', error: reason, statusCode: status, channelBroken: false };
  }
}
