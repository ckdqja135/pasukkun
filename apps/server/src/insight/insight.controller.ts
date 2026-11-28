import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import { CalendarDto, CalendarQueryDto, PackageQueryDto, PackageRemediationListDto, PublicNoticeDto } from './insight.dto.js';
import { InsightService } from './insight.service.js';

@ApiTags('insight')
@Controller()
export class InsightController {
  constructor(private readonly insight: InsightService) {}

  /** 패키지별 조치: 어떤 패키지를 어느 버전으로 올리면 몇 건이 해소되는지 */
  @Get('remediation/packages')
  packages(@CurrentUser() user: AuthUser, @Query() query: PackageQueryDto): Promise<PackageRemediationListDto> {
    return this.insight.packages(user.id, query.projectId);
  }

  /** 비상 달력: 공개일, KEV 조치 기한, 재검토 기한, 조치 예정일, 국내 공지 */
  @Get('calendar')
  calendar(@CurrentUser() user: AuthUser, @Query() query: CalendarQueryDto): Promise<CalendarDto> {
    return this.insight.calendar(user.id, query);
  }

  /** 보안공지 (KISA 보호나라, AWS) 출처별 최근 목록 */
  @Get('notices')
  notices(): Promise<PublicNoticeDto[]> {
    return this.insight.notices(10);
  }
}
