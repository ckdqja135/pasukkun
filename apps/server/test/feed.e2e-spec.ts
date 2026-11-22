import { PrismaService } from '../src/db/prisma.service.js';
import { normalizeGhsa } from '../src/ingestion/adapters/ghsa.adapter.js';
import { normalizeNvd } from '../src/ingestion/adapters/nvd.adapter.js';
import { VulnerabilityUpsertService } from '../src/ingestion/upsert.service.js';
import { ghsaFixture, nvdFixture } from './fixtures/advisories.js';
import { createTestContext, type TestClient, type TestContext } from './harness.js';

describe('취약점 피드와 관심 기술 필터', () => {
  let ctx: TestContext;
  let user: TestClient;
  const tech: Record<string, string> = {};
  const titles = (body: { items: Array<{ title: string }> }) => body.items.map((item) => item.title).sort();

  beforeAll(async () => {
    ctx = await createTestContext();
    user = await ctx.client('feed@example.com');
    const upserts = ctx.get(VulnerabilityUpsertService);
    const seed = (id: string, cve: string, title: string, ecosystem: string, name: string) =>
      upserts.upsert(
        normalizeGhsa(
          ghsaFixture({
            ghsa_id: id,
            cve_id: cve,
            identifiers: [],
            summary: title,
            vulnerabilities: [{ package: { ecosystem, name }, vulnerable_version_range: '< 1.0.0', first_patched_version: '1.0.0' }],
          }),
        ),
        { emitEvents: false },
      );
    await seed('GHSA-2222-2222-2222', 'CVE-2099-1001', 'npm-react', 'npm', 'react');
    await seed('GHSA-3333-3333-3333', 'CVE-2099-1002', 'npm-other', 'npm', 'left-pad-fixture');
    await seed('GHSA-4444-4444-4444', 'CVE-2099-1003', 'pypi-django', 'pip', 'django');
    await seed('GHSA-5555-5555-5555', 'CVE-2099-1004', 'pypi-other', 'pip', 'fixture-py');
    // 카탈로그에 매핑되지 않는 항목 (미분류)
    await upserts.upsert(normalizeNvd(nvdFixture({ id: 'CVE-2099-1005', descriptions: [{ lang: 'en', value: 'unclassified-router firmware issue.' }], configurations: [] })), { emitEvents: false });

    for (const row of (await user.get('/technologies').expect(200)).body as Array<{ id: string; slug: string }>) tech[row.slug] = row.id;
  });
  afterAll(() => ctx.close());

  it('관심 기술을 선택하지 않으면 수집된 전체가 표시된다 (미분류 포함)', async () => {
    const body = (await user.get('/vulnerabilities').expect(200)).body;
    expect(body.total).toBe(5);
    expect(body.items.some((item: { classified: boolean }) => !item.classified)).toBe(true);
    const unclassified = (await user.get('/vulnerabilities?unclassifiedOnly=true').expect(200)).body;
    expect(unclassified.total).toBe(1);
    expect(unclassified.items[0].technologies).toEqual([]);
  });

  it('같은 그룹 안에서 여러 항목은 OR 로 적용된다', async () => {
    const body = (await user.get(`/vulnerabilities?technologyIds=${tech.javascript},${tech.python}`).expect(200)).body;
    expect(titles(body)).toEqual(['npm-other', 'npm-react', 'pypi-django', 'pypi-other']);
  });

  it('서로 다른 그룹 사이는 기본적으로 AND 로 적용된다', async () => {
    // 언어=JavaScript AND 프레임워크=React
    const and = (await user.get(`/vulnerabilities?technologyIds=${tech.javascript},${tech.react}`).expect(200)).body;
    expect(titles(and)).toEqual(['npm-react']);
    // 언어=Python AND 프레임워크=React → 둘 다에 해당하는 공지는 없다
    const none = (await user.get(`/vulnerabilities?technologyIds=${tech.python},${tech.react}`).expect(200)).body;
    expect(none.total).toBe(0);
    // 그룹 안 OR + 그룹 간 AND: (JavaScript OR Python) AND (React OR Django)
    const mixed = (await user.get(`/vulnerabilities?technologyIds=${tech.javascript},${tech.python},${tech.react},${tech.django}`).expect(200)).body;
    expect(titles(mixed)).toEqual(['npm-react', 'pypi-django']);
  });

  it('그룹 간 결합을 OR 로 바꾸면 하나라도 일치하는 공지가 나온다', async () => {
    const body = (await user.get(`/vulnerabilities?groupMode=ANY_GROUP&technologyIds=${tech.python},${tech.react}`).expect(200)).body;
    expect(titles(body)).toEqual(['npm-react', 'pypi-django', 'pypi-other']);
  });

  it('JavaScript 와 TypeScript 는 npm 생태계를 공유한다', async () => {
    const js = (await user.get(`/vulnerabilities?technologyIds=${tech.javascript}`).expect(200)).body;
    const ts = (await user.get(`/vulnerabilities?technologyIds=${tech.typescript}`).expect(200)).body;
    expect(titles(js)).toEqual(titles(ts));
  });

  it('목록의 개수와 항목은 같은 필터 기준을 쓴다', async () => {
    const page1 = (await user.get(`/vulnerabilities?technologyIds=${tech.javascript},${tech.python}&pageSize=3&page=1`).expect(200)).body;
    const page2 = (await user.get(`/vulnerabilities?technologyIds=${tech.javascript},${tech.python}&pageSize=3&page=2`).expect(200)).body;
    expect(page1.total).toBe(4);
    expect(page1.items.length + page2.items.length).toBe(page1.total);
  });

  it('화면 필터는 저장된 관심 기술을 바꾸지 않는다', async () => {
    await user.put('/me/interests', { technologyIds: [tech.python] }).expect(200);
    await user.get(`/vulnerabilities?technologyIds=${tech.javascript}`).expect(200);
    expect((await user.get('/me/interests').expect(200)).body.technologyIds).toEqual([tech.python]);
  });

  it('관심 기술 일치만으로는 프로젝트 영향이 생기지 않는다', async () => {
    const project = (await user.post('/projects', { name: 'no-deps', technologyIds: [tech.javascript, tech.react] }).expect(201)).body;
    const body = (await user.get(`/vulnerabilities?technologyIds=${tech.react}&projectId=${project.id}`).expect(200)).body;
    expect(body.items[0].projectRelation.state).toBe('NOT_SCANNED');
    expect((await user.get(`/findings?projectId=${project.id}`).expect(200)).body.total).toBe(0);
    expect(await ctx.get(PrismaService).finding.count()).toBe(0);
  });

  it('검색·심각도·패치 여부 필터가 동작한다', async () => {
    expect((await user.get('/vulnerabilities?q=CVE-2099-1003').expect(200)).body.total).toBe(1);
    expect((await user.get('/vulnerabilities?q=django').expect(200)).body.total).toBe(1);
    expect((await user.get('/vulnerabilities?severities=CRITICAL').expect(200)).body.total).toBe(1);
    expect((await user.get('/vulnerabilities?patchAvailable=false').expect(200)).body.total).toBe(1);
    await user.get('/vulnerabilities?severities=NOPE').expect(400);
    await user.get('/vulnerabilities?projectMatch=AFFECTED').expect(400);
  });

  it('외부 공지의 HTML 은 텍스트 그대로 전달되고 서버가 해석하지 않는다', async () => {
    const list = (await user.get('/vulnerabilities?q=CVE-2099-1001').expect(200)).body;
    const detail = (await user.get(`/vulnerabilities/${list.items[0].id}`).expect(200)).body;
    expect(detail.details).toContain('<script>alert(1)</script>');
    expect(detail.identifiers).toEqual(['CVE-2099-1001', 'GHSA-2222-2222-2222']);
  });
});
