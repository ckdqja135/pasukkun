import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { OkDto } from '../auth/auth.dto.js';
import type { AuthedRequest, AuthUser } from '../auth/auth.types.js';
import { CurrentUser, Public } from '../auth/decorators.js';
import type { AppEnv } from '../config/env.js';
import { APP_ENV } from '../db/db.module.js';
import { GITHUB_CALLBACK_PATH, GithubLinkService } from './github-link.service.js';
import {
  GithubImportInputDto,
  GithubImportResultDto,
  GithubInspectDto,
  GithubInspectInputDto,
  GithubLinkDto,
  GithubLinkStartDto,
  GithubStatusDto,
} from './github.dto.js';

/** GitHub 인증이 진행되는 동안만 쓰는 쿠키: PKCE code_verifier */
export const GITHUB_COOKIE = 'psk_gh';
const COOKIE_TTL_MS = 15 * 60_000;

@ApiTags('github')
@Controller()
export class GithubController {
  constructor(
    private readonly links: GithubLinkService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  @Get('github/status')
  status(): GithubStatusDto {
    return this.links.status();
  }

  /** 저장소 가져오기 시작. 돌려받은 주소로 이동하면 GitHub 에서 인증한다. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('github/link')
  async start(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) response: Response): Promise<GithubLinkStartDto> {
    const { url, verifier } = await this.links.start(user.id);
    response.cookie(GITHUB_COOKIE, verifier, {
      httpOnly: true,
      secure: this.env.cookieSecure,
      // GitHub 에서 돌아오는 최상위 이동(GET)에는 Lax 쿠키가 함께 온다.
      sameSite: 'lax',
      path: GITHUB_CALLBACK_PATH,
      maxAge: COOKIE_TTL_MS,
    });
    return { url };
  }

  /** GitHub 에서 돌아오는 곳. 프론트의 정해진 주소로만 돌려보낸다. */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  @Get('github/callback')
  async callback(
    @Req() request: AuthedRequest,
    @Res() response: Response,
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Query('error') error: unknown,
  ): Promise<void> {
    const verifier = (request.cookies as Record<string, string> | undefined)?.[GITHUB_COOKIE];
    const result = await this.links.callback(request.user?.id, { code, state, error, verifier });
    response.clearCookie(GITHUB_COOKIE, { path: GITHUB_CALLBACK_PATH });
    const target = 'linkId' in result ? `github_link=${encodeURIComponent(result.linkId)}` : `github_error=${result.error}`;
    response.redirect(302, `${this.env.appOrigin}/projects?${target}`);
  }

  /**
   * GitHub 앱 설치·저장소 선택을 마치면 GitHub 가 보내는 곳 (Setup URL).
   * GitHub 문서대로 installation_id 는 위조될 수 있으므로 쓰지 않는다. 화면이 저장소 목록을 다시 받게만 한다.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  @Get('github/setup')
  setup(@Res() response: Response): void {
    response.redirect(302, `${this.env.appOrigin}/projects?github=installed`);
  }

  @Get('github/links/:id')
  link(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<GithubLinkDto> {
    return this.links.link(user.id, id);
  }

  /** 고른 저장소에서 lockfile 위치를 찾는다. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('github/links/:id/inspect')
  inspect(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: GithubInspectInputDto): Promise<GithubInspectDto> {
    return this.links.inspect(user.id, id, dto.repoIds);
  }

  /** 고른 lockfile 마다 프로젝트를 만들고 가져오기·검사를 시작한다. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('github/links/:id/import')
  import(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: GithubImportInputDto): Promise<GithubImportResultDto> {
    return this.links.import(user.id, id, dto);
  }

  /** [지금 확인]: lockfile 이 바뀌었는지 바로 확인한다. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('projects/:id/github/sync')
  async sync(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<OkDto> {
    await this.links.requestSync(user.id, id);
    return { ok: true };
  }

  /** 연결 해제. 프로젝트와 지금까지의 결과는 남는다. */
  @Delete('projects/:id/github')
  async disconnect(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<OkDto> {
    await this.links.disconnect(user.id, id);
    return { ok: true };
  }
}
