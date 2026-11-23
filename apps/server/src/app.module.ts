import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module.js';
import { BootstrapService } from './bootstrap.service.js';
import { CoreModule } from './core.module.js';
import { GithubModule } from './github/github.module.js';
import { InsightModule } from './insight/insight.module.js';
import { NotificationModule } from './notification/notification.module.js';
import { ProjectModule } from './project/project.module.js';
import { StatusModule } from './status/status.module.js';
import { VulnerabilityModule } from './vulnerability/vulnerability.module.js';

/** HTTP API 프로세스 */
@Module({
  imports: [
    CoreModule,
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 300 }] }),
    AuthModule,
    VulnerabilityModule,
    ProjectModule,
    NotificationModule,
    GithubModule,
    InsightModule,
    StatusModule,
  ],
  providers: [BootstrapService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
