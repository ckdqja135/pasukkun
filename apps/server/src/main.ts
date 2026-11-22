import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { API_PREFIX, buildOpenApi, configureApp } from './app.setup.js';
import { loadEnv } from './config/env.js';

const env = loadEnv();
const app = await NestFactory.create(AppModule, { bodyParser: false });
configureApp(app, env);
if (env.swaggerEnabled) {
  SwaggerModule.setup(`${API_PREFIX}/docs`, app, buildOpenApi(app), { jsonDocumentUrl: `${API_PREFIX}/docs-json` });
}
await app.listen(env.port, env.host);
new Logger('pasukkun').log(`API 대기 중: ${env.host}:${env.port} (프론트 주소 ${env.appOrigin})`);
