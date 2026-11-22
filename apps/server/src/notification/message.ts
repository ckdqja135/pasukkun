import type { TemplateValues } from './template.js';

/** 채널과 무관한 알림 내용. 채널별 형식 변환은 Provider 가 맡는다. */
export interface NotificationMessage {
  /** 예: "[프로젝트 영향] 신규 영향 버전 일치" */
  heading: string;
  title: string;
  identifiers: string[];
  /** 본문 첫 줄 요약 (선택) */
  lead?: string;
  fields: Array<{ label: string; value: string }>;
  links: Array<{ label: string; url: string }>;
  /** 색·아이콘 선택용 */
  tone: 'urgent' | 'high' | 'medium' | 'low' | 'info';
  footer: string;
  /** 사용자 문구 틀에 넣을 값. 없으면(요약 등) 틀을 쓰지 않고 기본 형식으로 보낸다. */
  values?: TemplateValues;
}

export const EVENT_HEADINGS: Record<string, string> = {
  TECH_NEW_VULN: '신규 취약점',
  PROJECT_NEW_MATCH: '신규 영향 버전 일치',
  KEV_ADDED: 'CISA KEV 신규 등재',
  PATCH_AVAILABLE: '수정 버전 확인됨',
  AFFECTED_RANGE_CHANGED: '영향 범위 변경',
  PRIORITY_RAISED: '대응 우선순위 상승',
  INITIAL_SCAN_SUMMARY: '최초 분석 요약',
};

export const SEVERITY_LABEL: Record<string, string> = {
  CRITICAL: '치명적',
  HIGH: '높음',
  MEDIUM: '보통',
  LOW: '낮음',
  UNKNOWN: '미제공',
};

export const PRIORITY_LABEL: Record<string, string> = {
  URGENT: '긴급',
  HIGH: '높음',
  NEEDS_CHECK: '확인 필요',
  MEDIUM: '보통',
  LOW: '낮음',
};

export const CONDITION_LABEL: Record<string, string> = {
  MET: '조건 충족',
  NOT_MET: '조건 불충족',
  NEEDS_CHECK: '확인 필요',
  NOT_ANALYZED: '아직 분석하지 않음',
};

export const MATCH_LABEL: Record<string, string> = {
  AFFECTED: '영향 버전 일치',
  NOT_AFFECTED: '확인된 영향 범위에 미포함',
  UNKNOWN: '판단 불가',
};
