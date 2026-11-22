import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { sha256, timingSafeEqualString } from '../common/crypto.js';
import type { AppEnv } from '../config/env.js';
import { APP_ENV } from '../db/db.module.js';
import { PrismaService } from '../db/prisma.service.js';
import { SESSION_COOKIE, type AuthedRequest } from './auth.types.js';
import { IS_PUBLIC } from './decorators.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TOUCH_INTERVAL_MS = 5 * 60_000;

/**
 * 세션 쿠키 인증 + CSRF 방어.
 * - 상태를 바꾸는 요청은 Origin 이 프론트 주소와 같아야 한다 (헤더가 있을 때).
 * - 로그인된 요청은 세션에 묶인 X-CSRF-Token 도 일치해야 한다.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    const unsafe = !SAFE_METHODS.has(request.method);

    if (unsafe) {
      const origin = request.headers.origin;
      if (typeof origin === 'string' && origin !== this.env.appOrigin) {
        throw new ForbiddenException('허용되지 않은 출처의 요청입니다.');
      }
    }

    const token = (request.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (token) {
      const session = await this.prisma.session.findUnique({
        where: { id: sha256(token) },
        include: { user: { select: { id: true, githubLogin: true } } },
      });
      if (session && session.expiresAt > new Date()) {
        request.user = { id: session.user.id, login: session.user.githubLogin };
        request.sessionId = session.id;
        request.csrfToken = session.csrfToken;
        if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
          await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
        }
      }
    }

    if (isPublic) return true;
    if (!request.user) throw new UnauthorizedException('로그인이 필요합니다.');

    if (unsafe) {
      const header = request.headers['x-csrf-token'];
      if (typeof header !== 'string' || !timingSafeEqualString(header, request.csrfToken ?? '')) {
        throw new ForbiddenException('CSRF 토큰이 올바르지 않습니다. 페이지를 새로고침해 주세요.');
      }
    }
    return true;
  }
}
