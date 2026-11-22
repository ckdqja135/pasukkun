import { Type } from 'class-transformer';
import { ProjectGithubDto } from '../github/github.dto.js';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const ENVIRONMENTS = ['PRODUCTION', 'DEVELOPMENT', 'TEST'] as const;
export const EXPOSURES = ['PUBLIC', 'INTERNAL', 'UNKNOWN'] as const;

export class ProjectInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /** 운영/개발/테스트 중 해당하는 환경 (복수 선택) */
  @IsOptional()
  @IsArray()
  @IsIn(ENVIRONMENTS, { each: true })
  environments?: (typeof ENVIRONMENTS)[number][];

  /** 인터넷 공개 여부: 공개 / 내부 / 알 수 없음 */
  @IsOptional()
  @IsIn(EXPOSURES)
  exposure?: (typeof EXPOSURES)[number];

  /** 런타임 (예: Node.js) */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  runtime?: string;

  /** 런타임의 정확한 버전 (예: 22.11.0) */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  runtimeVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  os?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  distro?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  arch?: string;

  /** 담당 메모 */
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;

  /** 프로젝트가 쓰는 언어·프레임워크 등 (기술 카탈로그 ID) */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  technologyIds?: string[];
}

export class ProjectUpdateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsArray()
  @IsIn(ENVIRONMENTS, { each: true })
  environments?: (typeof ENVIRONMENTS)[number][];

  @IsOptional()
  @IsIn(EXPOSURES)
  exposure?: (typeof EXPOSURES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(60)
  runtime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  runtimeVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  os?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  distro?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  arch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  technologyIds?: string[];
}

export class ProjectCountsDto {
  /** 영향 버전 일치 (현재 구성 기준, 미해소) */
  affected: number;
  /** 판단 불가 */
  unknown: number;
  urgent: number;
  high: number;
  /** 미조치: 미검토·검토 중·조치 예정 */
  open: number;
  needsRecheck: number;
}

export class ScanSummaryDto {
  id: string;
  projectId: string;
  snapshotId: string;
  snapshotSeq: number;
  trigger: 'MANUAL' | 'SNAPSHOT_CREATED' | 'SCHEDULED';
  /** PARTIAL: 일부 조회 실패 - 결과에 없는 항목을 "일치 없음"으로 해석하면 안 된다 */
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  isInitial: boolean;
  packagesTotal: number;
  packagesScanned: number;
  /** 검사 범위와 제외 항목 */
  scope: object;
  /** 검사 시점의 소스별 수집 상태 */
  sourceFreshness: object;
  summary: object;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export class SnapshotDto {
  id: string;
  seq: number;
  inputType: 'LOCKFILE' | 'MANUAL';
  /** UPLOAD(화면에서 올림) / GITHUB(저장소에서 자동으로 가져옴) */
  source: 'UPLOAD' | 'GITHUB';
  lockfileFormat: 'NPM' | 'PNPM' | 'YARN' | null;
  /** GitHub 에서 가져온 시점의 커밋 */
  sourceRef: string | null;
  fileName: string | null;
  fileSha256: string | null;
  lockfileVersion: number | null;
  packageCount: number;
  scannableCount: number;
  isCurrent: boolean;
  warnings: object[];
  /** 스냅샷 시점의 프로젝트 구성 사본 */
  projectConfig: object;
  createdAt: string;
}

export class ProjectDto {
  id: string;
  name: string;
  description: string;
  environments: string[];
  exposure: 'PUBLIC' | 'INTERNAL' | 'UNKNOWN';
  runtime: string;
  runtimeVersion: string;
  os: string;
  distro: string;
  arch: string;
  notes: string;
  technologyIds: string[];
  createdAt: string;
  updatedAt: string;
  currentSnapshot: SnapshotDto | null;
  lastScan: ScanSummaryDto | null;
  counts: ProjectCountsDto;
  /** GitHub 저장소와 연결된 프로젝트면 그 정보 */
  github: ProjectGithubDto | null;
}

export class ManualPackageDto {
  @IsString()
  @MaxLength(214)
  name: string;

  /** 정확한 설치 버전 (범위 불가) */
  @IsString()
  @MaxLength(100)
  version: string;
}

export class SnapshotInputDto {
  @IsIn(['LOCKFILE', 'MANUAL'])
  inputType: 'LOCKFILE' | 'MANUAL';

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;

  /** lockfile 내용 (package-lock.json v2/v3, pnpm-lock.yaml v5/v6/v9, yarn.lock v1/Berry). 서버는 데이터로만 해석하며 실행하지 않는다. */
  @IsOptional()
  @IsString()
  @MaxLength(32 * 1024 * 1024)
  lockfileContent?: string;

  /** 선택: package.json 내용. lockfile 과의 불일치 확인에만 쓰며 버전 범위를 설치 버전으로 쓰지 않는다. */
  @IsOptional()
  @IsString()
  @MaxLength(2 * 1024 * 1024)
  packageJsonContent?: string;

  /** 수동 등록: 패키지명과 정확한 버전 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50_000)
  @ValidateNested({ each: true })
  @Type(() => ManualPackageDto)
  packages?: ManualPackageDto[];
}

export class SnapshotPreviewDto {
  valid: boolean;
  /** valid 가 false 일 때의 사유 */
  error: string | null;
  errorCode: string | null;
  lockfileVersion: number | null;
  lockfileFormat: 'NPM' | 'PNPM' | 'YARN' | null;
  packageCount: number;
  scannableCount: number;
  directCount: number;
  devCount: number;
  /** 여러 버전으로 설치된 패키지 수 */
  multiVersionCount: number;
  warnings: object[];
  /** 외부로 전송되는 정보 안내 */
  disclosure: string;
}

export class SnapshotCreatedDto {
  snapshot: SnapshotDto;
  /** 자동으로 시작된 검사 */
  scan: ScanSummaryDto;
}

export class SnapshotPackageDto {
  id: string;
  name: string;
  version: string;
  installPath: string;
  isDirect: boolean;
  isDev: boolean;
  isOptional: boolean;
  dependencyPath: string[];
  refKind: string;
  scannable: boolean;
  unsupportedReason: string | null;
}

export class SnapshotPackageListDto {
  items: SnapshotPackageDto[];
  total: number;
  page: number;
  pageSize: number;
}
