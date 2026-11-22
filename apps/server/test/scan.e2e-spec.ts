import { PrismaService } from '../src/db/prisma.service.js';
import { normalizeGhsa } from '../src/ingestion/adapters/ghsa.adapter.js';
import { normalizeNvd } from '../src/ingestion/adapters/nvd.adapter.js';
import { OsvClient } from '../src/ingestion/adapters/osv.client.js';
import { VulnerabilityUpsertService } from '../src/ingestion/upsert.service.js';
import { ghsaFixture, lockfileFixture, nvdFixture, osvFixture } from './fixtures/advisories.js';
import { createTestContext, jsonResponse, type TestClient, type TestContext } from './harness.js';

interface Finding {
  id: string;
  packageName: string;
  version: string;
  versionMatch: string;
  exploitCondition: string;
  priority: string;
  remediationStatus: string;
  fixedVersion: string | null;
  needsRecheck: boolean;
  resolvedAt: string | null;
  isDirect: boolean;
}

describe('프로젝트 검사와 영향도 분석', () => {
  let ctx: TestContext;
  let user: TestClient;
  let projectId: string;
  let osvMode: 'ok' | 'fail' | 'empty' = 'ok';
  let osvCalls = 0;

  const upload = (content: string) => user.post(`/projects/${projectId}/snapshots`, { inputType: 'LOCKFILE', fileName: 'package-lock.json', lockfileContent: content });
  const findings = async (query = ''): Promise<Finding[]> => (await user.get(`/findings?projectId=${projectId}&pageSize=100${query}`).expect(200)).body.items;
  const lastScan = async () => (await user.get(`/projects/${projectId}`).expect(200)).body.lastScan;

  beforeAll(async () => {
    ctx = await createTestContext();
    user = await ctx.client('scan@example.com');
    projectId = (await user.post('/projects', { name: 'fixture-app', environments: ['PRODUCTION'], exposure: 'PUBLIC' }).expect(201)).body.id;

    // OSV 를 흉내낸다: fixture-lib@2.1.0 만 일치로 보고한다.
    ctx.get(OsvClient).fetchImpl = async (url, options) => {
      osvCalls += 1;
      if (osvMode === 'fail') throw new Error('fixture: OSV unreachable');
      if (url.endsWith('/v1/querybatch')) {
        const queries = JSON.parse(options?.body ?? '{}').queries as Array<{ package: { name: string }; version: string }>;
        return jsonResponse({
          results: queries.map((query) =>
            osvMode === 'ok' && query.package.name === 'fixture-lib' && query.version === '2.1.0' ? { vulns: [{ id: 'GHSA-f2f2-g3g3-h4h4', modified: new Date().toISOString() }] } : {},
          ),
        });
      }
      return jsonResponse(osvFixture());
    };
  });
  afterAll(() => ctx.close());

  it('지원하지 않는 입력을 정상 구성으로 받지 않는다', async () => {
    const v1 = await user.post(`/projects/${projectId}/snapshots/validate`, { inputType: 'LOCKFILE', lockfileContent: JSON.stringify({ lockfileVersion: 1, dependencies: {} }) }).expect(200);
    expect(v1.body).toMatchObject({ valid: false, errorCode: 'UNSUPPORTED_VERSION' });
    await upload(JSON.stringify({ lockfileVersion: 1, dependencies: {} })).expect(400);
    await upload('lockfileVersion: 9\n').expect(400);
    await upload(JSON.stringify({ name: 'x', dependencies: { a: '^1.0.0' } })).expect(400);
    await user.post(`/projects/${projectId}/snapshots`, { inputType: 'MANUAL', packages: [{ name: 'fixture-lib', version: '^2.0.0' }] }).expect(400);
    expect((await user.get(`/projects/${projectId}`).expect(200)).body.currentSnapshot).toBeNull();
    // 구성이 없으면 검사를 시작할 수 없다.
    await user.post(`/projects/${projectId}/scans`).expect(400);
  });

  it('업로드 내용을 저장 전에 검증하고 검사 불가 항목과 외부 전송 사실을 알려준다', async () => {
    const preview = (await user.post(`/projects/${projectId}/snapshots/validate`, { inputType: 'LOCKFILE', lockfileContent: lockfileFixture() }).expect(200)).body;
    expect(preview).toMatchObject({ valid: true, lockfileVersion: 3, packageCount: 5, scannableCount: 4, multiVersionCount: 1 });
    expect(JSON.stringify(preview.warnings)).toContain('Git 참조');
    expect(preview.disclosure).toContain('패키지명과 버전이 외부');
  });

  it('검사는 작업 ID 를 돌려주고, 같은 패키지의 여러 설치 버전과 전이 의존성을 각각 평가한다', async () => {
    const created = (await upload(lockfileFixture()).expect(201)).body;
    expect(created.scan.status).toBe('QUEUED');
    expect((await user.get(`/scans/${created.scan.id}`).expect(200)).body.status).toBe('QUEUED');
    await ctx.drain();

    const scan = (await user.get(`/scans/${created.scan.id}`).expect(200)).body;
    expect(scan.status).toBe('SUCCEEDED');
    expect(scan.isInitial).toBe(true);
    expect(scan.packagesScanned).toBe(4); // fixture-web, fixture-lib@2.1.0, fixture-lib@3.2.0, fixture-dev
    expect(scan.scope.skipped).toEqual([{ reason: 'Git 참조 - 레지스트리 버전으로 조회할 수 없음', count: 1 }]);
    expect(scan.snapshotId).toBe(created.snapshot.id);

    const items = await findings();
    // 2.1.0 은 [2.0.0, 2.3.1) 에 포함, 3.2.0 은 [3.0.0, 3.1.0) 밖 → 행을 만들지 않는다.
    expect(items.map((f) => `${f.packageName}@${f.version}:${f.versionMatch}`)).toEqual(['fixture-lib@2.1.0:AFFECTED']);
    expect(items[0]).toMatchObject({ fixedVersion: '2.3.1', isDirect: true, remediationStatus: 'UNREVIEWED' });
    // 확인할 조건을 알려주는 데이터가 아직 없으므로 "아직 분석하지 않음"이다. 충족으로 단정하지 않는다.
    expect(items[0].exploitCondition).toBe('NOT_ANALYZED');
  });

  it('판단 근거·출처·분석 시각과 우선순위 규칙을 함께 보여준다', async () => {
    const [finding] = await findings();
    const detail = (await user.get(`/findings/${finding.id}`).expect(200)).body;
    expect(detail.evidence.evaluations.map((e: { source: string; result: string }) => `${e.source}:${e.result}`).sort()).toEqual(['OSV:AFFECTED']);
    expect(detail.evidence.lastScan.osvReported).toBe(true);
    expect(detail.evidence.fix).toMatchObject({ kind: 'FIXED', version: '2.3.1' });
    expect(detail.evidence.installPaths[0].dependencyPath).toEqual(['fixture-lib@2.1.0']);
    expect(detail.priorityReasons.ruleId).toBe('R3');
    expect(detail.priority).toBe('HIGH');
    expect(Date.parse(detail.analyzedAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('여러 출처(GHSA, NVD, OSV)의 같은 취약점은 하나로 묶인다', async () => {
    const upserts = ctx.get(VulnerabilityUpsertService);
    await upserts.upsert(normalizeGhsa(ghsaFixture()), { emitEvents: true });
    await upserts.upsert(normalizeNvd(nvdFixture()), { emitEvents: true });
    await ctx.drain();
    const prisma = ctx.get(PrismaService);
    expect(await prisma.vulnerability.count()).toBe(1);
    expect((await prisma.sourceRecord.findMany({ select: { source: true }, orderBy: { source: 'asc' } })).map((r) => r.source)).toEqual(['GHSA', 'NVD', 'OSV']);
    const list = (await user.get('/vulnerabilities?q=CVE-2099-0001').expect(200)).body;
    expect(list.total).toBe(1);
    const detail = (await user.get(`/vulnerabilities/${list.items[0].id}`).expect(200)).body;
    // 출처별 CVSS 를 모두 보존하고, 대표값은 가장 높은 점수를 쓴다.
    expect(detail.cvss.length).toBe(3);
    expect(detail.cvssScore).toBe(9.8);
    expect(detail.conflicts.join(' ')).toContain('CVSS');
    // 심각도가 올라가 우선순위가 다시 계산된다 (9.8, 운영, 공개 → 긴급).
    const [finding] = await findings();
    expect(finding.priority).toBe('URGENT');
    // GHSA 가 취약 함수를 명시했으므로 "확인 필요"로 바뀐다 (충족으로 단정하지 않는다).
    expect(finding.exploitCondition).toBe('NEEDS_CHECK');
    const findingDetail = (await user.get(`/findings/${finding.id}`).expect(200)).body;
    expect(findingDetail.evidence.conditionChecks.map((c: { key: string }) => c.key)).toContain('functions');
    expect(findingDetail.evidence.evaluations.map((e: { source: string; result: string }) => `${e.source}:${e.result}`).sort()).toEqual(['GHSA:AFFECTED', 'OSV:AFFECTED']);
  });

  it('수동 검토는 작성자·근거·시각을 남기고 우선순위에 반영된다', async () => {
    const [finding] = await findings();
    await user.post(`/findings/${finding.id}/reviews`, { verdict: 'NOT_MET', rationale: '' }).expect(400);
    const reviewed = (await user.post(`/findings/${finding.id}/reviews`, { verdict: 'NOT_MET', rationale: 'merge() 를 호출하는 코드가 없음을 확인', checks: [{ label: '취약 기능 사용 여부', state: 'NOT_APPLICABLE' }] }).expect(201)).body;
    expect(reviewed.exploitCondition).toBe('NOT_MET');
    expect(reviewed.priority).toBe('LOW');
    expect(reviewed.priorityReasons.ruleId).toBe('R0');
    expect(reviewed.reviews[0]).toMatchObject({ authorName: 'scan', verdict: 'NOT_MET' });
    expect(reviewed.versionMatch).toBe('AFFECTED');
  });

  it('조치 완료로 바꿔도 버전 매칭 결과는 그대로다', async () => {
    const [finding] = await findings();
    await user.patch(`/findings/${finding.id}/status`, { status: 'RISK_ACCEPTED' }).expect(400);
    await user.patch(`/findings/${finding.id}/status`, { status: 'RISK_ACCEPTED', reason: '내부 전용', reviewDueAt: new Date(Date.now() - 1000).toISOString() }).expect(400);
    const accepted = (await user.patch(`/findings/${finding.id}/status`, { status: 'RISK_ACCEPTED', reason: '내부 전용', reviewDueAt: new Date(Date.now() + 86_400_000 * 30).toISOString() }).expect(200)).body;
    expect(accepted).toMatchObject({ remediationStatus: 'RISK_ACCEPTED', acceptReason: '내부 전용' });
    const done = (await user.patch(`/findings/${finding.id}/status`, { status: 'DONE', reason: '업데이트 예정' }).expect(200)).body;
    expect(done.remediationStatus).toBe('DONE');
    expect(done.versionMatch).toBe('AFFECTED');
    expect(done.resolvedAt).toBeNull();
    expect(done.history.map((h: { toStatus: string }) => h.toStatus)).toEqual(['DONE', 'RISK_ACCEPTED']);
  });

  it('프로젝트 환경이 바뀌면 기존 검토에 재확인 표시가 붙고 우선순위를 다시 계산한다', async () => {
    await user.patch(`/projects/${projectId}`, { exposure: 'INTERNAL' }).expect(200);
    await ctx.drain();
    const [finding] = await findings();
    expect(finding.needsRecheck).toBe(true);
    // 재확인이 필요한 "조건 불충족" 검토는 우선순위에 반영하지 않는다.
    expect(finding.priority).not.toBe('LOW');
  });

  it('공지의 영향 범위가 바뀌면 다시 평가한다', async () => {
    const upserts = ctx.get(VulnerabilityUpsertService);
    // GHSA 가 범위를 수정: 2.x 는 2.0.5 에서 이미 수정된 것으로 정정 → 2.1.0 은 GHSA 기준 미포함, OSV 는 여전히 포함 → 출처 간 불일치
    const narrowed = ghsaFixture({
      vulnerabilities: [{ package: { ecosystem: 'npm', name: 'fixture-lib' }, vulnerable_version_range: '>= 2.0.0, < 2.0.5', first_patched_version: '2.0.5' }],
    });
    const result = await upserts.upsert(normalizeGhsa(narrowed), { emitEvents: true });
    expect(result.rangeChanged).toBe(true);
    await ctx.drain();
    const [finding] = await findings();
    expect(finding.versionMatch).toBe('UNKNOWN');
    const detail = (await user.get(`/findings/${finding.id}`).expect(200)).body;
    expect(detail.evidence.reason).toContain('출처 간 영향 범위 불일치');
    expect(detail.priority).toBe('NEEDS_CHECK');

    // OSV 도 같은 범위로 정정되면 영향 범위에서 벗어난다. 기록은 지우지 않고 닫는다.
    await upserts.upsert(
      (await import('../src/ingestion/adapters/osv.client.js')).normalizeOsv(
        osvFixture({ affected: [{ package: { ecosystem: 'npm', name: 'fixture-lib' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '2.0.0' }, { fixed: '2.0.5' }] }] }] }),
      ),
      { emitEvents: true },
    );
    await ctx.drain();
    expect(await findings()).toEqual([]);
    const all = await findings('&includeResolved=true');
    expect(all[0]).toMatchObject({ versionMatch: 'NOT_AFFECTED' });
    expect(all[0].resolvedAt).not.toBeNull();
  });

  it('재수집으로 수정 시각만 바뀌면 아무것도 다시 하지 않는다', async () => {
    const prisma = ctx.get(PrismaService);
    const before = { events: await prisma.notificationEvent.count(), jobs: await prisma.job.count() };
    const same = ghsaFixture({
      updated_at: new Date().toISOString(),
      vulnerabilities: [{ package: { ecosystem: 'npm', name: 'fixture-lib' }, vulnerable_version_range: '>= 2.0.0, < 2.0.5', first_patched_version: '2.0.5' }],
    });
    const result = await ctx.get(VulnerabilityUpsertService).upsert(normalizeGhsa(same), { emitEvents: true });
    expect(result).toMatchObject({ changed: false, created: false });
    expect({ events: await prisma.notificationEvent.count(), jobs: await prisma.job.count() }).toEqual(before);
    expect(await prisma.sourceRecord.count({ where: { source: 'GHSA' } })).toBe(1);
  });

  it('구성을 바꿔 재검사하면 해소된 항목과 새 항목이 반영된다', async () => {
    // 범위를 원래대로 되돌린 뒤, 2.1.0 → 2.3.1 로 올린 lockfile 을 올린다.
    const upserts = ctx.get(VulnerabilityUpsertService);
    await upserts.upsert(normalizeGhsa(ghsaFixture()), { emitEvents: false });
    await upserts.upsert((await import('../src/ingestion/adapters/osv.client.js')).normalizeOsv(osvFixture()), { emitEvents: false });
    await ctx.drain();
    expect((await findings()).map((f) => f.versionMatch)).toEqual(['AFFECTED']);

    osvMode = 'empty';
    await upload(lockfileFixture({ fixtureLibVersions: ['2.3.1', '3.0.5'] })).expect(201);
    await ctx.drain();
    const scan = await lastScan();
    expect(scan).toMatchObject({ status: 'SUCCEEDED', isInitial: false, snapshotSeq: 2 });
    const active = await findings();
    // 2.3.1 은 수정 버전 → 해소. 전이 의존성 3.0.5 는 [3.0.0, 3.1.0) 에 포함 → 새로 일치.
    // OSV 가 보고하지 않았어도 수집된 공지의 범위로 일치를 찾는다.
    expect(active.map((f) => `${f.packageName}@${f.version}:${f.versionMatch}:${f.isDirect}`)).toEqual(['fixture-lib@3.0.5:AFFECTED:false']);
    const resolved = (await findings('&includeResolved=true')).find((f) => f.version === '2.1.0');
    expect(resolved?.resolvedAt).not.toBeNull();
    // 이전에 "조치 완료"로 표시했던 기록은 그대로 남는다.
    expect(resolved?.remediationStatus).toBe('DONE');
  });

  it('외부 조회가 실패하면 검사를 부분 완료로 남기고 "일치 없음"으로 처리하지 않는다', async () => {
    osvMode = 'fail';
    const before = osvCalls;
    await user.post(`/projects/${projectId}/scans`).expect(202);
    await ctx.drain();
    expect(osvCalls).toBeGreaterThan(before);
    const scan = await lastScan();
    expect(scan.status).toBe('PARTIAL');
    expect(scan.error).toContain('OSV 조회 실패');
    expect(scan.packagesScanned).toBe(0);
    expect(scan.sourceFreshness.OSV.status).toBe('FAILING');
    // 기존 결과를 지우거나 해소 처리하지 않는다.
    expect((await findings()).map((f) => f.version)).toEqual(['3.0.5']);
    const status = (await user.get('/status/ingestion').expect(200)).body;
    expect(status.sources.find((s: { key: string }) => s.key === 'OSV')).toMatchObject({ status: 'FAILING' });
  });

  it('일치가 없는 프로젝트는 검사 완료와 검사 범위를 함께 기록한다', async () => {
    osvMode = 'empty';
    const clean = (await user.post('/projects', { name: 'clean-app' }).expect(201)).body.id;
    await user.post(`/projects/${clean}/snapshots`, { inputType: 'MANUAL', packages: [{ name: 'fixture-clean', version: '1.0.0' }] }).expect(201);
    await ctx.drain();
    const project = (await user.get(`/projects/${clean}`).expect(200)).body;
    expect(project.lastScan.status).toBe('SUCCEEDED');
    expect(project.lastScan.scope.notCovered.join(' ')).toContain('코드 도달 가능성');
    expect(project.counts).toMatchObject({ affected: 0, unknown: 0 });
  });

  it('공지가 철회되면 일치 결과를 닫는다', async () => {
    const upserts = ctx.get(VulnerabilityUpsertService);
    const { normalizeOsv } = await import('../src/ingestion/adapters/osv.client.js');
    await upserts.upsert(normalizeGhsa(ghsaFixture({ withdrawn_at: new Date().toISOString() })), { emitEvents: true });
    await upserts.upsert(normalizeOsv(osvFixture({ withdrawn: new Date().toISOString() })), { emitEvents: true });
    await upserts.upsert(normalizeNvd(nvdFixture({ vulnStatus: 'Rejected' })), { emitEvents: true });
    await ctx.drain();
    expect(await findings()).toEqual([]);
    expect((await user.get('/vulnerabilities?q=CVE-2099-0001').expect(200)).body.total).toBe(0);
    expect((await user.get('/vulnerabilities?q=CVE-2099-0001&includeWithdrawn=true').expect(200)).body.items[0].withdrawn).toBe(true);
  });

  it('대시보드의 숫자와 목록은 같은 필터를 쓴다', async () => {
    const dashboard = (await user.get('/dashboard/summary').expect(200)).body;
    for (const card of dashboard.cards as Array<{ count: number; query: Record<string, unknown> }>) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(card.query)) params.set(key, Array.isArray(value) ? value.join(',') : String(value));
      const list = (await user.get(`/findings?${params.toString()}`).expect(200)).body;
      expect(list.total).toBe(card.count);
    }
  });
});
