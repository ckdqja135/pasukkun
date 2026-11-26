import { OsvClient } from '../src/ingestion/adapters/osv.client.js';
import { createTestContext, jsonResponse, type TestClient, type TestContext } from './harness.js';

// OSV 의 OpenSSF 악성 패키지 항목과 같은 모양: CVSS·심각도 없이 모든 버전이 영향 범위다.
const MAL_ID = 'MAL-2026-0001';
const malRecord = {
  id: MAL_ID,
  summary: 'Malicious code in fixture-evil (npm)',
  details: 'This package contains malicious code.',
  modified: '2026-11-20T00:00:00Z',
  published: '2026-11-20T00:00:00Z',
  affected: [{ package: { ecosystem: 'npm', name: 'fixture-evil' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }] }],
  database_specific: { 'malicious-packages-origins': [{ source: 'fixture' }] },
};

describe('악성 패키지 공지', () => {
  let ctx: TestContext;
  let user: TestClient;

  beforeAll(async () => {
    ctx = await createTestContext();
    user = await ctx.client('malicious@example.com');
    ctx.get(OsvClient).fetchImpl = async (url, options) => {
      if (url.endsWith('/v1/querybatch')) {
        const queries = JSON.parse(options?.body ?? '{}').queries as Array<{ package: { name: string } }>;
        return jsonResponse({
          results: queries.map((query) => (query.package.name === 'fixture-evil' ? { vulns: [{ id: MAL_ID, modified: malRecord.modified }] } : {})),
        });
      }
      return jsonResponse(malRecord);
    };
  });
  afterAll(() => ctx.close());

  it('내부 전용 개발 프로젝트의 개발 의존성이어도 긴급으로 보이고 악성 표시가 붙는다', async () => {
    const projectId = (await user.post('/projects', { name: 'internal-tool', environments: ['DEVELOPMENT'], exposure: 'INTERNAL' }).expect(201)).body.id;
    const lockfile = JSON.stringify({
      name: 'internal-tool',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'internal-tool', version: '1.0.0', devDependencies: { 'fixture-evil': '^1.0.0' } },
        'node_modules/fixture-evil': { version: '1.0.1', resolved: 'https://registry.npmjs.org/fixture-evil/-/fixture-evil-1.0.1.tgz', dev: true },
      },
    });
    await user.post(`/projects/${projectId}/snapshots`, { inputType: 'LOCKFILE', fileName: 'package-lock.json', lockfileContent: lockfile }).expect(201);
    await ctx.drain();

    const [finding, ...rest] = (await user.get(`/findings?projectId=${projectId}`).expect(200)).body.items;
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ packageName: 'fixture-evil', version: '1.0.1', malicious: true, priority: 'URGENT', devOnly: true });

    const detail = (await user.get(`/findings/${finding.id}`).expect(200)).body;
    expect(detail.priorityReasons).toMatchObject({ ruleId: 'RM', adjustments: [] });
  });
});
