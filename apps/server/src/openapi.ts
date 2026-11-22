import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { buildOpenApi, configureApp } from './app.setup.js';
import { loadEnv, REPO_ROOT } from './config/env.js';

// API 명세를 파일로 내보낸다. 프론트엔드 타입은 이 파일에서 생성한다.
const app = await NestFactory.create(AppModule, { bodyParser: false, logger: ['error'] });
configureApp(app, loadEnv());
const target = resolve(REPO_ROOT, 'packages/api-types/openapi.json');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(buildOpenApi(app), null, 2)}\n`);
await app.close();
console.log(`OpenAPI 명세 작성: ${target}`);
