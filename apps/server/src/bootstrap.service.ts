import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { CatalogService } from './catalog/catalog.service.js';
import { IngestionService } from './ingestion/ingestion.service.js';
import { JobService } from './jobs/job.service.js';

/** 기동 시 기술 카탈로그와 수집 소스 설정을 DB 에 반영한다. API·Worker 어느 쪽이 먼저 떠도 된다. */
@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    private readonly catalog: CatalogService,
    private readonly ingestion: IngestionService,
    private readonly jobs: JobService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const changed = await this.catalog.syncCatalog();
        await this.ingestion.ensureSources();
        // 매핑이 바뀌면 이미 수집된 취약점의 기술 태그를 다시 계산한다.
        if (changed) await this.jobs.enqueue('retag-all', {}, { dedupeKey: 'retag-all', maxAttempts: 2 });
        return;
      } catch (error) {
        // 두 프로세스가 동시에 기동하면 한쪽이 고유 제약에 걸릴 수 있다. 잠시 뒤 다시 시도한다.
        this.logger.warn(`초기화 재시도 (${attempt + 1}/3): ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    throw new Error('기술 카탈로그 초기화에 실패했습니다.');
  }
}
