import { Module } from '@nestjs/common';
import { VulnerabilityModule } from '../vulnerability/vulnerability.module.js';
import { InsightController } from './insight.controller.js';
import { InsightService } from './insight.service.js';

@Module({ imports: [VulnerabilityModule], controllers: [InsightController], providers: [InsightService] })
export class InsightModule {}
