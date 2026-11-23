import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import { DashboardDto, IngestionStatusDto, PriorityRulesDto, StatusSummaryDto } from './status.dto.js';
import { StatusService } from './status.service.js';

@ApiTags('status')
@Controller()
export class StatusController {
  constructor(private readonly status: StatusService) {}

  @Get('dashboard/summary')
  dashboard(@CurrentUser() user: AuthUser): Promise<DashboardDto> {
    return this.status.dashboard(user.id);
  }

  /** 데이터 소스별 수집 상태: 마지막 성공 시각, 실패, 지연 여부 */
  /** 모든 화면 상단의 수집 상태 표시용 */
  @Get('status/summary')
  summary(): Promise<StatusSummaryDto> {
    return this.status.summary();
  }

  @Get('status/ingestion')
  ingestion(): Promise<IngestionStatusDto> {
    return this.status.ingestionStatus();
  }

  /** 대응 우선순위 규칙과 임계값 */
  @Get('priority-rules')
  priorityRules(): PriorityRulesDto {
    return this.status.priorityRules();
  }
}
