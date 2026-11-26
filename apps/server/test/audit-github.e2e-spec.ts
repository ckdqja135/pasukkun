import { PrismaService } from '../src/db/prisma.service.js';
import { GithubSyncService } from '../src/github/github-sync.service.js';
import { OsvClient } from '../src/ingestion/adapters/osv.client.js';
import { ProjectService } from '../src/project/project.service.js';
import { createTestContext, jsonResponse, type TestClient, type TestContext } from './harness.js';

/** Audit: GitHub import/sync, projects, snapshots, job queue, calendar. */
const npmLock = (count: number, patch = 0) => {
  const deps = Object.fromEntries(Array.from({ length: Math.min(count, 10) }, (_, i) => [`audit-pkg-${i}`, '^1.0.0']));
  const packages: Record<string, unknown> = { '': { name: 'app', dependencies: deps } };
  for (let i = 0; i < count; i += 1) {
    packages[`node_modules/audit-pkg-${i}`] = { version: `1.0.${patch}`, resolved: `https://registry.npmjs.org/audit-pkg-${i}/-/audit-pkg-${i}-1.0.${patch}.tgz` };
  }
  return JSON.stringify({ name: 'app', lockfileVersion: 3, packages });
};

describe('audit: github / projects / jobs / calendar', () => {
  let ctx: TestContext;
  let prisma: PrismaService;
  let carol: TestClient;
  let dave: TestClient;

  const linkId = async (client: TestClient) => {
    const url = await ctx.githubAppLink(client);
    const id = url.searchParams.get('github_link');
    if (!id) throw new Error(`link failed ${url.toString()}`);
    return id;
  };
  const importOne = async (client: TestClient, lockfilePath: string) => {
    const id = await linkId(client);
    const res = await client.post(`/github/links/${id}/import`, { items: [{ repoId: '9101', lockfilePath }] }).expect(200);
    if (!res.body.created[0]) throw new Error(`import skipped: ${JSON.stringify(res.body)}`);
    return res.body.created[0].projectId as string;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    prisma = ctx.get(PrismaService);
    carol = await ctx.client('carol-gh');
    dave = await ctx.client('dave-gh');
    ctx.get(OsvClient).fetchImpl = async (_url, options) => {
      const body = JSON.parse(String(options?.body ?? '{"queries":[]}')) as { queries: unknown[] };
      return jsonResponse({ results: body.queries.map(() => ({})) });
    };
    const gh = ctx.githubApp;
    gh.reset();
    gh.repos.set(9101, { id: 9101, fullName: 'audit/web', private: true, description: '', defaultBranch: 'main', installationId: 601, head: 'd'.repeat(40), files: new Map() });
    gh.setFile(9101, 'package-lock.json', npmLock(2));
    gh.setFile(9101, 'apps/api/package-lock.json', npmLock(2));
    gh.setFile(9101, 'apps/x/package-lock.json', npmLock(2));
    gh.installations.set(601, new Set([9101]));
    gh.userInstallations.set(carol.login, [601]);
    gh.userInstallations.set(dave.login, [601]);
  });
  afterAll(() => ctx.close());

  describe('github sync', () => {
    it('stops pulling a repo when access was not re-confirmed within 30 days, and resumes only after re-linking with access', async () => {
      const projectId = await importOne(carol, 'package-lock.json');
      await ctx.drain();
      const expire = () => prisma.projectRepoSource.update({ where: { projectId }, data: { accessVerifiedAt: new Date(Date.now() - 31 * 86_400_000) } });
      // 30일 넘게 다시 연결하지 않았으면 lockfile 이 바뀌어도 가져오지 않는다
      await expire();
      ctx.githubApp.setFile(9101, 'package-lock.json', npmLock(3, 1));
      expect(await ctx.get(GithubSyncService).sync(projectId)).toBe('DISCONNECTED');
      expect((await prisma.projectRepoSource.findUniqueOrThrow({ where: { projectId } })).error).toContain('다시 연결');
      // 아직 접근할 수 있는 사람이 다시 연결하면 확인 시각이 새로 되고 바로 다시 가져온다
      await linkId(carol);
      await ctx.drain();
      const resumed = await prisma.projectRepoSource.findUniqueOrThrow({ where: { projectId } });
      expect(resumed.status).toBe('OK');
      expect(Date.now() - resumed.accessVerifiedAt!.getTime()).toBeLessThan(60_000);
      // 조직에서 빠져 접근을 잃은 뒤에는 다시 연결해도 확인되지 않아 계속 멈춰 있다
      await expire();
      ctx.githubApp.userInstallations.set(carol.login, []);
      try {
        await linkId(carol);
      } finally {
        ctx.githubApp.userInstallations.set(carol.login, [601]);
      }
      ctx.githubApp.setFile(9101, 'package-lock.json', npmLock(3, 2));
      expect(await ctx.get(GithubSyncService).sync(projectId)).toBe('DISCONNECTED');
    });

    it('two concurrent imports of the same lockfile create one project', async () => {
      const id = await linkId(dave);
      const items = [{ repoId: '9101', lockfilePath: 'apps/api/package-lock.json' }];
      await Promise.all([dave.post(`/github/links/${id}/import`, { items }), dave.post(`/github/links/${id}/import`, { items })]);
      const count = await prisma.projectRepoSource.count({ where: { repoId: '9101', lockfilePath: 'apps/api/package-lock.json', project: { userId: dave.userId } } });
      expect(count).toBe(1);
    });

    it('OK: deleting a project while its scan / sync is queued does not break the queue', async () => {
      const projectId = await importOne(dave, 'package-lock.json');
      await carol.delete(`/projects/${projectId}`).expect(404);
      await dave.delete(`/projects/${projectId}`).expect(204);
      await ctx.drain();
      expect(await prisma.job.count({ where: { status: { in: ['QUEUED', 'RUNNING'] }, type: { in: ['scan', 'github-sync'] } } })).toBe(0);
      expect(await ctx.get(GithubSyncService).sync(projectId)).toBe('SKIPPED');
    });
  });

  describe('projects and snapshots', () => {

    it('readers never see a half-written snapshot (current pointer + package rows consistent)', async () => {
      const projects = ctx.get(ProjectService);
      const pid = (await carol.post('/projects', { name: 'dirty-read' }).expect(201)).body.id as string;
      await projects.createSnapshotFromSource(pid, { content: npmLock(5), packageJson: null, fileName: 'package-lock.json', sourceRef: null });
      let done = false;
      let polls = 0;
      const seen = new Set<string>();
      const save = projects
        .createSnapshotFromSource(pid, { content: npmLock(3000, 2), packageJson: null, fileName: 'package-lock.json', sourceRef: null })
        .finally(() => (done = true));
      while (!done) {
        const current = await prisma.projectSnapshot.findMany({ where: { projectId: pid, isCurrent: true }, select: { seq: true, packageCount: true, _count: { select: { packages: true } } } });
        if (current.length !== 1) seen.add(`current-count=${current.length}`);
        else if (current[0]._count.packages !== current[0].packageCount) seen.add(`seq${current[0].seq}-partial`);
        polls += 1;
        await new Promise((resolve) => setImmediate(resolve));
      }
      await save;
      expect([...seen], `polls during save=${polls}`).toEqual([]);
    });
  });
});
