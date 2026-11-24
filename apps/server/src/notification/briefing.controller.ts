import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import { BriefingDto, BriefingListDto, BriefingOverviewDto, BriefingQueryDto } from './briefing.dto.js';
import { BriefingService } from './briefing.service.js';

@ApiTags('briefings')
@Controller('briefings')
export class BriefingController {
  constructor(private readonly briefings: BriefingService) {}

  /** 지난 보안 브리핑 (최신순) */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: BriefingQueryDto): Promise<BriefingListDto> {
    return this.briefings.list(user.id, query.cursor, query.limit ?? 20);
  }

  /** 다음 발송, 모인 알림, AI 요약 상태 */
  @Get('overview')
  overview(@CurrentUser() user: AuthUser): Promise<BriefingOverviewDto> {
    return this.briefings.overview(user.id);
  }

  /** 브리핑 하나 */
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number): Promise<BriefingDto> {
    return this.briefings.get(user.id, id);
  }
}
