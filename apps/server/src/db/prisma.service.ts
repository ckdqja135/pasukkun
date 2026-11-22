import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { loadEnv } from '../config/env.js';
import { PrismaClient, type Prisma } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaBetterSqlite3({ url: `file:${loadEnv().databasePath}` }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    // API 와 Worker 가 같은 파일에 쓴다: WAL + 잠금 대기.
    await this.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await this.$queryRawUnsafe('PRAGMA busy_timeout = 10000');
    await this.$queryRawUnsafe('PRAGMA synchronous = NORMAL');
    await this.$queryRawUnsafe('PRAGMA foreign_keys = ON');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

/** 트랜잭션 안팎에서 같은 코드를 쓰기 위한 클라이언트 타입 */
export type Db = Prisma.TransactionClient;
