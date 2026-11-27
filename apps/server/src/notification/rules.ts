import { sha256 } from '../common/crypto.js';

export const TECH_EVENT_TYPES = ['TECH_NEW_VULN', 'KEV_ADDED', 'PATCH_AVAILABLE', 'AFFECTED_RANGE_CHANGED'] as const;
export const PROJECT_EVENT_TYPES = [
  'PROJECT_NEW_MATCH',
  'KEV_ADDED',
  'PATCH_AVAILABLE',
  'AFFECTED_RANGE_CHANGED',
  'PRIORITY_RAISED',
  'INITIAL_SCAN_SUMMARY',
] as const;
/** 전체 신규 취약점 브리핑: 새로 공개된 취약점과 KEV 신규 등재를 받는 시각에 모은다 (이벤트로 보내지 않는다). */
export const ALL_NEW_EVENT_TYPES = ['TECH_NEW_VULN', 'KEV_ADDED'] as const;

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

/** 심각도 미제공은 낮은 위험으로 취급하지 않으므로 기준과 무관하게 통과시킨다. */
export function passesMinSeverity(severity: string, min: string | null | undefined): boolean {
  if (!min) return true;
  if (severity === 'UNKNOWN') return true;
  return (SEVERITY_RANK[severity] ?? 0) >= (SEVERITY_RANK[min] ?? 0);
}

/**
 * 저장된 관심 기술과 취약점의 기술 태그가 일치하는지.
 * 같은 그룹 안은 OR, 그룹 사이는 mode 에 따라 AND / OR.
 * 저장된 관심 기술이 없으면 알림 대상이 아니다 (피드와 달리 전체 발송하지 않는다).
 */
export function matchesInterests(
  vulnerabilityTechIds: Set<string>,
  interestGroups: string[][],
  mode: 'ALL_GROUPS' | 'ANY_GROUP',
): boolean {
  const groups = interestGroups.filter((group) => group.length > 0);
  if (groups.length === 0) return false;
  const hit = (group: string[]) => group.some((id) => vulnerabilityTechIds.has(id));
  return mode === 'ANY_GROUP' ? groups.some(hit) : groups.every(hit);
}

/**
 * 중복 억제 키. 수정 시각이 아니라 의미 있는 변경의 지문만 들어간다.
 * 같은 취약점이 여러 출처에서 수집되어도 내부 취약점 ID 가 하나이므로 키가 같다.
 */
export function dedupeKey(parts: {
  userId: string;
  channelId: string;
  eventType: string;
  vulnerabilityId: string | null;
  projectId: string | null;
  fingerprint: string;
}): string {
  return sha256(
    [parts.userId, parts.channelId, parts.eventType, parts.vulnerabilityId ?? '-', parts.projectId ?? '-', parts.fingerprint].join('|'),
  );
}

/** 주어진 시간대에서의 현재 시각 정보 */
export function localClock(now: Date, timezone: string): { minuteOfDay: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return { minuteOfDay: Number(get('hour')) * 60 + Number(get('minute')), date: `${get('year')}-${get('month')}-${get('day')}` };
}

export interface QuietHours {
  enabled: boolean;
  startMinute: number;
  endMinute: number;
  timezone: string;
}

/**
 * 방해 금지 시간이면 보류를 풀 시각을 돌려준다. 아니면 null.
 * 시작 > 종료 인 설정(예: 22:00-08:00)은 자정을 넘기는 구간으로 본다.
 */
export function quietUntil(now: Date, quiet: QuietHours): Date | null {
  if (!quiet.enabled || quiet.startMinute === quiet.endMinute) return null;
  const { minuteOfDay } = localClock(now, quiet.timezone);
  const { startMinute: start, endMinute: end } = quiet;
  const inside = start < end ? minuteOfDay >= start && minuteOfDay < end : minuteOfDay >= start || minuteOfDay < end;
  if (!inside) return null;
  const minutesLeft = (end - minuteOfDay + 1440) % 1440;
  const until = new Date(now.getTime() + minutesLeft * 60_000);
  until.setSeconds(0, 0);
  return until;
}

/** 재시도 간격: 30초, 1분, 2분, 4분 … 최대 30분 */
export function retryDelayMs(attempts: number): number {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}
