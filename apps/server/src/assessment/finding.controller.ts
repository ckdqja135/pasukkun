import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import { CreateReviewDto, FindingDetailDto, FindingListDto, FindingQueryDto, UpdateStatusDto } from './finding.dto.js';
import { FindingService } from './finding.service.js';

@ApiTags('findings')
@Controller('findings')
export class FindingController {
  constructor(private readonly findings: FindingService) {}

  /** 프로젝트별 분석 결과. projectId 를 주지 않으면 내 모든 프로젝트가 대상이다. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: FindingQueryDto): Promise<FindingListDto> {
    return this.findings.list(user.id, query);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<FindingDetailDto> {
    return this.findings.detail(user.id, id);
  }

  /** 수동 악용 조건 검토를 기록한다 (추가 전용). */
  @Post(':id/reviews')
  addReview(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CreateReviewDto): Promise<FindingDetailDto> {
    return this.findings.addReview(user, id, dto);
  }

  @Patch(':id/status')
  updateStatus(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateStatusDto): Promise<FindingDetailDto> {
    return this.findings.updateStatus(user, id, dto);
  }
}
