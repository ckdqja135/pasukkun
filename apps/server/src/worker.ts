import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from './config/env.js';
import { WorkerModule } from './worker.module.js';
import { WorkerService } from './worker.service.js';

loadEnv();
const app = await NestFactory.createApplicationContext(WorkerModule);
app.enableShutdownHooks();
app.get(WorkerService).start();
