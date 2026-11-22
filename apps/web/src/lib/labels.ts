/** 화면에 쓰는 한국어 라벨과 표시 형식 */
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

export const MATCH_LABEL: Record<string, string> = {
  AFFECTED: '영향 버전 일치',
  NOT_AFFECTED: '영향 범위 미포함',
  UNKNOWN: '판단 불가',
  NOT_SCANNED: '검사 대상 아님',
};

export const CONDITION_LABEL: Record<string, string> = {
  MET: '조건 충족',
  NOT_MET: '조건 불충족',
  NEEDS_CHECK: '확인 필요',
  NOT_ANALYZED: '아직 분석하지 않음',
};

export const STATUS_LABEL: Record<string, string> = {
  UNREVIEWED: '미검토',
  IN_REVIEW: '검토 중',
  PLANNED: '조치 예정',
  RISK_ACCEPTED: '위험 수용',
  DONE: '조치 완료',
};

export const GROUP_LABEL: Record<string, string> = {
  LANGUAGE: '언어',
  FRAMEWORK: '프레임워크',
  RUNTIME: '런타임',
  INFRA: '인프라 / 개발환경',
  DATABASE: '데이터베이스',
};

export const ENVIRONMENT_LABEL: Record<string, string> = { PRODUCTION: '운영', DEVELOPMENT: '개발', TEST: '테스트' };
export const EXPOSURE_LABEL: Record<string, string> = { PUBLIC: '공개', INTERNAL: '내부', UNKNOWN: '알 수 없음' };

export const SCAN_STATUS_LABEL: Record<string, string> = {
  QUEUED: '대기 중',
  RUNNING: '검사 중',
  SUCCEEDED: '완료',
  PARTIAL: '부분 완료',
  FAILED: '실패',
};

export const RESOLUTION_LABEL: Record<string, string> = {
  NOT_IN_CURRENT_SNAPSHOT: '현재 구성에 이 패키지 버전이 없음',
  RANGE_NO_LONGER_MATCHES: '공지의 영향 범위가 바뀌어 범위에서 벗어남',
  NO_LONGER_LISTED: '공지가 이 패키지를 더 이상 영향 대상으로 두지 않음',
  ADVISORY_WITHDRAWN: '공지가 철회됨',
};

export const EVENT_LABEL: Record<string, string> = {
  TECH_NEW_VULN: '관심 기술의 신규 취약점',
  PROJECT_NEW_MATCH: '프로젝트의 신규 영향 버전 일치',
  KEV_ADDED: 'KEV 신규 등재',
  PATCH_AVAILABLE: '수정 버전 확인',
  AFFECTED_RANGE_CHANGED: '영향 범위 변경',
  PRIORITY_RAISED: '대응 우선순위 상승',
  INITIAL_SCAN_SUMMARY: '최초 분석 요약',
};

export const DELIVERY_STATUS_LABEL: Record<string, string> = {
  PENDING: '발송 대기',
  SENDING: '발송 중',
  SENT: '발송됨',
  RETRYING: '재시도 중',
  FAILED: '최종 실패',
  SUPPRESSED: '중복 억제',
  HELD: '방해 금지 보류',
  DIGEST_PENDING: '일일 요약 대기',
  DIGESTED: '요약에 포함',
  CANCELLED: '취소됨',
};

export const BASIS_LABEL: Record<string, string> = { PACKAGE: '패키지명 일치', CPE: '제품(CPE) 일치', ECOSYSTEM: '패키지 생태계 일치' };

const dateTime = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' });
const relative = new Intl.RelativeTimeFormat('ko-KR', { numeric: 'auto' });

export function formatDateTime(value: string | null | undefined): string {
  return value ? dateTime.format(new Date(value)) : '-';
}

export function formatDate(value: string | null | undefined): string {
  return value ? dateOnly.format(new Date(value)) : '-';
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return '-';
  const diff = (new Date(value).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return '방금';
  if (abs < 3600) return relative.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return relative.format(Math.round(diff / 86400), 'day');
  return formatDate(value);
}

export function minutesToTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

/** EPSS 는 "30일 내 악용 활동이 관측될 확률 추정"으로만 표현한다. */
export function formatEpss(score: number | null | undefined): string {
  return score === null || score === undefined ? '-' : `${(score * 100).toFixed(score < 0.01 ? 2 : 1)}%`;
}
