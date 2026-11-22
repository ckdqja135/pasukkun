import { Module } from '@nestjs/common';
import { ProjectModule } from '../project/project.module.js';
import { VulnerabilityModule } from '../vulnerability/vulnerability.module.js';
import { StatusController } from './status.controller.js';
import { StatusService } from './status.service.js';

@Module({ imports: [ProjectModule, VulnerabilityModule], controllers: [StatusController], providers: [StatusService] })
export class StatusModule {}
