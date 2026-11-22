import { fetchWithRetry, HttpError, parseRetryAfter, redactUrl } from './http.js';

describe('외부 API 호출', () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  beforeEach(() => void (sleeps.length = 0));

  it('429 는 Retry-After 를 따르고 성공할 때까지 다시 시도한다', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls < 3 ? new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }) : new Response('ok');
    }) as typeof fetch;
    const response = await fetchWithRetry('https://example.com/x', { fetchImpl, sleep });
    expect(await response.text()).toBe('ok');
    expect(sleeps).toEqual([7000, 7000]);
  });

  it('5xx 와 네트워크 오류는 백오프로 재시도하고 한도에서 멈춘다', async () => {
    let calls = 0;
    const failing = (async () => {
      calls += 1;
      if (calls % 2) throw new TypeError('fetch failed');
      return new Response('down', { status: 503 });
    }) as typeof fetch;
    await expect(fetchWithRetry('https://example.com/x', { fetchImpl: failing, sleep, retries: 3 })).rejects.toThrow();
    expect(calls).toBe(4);
    expect(sleeps.length).toBe(3);
    expect(sleeps[2]).toBeGreaterThan(sleeps[0] / 2);
  });

  it('4xx 는 재시도하지 않는다', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    await expect(fetchWithRetry('https://example.com/x', { fetchImpl, sleep })).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });

  it('GitHub 의 요청 한도 소진(403 + x-ratelimit-reset)을 재시도 대상으로 본다', async () => {
    let calls = 0;
    const reset = String(Math.floor(Date.now() / 1000) + 30);
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1 ? new Response('limit', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } }) : new Response('ok');
    }) as typeof fetch;
    await fetchWithRetry('https://api.github.com/advisories', { fetchImpl, sleep });
    expect(calls).toBe(2);
    expect(sleeps[0]).toBeGreaterThan(20_000);
  });

  it('오류 메시지에 토큰이 들어간 주소를 남기지 않는다', async () => {
    const secretUrl = 'https://api.telegram.org/bot123456789:AAsecretsecretsecretsecretsecretsecr/sendMessage';
    expect(redactUrl(secretUrl)).toBe('https://api.telegram.org/bot***/sendMessage');
    expect(redactUrl('https://discord.com/api/v10/webhooks/123456/tok-en_secret?wait=true')).toBe('https://discord.com/api/v10/webhooks/123456/***?wait=true');
    expect(redactUrl('https://x.test/a?apiKey=abc&b=1')).toBe('https://x.test/a?apiKey=***&b=1');
    const fetchImpl = (async () => new Response('no', { status: 401 })) as typeof fetch;
    await expect(fetchWithRetry(secretUrl, { fetchImpl, sleep })).rejects.toThrow(/bot\*\*\*/);
    await expect(fetchWithRetry(secretUrl, { fetchImpl, sleep })).rejects.not.toThrow(/AAsecret/);
  });

  it('오류 메시지에 응답 본문과 쿼리 문자열을 담지 않는다', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 1800);
    const fetchImpl = (async () =>
      new Response('{"message":"API rate limit exceeded for 203.0.113.7."}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } })) as typeof fetch;
    const error = (await fetchWithRetry('https://api.github.com/advisories?modified=2026-01-01..2026-02-01&after=cursor', { fetchImpl, sleep }).then(
      () => null,
      (e: unknown) => e,
    )) as HttpError;
    expect(error).toBeInstanceOf(HttpError);
    expect(error.message).toMatch(/^HTTP 403 https:\/\/api\.github\.com\/advisories - 요청 한도 초과\. 약 \d+분 뒤/);
    expect(error.message).not.toContain('203.0.113.7');
    expect(error.message).not.toContain('cursor');
    // 본문은 필요할 때 볼 수 있도록 속성으로만 남긴다.
    expect(error.bodySnippet).toContain('rate limit');
    // 한도가 풀릴 때까지 오래 걸리면 기다리지 않고 바로 실패로 돌려준다 (다음 수집 주기에 맡긴다).
    expect(sleeps).toEqual([]);
  });

  it('Retry-After 의 초·날짜 형식을 모두 읽는다', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('1.5')).toBe(1500);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});
