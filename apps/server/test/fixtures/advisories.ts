/**
 * 테스트 전용 fixture. 실제 공지가 아니다 - 식별자(CVE-2099-…, GHSA-…)와 패키지명은 모두 지어낸 값이다.
 * 실제 수집 데이터와 섞이지 않도록 테스트는 항상 임시 DB 에서만 실행한다.
 */
import type { GhsaAdvisory } from '../../src/ingestion/adapters/ghsa.adapter.js';
import type { NvdCve } from '../../src/ingestion/adapters/nvd.adapter.js';
import type { OsvRecord } from '../../src/ingestion/adapters/osv.client.js';

// 같은 fixture 를 여러 번 만들어도 내용이 같도록 기준 시각을 한 번만 정한다.
const BASE = Date.now();
const recent = (daysAgo: number) => new Date(BASE - daysAgo * 86_400_000).toISOString();

export function ghsaFixture(overrides: Partial<GhsaAdvisory> = {}): GhsaAdvisory {
  return {
    ghsa_id: 'GHSA-f2f2-g3g3-h4h4',
    cve_id: 'CVE-2099-0001',
    html_url: 'https://github.com/advisories/GHSA-f2f2-g3g3-h4h4',
    summary: 'fixture-lib: prototype pollution in merge()',
    description: '## Impact\n\n<script>alert(1)</script> `merge()` allows prototype pollution.',
    severity: 'high',
    identifiers: [
      { type: 'GHSA', value: 'GHSA-f2f2-g3g3-h4h4' },
      { type: 'CVE', value: 'CVE-2099-0001' },
    ],
    references: ['https://example.com/fixture-advisory'],
    published_at: recent(2),
    updated_at: recent(1),
    withdrawn_at: null,
    vulnerabilities: [
      {
        package: { ecosystem: 'npm', name: 'fixture-lib' },
        vulnerable_version_range: '>= 2.0.0, < 2.3.1',
        first_patched_version: '2.3.1',
        vulnerable_functions: ['merge'],
      },
      {
        package: { ecosystem: 'npm', name: 'fixture-lib' },
        vulnerable_version_range: '>= 3.0.0, < 3.1.0',
        first_patched_version: '3.1.0',
        vulnerable_functions: [],
      },
    ],
    cvss_severities: {
      cvss_v3: { vector_string: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:N', score: 7.5 },
      cvss_v4: { vector_string: null, score: 0 },
    },
    ...overrides,
  };
}

export function nvdFixture(overrides: Partial<NvdCve> = {}): NvdCve {
  return {
    id: 'CVE-2099-0001',
    vulnStatus: 'Analyzed',
    published: recent(2).replace('Z', ''),
    lastModified: recent(1).replace('Z', ''),
    descriptions: [{ lang: 'en', value: 'fixture-lib before 2.3.1 allows prototype pollution via merge().' }],
    references: [{ url: 'https://example.com/fixture-advisory', tags: ['Patch'] }],
    metrics: {
      cvssMetricV31: [
        { source: 'nvd@nist.gov', type: 'Primary', cvssData: { version: '3.1', vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', baseScore: 9.8 } },
      ],
    },
    configurations: [{ nodes: [{ cpeMatch: [{ vulnerable: true, criteria: 'cpe:2.3:a:fixture:fixture-lib:*:*:*:*:*:node.js:*:*' }] }] }],
    ...overrides,
  };
}

export function osvFixture(overrides: Partial<OsvRecord> = {}): OsvRecord {
  return {
    id: 'GHSA-f2f2-g3g3-h4h4',
    modified: recent(1),
    published: recent(2),
    aliases: ['CVE-2099-0001'],
    summary: 'fixture-lib: prototype pollution in merge()',
    details: 'merge() allows prototype pollution.',
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:N' }],
    affected: [
      {
        package: { ecosystem: 'npm', name: 'fixture-lib' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '2.0.0' }, { fixed: '2.3.1' }, { introduced: '3.0.0' }, { fixed: '3.1.0' }] }],
      },
    ],
    references: [{ type: 'ADVISORY', url: 'https://github.com/advisories/GHSA-f2f2-g3g3-h4h4' }],
    database_specific: { severity: 'HIGH' },
    ...overrides,
  };
}

/** 여러 버전·전이 의존성·개발 의존성·검사 불가 항목이 섞인 lockfile fixture */
export function lockfileFixture(options: { fixtureLibVersions?: string[] } = {}): string {
  const [top, nested] = options.fixtureLibVersions ?? ['2.1.0', '3.2.0'];
  const packages: Record<string, unknown> = {
    '': { name: 'fixture-app', version: '1.0.0', dependencies: { 'fixture-web': '^1.0.0', 'fixture-lib': `^${top}` }, devDependencies: { 'fixture-dev': '^1.0.0' } },
    'node_modules/fixture-web': { version: '1.4.0', resolved: 'https://registry.npmjs.org/fixture-web/-/fixture-web-1.4.0.tgz', dependencies: { 'fixture-lib': '^3.0.0' } },
    'node_modules/fixture-lib': { version: top, resolved: `https://registry.npmjs.org/fixture-lib/-/fixture-lib-${top}.tgz` },
    'node_modules/fixture-dev': { version: '1.0.0', resolved: 'https://registry.npmjs.org/fixture-dev/-/fixture-dev-1.0.0.tgz', dev: true },
    'node_modules/fixture-git': { version: '0.1.0', resolved: 'git+ssh://git@github.com/example/fixture-git.git#0123456789abcdef' },
  };
  if (nested) {
    packages['node_modules/fixture-web/node_modules/fixture-lib'] = {
      version: nested,
      resolved: `https://registry.npmjs.org/fixture-lib/-/fixture-lib-${nested}.tgz`,
    };
  }
  return JSON.stringify({ name: 'fixture-app', version: '1.0.0', lockfileVersion: 3, requires: true, packages });
}
