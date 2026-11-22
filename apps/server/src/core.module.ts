import { Module } from '@nestjs/common';
import { CatalogModule } from './catalog/catalog.module.js';
import { DbModule } from './db/db.module.js';
import { IngestionModule } from './ingestion/ingestion.module.js';
import { JobModule } from './jobs/job.module.js';

/** API 와 Worker 가 공유하는 기반 모듈 */
@Module({
  imports: [DbModule, JobModule, CatalogModule, IngestionModule],
  exports: [DbModule, JobModule, CatalogModule, IngestionModule],
})
export class CoreModule {}
