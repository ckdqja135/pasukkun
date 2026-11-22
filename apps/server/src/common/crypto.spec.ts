import { pkceChallenge, stableHash } from './crypto.js';

describe('PKCE', () => {
  it('RFC 7636 부록 B 의 예시 값과 같은 challenge 를 만든다', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('stableHash', () => {
  it('키 순서와 무관하게 같은 해시를 만든다', () => {
    expect(stableHash({ a: 1, b: [1, 2] })).toBe(stableHash({ b: [1, 2], a: 1 }));
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });
});
