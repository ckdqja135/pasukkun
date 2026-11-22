import type { paths, Schemas } from '@pasukkun/api-types';
import createClient from 'openapi-fetch';

export type { Schemas };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let csrfToken = '';
export function setCsrfToken(token: string): void {
  csrfToken = token;
}

/** 세션이 끊겼을 때 화면을 로그인으로 돌리기 위한 훅 */
let onUnauthorized: () => void = () => undefined;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

/** 프론트와 같은 출처의 /api 로만 호출한다 (프록시가 백엔드로 전달). */
export const api = createClient<paths>({ baseUrl: '', credentials: 'same-origin' });

api.use({
  onRequest({ request }) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && csrfToken) {
      request.headers.set('X-CSRF-Token', csrfToken);
    }
    return request;
  },
});

interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

function errorMessage(error: unknown, status: number): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message;
    if (Array.isArray(message)) return message.join(' / ');
    if (typeof message === 'string') return message;
    if (message && typeof message === 'object' && 'message' in message) return String((message as { message: unknown }).message);
  }
  if (status === 429) return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  if (status >= 500) return '서버 오류가 발생했습니다.';
  return `요청을 처리하지 못했습니다 (HTTP ${status}).`;
}

/** openapi-fetch 결과에서 데이터를 꺼내고, 실패는 ApiError 로 던진다. */
export async function unwrap<T>(promise: Promise<FetchResult<T>>): Promise<T> {
  let result: FetchResult<T>;
  try {
    result = await promise;
  } catch {
    throw new ApiError('서버에 연결하지 못했습니다. 네트워크 상태를 확인해 주세요.', 0);
  }
  if (result.response.ok) return result.data as T;
  if (result.response.status === 401 && !result.response.url.includes('/auth/')) onUnauthorized();
  throw new ApiError(errorMessage(result.error, result.response.status), result.response.status);
}
