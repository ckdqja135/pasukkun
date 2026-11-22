import { sign } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppEnv } from '../config/env.js';
import { APP_ENV } from '../db/db.module.js';
import { HttpError, fetchWithRetry, type FetchOptions } from '../common/http.js';

/**
 * 서비스 GitHub 앱 클라이언트.
 * - 사용자 토큰(ghu_)은 "이 사용자가 접근할 수 있는 저장소 목록"을 한 번 읽는 데만 쓰고 저장하지 않는다.
 * - 저장소 읽기는 앱 개인 키로 만든 JWT → 설치 토큰(1시간, 해당 저장소·contents:read 로 제한)으로 한다. 저장하지 않는다.
 * - lockfile 과 package.json 만 읽는다. 리다이렉트는 따르지 않는다.
 */
const API = 'https://api.github.com';
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_VERSION = '2026-03-10';
const MAX_INSTALLATIONS = 20;
const MAX_REPOS = 1000;
const MAX_TREE_DEPTH = 6;
const MAX_LOCKFILES_PER_REPO = 20;

export const LOCKFILE_BASENAMES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] as const;
const FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]{1,255}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

export interface AccessibleRepo {
  installationId: string;
  repoId: string;
  fullName: string;
  private: boolean;
  description: string;
  defaultBranch: string;
}

export interface RepoInfo {
  repoId: string;
  fullName: string;
  defaultBranch: string;
  description: string;
  archived: boolean;
}

export interface FoundLockfile {
  path: string;
  size: number;
}

/** 실패 사유. 외부 응답 본문이나 토큰은 담지 않는다. */
export class GithubAppError extends Error {
  constructor(
    readonly code: 'NOT_CONFIGURED' | 'NO_ACCESS' | 'NOT_FOUND' | 'TOO_LARGE' | 'RATE_LIMITED' | 'FAILED' | 'INVALID_RESPONSE',
    message: string,
  ) {
    super(message);
  }
}

export function isValidFullName(fullName: string): boolean {
  return FULL_NAME.test(fullName) && !fullName.split('/')[1].startsWith('.');
}

/** 저장소 안의 lockfile 경로만 허용한다: 상대 경로, ../ 없음, node_modules 아님, 이름은 세 가지 중 하나. */
export function isValidLockfilePath(path: string): boolean {
  if (path.length === 0 || path.length > 300) return false;
  const segments = path.split('/');
  if (segments.length > MAX_TREE_DEPTH + 1) return false;
  if (!segments.every((seg) => PATH_SEGMENT.test(seg) && seg !== '.' && seg !== '..' && seg !== 'node_modules')) return false;
  return (LOCKFILE_BASENAMES as readonly string[]).includes(segments[segments.length - 1]);
}

/** lockfile 옆의 package.json 경로 */
export function siblingPackageJson(lockfilePath: string): string {
  const dir = lockfilePath.includes('/') ? lockfilePath.slice(0, lockfilePath.lastIndexOf('/')) : '';
  return dir ? `${dir}/package.json` : 'package.json';
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const base64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');
const str = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');
const id = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null);

@Injectable()
export class GithubAppClient {
  /** 테스트에서 네트워크를 대체하기 위한 주입점 */
  fetchImpl: (url: string, options?: FetchOptions) => Promise<Response> = fetchWithRetry;

  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  enabled(): boolean {
    return this.env.githubApp !== null;
  }

  private get app() {
    if (!this.env.githubApp) throw new GithubAppError('NOT_CONFIGURED', 'GitHub 앱이 설정되지 않았습니다.');
    return this.env.githubApp;
  }

  /** 앱 설치(저장소 선택) 화면 주소 */
  installUrl(): string | null {
    return this.env.githubApp ? `https://github.com/apps/${encodeURIComponent(this.env.githubApp.slug)}/installations/select_target` : null;
  }

  authorizeUrl(params: { redirectUri: string; state: string; codeChallenge: string }): string {
    const query = new URLSearchParams({
      client_id: this.app.clientId,
      redirect_uri: params.redirectUri,
      state: params.state,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${AUTHORIZE_URL}?${query.toString()}`;
  }

  /** 앱 인증용 JWT (RS256, 10분 미만). 시계 오차를 감안해 발급 시각을 60초 앞당긴다. */
  appJwt(now = Date.now()): string {
    const seconds = Math.floor(now / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: this.app.clientId }));
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), this.app.privateKey);
    return `${header}.${payload}.${base64url(signature)}`;
  }

  private async call(path: string, token: string, init: { method?: string; body?: string; accept?: string } = {}): Promise<Response> {
    try {
      return await this.fetchImpl(`${API}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Accept: init.accept ?? 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          Authorization: `Bearer ${token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body,
        redirect: 'error',
        timeoutMs: 30_000,
        retries: 2,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        // 422: 설치 토큰을 요청한 저장소가 더 이상 그 설치에 없을 때
        if (error.status === 404 || error.status === 401 || error.status === 410 || error.status === 422) throw new GithubAppError('NOT_FOUND', 'GitHub 에서 찾을 수 없거나 접근 권한이 없습니다.');
        if (error.status === 403 && error.retryAfterMs === null) throw new GithubAppError('NO_ACCESS', 'GitHub 앱에 이 저장소를 읽을 권한이 없습니다.');
        if (error.status === 403 || error.status === 429) throw new GithubAppError('RATE_LIMITED', 'GitHub 요청 한도에 걸렸습니다. 잠시 후 다시 확인합니다.');
      }
      throw new GithubAppError('FAILED', 'GitHub 에 연결하지 못했습니다.');
    }
  }

  private async json<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch {
      throw new GithubAppError('INVALID_RESPONSE', 'GitHub 응답을 해석하지 못했습니다.');
    }
  }

  /** 인가 코드를 사용자 토큰으로 바꾼다. 코드는 한 번만 쓸 수 있으므로 재시도하지 않는다. */
  async exchangeCode(params: { code: string; codeVerifier: string; redirectUri: string }): Promise<string> {
    let token: unknown;
    try {
      const response = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.app.clientId,
          client_secret: this.app.clientSecret,
          code: params.code,
          redirect_uri: params.redirectUri,
          code_verifier: params.codeVerifier,
        }).toString(),
        redirect: 'error',
        timeoutMs: 15_000,
        retries: 0,
      });
      const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown };
      if (body.error === undefined) token = body.access_token;
    } catch {
      // 아래에서 같은 오류로 처리한다.
    }
    if (typeof token !== 'string' || token === '') throw new GithubAppError('FAILED', 'GitHub 인증을 완료하지 못했습니다.');
    return token;
  }

  /** 사용자 토큰으로 이 앱이 설치된 곳 중 사용자가 접근할 수 있는 저장소를 모두 읽는다. */
  async listAccessibleRepos(userToken: string): Promise<AccessibleRepo[]> {
    const installations: string[] = [];
    for (let page = 1; installations.length < MAX_INSTALLATIONS; page += 1) {
      const body = await this.json<{ installations?: Array<{ id?: unknown }> }>(
        await this.call(`/user/installations?per_page=100&page=${page}`, userToken),
      );
      const list = Array.isArray(body.installations) ? body.installations : [];
      for (const item of list) {
        const installationId = id(item.id);
        if (installationId && installations.length < MAX_INSTALLATIONS) installations.push(installationId);
      }
      if (list.length < 100) break;
    }
    const repos: AccessibleRepo[] = [];
    for (const installationId of installations) {
      for (let page = 1; repos.length < MAX_REPOS; page += 1) {
        const body = await this.json<{ repositories?: unknown[] }>(
          await this.call(`/user/installations/${installationId}/repositories?per_page=100&page=${page}`, userToken),
        );
        const list = Array.isArray(body.repositories) ? body.repositories : [];
        for (const raw of list) {
          const repo = this.toRepoInfo(raw);
          if (repo && !repo.archived && repos.length < MAX_REPOS) {
            repos.push({
              installationId,
              repoId: repo.repoId,
              fullName: repo.fullName,
              private: (raw as { private?: unknown }).private === true,
              description: repo.description,
              defaultBranch: repo.defaultBranch,
            });
          }
        }
        if (list.length < 100) break;
      }
    }
    return repos;
  }

  private toRepoInfo(raw: unknown): RepoInfo | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const repoId = id(r.id);
    const fullName = str(r.full_name, 200);
    const defaultBranch = str(r.default_branch, 255);
    if (!repoId || !isValidFullName(fullName) || !defaultBranch) return null;
    return { repoId, fullName, defaultBranch, description: str(r.description, 2000), archived: r.archived === true };
  }

  /** 설치 토큰 (1시간). 지정한 저장소, contents 읽기 권한으로만 제한한다. */
  async installationToken(installationId: string, repoIds: string[]): Promise<string> {
    if (!/^\d{1,20}$/.test(installationId) || repoIds.length === 0 || repoIds.length > 500 || !repoIds.every((r) => /^\d{1,20}$/.test(r))) {
      throw new GithubAppError('NOT_FOUND', '잘못된 저장소 정보입니다.');
    }
    const response = await this.call(`/app/installations/${installationId}/access_tokens`, this.appJwt(), {
      method: 'POST',
      body: JSON.stringify({ repository_ids: repoIds.map(Number), permissions: { contents: 'read' } }),
    });
    const body = await this.json<{ token?: unknown }>(response);
    if (typeof body.token !== 'string' || body.token === '') throw new GithubAppError('INVALID_RESPONSE', 'GitHub 응답을 해석하지 못했습니다.');
    return body.token;
  }

  /** 설치 토큰으로 접근할 수 있는 저장소(토큰을 제한한 저장소)의 현재 정보. 이름이 바뀌었으면 새 이름이 온다. */
  async installationRepos(token: string): Promise<RepoInfo[]> {
    const body = await this.json<{ repositories?: unknown[] }>(await this.call('/installation/repositories?per_page=100', token));
    return (Array.isArray(body.repositories) ? body.repositories : []).map((raw) => this.toRepoInfo(raw)).filter((r): r is RepoInfo => r !== null);
  }

  /** 브랜치 최신 커밋 SHA */
  async branchHead(token: string, fullName: string, branch: string): Promise<string> {
    this.assertRepo(fullName);
    const response = await this.call(`/repos/${fullName}/commits/${encodeURIComponent(branch)}`, token, { accept: 'application/vnd.github.sha' });
    const sha = (await response.text().catch(() => '')).trim();
    if (!COMMIT_SHA.test(sha)) throw new GithubAppError('INVALID_RESPONSE', 'GitHub 응답을 해석하지 못했습니다.');
    return sha;
  }

  /** 커밋 기준으로 저장소 안의 lockfile 위치를 찾는다 (node_modules 제외, 깊이 제한). */
  async findLockfiles(token: string, fullName: string, commitSha: string): Promise<{ lockfiles: FoundLockfile[]; truncated: boolean }> {
    this.assertRepo(fullName);
    if (!COMMIT_SHA.test(commitSha)) throw new GithubAppError('INVALID_RESPONSE', 'GitHub 응답을 해석하지 못했습니다.');
    const body = await this.json<{ tree?: unknown[]; truncated?: unknown }>(
      await this.call(`/repos/${fullName}/git/trees/${commitSha}?recursive=1`, token),
    );
    const found: FoundLockfile[] = [];
    for (const raw of Array.isArray(body.tree) ? body.tree : []) {
      const item = raw as { path?: unknown; type?: unknown; size?: unknown };
      if (item.type !== 'blob' || typeof item.path !== 'string' || !isValidLockfilePath(item.path)) continue;
      found.push({ path: item.path, size: typeof item.size === 'number' ? item.size : 0 });
    }
    found.sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
    return { lockfiles: found.slice(0, MAX_LOCKFILES_PER_REPO), truncated: body.truncated === true || found.length > MAX_LOCKFILES_PER_REPO };
  }

  /** 파일의 blob sha 와 크기. 없으면 null. */
  async fileMeta(token: string, fullName: string, path: string, ref: string): Promise<{ sha: string; size: number } | null> {
    this.assertRepo(fullName);
    try {
      const response = await this.call(`/repos/${fullName}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, token, {
        accept: 'application/vnd.github.object+json',
      });
      const body = await this.json<{ type?: unknown; sha?: unknown; size?: unknown }>(response);
      if (body.type !== 'file' || typeof body.sha !== 'string' || typeof body.size !== 'number') return null;
      return { sha: body.sha.slice(0, 64), size: body.size };
    } catch (error) {
      if (error instanceof GithubAppError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  /** 파일 원문. 크기 상한을 넘으면 읽기를 멈춘다. 없으면 null. */
  async fileText(token: string, fullName: string, path: string, ref: string, maxBytes: number): Promise<string | null> {
    this.assertRepo(fullName);
    let response: Response;
    try {
      response = await this.call(`/repos/${fullName}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, token, {
        accept: 'application/vnd.github.raw+json',
      });
    } catch (error) {
      if (error instanceof GithubAppError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new GithubAppError('TOO_LARGE', '파일이 너무 큽니다.');
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new GithubAppError('TOO_LARGE', '파일이 너무 큽니다.');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private assertRepo(fullName: string) {
    if (!isValidFullName(fullName)) throw new GithubAppError('NOT_FOUND', '잘못된 저장소 이름입니다.');
  }
}
