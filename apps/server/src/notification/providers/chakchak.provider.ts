import { Inject, Injectable } from '@nestjs/common';
import type { AppEnv } from '../../config/env.js';
import { APP_ENV } from '../../db/db.module.js';
import type { NotificationMessage } from '../message.js';
import { truncateText, type FetchLike, type NotificationProvider, type SendResult, type Tone } from './provider.js';

/**
 * 착착 커스텀 봇.
 * 착착에서 봇을 만들어 채널에 초대하고 [알림 받기]로 만든 받는 주소(토큰 포함)를 서버 설정(CHAKCHAK_BOT_URL)에 둔다.
 * 이 주소로 보내면 봇이 그 채널에 글을 올린다. 보낼 곳이 주소 하나로 정해져 있어 이용자별로 저장하는 값은 없다.
 * 주소에 토큰이 들어 있으므로 주소를 로그·오류에 남기지 않는다.
 */
export type ChakchakTarget = Record<string, never>;

export interface ChakchakPayload {
  text: string;
}

/** 착착이 올리는 글의 한도 */
const MAX_TEXT = 8000;

/**
 * 외부 공지 문구가 착착 마크다운의 멘션(@[이름](id), @channel·@here 포함)이나 숨은 링크([보이는 글자](주소))로 바뀌지 않게 한다.
 * 링크 주소는 그대로 보이게 둔다 (주소 자체는 자동 링크가 되어도 무엇으로 가는지 보인다).
 */
export function neutralizeMarkdown(text: string): string {
  return text.replace(/@\[/g, '@​[').replace(/\]\(/g, ']​(');
}

@Injectable()
export class ChakchakProvider implements NotificationProvider<ChakchakTarget, ChakchakPayload> {
  readonly type = 'CHAKCHAK' as const;
  /** 테스트에서 네트워크를 대체하기 위한 주입점 */
  fetchImpl: FetchLike = (url, init) => fetch(url, init);

  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  enabled(): boolean {
    return Boolean(this.env.chakchakBotUrl);
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
    const tail = [...(links.length ? ['', links.join(' | ')] : []), '', plain(message.footer)];

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

  async send(_target: ChakchakTarget, payload: ChakchakPayload): Promise<SendResult> {
    void _target;
    const url = this.env.chakchakBotUrl;
    if (!url) return { status: 'PERMANENT', error: '착착 받는 주소가 설정되지 않았습니다.', statusCode: null, channelBroken: false };
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      // 예외 메시지에 주소(토큰 포함)가 섞이지 않도록 종류만 남긴다.
      return { status: 'RETRY', error: `네트워크 오류: ${error instanceof Error ? error.name : 'unknown'}`, statusCode: null, retryAfterMs: null };
    }
    // 실패하면 착착은 { success: false, code, data: 이유 } 로 답한다 (data 는 글자 또는 글자 목록).
    const data = (await response.json().catch(() => ({}))) as { id?: unknown; data?: unknown };
    if (response.ok) return { status: 'SENT', providerMessageId: typeof data.id === 'number' || typeof data.id === 'string' ? String(data.id) : null };
    const detail = truncateText(Array.isArray(data.data) ? data.data.join(', ') : typeof data.data === 'string' ? data.data : `HTTP ${response.status}`, 300);
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      return { status: 'RETRY', error: `요청 제한(429): ${detail}`, statusCode: 429, retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null };
    }
    if (response.status >= 500) return { status: 'RETRY', error: detail, statusCode: response.status, retryAfterMs: null };
    // 404: 착착에서 받는 주소를 지웠다. 새 주소를 넣기 전에는 보낼 수 없다.
    if (response.status === 404) {
      return {
        status: 'PERMANENT',
        error: '착착 봇의 받는 주소가 없어졌습니다. 착착에서 새 받는 주소를 만들어 서버 설정(CHAKCHAK_BOT_URL)을 바꾼 뒤 다시 연결해 주세요.',
        statusCode: 404,
        channelBroken: true,
      };
    }
    // 403: 받는 주소를 꺼 두었거나 봇이 채널에서 빠졌다. 착착에서 고친 뒤 다시 연결한다.
    if (response.status === 403) return { status: 'PERMANENT', error: `착착: ${detail} 고친 뒤 다시 연결해 주세요.`, statusCode: 403, channelBroken: true };
    return { status: 'PERMANENT', error: detail, statusCode: response.status, channelBroken: false };
  }
}
