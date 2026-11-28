import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CatalogService } from './catalog/catalog.service.js';
import { CoreModule } from './core.module.js';
import type { ScheduledSource } from './ingestion/context.js';
import { IngestionService } from './ingestion/ingestion.service.js';
import { VulnerabilityUpsertService } from './ingestion/upsert.service.js';
import { PrismaService } from './db/prisma.service.js';

/**
 * 운영 보조 명령.
 *   node dist/cli.js ingest <GHSA|NVD|KEV|EPSS|KISA|AWS>   소스 하나를 지금 수집
 *   node dist/cli.js status                        소스별 수집 상태
 *   node dist/cli.js retag                         기술 태그 전체 재계산
 *   node dist/cli.js user:list                      계정 목록 (계정은 GitHub 로그인으로만 만들어진다)
 */
@Module({ imports: [CoreModule] })
class CliModule {}

const [command, argument] = process.argv.slice(2);
const app = await NestFactory.createApplicationContext(CliModule, { logger: ['warn', 'error'] });

/** 계정 목록. 계정은 GitHub 로 처음 로그인할 때 만들어지므로 여기서는 보기만 한다. */
async function listUsers(prisma: PrismaService): Promise<string> {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: { githubLogin: true, name: true, createdAt: true, lastLoginAt: true, _count: { select: { projects: true } } },
  });
  if (users.length === 0) return '계정이 없습니다. GitHub 로 처음 로그인하면 계정이 만들어집니다.';
  return users
    .map((u) => `@${u.githubLogin}${u.name ? ` (${u.name})` : ''}\t가입 ${u.createdAt.toISOString().slice(0, 10)}\t최근 로그인 ${u.lastLoginAt.toISOString().slice(0, 10)}\t프로젝트 ${u._count.projects}개`)
    .join('\n');
}

try {
  if (command === 'user:list') {
    console.log(await listUsers(app.get(PrismaService)));
  } else {
    const ingestion = app.get(IngestionService);
    await app.get(CatalogService).syncCatalog();
    await ingestion.ensureSources();
    if (command === 'ingest' && ['GHSA', 'NVD', 'KEV', 'EPSS', 'KISA', 'AWS'].includes(argument ?? '')) {
      await ingestion.run(argument as ScheduledSource);
    } else if (command === 'status') {
      console.table(
        (await ingestion.status()).map((s) => ({
          소스: s.key,
          상태: s.status,
          지연: s.lagging,
          '마지막 성공': s.lastSuccessAt?.toISOString() ?? '-',
          오류: s.lastError ?? '',
        })),
      );
    } else if (command === 'retag') {
      console.log(`재계산한 취약점: ${await app.get(VulnerabilityUpsertService).retagAll()}`);
    } else {
      console.error('사용법: cli.js ingest <GHSA|NVD|KEV|EPSS|KISA|AWS> | status | retag | user:list');
      process.exitCode = 2;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await app.close();
}
