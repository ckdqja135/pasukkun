/**
 * Audit tests for vulnerability collection and the feed.
 * Each test asserts the expected (correct) behavior; a failing test is a confirmed defect.
 * All identifiers are fictional (CVE-2099-..., GHSA-...). No external requests are made.
 */
import { loadEnv } from '../src/config/env.js';
import { PrismaService } from '../src/db/prisma.service.js';
import { normalizeGhsa, type GhsaAdvisory } from '../src/ingestion/adapters/ghsa.adapter.js';
import { normalizeNvd } from '../src/ingestion/adapters/nvd.adapter.js';
import { OsvClient } from '../src/ingestion/adapters/osv.client.js';
import type { IngestContext } from '../src/ingestion/context.js';
import { IngestionService } from '../src/ingestion/ingestion.service.js';
import { VulnerabilityUpsertService } from '../src/ingestion/upsert.service.js';
import { ghsaFixture, nvdFixture } from './fixtures/advisories.js';
import { createTestContext, jsonResponse, type TestClient, type TestContext } from './harness.js';

const CVSS_98 = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
const CVSS_53 = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N';

describe('audit: ingestion and feed', () => {
  let ctx: TestContext;
  let prisma: PrismaService;
  let upserts: VulnerabilityUpsertService;
  let user: TestClient;
  const checkpoints = new Map<string, object>();

  const makeContext = (fetchImpl: (url: string) => Promise<Response>, emitEvents = true): IngestContext => ({
    env: loadEnv(),
    emitEvents,
    fetch: async (url) => fetchImpl(url),
    sleep: async () => undefined,
    getCheckpoint: async <T>(stream: string) => (checkpoints.get(stream) as T | undefined) ?? null,
    setCheckpoint: async (stream, cursor) => void checkpoints.set(stream, cursor),
    upsert: (advisory) => upserts.upsert(advisory, { emitEvents }),
    hasIdentifier: async (value) => (await prisma.vulnerabilityIdentifier.findUnique({ where: { value: value.toUpperCase() } })) !== null,
    setWindow: () => undefined,
    count: () => undefined,
    heartbeat: async () => undefined,
  });

  const ghsa = (id: string, cve: string | null, pkg: string, overrides: Partial<GhsaAdvisory> = {}): GhsaAdvisory =>
    ghsaFixture({
      ghsa_id: id,
      cve_id: cve,
      html_url: `https://github.com/advisories/${id}`,
      identifiers: [],
      summary: `${id} summary`,
      vulnerabilities: [{ package: { ecosystem: 'npm', name: pkg }, vulnerable_version_range: '< 2.0.0', first_patched_version: '2.0.0' }],
      ...overrides,
    });
  const vulnIdOf = async (source: 'GHSA' | 'NVD' | 'OSV', sourceId: string) =>
    (await prisma.sourceRecord.findUniqueOrThrow({ where: { source_sourceId: { source, sourceId } } })).vulnerabilityId;

  beforeAll(async () => {
    ctx = await createTestContext();
    prisma = ctx.get(PrismaService);
    upserts = ctx.get(VulnerabilityUpsertService);
    await ctx.get(IngestionService).ensureSources();
    user = await ctx.client('audit-ingest@example.com');
    // OSV: no matches for anything (the DB-ingested ranges drive the findings).
    ctx.get(OsvClient).fetchImpl = async (url, options) => {
      if (url.endsWith('/v1/querybatch')) {
        const queries = JSON.parse(options?.body ?? '{}').queries as unknown[];
        return jsonResponse({ results: queries.map(() => ({})) });
      }
      return jsonResponse({ message: 'not found' }, { status: 404 });
    };
  });
  afterAll(() => ctx.close());

  it('A: a CVE alias removed upstream must not keep attaching that CVE (and other advisories) to the old vulnerability', async () => {
    const A = 'GHSA-2c2c-2c2c-2c2c';
    await upserts.upsert(normalizeGhsa(ghsa(A, 'CVE-2099-7001', 'audit-alias-a')), { emitEvents: false });
    // GitHub corrects the CVE of advisory A: CVE-2099-7001 -> CVE-2099-7002
    await upserts.upsert(normalizeGhsa(ghsa(A, 'CVE-2099-7002', 'audit-alias-a', { description: 'corrected CVE' })), { emitEvents: false });
    const vA = await vulnIdOf('GHSA', A);
    const ids = (await prisma.vulnerabilityIdentifier.findMany({ where: { vulnerabilityId: vA } })).map((r) => r.value).sort();
    // A unrelated advisory for CVE-2099-7001 arrives
    await upserts.upsert(normalizeNvd(nvdFixture({ id: 'CVE-2099-7001' })), { emitEvents: false });
    await upserts.upsert(normalizeGhsa(ghsa('GHSA-3c3c-3c3c-3c3c', 'CVE-2099-7001', 'audit-alias-b')), { emitEvents: false });
    expect({
      identifiersOfA: ids,
      nvd7001SameAsA: (await vulnIdOf('NVD', 'CVE-2099-7001')) === vA,
      ghsaBMergedIntoA: (await vulnIdOf('GHSA', 'GHSA-3c3c-3c3c-3c3c')) === vA,
    }).toEqual({ identifiersOfA: ['CVE-2099-7002', A], nvd7001SameAsA: false, ghsaBMergedIntoA: false });
  });

  it('A2: when the NVD record of the old CVE is already merged in, a corrected alias splits it out with its data', async () => {
    const A = 'GHSA-2g2g-2g2g-2g2g';
    await upserts.upsert(normalizeGhsa(ghsa(A, 'CVE-2099-7011', 'audit-split-a', { cvss_severities: { cvss_v3: { vector_string: CVSS_53, score: 5.3 }, cvss_v4: null } })), {
      emitEvents: false,
    });
    await upserts.upsert(normalizeNvd(nvdFixture({ id: 'CVE-2099-7011' })), { emitEvents: false });
    const vA = await vulnIdOf('GHSA', A);
    expect(await vulnIdOf('NVD', 'CVE-2099-7011')).toBe(vA);
    // GitHub corrects the CVE of advisory A: CVE-2099-7011 -> CVE-2099-7012
    await upserts.upsert(
      normalizeGhsa(ghsa(A, 'CVE-2099-7012', 'audit-split-a', { description: 'corrected CVE', cvss_severities: { cvss_v3: { vector_string: CVSS_53, score: 5.3 }, cvss_v4: null } })),
      { emitEvents: false },
    );
    const vNvd = await vulnIdOf('NVD', 'CVE-2099-7011');
    // An unrelated advisory for the old CVE joins the NVD record, not A
    await upserts.upsert(normalizeGhsa(ghsa('GHSA-3g3g-3g3g-3g3g', 'CVE-2099-7011', 'audit-split-b')), { emitEvents: false });
    const a = await prisma.vulnerability.findUniqueOrThrow({ where: { id: vA }, include: { identifiers: true, sources: true, cvss: true, products: true } });
    const nvd = await prisma.vulnerability.findUniqueOrThrow({ where: { id: vNvd }, include: { identifiers: true, cvss: true } });
    expect({
      aIds: a.identifiers.map((r) => r.value).sort(),
      aSources: a.sources.map((r) => `${r.source}:${r.sourceId}`),
      aCvss: a.cvss.map((r) => r.source),
      aProducts: a.products.length,
      nvdSeparate: vNvd !== vA,
      nvdIds: nvd.identifiers.map((r) => r.value).sort(),
      nvdHasCvss: nvd.cvss.some((r) => r.source.startsWith('NVD')),
      ghsaBWithNvd: (await vulnIdOf('GHSA', 'GHSA-3g3g-3g3g-3g3g')) === vNvd,
    }).toEqual({
      aIds: ['CVE-2099-7012', A],
      aSources: [`GHSA:${A}`],
      aCvss: ['GHSA'],
      aProducts: 0,
      nvdSeparate: true,
      nvdIds: ['CVE-2099-7011', 'GHSA-3g3g-3g3g-3g3g'],
      nvdHasCvss: true,
      ghsaBWithNvd: true,
    });
  });

  it('B1: two GHSA advisories sharing a CVE keep both CVSS scores (highest wins)', async () => {
    const vuln = (id: string, vector: string, score: number, pkg: string) =>
      normalizeGhsa(ghsa(id, 'CVE-2099-7101', pkg, { cvss_severities: { cvss_v3: { vector_string: vector, score }, cvss_v4: null } }));
    await upserts.upsert(vuln('GHSA-4c4c-4c4c-4c4c', CVSS_98, 9.8, 'audit-cvss-c'), { emitEvents: false });
    await upserts.upsert(vuln('GHSA-5c5c-5c5c-5c5c', CVSS_53, 5.3, 'audit-cvss-d'), { emitEvents: false });
    const v = await prisma.vulnerability.findUniqueOrThrow({ where: { id: await vulnIdOf('GHSA', 'GHSA-4c4c-4c4c-4c4c') }, include: { cvss: true } });
    expect({ score: v.cvssScore, severity: v.severity, cvssRows: v.cvss.length }).toEqual({ score: 9.8, severity: 'CRITICAL', cvssRows: 2 });
  });

  it('B2: a withdrawn duplicate GHSA (same CVE, no CVSS) must not erase the active advisory CVSS', async () => {
    await upserts.upsert(
      normalizeGhsa(ghsa('GHSA-6c6c-6c6c-6c6c', 'CVE-2099-7102', 'audit-dup-f', { cvss_severities: { cvss_v3: { vector_string: CVSS_98, score: 9.8 }, cvss_v4: null } })),
      { emitEvents: false },
    );
    await upserts.upsert(
      normalizeGhsa(ghsa('GHSA-7c7c-7c7c-7c7c', 'CVE-2099-7102', 'audit-dup-f', { withdrawn_at: new Date().toISOString(), cvss_severities: null })),
      { emitEvents: false },
    );
    const v = await prisma.vulnerability.findUniqueOrThrow({ where: { id: await vulnIdOf('GHSA', 'GHSA-6c6c-6c6c-6c6c') } });
    expect({ score: v.cvssScore, severity: v.severity }).toEqual({ score: 9.8, severity: 'CRITICAL' });
  });

  it('B3: two NVD records on one vulnerability keep each other CVSS and CPE products', async () => {
    const P = 'GHSA-8c8c-8c8c-8c8c';
    await upserts.upsert(
      normalizeGhsa(ghsa(P, 'CVE-2099-7103', 'audit-two-cves', { identifiers: [{ type: 'CVE', value: 'CVE-2099-7104' }], cvss_severities: null })),
      { emitEvents: false },
    );
    await upserts.upsert(
      normalizeNvd(nvdFixture({ id: 'CVE-2099-7103', configurations: [{ nodes: [{ cpeMatch: [{ vulnerable: true, criteria: 'cpe:2.3:a:nodejs:node.js:*:*:*:*:*:*:*:*' }] }] }] })),
      { emitEvents: false },
    );
    await upserts.upsert(
      normalizeNvd(
        nvdFixture({
          id: 'CVE-2099-7104',
          metrics: { cvssMetricV31: [{ source: 'nvd@nist.gov', type: 'Primary', cvssData: { version: '3.1', vectorString: CVSS_53, baseScore: 5.3 } }] },
          configurations: [],
        }),
      ),
      { emitEvents: false },
    );
    const v = await prisma.vulnerability.findUniqueOrThrow({ where: { id: await vulnIdOf('GHSA', P) }, include: { products: true, technologies: { include: { technology: true } } } });
    expect({
      score: v.cvssScore,
      products: v.products.map((p) => `${p.vendor}:${p.product}`),
      nodeTag: v.technologies.some((t) => t.technology.slug === 'nodejs'),
    }).toEqual({ score: 9.8, products: ['nodejs:node.js'], nodeTag: true });
  });

  it('OK1: references and htmlUrl keep only http(s) links', async () => {
    const Q = 'GHSA-6f6f-6f6f-6f6f';
    await upserts.upsert(
      normalizeGhsa(ghsa(Q, 'CVE-2099-7701', 'audit-ref-lib', { html_url: 'javascript:alert(1)', references: ['javascript:alert(1)', 'data:text/html,x', 'https://ok.example/a', 'https://x.example/"onmouseover=1', 'HTTP://ok.example/b'] })),
      { emitEvents: false },
    );
    const record = await prisma.sourceRecord.findUniqueOrThrow({ where: { source_sourceId: { source: 'GHSA', sourceId: Q } } });
    expect({ htmlUrl: record.htmlUrl, refs: (record.references as Array<{ url: string }>).map((r) => r.url) }).toEqual({
      htmlUrl: null,
      refs: ['https://ok.example/a', 'HTTP://ok.example/b'],
    });
  });

  it('OK2: withdrawn then reinstated advisory clears withdrawnAt and restores ranges', async () => {
    const R = 'GHSA-7f7f-7f7f-7f7f';
    await upserts.upsert(normalizeGhsa(ghsa(R, 'CVE-2099-7702', 'audit-unwd-lib', { withdrawn_at: new Date().toISOString() })), { emitEvents: false });
    const id = await vulnIdOf('GHSA', R);
    const w = await prisma.vulnerability.findUniqueOrThrow({ where: { id } });
    await upserts.upsert(normalizeGhsa(ghsa(R, 'CVE-2099-7702', 'audit-unwd-lib')), { emitEvents: false });
    const u = await prisma.vulnerability.findUniqueOrThrow({ where: { id } });
    expect({ w: w.withdrawnAt !== null, wRange: w.rangeHash, u: u.withdrawnAt, uRange: u.rangeHash !== '', patch: u.patchStatus }).toEqual({ w: true, wRange: '', u: null, uRange: true, patch: 'AVAILABLE' });
  });

  it('OK3: EPSS attaches through CVE identifiers and uses the highest score per vulnerability', async () => {
    const { gzipSync } = await import('node:zlib');
    const { EpssAdapter } = await import('../src/ingestion/adapters/epss.adapter.js');
    const id = await vulnIdOf('GHSA', 'GHSA-8c8c-8c8c-8c8c'); // has CVE-2099-7103 and CVE-2099-7104
    const csv = '#model_version:v2099,score_date:2099-01-01T00:00:00Z\ncve,epss,percentile\nCVE-2099-7103,0.10000,0.5\nCVE-2099-7104,0.90000,0.99\nCVE-2099-0000,0.5,0.5\n';
    const body = gzipSync(Buffer.from(csv));
    await ctx.get(EpssAdapter).run(makeContext(async () => new Response(body)));
    const v = await prisma.vulnerability.findUniqueOrThrow({ where: { id } });
    expect({ score: v.epssScore, date: v.epssDate }).toEqual({ score: 0.9, date: '2099-01-01' });
  });

  it('OK4: feed filters and paging return consistent sets', async () => {
    const totalOf = async (q: string) => (await user.get(`/vulnerabilities?${q}`).expect(200)).body.total as number;
    const all = await totalOf('');
    expect((await totalOf('kev=true')) + (await totalOf('kev=false'))).toBe(all);
    expect((await totalOf('patchAvailable=true')) + (await totalOf('patchAvailable=false'))).toBe(all);
    const sev = await Promise.all(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].map((s) => totalOf(`severities=${s}`)));
    expect(sev.reduce((a, b) => a + b, 0)).toBe(all);
    expect(await totalOf('publishedFrom=2000-01-01&publishedTo=2000-01-01')).toBe(0);
    for (const sort of ['published', 'severity', 'epss', 'modified']) {
      const seen: string[] = [];
      for (let page = 1; page <= Math.ceil(all / 3); page += 1) {
        seen.push(...((await user.get(`/vulnerabilities?sort=${sort}&pageSize=3&page=${page}`).expect(200)).body.items as Array<{ id: string }>).map((i) => i.id));
      }
      expect(new Set(seen).size).toBe(all);
    }
  });
});
