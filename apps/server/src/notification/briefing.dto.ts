import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class BriefingQueryDto {
  /** 이 번호보다 이전 브리핑부터 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cursor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class BriefingItemDto {
  /** 우선순위 또는 심각도 표시 (예: 긴급) */
  tag: string;
  tone: 'urgent' | 'high' | 'medium' | 'low' | 'info';
  text: string;
  /** 화면 안 링크 (분석 결과 또는 취약점 상세) */
  href: string;
  kev: boolean;
  /** 영향받는 프로젝트 수 */
  affected: number;
}

export class ProjectCountDto {
  name: string;
  count: number;
}

export class BriefingPatchesDto {
  /** 재검사에서 설치 버전이 바뀌어 더는 나오지 않는 항목 */
  confirmed: number;
  confirmedByProject: ProjectCountDto[];
  /** 조치 완료로 바꿨지만 아직 재검사로 확인되지 않은 항목 */
  reported: number;
  reportedByProject: ProjectCountDto[];
}

export class BriefingNoticeDto {
  title: string;
  url: string;
}

export class BriefingChannelDto {
  name: string;
  type: 'TELEGRAM' | 'DISCORD';
  /** 이 채널로 보낸 결과 (발송 상태) */
  status: string;
}

export class BriefingDto {
  id: number;
  /** 예: 아침 보안 브리핑(밤사이 발생분) */
  title: string;
  ruleName: string;
  slotAt: string;
  /** 이 시각 이후 들어온 항목을 모았다 */
  fromAt: string;
  createdAt: string;
  headline: string;
  summary: string;
  tone: 'urgent' | 'high' | 'medium' | 'low' | 'info';
  /** AI 요약에 쓴 모델 (정해진 틀이면 null) */
  aiModel: string | null;
  /** AI 요약을 못 한 이유 */
  aiError: string | null;
  items: BriefingItemDto[];
  /** 새 이슈 전체 수 (items 는 최대 50건) */
  totalItems: number;
  patches: BriefingPatchesDto;
  notices: BriefingNoticeDto[];
  channels: BriefingChannelDto[];
}

export class BriefingListDto {
  items: BriefingDto[];
  nextCursor: number | null;
}

export class BriefingScheduleDto {
  ruleName: string;
  text: string;
}

export class BriefingPendingDto {
  channelName: string;
  count: number;
}

export class BriefingAiStatusDto {
  enabled: boolean;
  model: string | null;
}

export class BriefingOverviewDto {
  /** 켜져 있는 보안 브리핑 규칙 수 */
  ruleCount: number;
  nextSendAt: string | null;
  nextRuleName: string | null;
  schedules: BriefingScheduleDto[];
  /** 다음 브리핑에 들어갈, 지금까지 모인 알림 (채널별) */
  pending: BriefingPendingDto[];
  ai: BriefingAiStatusDto;
}
