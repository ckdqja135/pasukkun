/**
 * 규칙별 발송 시간.
 *   IMMEDIATE : 바로 보낸다
 *   DAILY     : 매일 정한 시각들 (예: 09:00, 18:00)
 *   WEEKLY    : 정한 요일들의 정한 시각 (1=월 … 7=일)
 *   INTERVAL  : N시간마다 (사용자 시간대의 자정 기준으로 정렬)
 * 시각은 모두 사용자 시간대 기준이다.
 */
export type DeliverySchedule =
  | { type: 'IMMEDIATE' }
  | { type: 'DAILY'; times: string[] }
  | { type: 'WEEKLY'; days: number[]; time: string }
  | { type: 'INTERVAL'; hours: number };

export const INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12] as const;
export const MAX_DAILY_TIMES = 6;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_NAMES = ['', '월', '화', '수', '목', '금', '토', '일'];

export class ScheduleError extends Error {}

/** 입력을 검사하고 정규화한다 (시각 정렬, 중복 제거). */
export function validateSchedule(input: unknown): DeliverySchedule {
  const raw = (input ?? {}) as Record<string, unknown>;
  switch (raw.type) {
    case 'IMMEDIATE':
      return { type: 'IMMEDIATE' };
    case 'DAILY': {
      const times = Array.isArray(raw.times) ? raw.times : [];
      if (times.length === 0) throw new ScheduleError('받을 시각을 하나 이상 정해 주세요.');
      if (times.length > MAX_DAILY_TIMES) throw new ScheduleError(`하루에 받을 시각은 ${MAX_DAILY_TIMES}개까지 정할 수 있습니다.`);
      if (!times.every((t) => typeof t === 'string' && TIME.test(t))) throw new ScheduleError('시각은 00:00 ~ 23:59 형식이어야 합니다.');
      return { type: 'DAILY', times: [...new Set(times as string[])].sort() };
    }
    case 'WEEKLY': {
      const days = Array.isArray(raw.days) ? raw.days : [];
      if (days.length === 0) throw new ScheduleError('받을 요일을 하나 이상 골라 주세요.');
      if (!days.every((d) => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7)) throw new ScheduleError('요일 값이 올바르지 않습니다.');
      if (typeof raw.time !== 'string' || !TIME.test(raw.time)) throw new ScheduleError('시각은 00:00 ~ 23:59 형식이어야 합니다.');
      return { type: 'WEEKLY', days: [...new Set(days as number[])].sort((a, b) => a - b), time: raw.time };
    }
    case 'INTERVAL': {
      if (!INTERVAL_HOURS.includes(raw.hours as (typeof INTERVAL_HOURS)[number])) {
        throw new ScheduleError(`간격은 ${INTERVAL_HOURS.join(', ')}시간 중에서 고를 수 있습니다.`);
      }
      return { type: 'INTERVAL', hours: raw.hours as number };
    }
    default:
      throw new ScheduleError('받는 시간 방식이 올바르지 않습니다.');
  }
}

export function describeSchedule(schedule: DeliverySchedule): string {
  switch (schedule.type) {
    case 'IMMEDIATE':
      return '즉시';
    case 'DAILY':
      return `매일 ${schedule.times.join(', ')}`;
    case 'WEEKLY':
      return `매주 ${schedule.days.map((d) => DAY_NAMES[d]).join('·')} ${schedule.time}`;
    case 'INTERVAL':
      return `${schedule.hours}시간마다`;
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function localParts(at: Date, timeZone: string): LocalParts & { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: WEEKDAY[get('weekday')] ?? 1,
  };
}

/** 그 시간대에서 해당 시각이 UTC 로 몇 시인지 (서머타임 포함) */
function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (instant: number) => {
    const p = localParts(new Date(instant), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - instant;
  };
  let instant = wall - offsetAt(wall);
  const corrected = wall - offsetAt(instant);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

/** 그 날짜(사용자 시간대)에 예정된 발송 시각들 (HH:MM) */
function slotsForDay(schedule: DeliverySchedule, weekday: number): string[] {
  switch (schedule.type) {
    case 'IMMEDIATE':
      return [];
    case 'DAILY':
      return schedule.times;
    case 'WEEKLY':
      return schedule.days.includes(weekday) ? [schedule.time] : [];
    case 'INTERVAL':
      return Array.from({ length: 24 / schedule.hours }, (_, i) => `${String(i * schedule.hours).padStart(2, '0')}:00`);
  }
}

/** now 이전(포함)의 가장 최근 예정 시각. 즉시 발송이면 null. */
export function latestSlot(now: Date, schedule: DeliverySchedule, timeZone: string): Date | null {
  if (schedule.type === 'IMMEDIATE') return null;
  const today = localParts(now, timeZone);
  for (let back = 0; back <= 7; back += 1) {
    // 사용자 시간대의 "back 일 전" 날짜를 구한다 (정오 기준으로 하루씩 거슬러 올라가 서머타임 경계를 피한다).
    const noon = zonedToUtc(today.year, today.month, today.day, 12, 0, timeZone);
    const day = localParts(new Date(noon.getTime() - back * 86_400_000), timeZone);
    const candidates = slotsForDay(schedule, day.weekday)
      .map((time) => {
        const [hour, minute] = time.split(':').map(Number);
        return zonedToUtc(day.year, day.month, day.day, hour, minute, timeZone);
      })
      .filter((slot) => slot.getTime() <= now.getTime())
      .sort((a, b) => b.getTime() - a.getTime());
    if (candidates.length > 0) return candidates[0];
  }
  return null;
}

/** 요약을 보낼 때가 되었는지: 마지막으로 보낸 뒤에 예정 시각이 지났는가 */
export function digestDue(now: Date, schedule: DeliverySchedule, timeZone: string, lastSentAt: Date): Date | null {
  const slot = latestSlot(now, schedule, timeZone);
  return slot && slot.getTime() > lastSentAt.getTime() ? slot : null;
}
