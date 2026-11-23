import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class PackageFindingDto {
  findingId: string;
  vulnerabilityId: string;
  title: string;
  projectId: string;
  projectName: string;
  priority: 'URGENT' | 'HIGH' | 'NEEDS_CHECK' | 'MEDIUM' | 'LOW';
  fixedVersion: string | null;
  kev: boolean;
}

export class ProjectRefDto {
  id: string;
  name: string;
}

export class PackageRemediationDto {
  packageName: string;
  installedVersion: string;
  /** 이 버전에서 확인된 수정 버전 중 가장 높은 것. 올리면 수정 버전이 있는 항목이 모두 해소된다. */
  targetVersion: string | null;
  findingCount: number;
  /** 수정 버전이 확인되지 않은 항목 수 (올려도 해소되는지 알 수 없음) */
  withoutFixCount: number;
  projects: ProjectRefDto[];
  topPriority: 'URGENT' | 'HIGH' | 'NEEDS_CHECK' | 'MEDIUM' | 'LOW';
  hasKev: boolean;
  findings: PackageFindingDto[];
}

export class PackageRemediationListDto {
  items: PackageRemediationDto[];
  /** 항목이 너무 많아 일부만 묶었는지 */
  truncated: boolean;
}

export class PackageQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  projectId?: string;
}

export const CALENDAR_VIEWS = ['PROJECT', 'IMPORTANT', 'INTEREST'] as const;

export class CalendarQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to: string;

  /** PROJECT: 내 프로젝트 영향 / IMPORTANT: 중요 이슈(KEV 신규 등재·기한, 관심 기술의 치명적 공지, 국내 공지) / INTEREST: 관심 기술 */
  @IsIn(CALENDAR_VIEWS)
  view: (typeof CALENDAR_VIEWS)[number];
}

export class CalendarEventDto {
  id: string;
  /** YYYY-MM-DD (사용자 시간대 기준) */
  date: string;
  kind: 'PUBLISHED' | 'KEV_ADDED' | 'KEV_DUE' | 'REVIEW_DUE' | 'PLANNED_FIX' | 'NOTICE';
  /** 표시 색: 긴급 / 높음 / 보통 / KEV 기한 / 조치 예정 / 재검토 / 국내 공지 */
  tone: 'URGENT' | 'HIGH' | 'NORMAL' | 'KEV' | 'PLAN' | 'REVIEW' | 'NOTICE';
  title: string;
  detail: string | null;
  /** 앱 안 경로 또는 외부 주소 */
  href: string;
  external: boolean;
}

export class CalendarDto {
  from: string;
  to: string;
  view: 'PROJECT' | 'IMPORTANT' | 'INTEREST';
  events: CalendarEventDto[];
  /** 너무 많아 일부만 담았는지 */
  truncated: boolean;
  /** 관심 기술 보기인데 저장된 관심 기술이 없음 */
  needsInterests: boolean;
}

export class PublicNoticeDto {
  id: string;
  source: string;
  title: string;
  url: string;
  publishedAt: string;
  /** 게시 날짜 (한국 날짜, YYYY-MM-DD) */
  publishedDate: string;
}
