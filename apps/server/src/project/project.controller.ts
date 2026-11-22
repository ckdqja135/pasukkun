import { Body, Controller, DefaultValuePipe, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import {
  ProjectDto,
  ProjectInputDto,
  ProjectUpdateDto,
  ScanSummaryDto,
  SnapshotCreatedDto,
  SnapshotDto,
  SnapshotInputDto,
  SnapshotPackageListDto,
  SnapshotPreviewDto,
} from './project.dto.js';
import { ProjectService } from './project.service.js';

@ApiTags('projects')
@Controller()
export class ProjectController {
  constructor(private readonly projects: ProjectService) {}

  @Get('projects')
  list(@CurrentUser() user: AuthUser): Promise<ProjectDto[]> {
    return this.projects.list(user.id);
  }

  @Post('projects')
  create(@CurrentUser() user: AuthUser, @Body() dto: ProjectInputDto): Promise<ProjectDto> {
    return this.projects.create(user.id, dto);
  }

  @Get('projects/:id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<ProjectDto> {
    return this.projects.get(user.id, id);
  }

  @Patch('projects/:id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ProjectUpdateDto): Promise<ProjectDto> {
    return this.projects.update(user.id, id, dto);
  }

  @Delete('projects/:id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.projects.remove(user.id, id);
  }

  /** 업로드 내용을 저장하지 않고 검증만 한다. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('projects/:id/snapshots/validate')
  @HttpCode(200)
  preview(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SnapshotInputDto): Promise<SnapshotPreviewDto> {
    return this.projects.preview(user.id, id, dto);
  }

  /** 구성 스냅샷을 만들고 검사를 시작한다. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('projects/:id/snapshots')
  createSnapshot(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SnapshotInputDto): Promise<SnapshotCreatedDto> {
    return this.projects.createSnapshot(user.id, id, dto);
  }

  @Get('projects/:id/snapshots')
  snapshots(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<SnapshotDto[]> {
    return this.projects.listSnapshots(user.id, id);
  }

  @Get('snapshots/:id/packages')
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'filter', required: false, enum: ['unsupported', 'direct', 'dev'] })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  snapshotPackages(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('q') q: string | undefined,
    @Query('filter') filter: string | undefined,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(50), ParseIntPipe) pageSize: number,
  ): Promise<SnapshotPackageListDto> {
    // 같은 이름의 쿼리가 여러 번 오면 배열이 된다. 문자열만 받는다.
    return this.projects.listSnapshotPackages(user.id, id, {
      q: typeof q === 'string' ? q.slice(0, 214) : undefined,
      filter: typeof filter === 'string' ? filter : undefined,
      page: Math.max(1, page),
      pageSize: Math.min(200, Math.max(1, pageSize)),
    });
  }

  /** 현재 구성으로 검사를 요청한다. 작업 ID 를 돌려주며 진행 상태는 GET /scans/:id 로 조회한다. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('projects/:id/scans')
  @HttpCode(202)
  requestScan(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<ScanSummaryDto> {
    return this.projects.requestScan(user.id, id);
  }

  @Get('projects/:id/scans')
  scans(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<ScanSummaryDto[]> {
    return this.projects.listScans(user.id, id);
  }

  @Get('scans/:id')
  scan(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<ScanSummaryDto> {
    return this.projects.getScan(user.id, id);
  }
}
