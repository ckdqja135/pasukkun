import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { pkceChallenge, randomToken, sha256 } from '../common/crypto.js';
import type { AppEnv } from '../config/env.js';
import { APP_ENV } from '../db/db.module.js';
import { PrismaService } from '../db/prisma.service.js';
import { formatFromFileName } from '../domain/lockfile.js';
import type { Prisma } from '../generated/prisma/client.js';
import { JobService } from '../jobs/job.service.js';
import { LIMITS, ProjectService } from '../project/project.service.js';
import { GithubAppClient, GithubAppError, isValidLockfilePath, type AccessibleRepo } from './github-app.client.js';
import type {
  GithubImportInputDto,
  GithubImportResultDto,
  GithubInspectDto,
  GithubInspectRepoDto,
  GithubLinkDto,
  GithubStatusDto,
} from './github.dto.js';

export const GITHUB_CALLBACK_PATH = '/api/v1/github/callback';
const LINK_TTL_MS = 15 * 60_000;
const MAX_LINKS_PER_HOUR = 10;

type LinkRow = Prisma.GithubLinkRequestGetPayload<object>;

/** 화면에 돌려보낼 오류 코드 */
export type GithubLinkError = 'expired' | 'session' | 'denied' | 'github' | 'not_configured';

export function syncJobKey(projectId: string): string {
  return `github-sync:${projectId}`;
}

@Injectable()
export class GithubLinkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: GithubAppClient,
    private readonly projects: ProjectService,
    private readonly jobs: JobService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  get redirectUri(): string {
    return `${this.env.appOrigin}${GITHUB_CALLBACK_PATH}`;
  }

  status(): GithubStatusDto {
    return { enabled: this.client.enabled(), installUrl: this.client.installUrl(), syncMinutes: this.env.githubSyncMinutes };
  }

  /** 저장소 가져오기 시작: state 는 해시만 저장하고, PKCE verifier 는 호출부가 짧은 쿠키로 둔다. */
  async start(userId: string): Promise<{ url: string; verifier: string }> {
    if (!this.client.enabled()) throw new BadRequestException('GitHub 앱이 설정되지 않아 저장소를 가져올 수 없습니다. 서비스 운영자에게 문의해 주세요.');
    const recent = await this.prisma.githubLinkRequest.count({ where: { userId, createdAt: { gt: new Date(Date.now() - 3_600_000) } } });
    if (recent >= MAX_LINKS_PER_HOUR) {
      throw new HttpException('GitHub 연결은 시간당 10번까지 시작할 수 있습니다. 잠시 후 다시 시도해 주세요.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const state = randomToken(24);
    const verifier = randomToken(48);
    await this.prisma.githubLinkRequest.create({ data: { userId, stateHash: sha256(state), expiresAt: new Date(Date.now() + LINK_TTL_MS) } });
    return { url: this.client.authorizeUrl({ redirectUri: this.redirectUri, state, codeChallenge: pkceChallenge(verifier) }), verifier };
  }

  /**
   * GitHub 에서 돌아왔을 때. 사용자 토큰으로 접근 가능한 저장소 목록만 읽어 두고 토큰은 버린다.
   * 돌려주는 값은 프론트의 정해진 주소에 붙일 결과다.
   */
  async callback(
    userId: string | undefined,
    query: { code: unknown; state: unknown; error: unknown; verifier: string | undefined },
  ): Promise<{ linkId: string } | { error: GithubLinkError }> {
    if (!this.client.enabled()) return { error: 'not_configured' };
    if (typeof query.state !== 'string' || query.state === '' || query.state.length > 100) return { error: 'expired' };
    const request = await this.prisma.githubLinkRequest.findUnique({ where: { stateHash: sha256(query.state) } });
    if (!request || request.status !== 'PENDING' || request.expiresAt <= new Date()) return { error: 'expired' };
    // 시작한 사람의 로그인 세션에서만 끝낼 수 있다 (다른 사람의 GitHub 결과를 끼워 넣는 공격 방지).
    if (!userId || userId !== request.userId) return { error: 'session' };
    if (query.error !== undefined) {
      await this.fail(request.id, '사용자가 GitHub 에서 취소했습니다.');
      return { error: 'denied' };
    }
    if (typeof query.code !== 'string' || query.code === '' || query.code.length > 200 || !query.verifier || query.verifier.length > 200) {
      await this.fail(request.id, 'GitHub 인증 정보가 올바르지 않습니다.');
      return { error: 'session' };
    }
    // 같은 state 로 두 번 끝내지 못하게 먼저 상태를 바꾼다.
    const claimed = await this.prisma.githubLinkRequest.updateMany({ where: { id: request.id, status: 'PENDING' }, data: { status: 'EXCHANGING' } });
    if (claimed.count === 0) return { error: 'expired' };

    let repos: AccessibleRepo[];
    try {
      const userToken = await this.client.exchangeCode({ code: query.code, codeVerifier: query.verifier, redirectUri: this.redirectUri });
      repos = await this.client.listAccessibleRepos(userToken);
      // userToken 은 여기서 버린다. 어디에도 저장하지 않는다.
    } catch {
      await this.fail(request.id, 'GitHub 에서 저장소 목록을 받아오지 못했습니다.');
      return { error: 'github' };
    }
    await this.prisma.githubLinkRequest.update({
      where: { id: request.id },
      data: { status: 'READY', repos: repos as unknown as object[], expiresAt: new Date(Date.now() + LINK_TTL_MS) },
    });
    // 지금 접근할 수 있는 저장소의 연결은 접근 확인 시각을 새로 하고, 끊겨 있던 연결은 바로 다시 확인한다.
    // 목록에는 상한이 있고 보관된 저장소는 빠지므로, 목록에 없다는 이유만으로 끊지는 않는다 (확인 주기가 지나면 멈춘다).
    const accessible = new Set(repos.map((repo) => repo.repoId));
    const verified = (await this.prisma.projectRepoSource.findMany({ where: { project: { userId } }, select: { projectId: true, repoId: true, status: true } })).filter(
      (source) => accessible.has(source.repoId),
    );
    if (verified.length > 0) {
      await this.prisma.projectRepoSource.updateMany({ where: { projectId: { in: verified.map((source) => source.projectId) } }, data: { accessVerifiedAt: new Date() } });
      for (const source of verified.filter((row) => row.status === 'DISCONNECTED')) {
        await this.jobs.enqueue('github-sync', { projectId: source.projectId }, { dedupeKey: syncJobKey(source.projectId), maxAttempts: 2 });
      }
    }
    return { linkId: request.id };
  }

  private async fail(id: string, error: string) {
    await this.prisma.githubLinkRequest.update({ where: { id }, data: { status: 'FAILED', error } });
  }

  private async owned(userId: string, id: string): Promise<LinkRow> {
    const request = await this.prisma.githubLinkRequest.findFirst({ where: { id, userId } });
    if (!request) throw new NotFoundException('연결 요청을 찾을 수 없습니다.');
    return request;
  }

  private async ready(userId: string, id: string): Promise<{ request: LinkRow; repos: AccessibleRepo[] }> {
    const request = await this.owned(userId, id);
    if (request.status !== 'READY' || request.expiresAt <= new Date()) {
      throw new BadRequestException('연결 시간이 지났습니다. [GitHub 저장소 가져오기]를 다시 눌러 주세요.');
    }
    return { request, repos: (request.repos ?? []) as unknown as AccessibleRepo[] };
  }

  /** 이미 가져온 (저장소, lockfile 경로) */
  private async importedPaths(userId: string): Promise<Map<string, Set<string>>> {
    const rows = await this.prisma.projectRepoSource.findMany({ where: { project: { userId } }, select: { repoId: true, lockfilePath: true } });
    const map = new Map<string, Set<string>>();
    for (const row of rows) map.set(row.repoId, (map.get(row.repoId) ?? new Set()).add(row.lockfilePath));
    return map;
  }

  async link(userId: string, id: string): Promise<GithubLinkDto> {
    const request = await this.owned(userId, id);
    const expired = request.status !== 'COMPLETED' && request.status !== 'FAILED' && request.expiresAt <= new Date();
    const status = expired ? 'EXPIRED' : request.status === 'EXCHANGING' ? 'PENDING' : (request.status as GithubLinkDto['status']);
    const imported = await this.importedPaths(userId);
    const repos = status === 'READY' ? ((request.repos ?? []) as unknown as AccessibleRepo[]) : [];
    return {
      id: request.id,
      status,
      error: request.error,
      expiresAt: request.expiresAt.toISOString(),
      installUrl: this.client.installUrl(),
      repos: repos.map((repo) => ({
        repoId: repo.repoId,
        fullName: repo.fullName,
        private: repo.private,
        description: repo.description,
        defaultBranch: repo.defaultBranch,
        importedPaths: [...(imported.get(repo.repoId) ?? [])],
      })),
    };
  }

  /** 고른 저장소에서 lockfile 위치를 찾는다. 연결할 때 확인한 목록에 있는 저장소만 다룬다. */
  async inspect(userId: string, id: string, repoIds: string[]): Promise<GithubInspectDto> {
    const { repos } = await this.ready(userId, id);
    const byId = new Map(repos.map((repo) => [repo.repoId, repo]));
    const selected = [...new Set(repoIds)].map((repoId) => byId.get(repoId));
    if (selected.some((repo) => repo === undefined)) throw new BadRequestException('목록에 없는 저장소가 포함되어 있습니다.');
    const imported = await this.importedPaths(userId);

    const results: GithubInspectRepoDto[] = [];
    const byInstallation = new Map<string, AccessibleRepo[]>();
    for (const repo of selected as AccessibleRepo[]) byInstallation.set(repo.installationId, [...(byInstallation.get(repo.installationId) ?? []), repo]);
    for (const [installationId, group] of byInstallation) {
      let token: string | null = null;
      try {
        token = await this.client.installationToken(installationId, group.map((repo) => repo.repoId));
      } catch {
        token = null;
      }
      for (const repo of group) {
        const base: GithubInspectRepoDto = { repoId: repo.repoId, fullName: repo.fullName, defaultBranch: repo.defaultBranch, lockfiles: [], truncated: false, error: null };
        if (!token) {
          results.push({ ...base, error: 'GitHub 앱이 이 저장소를 읽을 수 없습니다. 앱 설치에서 저장소가 빠졌는지 확인해 주세요.' });
          continue;
        }
        try {
          const head = await this.client.branchHead(token, repo.fullName, repo.defaultBranch);
          const found = await this.client.findLockfiles(token, repo.fullName, head);
          results.push({
            ...base,
            truncated: found.truncated,
            lockfiles: found.lockfiles.map((file) => ({
              path: file.path,
              format: formatFromFileName(file.path) ?? 'NPM',
              size: file.size,
              imported: imported.get(repo.repoId)?.has(file.path) ?? false,
            })),
          });
        } catch (error) {
          results.push({ ...base, error: error instanceof GithubAppError ? error.message : 'GitHub 에서 저장소를 읽지 못했습니다.' });
        }
      }
    }
    return { repos: results };
  }

  /** 고른 lockfile 마다 프로젝트를 만들고 첫 가져오기·검사를 대기열에 넣는다. */
  async import(userId: string, id: string, input: GithubImportInputDto): Promise<GithubImportResultDto> {
    const { repos } = await this.ready(userId, id);
    const byId = new Map(repos.map((repo) => [repo.repoId, repo]));
    const imported = await this.importedPaths(userId);
    const result: GithubImportResultDto = { created: [], skipped: [] };
    const seen = new Set<string>();

    for (const item of input.items) {
      const repo = byId.get(item.repoId);
      const key = `${item.repoId}:${item.lockfilePath}`;
      const skip = (reason: string) => result.skipped.push({ repoId: item.repoId, lockfilePath: item.lockfilePath, reason });
      if (!repo) {
        skip('목록에 없는 저장소입니다.');
        continue;
      }
      if (!isValidLockfilePath(item.lockfilePath)) {
        skip('지원하는 lockfile 경로가 아닙니다.');
        continue;
      }
      if (seen.has(key) || imported.get(item.repoId)?.has(item.lockfilePath)) {
        skip('이미 가져온 lockfile 입니다.');
        continue;
      }
      seen.add(key);
      const count = await this.prisma.project.count({ where: { userId } });
      if (count >= LIMITS.projectsPerUser) {
        skip(`프로젝트는 계정당 ${LIMITS.projectsPerUser}개까지 만들 수 있습니다.`);
        continue;
      }
      const repoName = repo.fullName.split('/')[1];
      const dir = item.lockfilePath.includes('/') ? item.lockfilePath.slice(0, item.lockfilePath.lastIndexOf('/')) : '';
      const project = await this.projects.create(userId, {
        name: (dir ? `${repoName}/${dir}` : repoName).slice(0, 100),
        description: repo.description.slice(0, 2000),
      });
      await this.prisma.projectRepoSource.create({
        data: {
          projectId: project.id,
          installationId: repo.installationId,
          repoId: repo.repoId,
          fullName: repo.fullName,
          defaultBranch: repo.defaultBranch,
          lockfilePath: item.lockfilePath,
        },
      });
      await this.jobs.enqueue('github-sync', { projectId: project.id }, { dedupeKey: syncJobKey(project.id), maxAttempts: 2 });
      result.created.push({ projectId: project.id, name: project.name });
    }
    if (result.created.length > 0) {
      await this.prisma.githubLinkRequest.update({ where: { id }, data: { status: 'COMPLETED' } });
    }
    return result;
  }

  /** [지금 확인] */
  async requestSync(userId: string, projectId: string): Promise<void> {
    await this.projects.findOwned(userId, projectId);
    const source = await this.prisma.projectRepoSource.findUnique({ where: { projectId } });
    if (!source) throw new BadRequestException('GitHub 저장소와 연결된 프로젝트가 아닙니다.');
    await this.jobs.enqueue('github-sync', { projectId }, { dedupeKey: syncJobKey(projectId), maxAttempts: 2 });
  }

  /** 연결 해제. 프로젝트와 지금까지의 구성·분석 결과는 그대로 둔다. */
  async disconnect(userId: string, projectId: string): Promise<void> {
    await this.projects.findOwned(userId, projectId);
    await this.prisma.projectRepoSource.deleteMany({ where: { projectId } });
  }

  async purgeLinkRequests(olderThan: Date): Promise<void> {
    await this.prisma.githubLinkRequest.deleteMany({ where: { createdAt: { lt: olderThan } } });
  }
}
