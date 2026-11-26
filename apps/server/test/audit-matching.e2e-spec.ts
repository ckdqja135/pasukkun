/**
 * Audit probes (e2e) for matching, re-assessment, notification of matches and remediation.
 * Each test asserts the CORRECT behavior; a failing test is a defect repro.
 * All identifiers / package names are invented fixtures. OSV is mocked; no external requests.
 */
import { PrismaService } from '../src/db/prisma.service.js';
import { normalizeGhsa } from '../src/ingestion/adapters/ghsa.adapter.js';
import { OsvClient, type OsvRecord } from '../src/ingestion/adapters/osv.client.js';
import { VulnerabilityUpsertService } from '../src/ingestion/upsert.service.js';
import { ghsaFixture } from './fixtures/advisories.js';
import { createTestContext, jsonResponse, type TestClient, type TestContext } from './harness.js';

const reg = (name: string, version: string) => `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;
const lockfile = (deps: Record<string, string>) =>
  JSON.stringify({
    name: 'audit-app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'audit-app', version: '1.0.0', dependencies: Object.fromEntries(Object.keys(deps).map((n) => [n, '*'])) },
      ...Object.fromEntries(Object.entries(deps).map(([n, v]) => [`node_modules/${n}`, { version: v, resolved: reg(n, v) }])),
    },
  });

const osvRecord = (id: string, pkg: string, events: Array<Record<string, string>>, extra: Partial<OsvRecord> = {}): OsvRecord => ({
  id,
  modified: '2026-11-20T00:00:00Z',
  published: '2026-11-20T00:00:00Z',
  aliases: [],
  summary: `${pkg}: audit fixture`,
  details: 'fixture',
  severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
  affected: [{ package: { ecosystem: 'npm', name: pkg }, ranges: [{ type: 'SEMVER', events }] }],
  ...extra,
});

describe('audit: matching / re-assessment / notification / remediation', () => {
  let ctx: TestContext;
  let user: TestClient;
  let prisma: PrismaService;
  /** "name@version" -> OSV ids reported by querybatch */
  const osvTable = new Map<string, string[]>();
  /** id -> record, or 'fail' to make the detail fetch fail */
  const osvRecords = new Map<string, OsvRecord | 'fail'>();
  const queriedNames: string[] = [];
  let osvDown = false;

  const project = async (name: string) => (await user.post('/projects', { name, environments: ['PRODUCTION'], exposure: 'PUBLIC' }).expect(201)).body.id as string;
  const upload = (projectId: string, deps: Record<string, string>) =>
    user.post(`/projects/${projectId}/snapshots`, { inputType: 'LOCKFILE', fileName: 'package-lock.json', lockfileContent: lockfile(deps) }).expect(201);
  const findings = async (projectId: string, extra = '') =>
    (await user.get(`/findings?projectId=${projectId}&pageSize=100${extra}`).expect(200)).body.items as Array<{ packageName: string; version: string; versionMatch: string; resolvedAt: string | null }>;
  const newMatchEvents = (projectId: string) => prisma.notificationEvent.count({ where: { projectId, type: 'PROJECT_NEW_MATCH' } });

  beforeAll(async () => {
    ctx = await createTestContext();
    user = await ctx.client('audit@example.com');
    prisma = ctx.get(PrismaService);
    ctx.get(OsvClient).fetchImpl = async (url, options) => {
      if (osvDown) throw new Error('fixture: OSV unreachable');
      if (url.endsWith('/v1/querybatch')) {
        const queries = JSON.parse(options?.body ?? '{}').queries as Array<{ package: { name: string }; version: string }>;
        queriedNames.push(...queries.map((q) => q.package.name));
        return jsonResponse({
          results: queries.map((q) => {
            const ids = osvTable.get(`${q.package.name}@${q.version}`) ?? [];
            return ids.length ? { vulns: ids.map((id) => ({ id, modified: '2026-11-20T00:00:00Z' })) } : {};
          }),
        });
      }
      const id = decodeURIComponent(url.split('/').pop() ?? '');
      const record = osvRecords.get(id);
      if (!record) return jsonResponse({ code: 5, message: 'Bug not found.' }, { status: 404 });
      if (record === 'fail') throw new Error('fixture: OSV detail unreachable');
      return jsonResponse(record);
    };
  });
  afterAll(() => ctx.close());

  it('a project already scanned gets a PROJECT_NEW_MATCH when another project\'s scan is what first discovers the advisory', async () => {
    const projectB = await project('audit-b');
    await upload(projectB, { 'audit-shared': '1.0.0' });
    await ctx.drain(); // B: initial scan, nothing known yet
    expect(await findings(projectB)).toEqual([]);

    // The advisory now exists in OSV (not yet seen by the GHSA feed).
    const id = 'GHSA-2c2c-3f3f-4g4g';
    osvTable.set('audit-shared@1.0.0', [id]);
    osvRecords.set(id, osvRecord(id, 'audit-shared', [{ introduced: '0' }, { fixed: '1.0.1' }], { aliases: ['CVE-2099-7001'] }));

    const projectA = await project('audit-a');
    await upload(projectA, { 'audit-shared': '1.0.0' });
    await ctx.drain(); // A's scan fetches the advisory; B is re-assessed as a side effect

    expect((await findings(projectB)).map((f) => `${f.packageName}@${f.version}:${f.versionMatch}`)).toEqual(['audit-shared@1.0.0:AFFECTED']);
    // Later the GHSA feed ingests the same advisory (loud), and B is rescanned: still no project event.
    await ctx.get(VulnerabilityUpsertService).upsert(
      normalizeGhsa(
        ghsaFixture({
          ghsa_id: id,
          cve_id: 'CVE-2099-7001',
          identifiers: [{ type: 'GHSA', value: id }, { type: 'CVE', value: 'CVE-2099-7001' }],
          html_url: `https://github.com/advisories/${id}`,
          vulnerabilities: [{ package: { ecosystem: 'npm', name: 'audit-shared' }, vulnerable_version_range: '< 1.0.1', first_patched_version: '1.0.1' }],
        }),
      ),
      { emitEvents: true },
    );
    await ctx.drain();
    await user.post(`/projects/${projectB}/scans`).expect(202);
    await ctx.drain();
    expect(await newMatchEvents(projectB)).toBeGreaterThan(0);
  });

  it('package remediation target is not a version that another stored advisory marks affected', async () => {
    const upserts = ctx.get(VulnerabilityUpsertService);
    await upserts.upsert(
      normalizeGhsa(
        ghsaFixture({
          ghsa_id: 'GHSA-8p8p-9q9q-2r2r',
          cve_id: 'CVE-2099-7002',
          identifiers: [{ type: 'GHSA', value: 'GHSA-8p8p-9q9q-2r2r' }, { type: 'CVE', value: 'CVE-2099-7002' }],
          html_url: 'https://github.com/advisories/GHSA-8p8p-9q9q-2r2r',
          vulnerabilities: [{ package: { ecosystem: 'npm', name: 'audit-rem' }, vulnerable_version_range: '< 1.2.0', first_patched_version: '1.2.0' }],
        }),
      ),
      { emitEvents: false },
    );
    // A second advisory introduced in exactly the version the first one is fixed in.
    await upserts.upsert(
      normalizeGhsa(
        ghsaFixture({
          ghsa_id: 'GHSA-3v3v-4w4w-5x5x',
          cve_id: 'CVE-2099-7003',
          identifiers: [{ type: 'GHSA', value: 'GHSA-3v3v-4w4w-5x5x' }, { type: 'CVE', value: 'CVE-2099-7003' }],
          html_url: 'https://github.com/advisories/GHSA-3v3v-4w4w-5x5x',
          vulnerabilities: [{ package: { ecosystem: 'npm', name: 'audit-rem' }, vulnerable_version_range: '>= 1.2.0, < 1.3.0', first_patched_version: '1.3.0' }],
        }),
      ),
      { emitEvents: false },
    );
    const projectD = await project('audit-d');
    await upload(projectD, { 'audit-rem': '1.1.0' });
    await ctx.drain();
    const items = (await user.get(`/remediation/packages?projectId=${projectD}`).expect(200)).body.items as Array<{ packageName: string; installedVersion: string; targetVersion: string | null }>;
    const item = items.find((i) => i.packageName === 'audit-rem');
    expect(item?.installedVersion).toBe('1.1.0');
    // 1.2.0 is inside GHSA-3v3v-4w4w-5x5x (>= 1.2.0, < 1.3.0)
    expect(item?.targetVersion).not.toBe('1.2.0');
  });

  it('OSV detail fetch failure for a newly reported id leaves the scan PARTIAL (fail-closed)', async () => {
    const id = 'GHSA-7m7m-8p8p-9q9q';
    osvTable.set('audit-fail@1.0.0', [id]);
    osvRecords.set(id, 'fail');
    const projectF = await project('audit-f');
    await upload(projectF, { 'audit-fail': '1.0.0' });
    await ctx.drain();
    const scan = (await user.get(`/projects/${projectF}`).expect(200)).body.lastScan;
    expect(scan.status).toBe('PARTIAL');
    expect(scan.error).toContain(id);
  });

  // OSV querybatch says the installed version is affected; the stored OSV record range says it is not -> UNKNOWN.
  const osvOnlyProject = async (pkg: string, id: string) => {
    osvTable.set(`${pkg}@1.0.7`, [id]);
    osvRecords.set(id, osvRecord(id, pkg, [{ introduced: '0' }, { fixed: '1.0.5' }]));
    const projectId = await project(`audit-${pkg}`);
    await upload(projectId, { [pkg]: '1.0.7' });
    await ctx.drain();
    return projectId;
  };

  it('an OSV-reported UNKNOWN finding is still open after the scan that discovered it', async () => {
    const projectH = await osvOnlyProject('audit-osvonly', 'GHSA-9q9q-2r2r-3v3v');
    expect((await findings(projectH)).map((f) => f.versionMatch)).toEqual(['UNKNOWN']);
  });

  it('a project setting change (reprioritize) does not close an OSV-reported UNKNOWN finding', async () => {
    const projectJ = await osvOnlyProject('audit-osvenv', 'GHSA-2v2v-3w3w-4x4x');
    await user.post(`/projects/${projectJ}/scans`).expect(202);
    await ctx.drain(); // rescan: record cached, no re-assess job -> finding reopened as UNKNOWN
    expect((await findings(projectJ)).map((f) => f.versionMatch)).toEqual(['UNKNOWN']);
    await user.patch(`/projects/${projectJ}`, { environments: ['TEST'] }).expect(200);
    await ctx.drain();
    expect((await findings(projectJ)).map((f) => f.versionMatch)).toEqual(['UNKNOWN']);
  });

  it('an OSV outage during a rescan does not close an OSV-reported UNKNOWN finding', async () => {
    const projectI = await osvOnlyProject('audit-osvdown', 'GHSA-4w4w-5x5x-6c6c');
    await user.post(`/projects/${projectI}/scans`).expect(202);
    await ctx.drain();
    expect((await findings(projectI)).map((f) => f.versionMatch)).toEqual(['UNKNOWN']);
    osvDown = true;
    try {
      await user.post(`/projects/${projectI}/scans`).expect(202);
      await ctx.drain();
    } finally {
      osvDown = false;
    }
    expect((await user.get(`/projects/${projectI}`).expect(200)).body.lastScan.status).toBe('PARTIAL');
    expect((await findings(projectI)).map((f) => f.versionMatch)).toEqual(['UNKNOWN']);
  });

  it('OSV is queried with the package name as written in the lockfile (legacy mixed-case npm names)', async () => {
    const projectG = await project('audit-g');
    await upload(projectG, { JSONStream: '1.3.5' });
    await ctx.drain();
    expect(queriedNames).toContain('JSONStream');
  });
});
