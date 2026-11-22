import { Injectable } from '@nestjs/common';

/**
 * GitHub OAuth App 웹 흐름 (https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).
 * - state(CSRF 방지)와 PKCE(S256)를 함께 쓴다.
 * - 권한(scope)을 요청하지 않는다: 공개 프로필(id, login, name)만 읽는다.
 * - 받은 access token 은 프로필을 한 번 읽는 데만 쓰고 저장하지 않는다.
 */
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const API_VERSION = '2026-03-10';
const USER_AGENT = 'pasukkun/0.1';
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface GithubProfile {
  /** 변하지 않는 사용자 ID */
  id: string;
  login: string;
  name: string | null;
}

/** 로그인 실패 사유. 화면에 보여줄 코드로만 쓰고, 외부 응답 내용은 담지 않는다. */
export class OAuthError extends Error {
  constructor(readonly code: 'github_error' | 'invalid_profile') {
    super(code);
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

@Injectable()
export class GithubOAuthClient {
  /** 테스트에서 네트워크를 대체하기 위한 주입점 */
  fetchImpl: FetchLike = (url, init) => fetch(url, init);

  authorizeUrl(params: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
    const query = new URLSearchParams({
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      state: params.state,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      allow_signup: 'true',
    });
    return `${AUTHORIZE_URL}?${query.toString()}`;
  }

  /** 인가 코드를 access token 으로 바꾼 뒤 공개 프로필을 읽는다. */
  async fetchProfile(params: { clientId: string; clientSecret: string; code: string; redirectUri: string; codeVerifier: string }): Promise<GithubProfile> {
    let token: string | undefined;
    try {
      const response = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body: new URLSearchParams({
          client_id: params.clientId,
          client_secret: params.clientSecret,
          code: params.code,
          redirect_uri: params.redirectUri,
          code_verifier: params.codeVerifier,
        }).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown };
      // 실패하면 200 응답에 error 필드가 담겨 올 수 있다.
      if (response.ok && typeof body.access_token === 'string' && body.access_token !== '' && body.error === undefined) {
        token = body.access_token;
      }
    } catch {
      // 네트워크 오류·시간 초과: 아래에서 같은 오류로 처리한다.
    }
    if (!token) throw new OAuthError('github_error');

    let profile: { id?: unknown; login?: unknown; name?: unknown };
    try {
      const response = await this.fetchImpl(USER_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          Authorization: `Bearer ${token}`,
          'User-Agent': USER_AGENT,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new OAuthError('github_error');
      profile = (await response.json()) as typeof profile;
    } catch {
      throw new OAuthError('github_error');
    }
    const id = typeof profile.id === 'number' && Number.isSafeInteger(profile.id) && profile.id > 0 ? String(profile.id) : null;
    const login = typeof profile.login === 'string' && LOGIN_PATTERN.test(profile.login) ? profile.login : null;
    if (!id || !login) throw new OAuthError('invalid_profile');
    const name = typeof profile.name === 'string' && profile.name.trim() !== '' ? profile.name.trim().slice(0, 100) : null;
    return { id, login, name };
  }
}
