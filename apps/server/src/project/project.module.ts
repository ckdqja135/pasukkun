import { Module } from '@nestjs/common';
import { AssessmentService } from '../assessment/assessment.service.js';
import { FindingController } from '../assessment/finding.controller.js';
import { FindingService } from '../assessment/finding.service.js';
import { ScanService } from '../scan/scan.service.js';
import { ProjectController } from './project.controller.js';
import { ProjectService } from './project.service.js';

@Module({
  controllers: [ProjectController, FindingController],
  providers: [ProjectService, ScanService, AssessmentService, FindingService],
  exports: [ProjectService, ScanService, AssessmentService, FindingService],
})
export class ProjectModule {}
