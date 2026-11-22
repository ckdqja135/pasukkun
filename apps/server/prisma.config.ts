import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

// Prisma CLI 는 .env 를 자동으로 읽지 않는다. 저장소 루트의 .env 를 직접 읽는다.
const repoRoot = resolve(import.meta.dirname, '../..');
for (const candidate of [resolve(repoRoot, '.env')]) {
  if (existsSync(candidate)) process.loadEnvFile(candidate);
}

const configured = process.env.DATABASE_PATH ?? 'data/pasukkun.db';
const dbPath = isAbsolute(configured) ? configured : resolve(repoRoot, configured);
mkdirSync(dirname(dbPath), { recursive: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: `file:${dbPath}` },
});
