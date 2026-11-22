import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { SESSION_COOKIE } from './auth/auth.types.js';
import { sha256 } from './common/crypto.js';
import type { AppEnv } from './config/env.js';
import { PrismaService } from './db/prisma.service.js';

export const API_PREFIX = 'api/v1';

/** main.ts 와 e2e 테스트가 같은 설정으로 앱을 구성하도록 한 곳에 모은다. */
export function configureApp(app: INestApplication, env: AppEnv): void {
  const http = app.getHttpAdapter().getInstance() as express.Express;
  http.set('trust proxy', env.trustProxy);
  http.disable('x-powered-by');

  app.use(helmet({ contentSecurityPolicy: env.swaggerEnabled ? false : undefined }));
  app.use(cookieParser());
  // lockfile 업로드 경로만 큰 본문을 허용하고, 나머지는 작게 제한한다.
  const snapshotLimit = Math.ceil(env.uploadMaxBytes * 1.3) + 64 * 1024;
  const snapshotPath = new RegExp(`^/${API_PREFIX}/projects/[^/]+/snapshots(/validate)?$`);
  const prisma = app.get(PrismaService);
  // 수십 MB 본문을 읽고 해석하기 전에 세션부터 확인한다. 로그인하지 않은 요청은 본문을 읽지 않고 거절한다.
  app.use(snapshotPath, (request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (request.method !== 'POST') return next();
    const token = (request.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    const reject = () => {
      response.status(401).set('Connection', 'close').json({ statusCode: 401, error: 'Unauthorized', message: '로그인이 필요합니다.' });
    };
    if (typeof token !== 'string' || token === '') return reject();
    prisma.session
      .findUnique({ where: { id: sha256(token) }, select: { expiresAt: true } })
      .then((session) => (session && session.expiresAt > new Date() ? next() : reject()))
      .catch(next);
  });
  app.use(snapshotPath, express.json({ limit: snapshotLimit }));
  app.use(express.json({ limit: '256kb' }));

  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
}

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('pasukkun API')
    .setDescription('취약점 모니터링 및 프로젝트 영향도 분석 API. 인증은 세션 쿠키, 상태 변경 요청에는 X-CSRF-Token 헤더가 필요합니다.')
    .setVersion('0.1.0')
    .addCookieAuth('psk_session')
    .build();
  return SwaggerModule.createDocument(app, config);
}
