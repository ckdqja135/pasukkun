import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class UserSettingsDto {
  /** IANA 시간대 (예: Asia/Seoul) */
  timezone: string;
  /** 저장된 관심 기술의 그룹 간 결합 방식 */
  interestMatchMode: 'ALL_GROUPS' | 'ANY_GROUP';
  quietHoursEnabled: boolean;
  /** 자정 기준 분 (0-1439) */
  quietStartMinute: number;
  quietEndMinute: number;
  urgentBypassQuiet: boolean;
}

export class UpdateSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsIn(['ALL_GROUPS', 'ANY_GROUP'])
  interestMatchMode?: 'ALL_GROUPS' | 'ANY_GROUP';

  @IsOptional()
  @IsBoolean()
  quietHoursEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1439)
  quietStartMinute?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1439)
  quietEndMinute?: number;

  @IsOptional()
  @IsBoolean()
  urgentBypassQuiet?: boolean;

}

export class MeDto {
  id: string;
  /** GitHub 아이디 */
  githubLogin: string;
  /** GitHub 프로필 이름 (없을 수 있음) */
  name: string | null;
  /** 상태 변경 요청의 X-CSRF-Token 헤더에 넣는 값 */
  csrfToken: string;
  settings: UserSettingsDto;
}

export class AuthStatusDto {
  /** GitHub 로그인이 설정되어 있는지 (Client ID / Secret) */
  githubEnabled: boolean;
}

export class OkDto {
  ok: boolean;
}
