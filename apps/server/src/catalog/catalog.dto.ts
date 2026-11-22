import { ArrayMaxSize, IsArray, IsString } from 'class-validator';

export class TechnologyDto {
  id: string;
  slug: string;
  name: string;
  group: 'LANGUAGE' | 'FRAMEWORK' | 'RUNTIME' | 'INFRA' | 'DATABASE';
  /** PRECISE: 설치 버전 정밀 검사 지원 / FEED_ONLY: 피드 관련성 표시만 */
  scanSupport: 'PRECISE' | 'FEED_ONLY';
}

export class InterestsDto {
  technologyIds: string[];
}

export class SetInterestsDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  technologyIds: string[];
}
