import type { Request } from 'express';

export interface AuthUser {
  id: string;
  /** GitHub 아이디 (표시용) */
  login: string;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
  sessionId?: string;
  csrfToken?: string;
}

export const SESSION_COOKIE = 'psk_session';
/** OAuth 진행 중에만 쓰는 쿠키: state 와 PKCE code_verifier */
export const OAUTH_COOKIE = 'psk_oauth';
