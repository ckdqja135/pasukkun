import type { NotificationMessage } from '../message.js';

export type SendResult =
  | { status: 'SENT'; providerMessageId: string | null }
  /** 일시적 실패. retryAfterMs 가 있으면 그만큼 기다린 뒤 다시 시도한다 (429). */
  | { status: 'RETRY'; error: string; statusCode: number | null; retryAfterMs: number | null }
  /** 재시도해도 소용없는 실패. channelBroken 이면 보낼 곳이 무효(봇 차단·추방, 채널 삭제 등)다. */
  | { status: 'PERMANENT'; error: string; statusCode: number | null; channelBroken: boolean };

export type Tone = NotificationMessage['tone'];

/**
 * 서비스 봇으로 보내는 채널의 공통 인터페이스.
 * 봇 키는 서버 설정에만 있고, 이용자별로는 "보낼 곳"(target)만 저장한다.
 * 형식 변환(길이 제한, 이스케이프, 멘션 방지)과 전송·오류 분류를 분리한다.
 */
export interface NotificationProvider<Target = unknown, Payload = unknown> {
  readonly type: 'TELEGRAM' | 'DISCORD';
  /** 서버에 봇이 설정되어 있는지 */
  enabled(): boolean;
  /** 기본 형식 */
  format(message: NotificationMessage): Payload;
  /** 사용자가 정한 문구 (일반 텍스트로 다룬다) */
  formatText(text: string, tone: Tone): Payload;
  send(target: Target, payload: Payload): Promise<SendResult>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
