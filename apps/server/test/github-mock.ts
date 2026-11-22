import { createHash, verify, type KeyObject } from 'node:crypto';
import { fetchWithRetry, type FetchOptions } from '../src/common/http.js';

/**
 * 서비스 GitHub 앱이 부르는 GitHub 를 흉내낸다.
 * - 인가 코드 "gh:<login>" → 사용자 토큰 "ghu_<login>"
 * - 앱 JWT 는 실제로 공개 키로 서명을 검증한다.
 * - 설치 토큰은 요청한 저장소로만 제한되고, 다른 저장소 요청은 404 로 막는다.
 */
export interface MockRepo {
  id: number;
  fullName: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  installationId: number;
  head: string;
  files: Map<string, string>;
}

export interface GithubAppMock {
  clientId: string;
  repos: Map<number, MockRepo>;
  /** 설치별로 앱에 허용된 저장소 */
  installations: Map<number, Set<number>>;
  /** GitHub 사용자(login)별로 접근할 수 있는 설치 */
  userInstallations: Map<string, number[]>;
  /** 받은 요청 (메서드, 경로, Authorization 종류) */
  calls: Array<{ method: string; url: string; auth: string }>;
  /** 발급한 설치 토큰 요청 본문 */
  tokenRequests: Array<{ installationId: number; body: Record<string, unknown> }>;
  /** 토큰 교환 요청 본문 */
  exchanges: URLSearchParams[];
  setFile(repoId: number, path: string, content: string): void;
  reset(): void;
}

const blobSha = (content: string) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notFound = () => json({ message: 'Not Found' }, 404);

function verifyJwt(token: string, publicKey: KeyObject, clientId: string): boolean {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return false;
  const ok = verify('sha256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'));
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { iat: number; exp: number; iss: string };
  const now = Math.floor(Date.now() / 1000);
  return ok && claims.iss === clientId && claims.iat <= now && claims.exp > now && claims.exp - claims.iat <= 600;
}

export function createGithubAppMock(publicKey: KeyObject, clientId: string) {
  const issued = new Map<string, Set<number>>();
  let tokenSeq = 0;

  const mock: GithubAppMock = {
    clientId,
    repos: new Map(),
    installations: new Map(),
    userInstallations: new Map(),
    calls: [],
    tokenRequests: [],
    exchanges: [],
    setFile(repoId, path, content) {
      const repo = mock.repos.get(repoId);
      if (!repo) throw new Error(`no repo ${repoId}`);
      repo.files.set(path, content);
      repo.head = createHash('sha1').update(`${repo.head}:${path}:${content}`).digest('hex');
    },
    reset() {
      mock.repos.clear();
      mock.installations.clear();
      mock.userInstallations.clear();
      mock.calls.length = 0;
      mock.tokenRequests.length = 0;
      mock.exchanges.length = 0;
      issued.clear();
    },
  };

  const repoJson = (repo: MockRepo) => ({
    id: repo.id,
    full_name: repo.fullName,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    archived: false,
  });

  const fake = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const auth = String(headers.Authorization ?? '');
    const method = init.method ?? 'GET';
    mock.calls.push({ method, url, auth: auth.split('_')[0].replace('Bearer ', '') || '-' });

    if (url === 'https://github.com/login/oauth/access_token') {
      const body = new URLSearchParams(String(init.body));
      mock.exchanges.push(body);
      const code = body.get('code') ?? '';
      if (!code.startsWith('gh:') || body.get('client_id') !== clientId || !body.get('code_verifier')) return json({ error: 'bad_verification_code' });
      return json({ access_token: `ghu_${code.slice(3)}`, token_type: 'bearer' });
    }

    const { pathname, searchParams } = new URL(url);
    const page = Number(searchParams.get('page') ?? '1');

    // 사용자 토큰으로 부르는 API
    if (auth.startsWith('Bearer ghu_')) {
      const login = auth.slice('Bearer ghu_'.length);
      const allowed = mock.userInstallations.get(login) ?? [];
      if (pathname === '/user/installations') return json({ total_count: allowed.length, installations: page === 1 ? allowed.map((id) => ({ id })) : [] });
      const match = /^\/user\/installations\/(\d+)\/repositories$/.exec(pathname);
      if (match && allowed.includes(Number(match[1]))) {
        const ids = [...(mock.installations.get(Number(match[1])) ?? [])];
        return json({ total_count: ids.length, repositories: page === 1 ? ids.map((id) => repoJson(mock.repos.get(id)!)) : [] });
      }
      return notFound();
    }

    // 앱 JWT 로 설치 토큰 발급
    const tokenMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(pathname);
    if (tokenMatch && method === 'POST') {
      if (!verifyJwt(auth.replace('Bearer ', ''), publicKey, clientId)) return json({ message: 'Bad credentials' }, 401);
      const installationId = Number(tokenMatch[1]);
      const installed = mock.installations.get(installationId);
      if (!installed) return notFound();
      const body = JSON.parse(String(init.body)) as { repository_ids?: number[] };
      mock.tokenRequests.push({ installationId, body });
      const ids = body.repository_ids ?? [];
      if (ids.length === 0 || ids.some((id) => !installed.has(id))) return json({ message: 'There is at least one repository that does not exist or is not accessible to the parent installation.' }, 422);
      const token = `ghs_fixture${(tokenSeq += 1)}`;
      issued.set(token, new Set(ids));
      return json({ token, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }

    // 설치 토큰으로 부르는 API: 토큰이 허용된 저장소만 보인다.
    const scope = issued.get(auth.replace('Bearer ', ''));
    if (!scope) return json({ message: 'Bad credentials' }, 401);
    const visible = (repo: MockRepo | undefined): repo is MockRepo =>
      repo !== undefined && scope.has(repo.id) && (mock.installations.get(repo.installationId)?.has(repo.id) ?? false);
    if (pathname === '/installation/repositories') {
      const list = [...scope].map((id) => mock.repos.get(id)).filter(visible);
      return json({ total_count: list.length, repositories: list.map(repoJson) });
    }
    const repoMatch = /^\/repos\/([^/]+\/[^/]+)\/(.*)$/.exec(pathname);
    const repo = repoMatch ? [...mock.repos.values()].find((r) => r.fullName === repoMatch[1]) : undefined;
    if (!repoMatch || !visible(repo)) return notFound();
    const rest = repoMatch[2];
    if (rest === `commits/${encodeURIComponent(repo.defaultBranch)}` && headers.Accept === 'application/vnd.github.sha') {
      return new Response(repo.head, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (rest === `git/trees/${repo.head}`) {
      const tree = [...repo.files.keys()].flatMap((path) => {
        const dirs = path.split('/').slice(0, -1).map((_, i, all) => ({ path: all.slice(0, i + 1).join('/'), type: 'tree' }));
        return [...dirs, { path, type: 'blob', sha: blobSha(repo.files.get(path)!), size: Buffer.byteLength(repo.files.get(path)!) }];
      });
      return json({ sha: repo.head, tree, truncated: false });
    }
    if (rest.startsWith('contents/')) {
      const path = rest.slice('contents/'.length).split('/').map(decodeURIComponent).join('/');
      const content = repo.files.get(path);
      if (content === undefined) return notFound();
      if (headers.Accept === 'application/vnd.github.raw+json') {
        return new Response(content, { status: 200, headers: { 'content-type': 'application/vnd.github.raw', 'content-length': String(Buffer.byteLength(content)) } });
      }
      return json({ type: 'file', path, sha: blobSha(content), size: Buffer.byteLength(content), content: '', encoding: 'none' });
    }
    return notFound();
  };

  /** GithubAppClient.fetchImpl 대체: 실제 fetchWithRetry 의 오류 처리를 그대로 쓰되 네트워크만 바꾼다. */
  const fetchImpl = (url: string, options: FetchOptions = {}) =>
    fetchWithRetry(url, { ...options, retries: 0, fetchImpl: fake as typeof fetch });

  return { mock, fetchImpl };
}
