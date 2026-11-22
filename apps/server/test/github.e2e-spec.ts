import { getStorageToken, type ThrottlerStorageService } from '@nestjs/throttler';
import { PrismaService } from '../src/db/prisma.service.js';
import { GithubSyncService } from '../src/github/github-sync.service.js';
import { OsvClient } from '../src/ingestion/adapters/osv.client.js';
import { lockfileFixture } from './fixtures/advisories.js';
import { createTestContext, jsonResponse, type TestClient, type TestContext } from './harness.js';

const NPM_LOCK = JSON.stringify({
  name: 'web',
  lockfileVersion: 3,
  packages: {
    '': { name: 'web', dependencies: { express: '^4.18.0' } },
    'node_modules/express': { version: '4.18.2', resolved: 'https://registry.npmjs.org/express/-/express-4.18.2.tgz', dependencies: { qs: '6.11.0' } },
    'node_modules/qs': { version: '6.11.0', resolved: 'https://registry.npmjs.org/qs/-/qs-6.11.0.tgz' },
  },
});
const PNPM_LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      react:
        specifier: ^19.0.0
        version: 19.3.1

packages:

  react@19.3.1:
    resolution: {integrity: sha512-x}

snapshots:

  react@19.3.1: {}
`;
const YARN_LOCK = `# yarn lockfile v1


lodash@^4.17.15:
  version "4.17.21"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#679591c564c3bffaae8454cf0b3df370c3d6911c"
`;

describe('GitHub 저장소 가져오기', () => {
  let ctx: TestContext;
  let prisma: PrismaService;
  let alice: TestClient;
  let bob: TestClient;

  const setupGithub = () => {
    const gh = ctx.githubApp;
    gh.reset();
    gh.repos.set(9001, { id: 9001, fullName: 'acme/web', private: false, description: 'Acme web app', defaultBranch: 'main', installationId: 501, head: 'a'.repeat(40), files: new Map() });
    gh.repos.set(9002, { id: 9002, fullName: 'acme/private-api', private: true, description: '', defaultBranch: 'develop', installationId: 501, head: 'b'.repeat(40), files: new Map() });
    gh.repos.set(9003, { id: 9003, fullName: 'bob/secret', private: true, description: 'bob only', defaultBranch: 'main', installationId: 777, head: 'c'.repeat(40), files: new Map() });
    gh.setFile(9001, 'package-lock.json', NPM_LOCK);
    gh.setFile(9001, 'package.json', JSON.stringify({ name: 'web', dependencies: { express: '^4.18.0' } }));
    gh.setFile(9001, 'apps/mobile/pnpm-lock.yaml', PNPM_LOCK);
    gh.setFile(9001, 'node_modules/left-pad/package-lock.json', NPM_LOCK);
    gh.setFile(9001, 'src/index.ts', 'export {}');
    gh.setFile(9002, 'yarn.lock', YARN_LOCK);
    gh.setFile(9003, 'package-lock.json', lockfileFixture());
    gh.installations.set(501, new Set([9001, 9002]));
    gh.installations.set(777, new Set([9003]));
    gh.userInstallations.set(alice.login, [501]);
    gh.userInstallations.set(bob.login, [777]);
  };

  const linkId = (url: URL) => url.searchParams.get('github_link');
  const readyLink = async (client: TestClient) => {
    const url = await ctx.githubAppLink(client);
    const id = linkId(url);
    if (!id) throw new Error(`link failed: ${url.toString()}`);
    return id;
  };
  const importRepos = async (client: TestClient, items: Array<{ repoId: string; lockfilePath: string }>) => {
    const id = await readyLink(client);
    return (await client.post(`/github/links/${id}/import`, { items }).expect(200)).body as { created: Array<{ projectId: string; name: string }>; skipped: Array<{ reason: string }> };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    prisma = ctx.get(PrismaService);
    alice = await ctx.client('alice-gh');
    bob = await ctx.client('bob-gh');
    ctx.get(OsvClient).fetchImpl = async (url, options) => {
      const body = JSON.parse(String(options?.body ?? '{"queries":[]}')) as { queries: unknown[] };
      return jsonResponse({ results: body.queries.map(() => ({})) });
    };
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    setupGithub();
    // 연결 시작 요청 한도(분당·시간당)는 테스트마다 비운다. 한도 자체는 아래에서 따로 확인한다.
    const throttle = ctx.app.get<ThrottlerStorageService>(getStorageToken());
    throttle.storage.clear();
    // 요청 시각 기록은 내부 맵에 따로 남는다.
    (throttle as unknown as { hitExpirations: Map<string, unknown> }).hitExpirations.clear();
    await prisma.githubLinkRequest.deleteMany();
  });

  it('설정 상태와 앱 설치 주소를 알려준다', async () => {
    const status = await alice.get('/github/status').expect(200);
    expect(status.body).toEqual({ enabled: true, installUrl: 'https://github.com/apps/pasukkun-fixture/installations/select_target', syncMinutes: 360 });
  });

  it('GitHub 인증 주소는 state 와 PKCE 를 쓰고, verifier 는 콜백 경로에만 보내는 쿠키에 둔다', async () => {
    const start = await alice.post('/github/link').expect(201);
    const url = new URL(start.body.url as string);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('Iv23fixtureapp');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5273/api/v1/github/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')?.length).toBeGreaterThan(20);
    const cookie = (start.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('psk_gh='));
    expect(cookie).toMatch(/Path=\/api\/v1\/github\/callback/);
    expect(cookie).toMatch(/HttpOnly/);
  });

  it('돌아오면 사용자가 접근할 수 있는 저장소만 보여주고, 사용자 토큰은 저장하지 않는다', async () => {
    const url = await ctx.githubAppLink(alice);
    expect(url.pathname).toBe('/projects');
    const id = linkId(url);
    const link = await alice.get(`/github/links/${id}`).expect(200);
    expect(link.body.status).toBe('READY');
    expect(link.body.repos.map((r: { fullName: string }) => r.fullName).sort()).toEqual(['acme/private-api', 'acme/web']);
    expect(ctx.githubApp.exchanges.at(-1)?.get('code_verifier')).toBeTruthy();

    const dump = JSON.stringify(await prisma.githubLinkRequest.findMany());
    expect(dump).not.toContain('ghu_');
  });

  it('고른 저장소에서 lockfile 을 찾는다 (node_modules 제외, 설치 토큰은 고른 저장소·읽기 권한으로만)', async () => {
    const id = await readyLink(alice);
    const inspect = await alice.post(`/github/links/${id}/inspect`, { repoIds: ['9001', '9002'] }).expect(200);
    const web = inspect.body.repos.find((r: { repoId: string }) => r.repoId === '9001');
    expect(web.lockfiles.map((f: { path: string; format: string }) => [f.path, f.format])).toEqual([
      ['package-lock.json', 'NPM'],
      ['apps/mobile/pnpm-lock.yaml', 'PNPM'],
    ]);
    const api = inspect.body.repos.find((r: { repoId: string }) => r.repoId === '9002');
    expect(api.lockfiles.map((f: { path: string }) => f.path)).toEqual(['yarn.lock']);
    const tokenRequest = ctx.githubApp.tokenRequests.at(-1);
    expect(tokenRequest?.body).toEqual({ repository_ids: [9001, 9002], permissions: { contents: 'read' } });
  });

  it('가져오면 프로젝트가 만들어지고, lockfile 을 받아 검사하며 사용 기술도 채운다', async () => {
    const result = await importRepos(alice, [
      { repoId: '9001', lockfilePath: 'package-lock.json' },
      { repoId: '9001', lockfilePath: 'apps/mobile/pnpm-lock.yaml' },
      { repoId: '9002', lockfilePath: 'yarn.lock' },
    ]);
    expect(result.created.map((p) => p.name)).toEqual(['web', 'web/apps/mobile', 'private-api']);
    await ctx.drain();

    const web = (await alice.get(`/projects/${result.created[0].projectId}`).expect(200)).body;
    expect(web.description).toBe('Acme web app');
    expect(web.github).toMatchObject({ fullName: 'acme/web', lockfilePath: 'package-lock.json', branch: 'main', status: 'OK', commitSha: ctx.githubApp.repos.get(9001)?.head });
    expect(web.currentSnapshot).toMatchObject({ source: 'GITHUB', lockfileFormat: 'NPM', packageCount: 2, sourceRef: ctx.githubApp.repos.get(9001)?.head });
    expect(web.lastScan.status).toBe('SUCCEEDED');
    const technologies = (await alice.get('/technologies').expect(200)).body as Array<{ id: string; slug: string }>;
    const express = technologies.find((t) => t.slug === 'express')?.id;
    expect(web.technologyIds).toContain(express);

    const mobile = (await alice.get(`/projects/${result.created[1].projectId}`).expect(200)).body;
    expect(mobile.currentSnapshot).toMatchObject({ lockfileFormat: 'PNPM', packageCount: 1 });
    const api = (await alice.get(`/projects/${result.created[2].projectId}`).expect(200)).body;
    expect(api.currentSnapshot).toMatchObject({ lockfileFormat: 'YARN', packageCount: 1 });
    expect(api.github.branch).toBe('develop');

    // 같은 lockfile 은 다시 가져오지 않는다
    const again = await importRepos(alice, [{ repoId: '9001', lockfilePath: 'package-lock.json' }]);
    expect(again.created).toHaveLength(0);
    expect(again.skipped[0].reason).toContain('이미');
  });

  it('lockfile 이 그대로면 새 구성을 만들지 않고, 바뀌면 새로 가져와 검사한다', async () => {
    const [created] = (await importRepos(alice, [{ repoId: '9002', lockfilePath: 'yarn.lock' }])).created ?? [];
    const projectId = created?.projectId ?? (await prisma.projectRepoSource.findFirstOrThrow({ where: { repoId: '9002', project: { userId: alice.userId } } })).projectId;
    await ctx.drain();
    const sync = ctx.get(GithubSyncService);
    expect(await sync.sync(projectId)).toBe('UNCHANGED');
    const seqBefore = (await alice.get(`/projects/${projectId}`).expect(200)).body.currentSnapshot.seq;

    ctx.githubApp.setFile(9002, 'yarn.lock', `${YARN_LOCK}\nqs@^6.0.0:\n  version "6.11.0"\n  resolved "https://registry.yarnpkg.com/qs/-/qs-6.11.0.tgz#abc"\n`);
    await alice.post(`/projects/${projectId}/github/sync`).expect(200);
    await ctx.drain();
    const after = (await alice.get(`/projects/${projectId}`).expect(200)).body;
    expect(after.currentSnapshot.seq).toBe(seqBefore + 1);
    expect(after.currentSnapshot.packageCount).toBe(2);
    expect(after.github.lastChangedAt).not.toBeNull();
  });

  it('앱에서 저장소가 빠지면 연결 끊김으로 표시하고, 연결 해제해도 프로젝트는 남는다', async () => {
    const created = await importRepos(alice, [{ repoId: '9001', lockfilePath: 'apps/mobile/pnpm-lock.yaml' }]);
    const projectId = created.created[0]?.projectId ?? (await prisma.projectRepoSource.findFirstOrThrow({ where: { repoId: '9001', lockfilePath: 'apps/mobile/pnpm-lock.yaml' } })).projectId;
    await ctx.drain();
    ctx.githubApp.installations.get(501)?.delete(9001);
    expect(await ctx.get(GithubSyncService).sync(projectId)).toBe('DISCONNECTED');
    const project = (await alice.get(`/projects/${projectId}`).expect(200)).body;
    expect(project.github.status).toBe('DISCONNECTED');
    expect(project.github.error).toContain('앱 설치');

    await alice.delete(`/projects/${projectId}/github`).expect(200);
    const after = (await alice.get(`/projects/${projectId}`).expect(200)).body;
    expect(after.github).toBeNull();
    expect(after.currentSnapshot).not.toBeNull();
  });

  it('주기가 된 연결만 확인 대기열에 넣는다', async () => {
    const sync = ctx.get(GithubSyncService);
    await prisma.projectRepoSource.updateMany({ data: { lastCheckedAt: new Date() } });
    expect(await sync.enqueueDue()).toBe(0);
    await prisma.projectRepoSource.updateMany({ data: { lastCheckedAt: new Date(Date.now() - 7 * 3_600_000) } });
    expect(await sync.enqueueDue()).toBeGreaterThan(0);
    await ctx.drain();
  });

  describe('보안', () => {
    it('다른 사람의 세션으로는 연결을 끝낼 수 없고, 같은 state 를 다시 쓸 수 없다', async () => {
      const hijack = await ctx.githubAppLink(alice, { as: bob });
      expect(hijack.searchParams.get('github_error')).toBe('session');
      const anonymous = await ctx.githubAppLink(alice, { as: null });
      expect(anonymous.searchParams.get('github_error')).toBe('session');

      const start = await alice.post('/github/link').expect(201);
      const state = new URL(start.body.url as string).searchParams.get('state') ?? '';
      const verifier = ((start.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('psk_gh=')) ?? '').split(';')[0];
      const first = await ctx.githubAppLink(alice, { state, cookie: verifier });
      expect(first.searchParams.get('github_link')).toBeTruthy();
      const replay = await ctx.githubAppLink(alice, { state, cookie: verifier });
      expect(replay.searchParams.get('github_error')).toBe('expired');
    });

    it('취소, verifier 없음, 잘못된 코드, 만료를 구분해 돌려보낸다', async () => {
      expect((await ctx.githubAppLink(alice, { error: 'access_denied' })).searchParams.get('github_error')).toBe('denied');
      expect((await ctx.githubAppLink(alice, { cookie: null })).searchParams.get('github_error')).toBe('session');
      expect((await ctx.githubAppLink(alice, { code: 'bad-code' })).searchParams.get('github_error')).toBe('github');
      expect((await ctx.githubAppLink(alice, { state: 'not-a-real-state' })).searchParams.get('github_error')).toBe('expired');

      const id = await readyLink(alice);
      await prisma.githubLinkRequest.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await alice.get(`/github/links/${id}`).expect(200)).body.status).toBe('EXPIRED');
      await alice.post(`/github/links/${id}/inspect`, { repoIds: ['9001'] }).expect(400);
    });

    it('연결할 때 확인한 목록에 없는 저장소는 찾거나 가져올 수 없다', async () => {
      const id = await readyLink(alice);
      await alice.post(`/github/links/${id}/inspect`, { repoIds: ['9003'] }).expect(400);
      const result = await alice.post(`/github/links/${id}/import`, { items: [{ repoId: '9003', lockfilePath: 'package-lock.json' }] }).expect(200);
      expect(result.body.created).toHaveLength(0);
      expect(await prisma.projectRepoSource.count({ where: { repoId: '9003' } })).toBe(0);
    });

    it('lockfile 이 아닌 경로나 저장소 밖 경로는 가져오지 않는다', async () => {
      const id = await readyLink(alice);
      const paths = ['../package-lock.json', 'src/index.ts', 'node_modules/left-pad/package-lock.json', '/etc/passwd', 'a/../../yarn.lock'];
      const result = await alice.post(`/github/links/${id}/import`, { items: paths.map((lockfilePath) => ({ repoId: '9001', lockfilePath })) }).expect(200);
      expect(result.body.created).toHaveLength(0);
      expect(result.body.skipped).toHaveLength(paths.length);
      await alice.post(`/github/links/${id}/inspect`, { repoIds: ['9001; rm -rf /'] }).expect(400);
    });

    it('다른 사람의 연결 요청과 프로젝트에는 손댈 수 없다', async () => {
      const id = await readyLink(alice);
      await bob.get(`/github/links/${id}`).expect(404);
      await bob.post(`/github/links/${id}/import`, { items: [{ repoId: '9001', lockfilePath: 'package-lock.json' }] }).expect(404);
      const source = await prisma.projectRepoSource.findFirstOrThrow({ where: { project: { userId: alice.userId } } });
      await bob.post(`/projects/${source.projectId}/github/sync`).expect(404);
      await bob.delete(`/projects/${source.projectId}/github`).expect(404);
      expect(await prisma.projectRepoSource.count({ where: { projectId: source.projectId } })).toBe(1);
    });

    it('연결 시작은 사용자마다 시간당 10번으로 제한한다', async () => {
      for (let i = 0; i < 10; i += 1) {
        await prisma.githubLinkRequest.create({ data: { userId: bob.userId, stateHash: `fixture-${i}`, expiresAt: new Date(Date.now() + 60_000) } });
      }
      await bob.post('/github/link').expect(429);
      await alice.post('/github/link').expect(201);
    });

    it('Setup URL 의 installation_id 는 믿지 않고 화면으로만 돌려보낸다', async () => {
      const before = await prisma.githubLinkRequest.count();
      const response = await alice.get('/github/setup?installation_id=777&setup_action=install').expect(302);
      expect(response.headers.location).toBe('http://localhost:5273/projects?github=installed');
      expect(await prisma.githubLinkRequest.count()).toBe(before);
    });

    it('어떤 테이블에도 GitHub 토큰을 남기지 않는다', async () => {
      const tables = ['GithubLinkRequest', 'ProjectRepoSource', 'ProjectSnapshot', 'Job', 'Project', 'AppState'];
      for (const table of tables) {
        const rows = await prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${table}"`);
        const text = JSON.stringify(rows, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
        expect(text).not.toMatch(/gh[usop]_/);
      }
    });
  });
});
