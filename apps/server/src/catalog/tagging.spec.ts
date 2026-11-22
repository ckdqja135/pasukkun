import { computeTechnologyTags, parseCpe, type MappingRow } from './tagging.js';

const mappings: MappingRow[] = [
  { technologyId: 'js', kind: 'ECOSYSTEM', ecosystem: 'npm', pattern: null },
  { technologyId: 'ts', kind: 'ECOSYSTEM', ecosystem: 'npm', pattern: null },
  { technologyId: 'react', kind: 'PACKAGE', ecosystem: 'npm', pattern: 'react' },
  { technologyId: 'nest', kind: 'PACKAGE', ecosystem: 'npm', pattern: '@nestjs/*' },
  { technologyId: 'node', kind: 'CPE', ecosystem: null, pattern: 'nodejs:node.js' },
  { technologyId: 'windows', kind: 'CPE', ecosystem: null, pattern: 'microsoft:windows*' },
  { technologyId: 'java', kind: 'ECOSYSTEM', ecosystem: 'maven', pattern: null },
];

describe('computeTechnologyTags', () => {
  it('npm 패키지는 JavaScript 와 TypeScript 둘 다에 해당한다', () => {
    const tags = computeTechnologyTags({ packages: [{ ecosystem: 'npm', name: 'lodash' }], products: [] }, mappings);
    expect([...tags.keys()].sort()).toEqual(['js', 'ts']);
    expect(tags.get('js')).toBe('ECOSYSTEM');
  });
  it('패키지명은 정확히 또는 접두 패턴으로만 일치한다', () => {
    const tags = computeTechnologyTags(
      { packages: [{ ecosystem: 'npm', name: 'react' }, { ecosystem: 'npm', name: '@nestjs/core' }], products: [] },
      mappings,
    );
    expect(tags.get('react')).toBe('PACKAGE');
    expect(tags.get('nest')).toBe('PACKAGE');
    const other = computeTechnologyTags({ packages: [{ ecosystem: 'npm', name: 'react-native-foo' }], products: [] }, mappings);
    expect(other.has('react')).toBe(false);
  });
  it('다른 생태계의 같은 이름은 일치로 보지 않는다', () => {
    const tags = computeTechnologyTags({ packages: [{ ecosystem: 'pypi', name: 'react' }], products: [] }, mappings);
    expect(tags.size).toBe(0);
  });
  it('CPE vendor:product 로 런타임·OS 를 태깅한다', () => {
    const tags = computeTechnologyTags(
      { packages: [], products: [{ vendor: 'nodejs', product: 'node.js' }, { vendor: 'microsoft', product: 'windows_11_24h2' }] },
      mappings,
    );
    expect(tags.get('node')).toBe('CPE');
    expect(tags.get('windows')).toBe('CPE');
  });
  it('매핑되는 근거가 없으면 미분류(빈 결과)다', () => {
    expect(computeTechnologyTags({ packages: [], products: [{ vendor: 'acme', product: 'router' }] }, mappings).size).toBe(0);
  });
});

describe('parseCpe', () => {
  it('vendor 와 product 를 추출한다', () => {
    expect(parseCpe('cpe:2.3:a:nodejs:node.js:*:*:*:*:lts:*:*:*')).toEqual({ vendor: 'nodejs', product: 'node.js' });
    expect(parseCpe('not-a-cpe')).toBeNull();
  });
});
