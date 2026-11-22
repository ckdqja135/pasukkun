import { Global, Module } from '@nestjs/common';
import { loadEnv, type AppEnv } from '../config/env.js';
import { PrismaService } from './prisma.service.js';

export const APP_ENV = Symbol('APP_ENV');

@Global()
@Module({
  providers: [
    PrismaService,
    { provide: APP_ENV, useFactory: (): AppEnv => loadEnv() },
  ],
  exports: [PrismaService, APP_ENV],
})
export class DbModule {}
