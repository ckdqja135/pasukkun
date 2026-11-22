import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { GithubOAuthClient } from './github-oauth.client.js';
import { SessionGuard } from './session.guard.js';

@Module({
  controllers: [AuthController],
  providers: [AuthService, GithubOAuthClient, { provide: APP_GUARD, useClass: SessionGuard }],
  exports: [AuthService, GithubOAuthClient],
})
export class AuthModule {}
