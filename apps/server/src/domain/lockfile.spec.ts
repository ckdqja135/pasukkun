import { LockfileError, parseLockfile, validateManualPackages } from './lockfile.js';

const limits = { maxBytes: 1024 * 1024, maxPackages: 1000 };
const reg = (name: string, version: string) =>
  `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;

const fixture = {
  name: 'demo',
  version: '1.0.0',
  lockfileVersion: 3,
  packages: {
    '': {
      name: 'demo',
      version: '1.0.0',
      dependencies: { express: '^4.18.0', 'string-width-cjs': 'npm:string-width@^4.2.0', local: 'file:../local' },
      devDependencies: { vitest: '^1.0.0' },
      workspaces: ['packages/*'],
    },
    'node_modules/express': {
      version: '4.18.2',
      resolved: reg('express', '4.18.2'),
      dependencies: { qs: '6.11.0', debug: '2.6.9' },
    },
    'node_modules/qs': { version: '6.11.0', resolved: reg('qs', '6.11.0') },
    'node_modules/debug': { version: '4.3.4', resolved: reg('debug', '4.3.4'), dev: true, dependencies: { ms: '2.1.2' } },
    'node_modules/express/node_modules/debug': {
      version: '2.6.9',
      resolved: reg('debug', '2.6.9'),
      dependencies: { ms: '2.0.0' },
    },
    'node_modules/express/node_modules/ms': { version: '2.0.0', resolved: reg('ms', '2.0.0') },
    'node_modules/ms': { version: '2.1.2', resolved: reg('ms', '2.1.2'), dev: true },
    'node_modules/vitest': { version: '1.6.0', resolved: reg('vitest', '1.6.0'), dev: true, dependencies: { debug: '^4.3.4' } },
    'node_modules/string-width-cjs': {
      name: 'string-width',
      version: '4.2.3',
      resolved: reg('string-width', '4.2.3'),
    },
    'node_modules/gitdep': { version: '1.0.0', resolved: 'git+ssh://git@github.com/acme/gitdep.git#abcdef' },
    'node_modules/local': { resolved: '../local', link: true },
    'node_modules/@acme/ui': { resolved: 'packages/ui', link: true },
    'packages/ui': { name: '@acme/ui', version: '0.1.0', dependencies: { qs: '6.11.0' } },
    'node_modules/weird': { version: 'not-semver', resolved: reg('weird', '0.0.0') },
    'node_modules/fsevents': { version: '2.3.3', resolved: reg('fsevents', '2.3.3'), optional: true },
  },
};

describe('parseLockfile', () => {
  const parsed = parseLockfile(JSON.stringify(fixture), limits);
  const byPath = new Map(parsed.packages.map((p) => [p.installPath, p]));

  it('루트와 워크스페이스 멤버 자체는 패키지 목록에 넣지 않는다', () => {
    expect(byPath.has('')).toBe(false);
    expect(byPath.has('packages/ui')).toBe(false);
  });

  it('같은 패키지의 여러 설치 버전을 각각 보존한다', () => {
    const debugs = parsed.packages.filter((p) => p.name === 'debug').map((p) => p.version).sort();
    expect(debugs).toEqual(['2.6.9', '4.3.4']);
    const ms = parsed.packages.filter((p) => p.name === 'ms').map((p) => p.version).sort();
    expect(ms).toEqual(['2.0.0', '2.1.2']);
  });

  it('직접 의존성과 전이 의존성을 구분하고 경로를 남긴다', () => {
    expect(byPath.get('node_modules/express')?.isDirect).toBe(true);
    // qs 는 워크스페이스 멤버(packages/ui)가 직접 선언했으므로 직접 의존성이다.
    expect(byPath.get('node_modules/qs')?.isDirect).toBe(true);
    expect(byPath.get('node_modules/express/node_modules/debug')?.isDirect).toBe(false);
    expect(byPath.get('node_modules/ms')?.isDirect).toBe(false);
    expect(byPath.get('node_modules/express/node_modules/ms')?.dependencyPath).toEqual([
      'express@4.18.2',
      'debug@2.6.9',
      'ms@2.0.0',
    ]);
    // 중첩 설치가 있으면 가까운 쪽을 따른다 (express → debug@2.6.9, vitest → debug@4.3.4)
    expect(byPath.get('node_modules/debug')?.dependencyPath).toEqual(['vitest@1.6.0', 'debug@4.3.4']);
  });

  it('개발·선택 의존성 여부를 표시하되 검사 대상에서 빼지 않는다', () => {
    const vitest = byPath.get('node_modules/vitest');
    expect(vitest?.isDev).toBe(true);
    expect(vitest?.scannable).toBe(true);
    expect(byPath.get('node_modules/fsevents')?.isOptional).toBe(true);
  });

  it('별칭은 실제 패키지명으로 검사한다', () => {
    const alias = byPath.get('node_modules/string-width-cjs');
    expect(alias).toMatchObject({ name: 'string-width', version: '4.2.3', refKind: 'ALIAS', scannable: true });
  });

  it('git·링크·비표준 버전은 검사 불가로 명시한다', () => {
    expect(byPath.get('node_modules/gitdep')).toMatchObject({ refKind: 'GIT', scannable: false });
    expect(byPath.get('node_modules/local')).toMatchObject({ refKind: 'LINK', scannable: false });
    expect(byPath.get('node_modules/@acme/ui')).toMatchObject({ refKind: 'LINK', scannable: false });
    expect(byPath.get('node_modules/weird')).toMatchObject({ scannable: false });
    const codes = parsed.warnings.map((w) => w.code);
    expect(codes).toContain('UNSUPPORTED_REFERENCE');
    expect(codes).toContain('LOCAL_PACKAGE');
    expect(codes).toContain('NON_SEMVER_VERSION');
  });

  it('워크스페이스 멤버의 의존성도 직접 의존성으로 본다', () => {
    const only = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', workspaces: ['packages/*'] },
        'packages/a': { name: 'a', version: '1.0.0', dependencies: { qs: '6.11.0' } },
        'node_modules/a': { resolved: 'packages/a', link: true },
        'node_modules/qs': { version: '6.11.0', resolved: reg('qs', '6.11.0') },
      },
    };
    const result = parseLockfile(JSON.stringify(only), limits);
    expect(result.packages.find((p) => p.name === 'qs')?.isDirect).toBe(true);
  });

  it('package.json 과 lockfile 의 불일치를 경고한다', () => {
    const result = parseLockfile(
      JSON.stringify(fixture),
      limits,
      JSON.stringify({ dependencies: { express: '^4.18.0', lodash: '^4.17.21' } }),
    );
    const mismatch = result.warnings.filter((w) => w.code === 'PACKAGE_JSON_MISMATCH');
    expect(mismatch.some((w) => w.examples.includes('lodash'))).toBe(true);
  });
});

describe('parseLockfile - 거부해야 하는 입력', () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return error instanceof LockfileError ? error.code : 'OTHER';
    }
    return 'NO_ERROR';
  };

  it('lockfileVersion 1 과 알 수 없는 버전을 거부한다', () => {
    expect(code(() => parseLockfile(JSON.stringify({ lockfileVersion: 1, dependencies: {} }), limits))).toBe(
      'UNSUPPORTED_VERSION',
    );
    expect(code(() => parseLockfile(JSON.stringify({ lockfileVersion: 4, packages: {} }), limits))).toBe(
      'UNSUPPORTED_VERSION',
    );
  });
  it('package.json 이나 다른 형식의 파일을 lockfile 로 받지 않는다', () => {
    expect(code(() => parseLockfile(JSON.stringify({ name: 'x', dependencies: { a: '^1.0.0' } }), limits))).toBe(
      'NOT_A_LOCKFILE',
    );
    expect(code(() => parseLockfile('{ "lockfileVersion": 3, ', limits))).toBe('INVALID_JSON');
    expect(code(() => parseLockfile('hello world', limits))).toBe('UNSUPPORTED_FORMAT');
    expect(code(() => parseLockfile('[]', limits))).toBe('NOT_A_LOCKFILE');
  });
  it('크기와 패키지 수 제한을 적용한다', () => {
    expect(code(() => parseLockfile('x'.repeat(200), { maxBytes: 100, maxPackages: 10 }))).toBe('TOO_LARGE');
    const many: Record<string, unknown> = { '': {} };
    for (let i = 0; i < 20; i += 1) many[`node_modules/p${i}`] = { version: '1.0.0' };
    expect(
      code(() => parseLockfile(JSON.stringify({ lockfileVersion: 3, packages: many }), { maxBytes: 1e6, maxPackages: 10 })),
    ).toBe('TOO_MANY_PACKAGES');
  });
  it('__proto__ 같은 키가 있어도 프로토타입을 오염시키지 않는다', () => {
    const text =
      '{"lockfileVersion":3,"packages":{"":{"dependencies":{"__proto__":"1.0.0"}},"node_modules/__proto__":{"version":"1.0.0"},"__proto__":{"polluted":true}}}';
    parseLockfile(text, limits);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('validateManualPackages', () => {
  it('정확한 버전만 받는다', () => {
    expect(validateManualPackages([{ name: 'lodash', version: '4.17.20' }], 10)[0]).toMatchObject({
      name: 'lodash',
      version: '4.17.20',
      scannable: true,
    });
    expect(() => validateManualPackages([{ name: 'lodash', version: '^4.17.20' }], 10)).toThrow(LockfileError);
    expect(() => validateManualPackages([{ name: 'lodash', version: '4.x' }], 10)).toThrow(LockfileError);
    expect(() => validateManualPackages([{ name: '../etc/passwd', version: '1.0.0' }], 10)).toThrow(LockfileError);
  });
});

describe('parseLockfile - 서비스 거부를 노린 입력', () => {
  const big = { maxBytes: 20 * 1024 * 1024, maxPackages: 50_000 };
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return error instanceof LockfileError ? error.code : 'OTHER';
    }
    return 'NO_ERROR';
  };
  const timed = (fn: () => unknown) => {
    const start = performance.now();
    const result = code(fn);
    return { result, ms: performance.now() - start };
  };

  it('비정상적으로 깊은 경로를 가리키는 링크로 계산을 폭증시킬 수 없다', () => {
    // 항목 3개짜리 작은 파일이지만, 링크 대상 경로를 수만 단계로 만들어 경로 해석을 반복시키는 입력
    const deep = `node_modules/a${'/node_modules/a'.repeat(32_000)}`;
    const dependencies = Object.fromEntries(Array.from({ length: 160 }, (_, i) => [`dep-${i}`, '1.0.0']));
    const attack = { lockfileVersion: 3, packages: { '': { dependencies: { x: '1.0.0' } }, 'node_modules/x': { link: true, resolved: deep }, [deep]: { version: '1.0.0', dependencies } } };
    const { result, ms } = timed(() => parseLockfile(JSON.stringify(attack), big));
    expect(result).toBe('TOO_COMPLEX');
    expect(ms).toBeLessThan(1000);
  });

  it('존재하지 않는 대상을 가리키는 링크는 따라가지 않는다', () => {
    const lock = { lockfileVersion: 3, packages: { '': { dependencies: { x: '1.0.0' } }, 'node_modules/x': { link: true, resolved: `node_modules/a${'/node_modules/a'.repeat(30)}` } } };
    expect(parseLockfile(JSON.stringify(lock), big).packages).toHaveLength(1);
  });

  it('의존성 수가 과도한 항목과 작업량이 과도한 구조를 거부한다', () => {
    const many = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`d${i}`, '1.0.0']));
    expect(code(() => parseLockfile(JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: many } } }), big))).toBe('TOO_COMPLEX');

    // 깊이 제한 안에서도 (항목 수 × 의존성 수 × 깊이) 로 일을 키우는 입력: 작업량 상한에서 멈춘다.
    const packages: Record<string, unknown> = { '': { dependencies: { p0: '1.0.0' } } };
    const missing = Object.fromEntries(Array.from({ length: 1900 }, (_, i) => [`missing-${i}`, '1.0.0']));
    let path = '';
    for (let level = 0; level < 39; level += 1) {
      path = `${path}${path ? '/' : ''}node_modules/p${level}`;
      packages[path] = { version: '1.0.0', dependencies: { ...missing, [`p${level + 1}`]: '1.0.0' } };
    }
    const { result, ms } = timed(() => parseLockfile(JSON.stringify({ lockfileVersion: 3, packages }), big));
    expect(['TOO_COMPLEX', 'NO_ERROR']).toContain(result);
    expect(ms).toBeLessThan(3000);
  });

  it('npm 이름 형식이 아닌 패키지명은 외부 조회 대상에서 뺀다', () => {
    const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/ok': { version: '1.0.0' }, 'node_modules/bad name;rm -rf': { version: '1.0.0' }, 'node_modules/x': { name: '../../etc/passwd', version: '1.0.0' } } };
    const parsed = parseLockfile(JSON.stringify(lock), big);
    expect(parsed.packages.filter((p) => p.scannable).map((p) => p.name)).toEqual(['ok']);
  });

  it('실제 크기의 lockfile 은 제한에 걸리지 않고 빠르게 처리된다', () => {
    // 2만 개 패키지, 패키지마다 의존성 8개
    const packages: Record<string, unknown> = { '': { dependencies: { 'pkg-0': '1.0.0' } } };
    for (let i = 0; i < 20_000; i += 1) {
      const dependencies = Object.fromEntries(Array.from({ length: 8 }, (_, d) => [`pkg-${(i * 7 + d * 13 + 1) % 20_000}`, '1.0.0']));
      packages[`node_modules/pkg-${i}`] = { version: '1.0.0', resolved: `https://registry.npmjs.org/pkg-${i}/-/pkg-${i}-1.0.0.tgz`, dependencies };
    }
    const { result, ms } = timed(() => parseLockfile(JSON.stringify({ lockfileVersion: 3, packages }), big));
    expect(result).toBe('NO_ERROR');
    expect(ms).toBeLessThan(3000);
  });
});
