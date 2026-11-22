import { Body, Controller, Get, HttpCode, Inject, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { pkceChallenge, randomToken, timingSafeEqualString } from '../common/crypto.js';
import type { AppEnv } from '../config/env.js';
import { APP_ENV } from '../db/db.module.js';
import { AuthStatusDto, MeDto, OkDto, UpdateSettingsDto, UserSettingsDto } from './auth.dto.js';
import { AuthService, LoginRejected, type IssuedSession } from './auth.service.js';
import { OAUTH_COOKIE, SESSION_COOKIE, type AuthedRequest, type AuthUser } from './auth.types.js';
import { CurrentUser, Public } from './decorators.js';
import { GithubOAuthClient, OAuthError } from './github-oauth.client.js';

const OAUTH_PATH = '/api/v1/auth/github';
const OAUTH_TTL_MS = 10 * 60_000;

@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly github: GithubOAuthClient,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  private get redirectUri(): string {
    return `${this.env.appOrigin}${OAUTH_PATH}/callback`;
  }

  private setSessionCookie(response: Response, session: IssuedSession): void {
    response.cookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: this.env.cookieSecure,
      sameSite: 'lax',
      path: '/',
      expires: session.expiresAt,
    });
  }

  /** 프론트의 정해진 주소로만 돌려보낸다 (외부 주소로 보내는 기능 없음). */
  private finish(response: Response, error?: string): void {
    response.clearCookie(OAUTH_COOKIE, { path: OAUTH_PATH });
    response.redirect(302, error ? `${this.env.appOrigin}/?login_error=${error}` : `${this.env.appOrigin}/`);
  }

  @Public()
  @Get('auth/status')
  status(): AuthStatusDto {
    return { githubEnabled: this.auth.githubEnabled() };
  }

  /** GitHub 로그인 시작: state 와 PKCE 값을 짧게 쿠키에 담고 GitHub 로 보낸다. */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  @Get('auth/github')
  start(@Res() response: Response): void {
    const config = this.env.githubOAuth;
    if (!config) return this.finish(response, 'not_configured');
    const state = randomToken(24);
    const verifier = randomToken(48);
    response.cookie(OAUTH_COOKIE, `${state}.${verifier}`, {
      httpOnly: true,
      secure: this.env.cookieSecure,
      // GitHub 에서 돌아오는 최상위 이동(GET)에는 Lax 쿠키가 함께 온다.
      sameSite: 'lax',
      path: OAUTH_PATH,
      maxAge: OAUTH_TTL_MS,
    });
    response.redirect(
      302,
      this.github.authorizeUrl({ clientId: config.clientId, redirectUri: this.redirectUri, state, codeChallenge: pkceChallenge(verifier) }),
    );
  }

  /** GitHub 에서 돌아오는 곳. 처음 로그인한 사람이면 여기서 계정이 만들어진다. */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  @Get('auth/github/callback')
  async callback(
    @Req() request: AuthedRequest,
    @Res() response: Response,
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Query('error') error: unknown,
  ): Promise<void> {
    const config = this.env.githubOAuth;
    if (!config) return this.finish(response, 'not_configured');
    const saved = (request.cookies as Record<string, string> | undefined)?.[OAUTH_COOKIE] ?? '';
    const [savedState, verifier] = saved.split('.');
    // 이 브라우저에서 시작한 로그인인지 확인한다 (다른 사람의 로그인 결과를 끼워 넣는 공격 방지).
    if (typeof state !== 'string' || !savedState || !verifier || !timingSafeEqualString(state, savedState)) {
      return this.finish(response, 'state_mismatch');
    }
    if (error !== undefined) return this.finish(response, 'denied');
    if (typeof code !== 'string' || code === '' || code.length > 200) return this.finish(response, 'github_error');

    try {
      const profile = await this.github.fetchProfile({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        code,
        redirectUri: this.redirectUri,
        codeVerifier: verifier,
      });
      const session = await this.auth.loginWithGithub(profile);
      // 이 브라우저에 남아 있던 이전 세션은 끝낸다.
      await this.auth.logout(request.sessionId);
      this.setSessionCookie(response, session);
      return this.finish(response);
    } catch (failure) {
      if (failure instanceof OAuthError || failure instanceof LoginRejected) return this.finish(response, failure.code);
      throw failure;
    }
  }

  @HttpCode(200)
  @Post('auth/logout')
  async logout(@Req() request: AuthedRequest, @Res({ passthrough: true }) response: Response): Promise<OkDto> {
    await this.auth.logout(request.sessionId);
    response.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('auth/me')
  me(@CurrentUser() user: AuthUser, @Req() request: AuthedRequest): Promise<MeDto> {
    return this.auth.me(user.id, request.csrfToken ?? '');
  }

  @Get('me/settings')
  settings(@CurrentUser() user: AuthUser): Promise<UserSettingsDto> {
    return this.auth.getSettings(user.id);
  }

  @Patch('me/settings')
  updateSettings(@CurrentUser() user: AuthUser, @Body() dto: UpdateSettingsDto): Promise<UserSettingsDto> {
    return this.auth.updateSettings(user.id, dto);
  }
}
