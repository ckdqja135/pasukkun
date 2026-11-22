/**
 * 외부 API 호출용 fetch 래퍼: 타임아웃, 429/5xx 재시도, Retry-After 준수, 지수 백오프.
 * 리다이렉트를 허용할지 호출부가 명시한다.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly bodySnippet: string,
    readonly retryAfterMs: number | null,
  ) {
    // 메시지에는 상태 코드와 호스트·경로만 담는다. 응답 본문과 쿼리 문자열은 넣지 않는다
    // (본문에는 서버의 공인 IP 나 요청 내용이 되돌아올 수 있고, 이 메시지는 로그와 수집 상태 화면에 남는다).
    super(`HTTP ${status} ${describeTarget(url)}${hint(status, retryAfterMs)}`);
  }
}

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retries?: number;
  redirect?: 'follow' | 'error' | 'manual';
  /** 테스트에서 대기 시간을 없애기 위한 주입점 */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export const USER_AGENT = 'pasukkun/0.1 (vulnerability monitor)';

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 토큰이 경로에 들어가는 URL(Telegram, Discord)을 로그에 남기지 않도록 가린다. */
export function redactUrl(url: string): string {
  return url
    .replace(/(api\.telegram\.org\/bot)[^/]+/i, '$1***')
    .replace(/(\/api(?:\/v\d+)?\/webhooks\/\d+\/)[^/?]+/i, '$1***')
    .replace(/([?&](?:apiKey|token|key)=)[^&]+/gi, '$1***');
}

/** 로그·상태 화면용 요청 대상 표기: 호스트와 경로만 (쿼리 문자열 제외) */
export function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return redactUrl(`${parsed.origin}${parsed.pathname}`);
  } catch {
    return '(알 수 없는 주소)';
  }
}

function hint(status: number, retryAfterMs: number | null): string {
  if (status === 429 || (status === 403 && retryAfterMs !== null)) {
    const minutes = retryAfterMs !== null ? ` 약 ${Math.max(1, Math.ceil(retryAfterMs / 60_000))}분 뒤 다시 시도할 수 있습니다.` : '';
    return ` - 요청 한도 초과.${minutes}`;
  }
  return '';
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export function backoffMs(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

export async function fetchWithRetry(url: string, options: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 30_000, retries = 4, sleep = defaultSleep, fetchImpl = fetch } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: options.method ?? 'GET',
        headers: { 'User-Agent': USER_AGENT, ...options.headers },
        body: options.body,
        redirect: options.redirect ?? 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // 네트워크 오류·타임아웃
      lastError = error;
      if (attempt === retries) break;
      await sleep(backoffMs(attempt));
      continue;
    }
    if (response.ok) return response;

    const resetHeader = response.headers.get('x-ratelimit-reset');
    const retryAfterMs =
      parseRetryAfter(response.headers.get('retry-after')) ??
      (response.headers.get('x-ratelimit-remaining') === '0' && resetHeader
        ? Math.max(0, Number(resetHeader) * 1000 - Date.now())
        : null);
    const snippet = (await response.text().catch(() => '')).slice(0, 200);
    const error = new HttpError(response.status, url, snippet, retryAfterMs);
    const retryable =
      response.status === 429 || response.status >= 500 || (response.status === 403 && retryAfterMs !== null);
    // 대기 시간이 지나치게 길면 이번 실행에서는 포기하고 다음 주기에 맡긴다.
    if (!retryable || attempt === retries || (retryAfterMs !== null && retryAfterMs > 5 * 60_000)) throw error;
    await sleep(retryAfterMs ?? backoffMs(attempt));
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`요청 실패 ${describeTarget(url)}: ${message}`);
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const response = await fetchWithRetry(url, options);
  return (await response.json()) as T;
}
