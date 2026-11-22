import { Global, Module } from '@nestjs/common';
import { JobRunner } from './job-runner.service.js';
import { JobService } from './job.service.js';

@Global()
@Module({ providers: [JobService, JobRunner], exports: [JobService, JobRunner] })
export class JobModule {}
