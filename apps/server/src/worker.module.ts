import { Module } from '@nestjs/common';
import { BootstrapService } from './bootstrap.service.js';
import { CoreModule } from './core.module.js';
import { GithubModule } from './github/github.module.js';
import { NotificationModule } from './notification/notification.module.js';
import { ProjectModule } from './project/project.module.js';
import { WorkerService } from './worker.service.js';

/** 백그라운드 Worker 프로세스. API 와 같은 모듈을 공유하고 HTTP 서버는 띄우지 않는다. */
@Module({
  imports: [CoreModule, ProjectModule, NotificationModule, GithubModule],
  providers: [BootstrapService, WorkerService],
  exports: [WorkerService],
})
export class WorkerModule {}
