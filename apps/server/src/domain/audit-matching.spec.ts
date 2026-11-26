/**
 * Audit probes for the "is this installed version affected?" logic.
 * Each test asserts the CORRECT behavior. A failing test is a defect repro.
 * Lockfile fixtures follow the formats the parsers claim to support (npm v2/v3, pnpm v5/v6/v9, Yarn 1, Yarn Berry);
 * they were written from those formats, not fetched from the internet.
 */
import { OsvClient } from '../ingestion/adapters/osv.client.js';
import { parseLockfile, type ParsedLockfile } from './lockfile.js';
import { parseGhsaRange, parseOsvAffected } from './range-parse.js';
import { combineEvaluations, evaluateSpec, suggestFix, type AffectedSpec } from './version-match.js';

const limits = { maxBytes: 4 * 1024 * 1024, maxPackages: 5000 };
const reg = (name: string, version: string) => `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;
const scannable = (parsed: ParsedLockfile) =>
  parsed.packages.filter((p) => p.scannable).map((p) => `${p.name}@${p.version}`).sort();

const spec = (source: string, r: ReturnType<typeof parseGhsaRange>): AffectedSpec => ({ source, ...r });

describe('audit: range parsing and matching', () => {
  it('GHSA syntax: reversed bounds, exact "=", no spaces', () => {
    const reversed = spec('GHSA', parseGhsaRange('< 1.2.3, >= 1.0.0', '1.2.3'));
    expect(evaluateSpec('1.0.0', reversed).result).toBe('AFFECTED');
    expect(evaluateSpec('1.2.2', reversed).result).toBe('AFFECTED');
    expect(evaluateSpec('1.2.3', reversed).result).toBe('NOT_AFFECTED');
    expect(evaluateSpec('0.9.9', reversed).result).toBe('NOT_AFFECTED');
    const exact = spec('GHSA', parseGhsaRange('= 2.8.0', null));
    expect(evaluateSpec('2.8.0', exact).result).toBe('AFFECTED');
    expect(evaluateSpec('2.8.1', exact).result).toBe('NOT_AFFECTED');
    const tight = spec('GHSA', parseGhsaRange('>=1.0.0,<1.2.3', null));
    expect(evaluateSpec('1.1.0', tight).result).toBe('AFFECTED');
    const le = spec('GHSA', parseGhsaRange('<= 1.4.2', '1.4.3'));
    expect(evaluateSpec('1.4.2', le).result).toBe('AFFECTED');
    expect(suggestFix('1.4.2', [le])).toEqual({ kind: 'FIXED', version: '1.4.3', source: 'GHSA' });
  });

  it('OSV: multiple introduced/fixed pairs, last_affected, limit, introduced 0, versions list', () => {
    const osv = spec(
      'OSV',
      parseOsvAffected(
        [
          { type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.0.1' }, { introduced: '2.0.0' }, { last_affected: '2.4.0' }] },
          { type: 'ECOSYSTEM', events: [{ introduced: '3.0.0' }, { limit: '3.5.0' }] },
          { type: 'GIT', events: [{ introduced: 'abc' }, { fixed: 'def' }] },
        ],
        ['5.0.0'],
      ),
    );
    expect(evaluateSpec('0.0.1', osv).result).toBe('AFFECTED');
    expect(evaluateSpec('1.0.1', osv).result).toBe('NOT_AFFECTED');
    expect(evaluateSpec('2.4.0', osv).result).toBe('AFFECTED');
    expect(evaluateSpec('2.4.1', osv).result).toBe('NOT_AFFECTED');
    expect(evaluateSpec('3.4.9', osv).result).toBe('AFFECTED');
    expect(evaluateSpec('5.0.0', osv).result).toBe('AFFECTED');
    expect(evaluateSpec('5.0.0+build.7', osv).result).toBe('AFFECTED');
  });

  it('prerelease installs are compared by semver precedence (not npm range prerelease exclusion)', () => {
    const ghsa = spec('GHSA', parseGhsaRange('< 1.2.3', '1.2.3'));
    expect(evaluateSpec('1.2.3-beta.1', ghsa).result).toBe('AFFECTED');
    const intro0 = spec('OSV', parseOsvAffected([{ type: 'SEMVER', events: [{ introduced: '0' }] }], []));
    expect(evaluateSpec('0.0.0-alpha.0', intro0).result).toBe('AFFECTED');
  });

  it('MAL record with introduced + last_affected only flags that window', () => {
    const mal = spec('OSV', parseOsvAffected([{ type: 'SEMVER', events: [{ introduced: '1.0.1' }, { last_affected: '1.0.2' }] }], ['1.0.1', '1.0.2']));
    expect(evaluateSpec('1.0.0', mal).result).toBe('NOT_AFFECTED');
    expect(evaluateSpec('1.0.1', mal).result).toBe('AFFECTED');
    expect(evaluateSpec('1.0.2', mal).result).toBe('AFFECTED');
    expect(evaluateSpec('1.0.3', mal).result).toBe('NOT_AFFECTED');
    expect(suggestFix('1.0.1', [mal]).kind).toBe('UNCONFIRMED');
  });

  it('OSV events given out of version order are still evaluated (OSV schema sorts events before evaluating)', () => {
    // introduced 0 / fixed 1.0.0 / introduced 2.0.0 (still open), listed in a different order.
    const osv = spec('OSV', parseOsvAffected([{ type: 'SEMVER', events: [{ introduced: '2.0.0' }, { introduced: '0' }, { fixed: '1.0.0' }] }], []));
    expect(evaluateSpec('2.5.0', osv).result).toBe('AFFECTED');
    const osv2 = spec('OSV', parseOsvAffected([{ type: 'SEMVER', events: [{ introduced: '0' }, { introduced: '2.0.0' }, { fixed: '1.0.0' }] }], []));
    // sorted: introduced 0, fixed 1.0.0, introduced 2.0.0 -> 1.5.0 is NOT affected, 2.5.0 is affected
    expect(evaluateSpec('2.5.0', osv2).result).toBe('AFFECTED');
  });

  it('source disagreement is never reported as NOT_AFFECTED', () => {
    const ghsa = spec('GHSA', parseGhsaRange('>= 2.0.0, < 2.0.5', '2.0.5'));
    const osv = spec('OSV', parseOsvAffected([{ type: 'SEMVER', events: [{ introduced: '2.0.0' }, { fixed: '2.3.1' }] }], []));
    const evals = [evaluateSpec('2.1.0', ghsa), evaluateSpec('2.1.0', osv)];
    expect(combineEvaluations(evals, false).result).toBe('UNKNOWN');
    expect(combineEvaluations([evaluateSpec('2.1.0', ghsa)], true).result).toBe('UNKNOWN');
  });

  it('suggestFix: when sources give different fixed versions, suggest one no source still marks affected', () => {
    // GHSA says fixed in 1.2.0, OSV says 1.2.0 is still affected (fixed in 1.2.1).
    const ghsa = spec('GHSA', parseGhsaRange('< 1.2.0', '1.2.0'));
    const osv = spec('OSV', parseOsvAffected([{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.2.1' }] }], []));
    const specs = [ghsa, osv];
    const fix = suggestFix('1.1.0', specs);
    expect(fix.kind).toBe('FIXED');
    const suggested = (fix as { version: string }).version;
    expect(specs.map((s) => `${s.source}:${evaluateSpec(suggested, s).result}`)).toEqual(['GHSA:NOT_AFFECTED', 'OSV:NOT_AFFECTED']);
  });

  it('suggestFix: the suggested version must not fall in another affected interval of the same advisory', () => {
    // one advisory, two overlapping entries for the same package (merged per package on upsert)
    const merged = spec('GHSA', { intervals: [...parseGhsaRange('< 1.5.0', '1.5.0').intervals, ...parseGhsaRange('>= 1.0.0, < 2.0.0', '2.0.0').intervals], versions: [], unparsed: [] });
    const fix = suggestFix('1.2.0', [merged]) as { kind: string; version: string };
    expect(evaluateSpec(fix.version, merged).result).toBe('NOT_AFFECTED');
  });
});

describe('audit: OSV querybatch client', () => {
  it('follows next_page_token per query and keeps result order', async () => {
    const client = new OsvClient();
    const bodies: Array<{ queries: Array<{ package: { name: string }; page_token?: string }> }> = [];
    client.fetchImpl = async (_url, options) => {
      const body = JSON.parse(options?.body ?? '{}');
      bodies.push(body);
      const results = body.queries.map((q: { package: { name: string }; page_token?: string }) => {
        if (q.package.name === 'a' && !q.page_token) return { vulns: [{ id: 'GHSA-aaaa-aaaa-aaa1', modified: 'x' }], next_page_token: 't1' };
        if (q.package.name === 'a' && q.page_token === 't1') return { vulns: [{ id: 'GHSA-aaaa-aaaa-aaa2', modified: 'x' }] };
        if (q.package.name === 'c') return { vulns: [{ id: 'MAL-2026-1', modified: 'x' }] };
        return {};
      });
      return new Response(JSON.stringify({ results }), { status: 200 });
    };
    const out = await client.queryBatch([
      { name: 'a', version: '1.0.0' },
      { name: 'b', version: '1.0.0' },
      { name: 'c', version: '1.0.0' },
    ]);
    expect(out.map((hits) => hits.map((h) => h.id))).toEqual([['GHSA-aaaa-aaaa-aaa1', 'GHSA-aaaa-aaaa-aaa2'], [], ['MAL-2026-1']]);
    expect(bodies[1].queries).toEqual([{ package: { name: 'a', ecosystem: 'npm' }, version: '1.0.0', page_token: 't1' }]);
  });

  it('a malformed / short querybatch response throws instead of becoming "no vulnerabilities"', async () => {
    const client = new OsvClient();
    client.fetchImpl = async () => new Response(JSON.stringify({ results: [{}] }), { status: 200 });
    await expect(client.queryBatch([{ name: 'a', version: '1.0.0' }, { name: 'b', version: '1.0.0' }])).rejects.toThrow();
    client.fetchImpl = async () => new Response(JSON.stringify({ results: [null] }), { status: 200 });
    await expect(client.queryBatch([{ name: 'a', version: '1.0.0' }])).rejects.toThrow();
  });
});

describe('audit: lockfile coverage', () => {
  it('npm v3: nested, scoped, aliased (to scoped), workspace-nested, bundled, optional, peer, uppercase legacy name', () => {
    const lock = {
      name: 'root',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'root', workspaces: ['packages/*'], dependencies: { a: '^1', 'my-alias': 'npm:@scope/real@^1', JSONStream: '^1' } },
        'node_modules/a': { version: '1.0.0', resolved: reg('a', '1.0.0'), dependencies: { b: '^2' } },
        'node_modules/a/node_modules/b': { version: '2.0.0', resolved: reg('b', '2.0.0') },
        'node_modules/b': { version: '1.0.0', resolved: reg('b', '1.0.0') },
        'node_modules/my-alias': { name: '@scope/real', version: '1.1.0', resolved: reg('@scope/real', '1.1.0') },
        'node_modules/JSONStream': { version: '1.3.5', resolved: reg('JSONStream', '1.3.5') },
        'node_modules/ws-a': { resolved: 'packages/ws-a', link: true },
        'packages/ws-a': { name: 'ws-a', version: '0.0.1', dependencies: { c: '^3' } },
        'packages/ws-a/node_modules/c': { version: '3.0.0', resolved: reg('c', '3.0.0'), dependencies: { d: '^1' } },
        'packages/ws-a/node_modules/c/node_modules/d': { version: '1.0.0', inBundle: true },
        'node_modules/@esbuild/darwin-arm64': { version: '0.20.0', resolved: reg('@esbuild/darwin-arm64', '0.20.0'), optional: true, os: ['darwin'] },
        'node_modules/peer-x': { version: '4.0.0', resolved: reg('peer-x', '4.0.0'), peer: true },
      },
    };
    const parsed = parseLockfile(JSON.stringify(lock), limits);
    expect(scannable(parsed)).toEqual(
      ['@esbuild/darwin-arm64@0.20.0', '@scope/real@1.1.0', 'JSONStream@1.3.5', 'a@1.0.0', 'b@1.0.0', 'b@2.0.0', 'c@3.0.0', 'd@1.0.0', 'peer-x@4.0.0'].sort(),
    );
  });

  it('npm v2 (packages + legacy dependencies section) is read from packages', () => {
    const lock = {
      name: 'root',
      lockfileVersion: 2,
      packages: { '': { dependencies: { a: '^1' } }, 'node_modules/a': { version: '1.0.0', resolved: reg('a', '1.0.0') } },
      dependencies: { a: { version: '1.0.0', resolved: reg('a', '1.0.0') } },
    };
    expect(scannable(parseLockfile(JSON.stringify(lock), limits))).toEqual(['a@1.0.0']);
  });

  it('pnpm v9: peer-suffixed, patched, scoped alias, nested peers', () => {
    const yaml = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

patchedDependencies:
  lodash@4.17.20:
    hash: abc123
    path: patches/lodash@4.17.20.patch

importers:

  .:
    dependencies:
      lodash:
        specifier: 4.17.20
        version: 4.17.20(patch_hash=abc123)
      react-dom:
        specifier: ^18.2.0
        version: 18.2.0(react@18.2.0)
      my-alias:
        specifier: npm:@scope/real@^1.0.0
        version: '@scope/real@1.0.0'
      '@tanstack/react-query':
        specifier: ^5.0.0
        version: 5.0.0(react-dom@18.2.0(react@18.2.0))(react@18.2.0)

packages:

  '@scope/real@1.0.0':
    resolution: {integrity: sha512-a}
  '@tanstack/react-query@5.0.0':
    resolution: {integrity: sha512-b}
    peerDependencies:
      react: ^18
  lodash@4.17.20:
    resolution: {integrity: sha512-c}
  loose-envify@1.4.0:
    resolution: {integrity: sha512-d}
    hasBin: true
  react-dom@18.2.0:
    resolution: {integrity: sha512-e}
  react@18.2.0:
    resolution: {integrity: sha512-f}

snapshots:

  '@scope/real@1.0.0': {}
  '@tanstack/react-query@5.0.0(react-dom@18.2.0(react@18.2.0))(react@18.2.0)':
    dependencies:
      react: 18.2.0
      react-dom: 18.2.0(react@18.2.0)
  lodash@4.17.20(patch_hash=abc123): {}
  loose-envify@1.4.0: {}
  react-dom@18.2.0(react@18.2.0):
    dependencies:
      loose-envify: 1.4.0
      react: 18.2.0
  react@18.2.0:
    dependencies:
      loose-envify: 1.4.0
`;
    expect(scannable(parseLockfile(yaml, limits))).toEqual(
      ['@scope/real@1.0.0', '@tanstack/react-query@5.0.0', 'lodash@4.17.20', 'loose-envify@1.4.0', 'react-dom@18.2.0', 'react@18.2.0'].sort(),
    );
  });

  it('pnpm v6: peer-suffixed keys with scoped names', () => {
    const yaml = `lockfileVersion: '6.0'

dependencies:
  '@scope/ui':
    specifier: ^1.0.0
    version: 1.0.0(react@18.2.0)
  react:
    specifier: ^18.2.0
    version: 18.2.0

packages:

  /@scope/ui@1.0.0(react@18.2.0):
    resolution: {integrity: sha512-a}
    peerDependencies:
      react: ^18
    dependencies:
      react: 18.2.0
    dev: false

  /react@18.2.0:
    resolution: {integrity: sha512-b}
    dev: false
`;
    expect(scannable(parseLockfile(yaml, limits))).toEqual(['@scope/ui@1.0.0', 'react@18.2.0']);
  });

  it('yarn classic: multiple ranges per entry, alias merged with regular spec, scoped', () => {
    const lock = `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"@babel/code-frame@^7.0.0", "@babel/code-frame@^7.22.13":
  version "7.22.13"
  resolved "https://registry.yarnpkg.com/@babel/code-frame/-/code-frame-7.22.13.tgz#e3c1c099402598483b7a8c46a721d1038803755e"
  integrity sha512-x

"string-width-cjs@npm:string-width@^4.2.0", "string-width@^1.0.2 || 2 || 3 || 4", string-width@^4.1.0:
  version "4.2.3"
  resolved "https://registry.yarnpkg.com/string-width/-/string-width-4.2.3.tgz#269c7117d27b05ad2e536830a8ec895ef9c6d010"
  integrity sha512-y
  dependencies:
    emoji-regex "^8.0.0"

emoji-regex@^8.0.0:
  version "8.0.0"
  resolved "https://registry.yarnpkg.com/emoji-regex/-/emoji-regex-8.0.0.tgz#e818fd69ce5ccfcb404594f842963bf53164cc37"
  integrity sha512-z
`;
    expect(scannable(parseLockfile(lock, limits))).toEqual(['@babel/code-frame@7.22.13', 'emoji-regex@8.0.0', 'string-width@4.2.3']);
  });

  it('yarn berry: patch: protocol (scoped), npm: alias to scoped, custom registry archiveUrl', () => {
    const lock = `# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 8
  cacheKey: 10c0

"@types/node@npm:^20.0.0":
  version: 20.1.0
  resolution: "@types/node@npm:20.1.0"
  checksum: 10c0/aaa
  languageName: node
  linkType: hard

"@scope/patched@npm:1.2.3":
  version: 1.2.3
  resolution: "@scope/patched@npm:1.2.3"
  languageName: node
  linkType: hard

"@scope/patched@patch:@scope/patched@npm%3A1.2.3#~/.yarn/patches/@scope-patched-npm-1.2.3-abc.patch":
  version: 1.2.3
  resolution: "@scope/patched@patch:@scope/patched@npm%3A1.2.3#~/.yarn/patches/@scope-patched-npm-1.2.3-abc.patch::version=1.2.3&hash=def"
  languageName: node
  linkType: hard

"my-alias@npm:@scope/real@^1.0.0":
  version: 1.0.4
  resolution: "@scope/real@npm:1.0.4"
  languageName: node
  linkType: hard

"lodash@npm:^4.17.0":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21::__archiveUrl=https%3A%2F%2Fnexus.example.com%2Frepository%2Fnpm%2Flodash%2F-%2Flodash-4.17.21.tgz"
  languageName: node
  linkType: hard

"typescript@patch:typescript@npm%3A^5.3.0#optional!builtin<compat/typescript>":
  version: 5.3.3
  resolution: "typescript@patch:typescript@npm%3A5.3.3#optional!builtin<compat/typescript>::version=5.3.3&hash=e012d7"
  languageName: node
  linkType: hard

"app@workspace:.":
  version: 0.0.0-use.local
  resolution: "app@workspace:."
  dependencies:
    "@types/node": "npm:^20.0.0"
    lodash: "npm:^4.17.0"
    my-alias: "npm:@scope/real@^1.0.0"
  languageName: unknown
  linkType: soft
`;
    expect(scannable(parseLockfile(lock, limits))).toEqual(
      ['@scope/patched@1.2.3', '@scope/real@1.0.4', '@types/node@20.1.0', 'lodash@4.17.21', 'typescript@5.3.3'].sort(),
    );
  });
});
