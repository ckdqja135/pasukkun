import { dedupeKey, localClock, matchesInterests, passesMinSeverity, quietUntil, retryDelayMs } from './rules.js';

describe('구독 규칙 판단', () => {
  it('심각도 기준: 미제공은 항상 통과한다', () => {
    expect(passesMinSeverity('CRITICAL', 'HIGH')).toBe(true);
    expect(passesMinSeverity('MEDIUM', 'HIGH')).toBe(false);
    expect(passesMinSeverity('UNKNOWN', 'CRITICAL')).toBe(true);
    expect(passesMinSeverity('LOW', null)).toBe(true);
  });

  it('관심 기술: 그룹 안은 OR, 그룹 사이는 AND 또는 OR', () => {
    const tags = new Set(['js', 'react']);
    expect(matchesInterests(tags, [['js', 'python']], 'ALL_GROUPS')).toBe(true);
    expect(matchesInterests(tags, [['js'], ['react', 'vue']], 'ALL_GROUPS')).toBe(true);
    expect(matchesInterests(tags, [['js'], ['postgres']], 'ALL_GROUPS')).toBe(false);
    expect(matchesInterests(tags, [['python'], ['react']], 'ANY_GROUP')).toBe(true);
    expect(matchesInterests(tags, [['python'], ['postgres']], 'ANY_GROUP')).toBe(false);
  });

  it('저장된 관심 기술이 없으면 알림 대상이 아니다 (전체 발송하지 않는다)', () => {
    expect(matchesInterests(new Set(['js']), [], 'ALL_GROUPS')).toBe(false);
    expect(matchesInterests(new Set(['js']), [], 'ANY_GROUP')).toBe(false);
  });

  it('중복 억제 키는 사용자·채널·이벤트·취약점·프로젝트·변경 지문으로 정해진다', () => {
    const base = { userId: 'u', channelId: 'c', eventType: 'KEV_ADDED', vulnerabilityId: 'v', projectId: null, fingerprint: 'kev:2026-01-01' };
    expect(dedupeKey(base)).toBe(dedupeKey({ ...base }));
    for (const change of [{ userId: 'u2' }, { channelId: 'c2' }, { eventType: 'PATCH_AVAILABLE' }, { vulnerabilityId: 'v2' }, { projectId: 'p' }, { fingerprint: 'kev:2026-01-02' }]) {
      expect(dedupeKey({ ...base, ...change })).not.toBe(dedupeKey(base));
    }
  });

  it('사용자 시간대의 현재 시각을 구한다', () => {
    const at = new Date('2026-03-01T15:30:00Z');
    expect(localClock(at, 'Asia/Seoul')).toEqual({ minuteOfDay: 30, date: '2026-03-02' });
    expect(localClock(at, 'UTC')).toEqual({ minuteOfDay: 930, date: '2026-03-01' });
  });

  it('방해 금지 시간: 자정을 넘는 구간과 종료 시각을 계산한다', () => {
    const quiet = { enabled: true, startMinute: 22 * 60, endMinute: 8 * 60, timezone: 'Asia/Seoul' };
    // 서울 23:00
    expect(quietUntil(new Date('2026-03-01T14:00:00Z'), quiet)?.toISOString()).toBe('2026-03-01T23:00:00.000Z');
    // 서울 07:30 → 08:00 까지
    expect(quietUntil(new Date('2026-03-01T22:30:00Z'), quiet)?.toISOString()).toBe('2026-03-01T23:00:00.000Z');
    // 서울 12:00 은 방해 금지 시간이 아니다
    expect(quietUntil(new Date('2026-03-01T03:00:00Z'), quiet)).toBeNull();
    expect(quietUntil(new Date('2026-03-01T14:00:00Z'), { ...quiet, enabled: false })).toBeNull();
    // 같은 날 안의 구간
    const day = { enabled: true, startMinute: 60, endMinute: 120, timezone: 'UTC' };
    expect(quietUntil(new Date('2026-03-01T01:30:00Z'), day)?.toISOString()).toBe('2026-03-01T02:00:00.000Z');
    expect(quietUntil(new Date('2026-03-01T02:00:00Z'), day)).toBeNull();
  });

  it('재시도 간격은 늘어나되 상한이 있다', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(20)).toBe(30 * 60_000);
  });
});
