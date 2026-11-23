import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
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
const toBool = ({ value }: { value: unknown }): boolean | undefined =>
  value === undefined || value === '' ? undefined : value === true || value === 'true' || value === '1';

export const VERSION_MATCHES = ['AFFECTED', 'NOT_AFFECTED', 'UNKNOWN'] as const;
export const PRIORITIES = ['URGENT', 'HIGH', 'NEEDS_CHECK', 'MEDIUM', 'LOW'] as const;
export const STATUSES = ['UNREVIEWED', 'IN_REVIEW', 'PLANNED', 'RISK_ACCEPTED', 'DONE'] as const;
export const EXPLOIT_CONDITIONS = ['MET', 'NOT_MET', 'NEEDS_CHECK', 'NOT_ANALYZED'] as const;

export class FindingQueryDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @Transform(toArray)
  @IsIn(VERSION_MATCHES, { each: true })
  versionMatch?: (typeof VERSION_MATCHES)[number][];

  @IsOptional()
  @Transform(toArray)
  @IsIn(PRIORITIES, { each: true })
  priorities?: (typeof PRIORITIES)[number][];

  @IsOptional()
  @Transform(toArray)
  @IsIn(STATUSES, { each: true })
  statuses?: (typeof STATUSES)[number][];

  @IsOptional()
  @Transform(toArray)
  @IsIn(EXPLOIT_CONDITIONS, { each: true })
  exploitConditions?: (typeof EXPLOIT_CONDITIONS)[number][];

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  needsRecheck?: boolean;

  /** 위험 수용 재검토 기한이 지난 항목만 */
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  reviewOverdue?: boolean;

  /** 현재 구성에서 더 이상 검출되지 않는 항목 포함 (기본 false) */
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  includeResolved?: boolean;

  /** 패키지명·식별자·제목 검색 */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsIn(['priority', 'analyzed', 'severity'])
  sort?: 'priority' | 'analyzed' | 'severity';

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

export class FindingListItemDto {
  id: string;
  projectId: string;
  projectName: string;
  vulnerabilityId: string;
  vulnerabilityTitle: string;
  identifiers: string[];
  packageName: string;
  /** 현재 설치 버전 */
  version: string;
  /** AFFECTED: 영향 버전 일치 / NOT_AFFECTED: 확인된 영향 범위에 미포함 / UNKNOWN: 판단 불가 */
  versionMatch: 'AFFECTED' | 'NOT_AFFECTED' | 'UNKNOWN';
  /** MET: 조건 충족 / NOT_MET: 조건 불충족 / NEEDS_CHECK: 확인 필요 / NOT_ANALYZED: 아직 분석하지 않음 */
  exploitCondition: 'MET' | 'NOT_MET' | 'NEEDS_CHECK' | 'NOT_ANALYZED';
  /** 대응 우선순위 (취약점 심각도와 별개) */
  priority: 'URGENT' | 'HIGH' | 'NEEDS_CHECK' | 'MEDIUM' | 'LOW';
  /** 취약점 자체의 심각도 */
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  cvssScore: number | null;
  kevListed: boolean;
  epssScore: number | null;
  /** 확인된 수정 버전. 없으면 null (패치 미확인) */
  fixedVersion: string | null;
  remediationStatus: 'UNREVIEWED' | 'IN_REVIEW' | 'PLANNED' | 'RISK_ACCEPTED' | 'DONE';
  reviewDueAt: string | null;
  /** 조치 예정일 (조치 예정 상태일 때) */
  plannedFixAt: string | null;
  needsRecheck: boolean;
  recheckReason: string | null;
  isDirect: boolean;
  devOnly: boolean;
  /** 현재 구성에서 더 이상 검출되지 않게 된 시각 */
  resolvedAt: string | null;
  resolution: string | null;
  analyzedAt: string;
}

export class FindingListDto {
  items: FindingListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}

export class FindingReviewDto {
  id: string;
  /** 작성 당시의 GitHub 아이디 */
  authorName: string;
  verdict: 'MET' | 'NOT_MET' | 'NEEDS_CHECK' | 'NOT_ANALYZED';
  checks: object[];
  rationale: string;
  basedOnSnapshotId: string | null;
  createdAt: string;
}

export class FindingHistoryDto {
  id: string;
  fromStatus: string;
  toStatus: string;
  /** 작성 당시의 GitHub 아이디 */
  authorName: string;
  reason: string;
  createdAt: string;
}

export class FindingDetailDto extends FindingListItemDto {
  /** 판단 근거: 출처별 평가, 일치 구간, 수정 버전, 확인할 조건, 설치 경로 */
  evidence: object;
  /** 우선순위 산정에 적용된 규칙과 입력값 */
  priorityReasons: object;
  ruleVersion: string;
  acceptReason: string | null;
  reviews: FindingReviewDto[];
  history: FindingHistoryDto[];
}

export class ReviewCheckDto {
  @IsString()
  @MaxLength(200)
  label: string;

  /** CONFIRMED: 해당함 / NOT_APPLICABLE: 해당 없음 / UNKNOWN: 확인 못 함 */
  @IsIn(['CONFIRMED', 'NOT_APPLICABLE', 'UNKNOWN'])
  state: 'CONFIRMED' | 'NOT_APPLICABLE' | 'UNKNOWN';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreateReviewDto {
  /** 악용 조건 판정: 충족 / 불충족 / 확인 필요 */
  @IsIn(['MET', 'NOT_MET', 'NEEDS_CHECK'])
  verdict: 'MET' | 'NOT_MET' | 'NEEDS_CHECK';

  /** 판단 근거 (필수) */
  @IsString()
  @MinLength(5)
  @MaxLength(4000)
  rationale: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ReviewCheckDto)
  checks?: ReviewCheckDto[];
}

export class UpdateStatusDto {
  @IsIn(STATUSES)
  status: (typeof STATUSES)[number];

  /** 변경 사유. 위험 수용일 때는 필수 */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  /** 위험 수용 재검토 기한 (ISO 날짜). 위험 수용일 때 필수 */
  @IsOptional()
  @IsISO8601()
  reviewDueAt?: string;

  /** 조치 예정일 (ISO 날짜). 조치 예정일 때만 쓰고, 비우면 날짜 없이 둔다 */
  @IsOptional()
  @IsISO8601()
  plannedFixAt?: string;
}
