import type { AppEnv } from '../config/env.js';

/** 허용 목록(GitHub 아이디)이 비어 있으면 누구나 들어올 수 있다. 아이디는 대소문자를 구분하지 않는다. */
export function isAllowedLogin(env: Pick<AppEnv, 'allowedGithubUsers'>, login: string): boolean {
  return env.allowedGithubUsers.length === 0 || env.allowedGithubUsers.includes(login.toLowerCase());
}
