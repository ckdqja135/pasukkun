import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';

export class GithubStatusDto {
  /** 서비스 GitHub 앱이 설정되어 있는지 */
  enabled: boolean;
  /** 앱을 설치하거나 저장소 선택을 바꾸는 GitHub 화면 주소 */
  installUrl: string | null;
  /** 연결된 저장소의 lockfile 변경을 확인하는 주기 (분) */
  syncMinutes: number;
}

export class GithubLinkStartDto {
  /** 이동할 GitHub 인증 주소 */
  url: string;
}

export class GithubRepoDto {
  repoId: string;
  fullName: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  /** 이미 프로젝트로 가져온 lockfile 경로 */
  importedPaths: string[];
}

export class GithubLinkDto {
  id: string;
  /** PENDING / READY(저장소 선택 대기) / COMPLETED / FAILED / EXPIRED */
  status: 'PENDING' | 'READY' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
  error: string | null;
  expiresAt: string;
  installUrl: string | null;
  repos: GithubRepoDto[];
}

export class GithubInspectInputDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Matches(/^\d{1,20}$/, { each: true })
  repoIds: string[];
}

export class GithubLockfileDto {
  path: string;
  format: 'NPM' | 'PNPM' | 'YARN';
  size: number;
  imported: boolean;
}

export class GithubInspectRepoDto {
  repoId: string;
  fullName: string;
  defaultBranch: string;
  lockfiles: GithubLockfileDto[];
  /** 저장소가 커서 일부 폴더만 찾았는지 */
  truncated: boolean;
  error: string | null;
}

export class GithubInspectDto {
  repos: GithubInspectRepoDto[];
}

export class GithubImportItemDto {
  @IsString()
  @Matches(/^\d{1,20}$/)
  repoId: string;

  @IsString()
  @MaxLength(300)
  lockfilePath: string;
}

export class GithubImportInputDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => GithubImportItemDto)
  items: GithubImportItemDto[];
}

export class GithubImportedProjectDto {
  projectId: string;
  name: string;
}

export class GithubSkippedDto {
  repoId: string;
  lockfilePath: string;
  reason: string;
}

export class GithubImportResultDto {
  created: GithubImportedProjectDto[];
  skipped: GithubSkippedDto[];
}

export class ProjectGithubDto {
  fullName: string;
  lockfilePath: string;
  branch: string;
  /** OK / ERROR(이번 확인 실패, 다음에 다시 시도) / DISCONNECTED(앱 설치 해제 등으로 접근 불가) */
  status: 'OK' | 'ERROR' | 'DISCONNECTED';
  error: string | null;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  commitSha: string | null;
  /** 저장소 안의 lockfile 주소 */
  url: string;
}
