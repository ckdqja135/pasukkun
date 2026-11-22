import { Inject, Injectable } from '@nestjs/common';
import type { AppEnv } from '../../config/env.js';
import { APP_ENV } from '../../db/db.module.js';
import type { NotificationMessage } from '../message.js';
import { truncateText, type FetchLike, type NotificationProvider, type SendResult, type Tone } from './provider.js';

/**
 * 서비스 텔레그램 봇 (https://core.telegram.org/bots/api).
 * 봇 토큰은 서버 설정(TELEGRAM_BOT_TOKEN)에만 있다. 이용자는 봇과 대화를 시작해 연결하고, 우리는 chat_id 만 저장한다.
 * 토큰이 URL 경로에 들어가므로 URL 을 로그·오류에 남기지 않는다.
 */
export interface TelegramTarget {
  chatId: string;
}

export interface TelegramPayload {
  text: string;
  parse_mode: 'HTML';
  link_preview_options: { is_disabled: true };
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: TelegramChat;
    from?: { id: number; username?: string; first_name?: string };
    /** 그룹이 슈퍼그룹으로 바뀌면 오는 새 chat id */
    migrate_to_chat_id?: number;
  };
  my_chat_member?: { chat: TelegramChat; new_chat_member?: { status?: string } };
}

const API_HOST = 'https://api.telegram.org';
const MAX_TEXT = 4096;

/** HTML parse_mode 에서 반드시 바꿔야 하는 문자 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(url: string): string {
  return escapeHtml(url).replace(/"/g, '&quot;');
}

interface TelegramResponse<T = unknown> {
  ok?: boolean;
  description?: string;
  error_code?: number;
  result?: T;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export class TelegramApiError extends Error {
  constructor(
    readonly status: number,
    description: string,
  ) {
    super(description);
  }
}

@Injectable()
export class TelegramProvider implements NotificationProvider<TelegramTarget, TelegramPayload> {
  readonly type = 'TELEGRAM' as const;
  /** 테스트에서 네트워크를 대체하기 위한 주입점 */
  fetchImpl: FetchLike = (url, init) => fetch(url, init);
  private username: string | null = null;

  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  enabled(): boolean {
    return Boolean(this.env.telegramBotToken);
  }

  private async call<T>(method: string, body: object, timeoutMs = 20_000): Promise<{ status: number; data: TelegramResponse<T> }> {
    const token = this.env.telegramBotToken;
    if (!token) throw new TelegramApiError(0, '텔레그램 봇이 설정되지 않았습니다.');
    const response = await this.fetchImpl(`${API_HOST}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await response.json().catch(() => ({}))) as TelegramResponse<T>;
    return { status: response.status, data };
  }

  /** 연결 링크에 쓰는 봇 아이디 (getMe 결과를 기억해 둔다) */
  async botUsername(): Promise<string | null> {
    if (this.username) return this.username;
    try {
      const { status, data } = await this.call<{ username?: string }>('getMe', {});
      if (status === 200 && data.ok && data.result?.username) this.username = data.result.username;
    } catch {
      // 네트워크 오류: 다음에 다시 시도한다.
    }
    return this.username;
  }

  /** 긴 폴링으로 새 메시지를 받는다. 서버 주소를 외부에 열 필요가 없다. */
  async getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    const { status, data } = await this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'my_chat_member'] },
      (timeoutSeconds + 15) * 1000,
    );
    if (status !== 200 || !data.ok || !Array.isArray(data.result)) {
      throw new TelegramApiError(status, truncateText(data.description ?? `HTTP ${status}`, 200));
    }
    return data.result;
  }

  format(message: NotificationMessage): TelegramPayload {
    const lines: string[] = [`<b>${escapeHtml(message.heading)}</b>`, `<b>${escapeHtml(message.title)}</b>`];
    if (message.identifiers.length) lines.push(`<code>${escapeHtml(message.identifiers.join(' · '))}</code>`);
    if (message.lead) lines.push('', escapeHtml(message.lead));
    lines.push('');
    for (const field of message.fields) {
      lines.push(`<b>${escapeHtml(field.label)}</b>: ${escapeHtml(field.value)}`);
    }
    const links = message.links
      .filter((link) => /^https?:\/\//i.test(link.url))
      .map((link) => `<a href="${escapeAttribute(link.url)}">${escapeHtml(link.label)}</a>`);
    const tail = [...(links.length ? ['', links.join(' | ')] : []), '', `<i>${escapeHtml(message.footer)}</i>`];

    // 길이 제한(4096자)을 넘으면 필드 본문부터 줄인다. 태그가 중간에 잘리지 않도록 줄 단위로 처리한다.
    let body = lines;
    const size = (parts: string[]) => [...parts, ...tail].join('\n').length;
    while (size(body) > MAX_TEXT && body.length > 3) body = body.slice(0, -1);
    let text = [...body, ...tail].join('\n');
    if (text.length > MAX_TEXT) {
      text = `<b>${escapeHtml(truncateText(message.heading, 100))}</b>\n${escapeHtml(truncateText(message.title, 500))}`;
    }
    return { text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  }

  /** 사용자 문구는 전부 일반 텍스트로 다룬다 (HTML 로 해석하지 않는다). */
  formatText(text: string, _tone: Tone): TelegramPayload {
    void _tone;
    let raw = text;
    while (escapeHtml(raw).length > MAX_TEXT) raw = raw.slice(0, Math.max(0, raw.length - 200));
    return { text: escapeHtml(raw === text ? raw : `${raw}…`) || '-', parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  }

  async send(target: TelegramTarget, payload: TelegramPayload): Promise<SendResult> {
    let status: number;
    let data: TelegramResponse<{ message_id?: number }>;
    try {
      ({ status, data } = await this.call<{ message_id?: number }>('sendMessage', { chat_id: target.chatId, ...payload }));
    } catch (error) {
      // 예외 메시지에 URL(토큰 포함)이 섞이지 않도록 종류만 남긴다.
      if (error instanceof TelegramApiError) return { status: 'PERMANENT', error: error.message, statusCode: null, channelBroken: false };
      return { status: 'RETRY', error: `네트워크 오류: ${error instanceof Error ? error.name : 'unknown'}`, statusCode: null, retryAfterMs: null };
    }
    if (status === 200 && data.ok) {
      return { status: 'SENT', providerMessageId: data.result?.message_id !== undefined ? String(data.result.message_id) : null };
    }
    const description = truncateText(data.description ?? `HTTP ${status}`, 300);
    if (status === 429) {
      const seconds = data.parameters?.retry_after;
      return { status: 'RETRY', error: `요청 제한(429): ${description}`, statusCode: 429, retryAfterMs: typeof seconds === 'number' ? seconds * 1000 : null };
    }
    if (status >= 500) return { status: 'RETRY', error: description, statusCode: status, retryAfterMs: null };
    if (data.parameters?.migrate_to_chat_id !== undefined) {
      return { status: 'PERMANENT', error: '그룹이 슈퍼그룹으로 바뀌었습니다. 텔레그램을 다시 연결해 주세요.', statusCode: status, channelBroken: true };
    }
    // 403(봇 차단·강퇴), 400 chat not found 등: 다시 연결하기 전에는 보낼 수 없다.
    const channelBroken = status === 403 || status === 404 || /chat not found|bot was blocked|bot was kicked|deactivated/i.test(description);
    return { status: 'PERMANENT', error: description, statusCode: status, channelBroken };
  }
}
