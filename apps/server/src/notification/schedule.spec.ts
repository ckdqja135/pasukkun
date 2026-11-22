import { describeSchedule, digestDue, latestSlot, ScheduleError, validateSchedule } from './schedule.js';

const at = (iso: string) => new Date(iso);

describe('받는 시간 입력 검사', () => {
  it('정상 입력을 정규화한다', () => {
    expect(validateSchedule({ type: 'DAILY', times: ['18:00', '09:00', '09:00'] })).toEqual({ type: 'DAILY', times: ['09:00', '18:00'] });
    expect(validateSchedule({ type: 'WEEKLY', days: [5, 1, 1], time: '08:30' })).toEqual({ type: 'WEEKLY', days: [1, 5], time: '08:30' });
    expect(validateSchedule({ type: 'INTERVAL', hours: 6 })).toEqual({ type: 'INTERVAL', hours: 6 });
    expect(validateSchedule({ type: 'IMMEDIATE', extra: 1 })).toEqual({ type: 'IMMEDIATE' });
  });
  it.each([
    [{ type: 'DAILY', times: [] }],
    [{ type: 'DAILY', times: ['24:00'] }],
    [{ type: 'DAILY', times: ['9:00'] }],
    [{ type: 'DAILY', times: Array.from({ length: 7 }, (_, i) => `0${i}:00`) }],
    [{ type: 'WEEKLY', days: [0], time: '09:00' }],
    [{ type: 'WEEKLY', days: [1], time: 'noon' }],
    [{ type: 'INTERVAL', hours: 5 }],
    [{ type: 'HOURLY' }],
    [null],
  ])('잘못된 입력 %j 을 거부한다', (input) => {
    expect(() => validateSchedule(input)).toThrow(ScheduleError);
  });
  it('사람이 읽는 설명을 만든다', () => {
    expect(describeSchedule({ type: 'DAILY', times: ['09:00', '18:00'] })).toBe('매일 09:00, 18:00');
    expect(describeSchedule({ type: 'WEEKLY', days: [1, 3], time: '09:00' })).toBe('매주 월·수 09:00');
    expect(describeSchedule({ type: 'INTERVAL', hours: 3 })).toBe('3시간마다');
  });
});

describe('가장 최근 예정 시각', () => {
  const seoul = 'Asia/Seoul';
  it('매일 여러 시각: 오늘 지난 것 중 가장 늦은 시각, 없으면 어제 마지막 시각', () => {
    const schedule = { type: 'DAILY' as const, times: ['09:00', '18:00'] };
    // 서울 2026-03-02 10:30 → 같은 날 09:00
    expect(latestSlot(at('2026-03-02T01:30:00Z'), schedule, seoul)?.toISOString()).toBe('2026-03-02T00:00:00.000Z');
    // 서울 2026-03-02 08:00 → 전날 18:00
    expect(latestSlot(at('2026-03-01T23:00:00Z'), schedule, seoul)?.toISOString()).toBe('2026-03-01T09:00:00.000Z');
    // 정각은 포함
    expect(latestSlot(at('2026-03-02T09:00:00Z'), schedule, seoul)?.toISOString()).toBe('2026-03-02T09:00:00.000Z');
  });
  it('매주: 정한 요일만', () => {
    // 2026-03-02 은 월요일. 서울 수요일 10:00 기준, 월·금 09:00 → 월요일 09:00
    const schedule = { type: 'WEEKLY' as const, days: [1, 5], time: '09:00' };
    expect(latestSlot(at('2026-03-04T01:00:00Z'), schedule, seoul)?.toISOString()).toBe('2026-03-02T00:00:00.000Z');
    // 서울 토요일 → 금요일 09:00
    expect(latestSlot(at('2026-03-07T03:00:00Z'), schedule, seoul)?.toISOString()).toBe('2026-03-06T00:00:00.000Z');
  });
  it('N시간마다: 사용자 시간대 자정 기준으로 정렬', () => {
    const schedule = { type: 'INTERVAL' as const, hours: 6 };
    // 서울 14:20 → 12:00
    expect(latestSlot(at('2026-03-02T05:20:00Z'), schedule, seoul)?.toISOString()).toBe('2026-03-02T03:00:00.000Z');
    // 서울 05:00 → 00:00
    expect(latestSlot(at('2026-03-01T20:00:00Z'), schedule, seoul)?.toISOString()).toBe('2026-03-01T15:00:00.000Z');
  });
  it('서머타임이 있는 시간대에서도 현지 시각을 지킨다', () => {
    const schedule = { type: 'DAILY' as const, times: ['09:00'] };
    // 뉴욕: 3월 첫 주는 UTC-5, 서머타임 시작(3/8) 뒤에는 UTC-4
    expect(latestSlot(at('2026-03-02T20:00:00Z'), schedule, 'America/New_York')?.toISOString()).toBe('2026-03-02T14:00:00.000Z');
    expect(latestSlot(at('2026-03-10T20:00:00Z'), schedule, 'America/New_York')?.toISOString()).toBe('2026-03-10T13:00:00.000Z');
  });
  it('즉시 발송은 예정 시각이 없다', () => {
    expect(latestSlot(new Date(), { type: 'IMMEDIATE' }, seoul)).toBeNull();
  });
  it('마지막 발송 뒤에 예정 시각이 지났을 때만 보낼 때가 된 것이다', () => {
    const schedule = { type: 'DAILY' as const, times: ['09:00'] };
    const now = at('2026-03-02T01:00:00Z'); // 서울 10:00
    expect(digestDue(now, schedule, seoul, at('2026-03-01T05:00:00Z'))?.toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(digestDue(now, schedule, seoul, at('2026-03-02T00:30:00Z'))).toBeNull();
  });
});
