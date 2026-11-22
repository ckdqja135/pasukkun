import { describe, expect, it } from 'vitest';
import { parseManualLines } from '@/components/snapshot-uploader';
import { findingFilterToQuery, parseFindingFilter, writeFindingFilter } from '@/components/finding-filters';
import { formatEpss, minutesToTime, timeToMinutes } from '@/lib/labels';
import { findingQueryToSearch } from '@/pages/dashboard';

describe('수동 패키지 입력', () => {
  it('스코프 패키지를 포함해 이름@버전을 나눈다', () => {
    expect(parseManualLines('lodash@4.17.20\n@nestjs/core@10.3.0\n\n# 주석\n  express@4.18.2  ')).toEqual({
      packages: [
        { name: 'lodash', version: '4.17.20' },
        { name: '@nestjs/core', version: '10.3.0' },
        { name: 'express', version: '4.18.2' },
      ],
      errors: [],
    });
  });
  it('버전이 없는 줄은 오류로 돌려준다', () => {
    expect(parseManualLines('lodash\n@scope/name').errors).toEqual(['lodash', '@scope/name']);
  });
});

describe('대시보드 카드와 목록의 필터 일치', () => {
  it('카드가 준 필터가 주소를 거쳐 같은 API 질의가 된다', () => {
    const cardQuery = { priorities: ['URGENT'], statuses: ['UNREVIEWED', 'IN_REVIEW', 'PLANNED'] };
    const filter = parseFindingFilter(new URLSearchParams(findingQueryToSearch(cardQuery)));
    expect(findingFilterToQuery(filter)).toMatchObject(cardQuery);
    const flags = parseFindingFilter(new URLSearchParams(findingQueryToSearch({ needsRecheck: true })));
    expect(findingFilterToQuery(flags)).toMatchObject({ needsRecheck: true });
  });
  it('필터를 주소에 쓰고 다시 읽으면 같은 값이다', () => {
    const value = { versionMatch: ['AFFECTED'], priorities: ['HIGH', 'URGENT'], statuses: [], needsRecheck: true, reviewOverdue: false, includeResolved: true };
    const params = writeFindingFilter(new URLSearchParams('projectId=p1&page=3'), value);
    expect(params.get('projectId')).toBe('p1');
    expect(params.has('page')).toBe(false);
    expect(parseFindingFilter(params)).toEqual(value);
  });
});

describe('표시 형식', () => {
  it('EPSS 를 백분율로 보여준다', () => {
    expect(formatEpss(0.0123)).toBe('1.2%');
    expect(formatEpss(0.0005)).toBe('0.05%');
    expect(formatEpss(null)).toBe('-');
  });
  it('분 ↔ 시각 변환', () => {
    expect(minutesToTime(1320)).toBe('22:00');
    expect(timeToMinutes('08:05')).toBe(485);
  });
});
