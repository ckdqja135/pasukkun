import { Global, Module } from '@nestjs/common';
import { EpssAdapter } from './adapters/epss.adapter.js';
import { GhsaAdapter } from './adapters/ghsa.adapter.js';
import { KevAdapter } from './adapters/kev.adapter.js';
import { KisaAdapter } from './adapters/kisa.adapter.js';
import { NvdAdapter } from './adapters/nvd.adapter.js';
import { OsvClient } from './adapters/osv.client.js';
import { IngestionService } from './ingestion.service.js';
import { VulnerabilityUpsertService } from './upsert.service.js';

@Global()
@Module({
  providers: [VulnerabilityUpsertService, IngestionService, GhsaAdapter, NvdAdapter, KevAdapter, EpssAdapter, KisaAdapter, OsvClient],
  exports: [VulnerabilityUpsertService, IngestionService, OsvClient],
})
export class IngestionModule {}
