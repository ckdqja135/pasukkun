import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const toArray = ({ value }: { value: unknown }): string[] | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list.map((item) => String(item).trim()).filter(Boolean);
};

export const EVENT_TYPES = [
  'TECH_NEW_VULN',
  'PROJECT_NEW_MATCH',
  'KEV_ADDED',
  'PATCH_AVAILABLE',
  'AFFECTED_RANGE_CHANGED',
  'PRIORITY_RAISED',
  'INITIAL_SCAN_SUMMARY',
] as const;
export const DELIVERY_STATUSES = [
  'PENDING',
  'SENDING',
  'SENT',
  'RETRYING',
  'FAILED',
  'SUPPRESSED',
  'HELD',
  'DIGEST_PENDING',
  'DIGESTED',
  'CANCELLED',
] as const;

export class ChannelLinkInputDto {
  /** 화면에 보일 이름 (예: 보안 알림방) */
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name: string;
}

export class UpdateChannelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name: string;
}

export class ChannelDto {
  id: string;
  type: 'TELEGRAM' | 'DISCORD';
  name: string;
  /** 보낼 곳 설명 (예: "디스코드 · 내서버 #alerts"). 비밀값은 저장하지 않는다. */
  label: string;
  /** ACTIVE / PAUSED: 일시 중지 / ERROR: 봇이 차단·추방되었거나 채널이 사라짐 */
  status: 'ACTIVE' | 'PAUSED' | 'ERROR';
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
  createdAt: string;
}

export class ChannelTestResultDto {
  ok: boolean;
  /** 결과 설명 */
  message: string;
  channel: ChannelDto;
  deliveryId: string | null;
}

export class ChannelProvidersDto {
  /** 서비스 텔레그램 봇이 설정되어 있는지 */
  telegram: boolean;
  /** 서비스 텔레그램 봇 아이디 (연결 안내용) */
  telegramBotUsername: string | null;
  /** 서비스 디스코드 봇이 설정되어 있는지 */
  discord: boolean;
}

export class TelegramLinkDto {
  requestId: string;
  /** 개인 대화로 받기: 이 주소를 열고 [시작]을 누른다 */
  url: string;
  /** 그룹으로 받기: 봇을 그룹에 초대하면서 연결한다 */
  groupUrl: string;
  expiresAt: string;
}

export class DiscordLinkDto {
  requestId: string;
  /** 디스코드에서 봇을 넣을 서버를 고르는 주소 */
  url: string;
}

export class ChannelLinkStatusDto {
  requestId: string;
  type: 'TELEGRAM' | 'DISCORD';
  /** PENDING / GUILD_SELECTED(디스코드: 채널 선택 대기) / COMPLETED / EXPIRED / FAILED */
  status: 'PENDING' | 'GUILD_SELECTED' | 'COMPLETED' | 'EXPIRED' | 'FAILED';
  guildName: string | null;
  channelId: string | null;
  error: string | null;
}

export class DiscordChannelOptionDto {
  id: string;
  name: string;
}

export class CompleteDiscordLinkDto {
  /** 알림을 받을 디스코드 채널 ID */
  @IsString()
  @MaxLength(30)
  channelId: string;
}

/**
 * 받는 시간.
 * IMMEDIATE: 즉시 / DAILY: 매일 times 의 시각들 / WEEKLY: days(1=월…7=일)의 time / INTERVAL: hours 시간마다.
 * 시각은 사용자 시간대 기준 "HH:MM".
 */
export class ScheduleDto {
  @IsIn(['IMMEDIATE', 'DAILY', 'WEEKLY', 'INTERVAL'])
  type: 'IMMEDIATE' | 'DAILY' | 'WEEKLY' | 'INTERVAL';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  times?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  days?: number[];

  @IsOptional()
  @IsString()
  @MaxLength(5)
  time?: string;

  @IsOptional()
  @IsInt()
  hours?: number;
}

export class RuleInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  /** TECH_INTEREST: 저장된 관심 기술 기준 / PROJECT_IMPACT: 프로젝트 영향 기준 */
  @IsIn(['TECH_INTEREST', 'PROJECT_IMPACT'])
  kind: 'TECH_INTEREST' | 'PROJECT_IMPACT';

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(EVENT_TYPES, { each: true })
  eventTypes: (typeof EVENT_TYPES)[number][];

  /** 이 심각도 이상만. 비우면 제한 없음. 심각도 미제공 항목은 항상 포함된다. */
  @IsOptional()
  @IsIn(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])
  minSeverity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | null;

  /** PROJECT_IMPACT: 대상 프로젝트. 비우면 내 모든 프로젝트 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  projectIds?: string[];

  /** 받는 시간 */
  @ValidateNested()
  @Type(() => ScheduleDto)
  schedule: ScheduleDto;

  /** 모아 받을 때의 형식. BRIEFING 은 받는 시각마다 새 항목이 없어도 현황을 보낸다. 즉시 받기에서는 쓰지 않는다. */
  @IsOptional()
  @IsIn(['LIST', 'BRIEFING'])
  digestFormat?: 'LIST' | 'BRIEFING';

  /** 알림 문구 틀. 비우면 기본 형식. {제목} 같은 자리표시자를 쓸 수 있다. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  template?: string | null;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  channelIds: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class RuleDto {
  id: string;
  name: string;
  kind: 'TECH_INTEREST' | 'PROJECT_IMPACT';
  eventTypes: string[];
  minSeverity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN' | null;
  projectIds: string[];
  schedule: ScheduleDto;
  /** 사람이 읽는 받는 시간 (예: 매일 09:00, 18:00) */
  scheduleText: string;
  /** 모아 받을 때의 형식 */
  digestFormat: 'LIST' | 'BRIEFING';
  /** 사용자 문구 틀. null 이면 기본 형식 */
  template: string | null;
  channelIds: string[];
  enabled: boolean;
  /** 현재 설정으로는 발송되지 않는 이유가 있으면 알려준다 */
  warnings: string[];
  createdAt: string;
}

export class DeliveryQueryDto {
  @IsOptional()
  @Transform(toArray)
  @IsIn(DELIVERY_STATUSES, { each: true })
  statuses?: (typeof DELIVERY_STATUSES)[number][];

  @IsOptional()
  @IsString()
  channelId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class DeliveryDto {
  id: string;
  /** EVENT: 이벤트 알림 / DIGEST: 일일 요약 / TEST: 연결 테스트 */
  kind: string;
  eventType: string | null;
  title: string;
  channelId: string;
  channelName: string;
  channelType: string;
  ruleName: string | null;
  vulnerabilityId: string | null;
  projectId: string | null;
  projectName: string | null;
  status: (typeof DELIVERY_STATUSES)[number];
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  lastStatusCode: number | null;
  createdAt: string;
  sentAt: string | null;
}

export class DeliveryListDto {
  items: DeliveryDto[];
  total: number;
  page: number;
  pageSize: number;
}

export class PlaceholderDto {
  key: string;
  description: string;
}

export class TemplateInfoDto {
  /** 쓸 수 있는 자리표시자 */
  placeholders: PlaceholderDto[];
  /** 규칙 종류별 기본 틀 (편집 시작점) */
  defaults: TemplateDefaultsDto;
}

export class TemplateDefaultsDto {
  TECH_INTEREST: string;
  PROJECT_IMPACT: string;
}

export class TemplatePreviewInputDto {
  @IsIn(['TECH_INTEREST', 'PROJECT_IMPACT'])
  kind: 'TECH_INTEREST' | 'PROJECT_IMPACT';

  @IsString()
  @MaxLength(2000)
  template: string;
}

export class TemplatePreviewDto {
  /** 예시 데이터로 채운 결과 (실제 알림과 같은 방식으로 바꾼다) */
  text: string;
}
