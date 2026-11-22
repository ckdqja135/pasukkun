import { Module } from '@nestjs/common';
import { ProjectModule } from '../project/project.module.js';
import { GithubAppClient } from './github-app.client.js';
import { GithubLinkService } from './github-link.service.js';
import { GithubSyncService } from './github-sync.service.js';
import { GithubController } from './github.controller.js';

@Module({
  imports: [ProjectModule],
  controllers: [GithubController],
  providers: [GithubAppClient, GithubLinkService, GithubSyncService],
  exports: [GithubAppClient, GithubLinkService, GithubSyncService],
})
export class GithubModule {}
