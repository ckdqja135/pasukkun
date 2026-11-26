import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomToken, sha256 } from '../common/crypto.js';
import type { AppEnv } from '../config/env.js';
import { APP_ENV } from '../db/db.module.js';
import { PrismaService } from '../db/prisma.service.js';
import type { MeDto, UpdateSettingsDto, UserSettingsDto } from './auth.dto.js';
import { isAllowedLogin } from './allowlist.js';
import type { GithubProfile } from './github-oauth.client.js';

export interface IssuedSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
  userId: string;
}

export class LoginRejected extends Error {
  constructor(readonly code: 'not_allowed') {
    super(code);
  }
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  githubEnabled(): boolean {
    return this.env.githubOAuth !== null;
  }

  /**
   * GitHub 로 확인된 사람에게 세션을 발급한다. 처음 온 사람이면 계정을 만든다(가입).
   * 사람은 변하지 않는 GitHub ID 로 식별하고, 아이디(login)는 바뀌면 따라 갱신한다.
   */
  async loginWithGithub(profile: GithubProfile): Promise<IssuedSession> {
    if (!isAllowedLogin(this.env, profile.login)) throw new LoginRejected('not_allowed');
    if (this.env.allowedGithubUsers.length > 0) {
      // 허용 목록은 바뀔 수 있는 아이디로 적는다. 이 아이디로 이미 들어온 적 있는 다른 GitHub 계정이 있으면,
      // 아이디를 넘겨받은 다른 사람일 수 있으므로 막는다. (허용 목록을 쓰는 서버는 사용자가 적어 전부 읽어도 된다.)
      const others = await this.prisma.user.findMany({ where: { NOT: { githubId: profile.id } }, select: { githubLogin: true } });
      if (others.some((other) => other.githubLogin.toLowerCase() === profile.login.toLowerCase())) throw new LoginRejected('not_allowed');
    }
    const user = await this.prisma.user.upsert({
      where: { githubId: profile.id },
      update: { githubLogin: profile.login, name: profile.name, lastLoginAt: new Date() },
      create: { githubId: profile.id, githubLogin: profile.login, name: profile.name, settings: { create: {} } },
    });
    return this.issueSession(user.id);
  }

  async logout(sessionId: string | undefined): Promise<void> {
    if (sessionId) await this.prisma.session.deleteMany({ where: { id: sessionId } });
  }

  private async issueSession(userId: string): Promise<IssuedSession> {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const expiresAt = new Date(Date.now() + this.env.sessionTtlDays * 86_400_000);
    await this.prisma.session.create({ data: { id: sha256(token), userId, csrfToken, expiresAt } });
    return { token, csrfToken, expiresAt, userId };
  }

  async me(userId: string, csrfToken: string): Promise<MeDto> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { id: user.id, githubLogin: user.githubLogin, name: user.name, csrfToken, settings: await this.getSettings(userId) };
  }

  async getSettings(userId: string): Promise<UserSettingsDto> {
    const settings = await this.prisma.userSettings.upsert({ where: { userId }, update: {}, create: { userId } });
    return {
      timezone: settings.timezone,
      interestMatchMode: settings.interestMatchMode,
      quietHoursEnabled: settings.quietHoursEnabled,
      quietStartMinute: settings.quietStartMinute,
      quietEndMinute: settings.quietEndMinute,
      urgentBypassQuiet: settings.urgentBypassQuiet,
    };
  }

  async updateSettings(userId: string, dto: UpdateSettingsDto): Promise<UserSettingsDto> {
    if (dto.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: dto.timezone });
      } catch {
        throw new BadRequestException(`알 수 없는 시간대입니다: ${dto.timezone}`);
      }
    }
    await this.prisma.userSettings.upsert({ where: { userId }, update: dto, create: { userId, ...dto } });
    return this.getSettings(userId);
  }
}
