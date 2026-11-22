import { parseGhsaRange, parseOsvAffected } from './range-parse.js';
import { combineEvaluations, evaluateSpec, suggestFix, type AffectedSpec } from './version-match.js';

const spec = (partial: Partial<AffectedSpec>): AffectedSpec => ({
  source: 'GHSA',
  intervals: [],
  versions: [],
  unparsed: [],
  ...partial,
});

describe('evaluateSpec - 버전 경계', () => {
  const s = spec({ intervals: [{ introduced: '2.0.0', fixed: '2.3.1' }] });

  it('introduced 는 포함, fixed 는 제외한다', () => {
    expect(evaluateSpec('2.0.0', s).result).toBe('AFFECTED');
    expect(evaluateSpec('2.3.0', s).result).toBe('AFFECTED');
    expect(evaluateSpec('2.3.1', s).result).toBe('NOT_AFFECTED');
    expect(evaluateSpec('1.9.9', s).result).toBe('NOT_AFFECTED');
  });

  it('last_affected 는 포함한다', () => {
    const last = spec({ intervals: [{ introduced: '0', lastAffected: '1.4.2' }] });
    expect(evaluateSpec('1.4.2', last).result).toBe('AFFECTED');
    expect(evaluateSpec('1.4.3', last).result).toBe('NOT_AFFECTED');
    expect(evaluateSpec('0.0.1', last).result).toBe('AFFECTED');
  });

  it('상한이 없으면 introduced 이후 전부가 영향 범위다', () => {
    const open = spec({ intervals: [{ introduced: '3.0.0' }] });
    expect(evaluateSpec('99.0.0', open).result).toBe('AFFECTED');
    expect(evaluateSpec('2.9.9', open).result).toBe('NOT_AFFECTED');
  });

  it('초과(>) 하한을 구분한다', () => {
    const excl = spec({ intervals: [{ introduced: '1.0.0', introducedExclusive: true, fixed: '1.2.0' }] });
    expect(evaluateSpec('1.0.0', excl).result).toBe('NOT_AFFECTED');
    expect(evaluateSpec('1.0.1', excl).result).toBe('AFFECTED');
  });
});

describe('evaluateSpec - 제외 구간', () => {
  const s = spec({
    intervals: [
      { introduced: '2.0.0', fixed: '2.3.1' },
      { introduced: '3.0.0', fixed: '3.1.0' },
    ],
  });
  it('두 영향 구간 사이의 버전은 미포함이다', () => {
    expect(evaluateSpec('2.5.0', s).result).toBe('NOT_AFFECTED');
    expect(evaluateSpec('2.3.1', s).result).toBe('NOT_AFFECTED');
    expect(evaluateSpec('3.0.5', s).result).toBe('AFFECTED');
    expect(evaluateSpec('3.1.0', s).result).toBe('NOT_AFFECTED');
  });
});

describe('evaluateSpec - prerelease', () => {
  const s = spec({ intervals: [{ introduced: '1.0.0', fixed: '1.2.3' }] });
  it('수정 버전의 prerelease 는 수정 버전보다 낮으므로 영향 범위다', () => {
    expect(evaluateSpec('1.2.3-rc.1', s).result).toBe('AFFECTED');
  });
  it('도입 버전의 prerelease 는 도입 버전보다 낮으므로 범위 밖이다', () => {
    expect(evaluateSpec('1.0.0-beta.2', s).result).toBe('NOT_AFFECTED');
  });
  it('prerelease 경계끼리도 순서대로 비교한다', () => {
    const pre = spec({ intervals: [{ introduced: '2.0.0-alpha.1', fixed: '2.0.0-rc.2' }] });
    expect(evaluateSpec('2.0.0-beta.1', pre).result).toBe('AFFECTED');
    expect(evaluateSpec('2.0.0-rc.2', pre).result).toBe('NOT_AFFECTED');
    expect(evaluateSpec('2.0.0', pre).result).toBe('NOT_AFFECTED');
  });
  it('빌드 메타데이터는 비교에서 무시한다', () => {
    expect(evaluateSpec('1.2.2+build.5', s).result).toBe('AFFECTED');
    expect(evaluateSpec('1.2.3+build.5', s).result).toBe('NOT_AFFECTED');
  });
});

describe('evaluateSpec - 판단 불가', () => {
  it('semver 가 아닌 설치 버전은 판단 불가다', () => {
    const s = spec({ intervals: [{ introduced: '0', fixed: '1.0.0' }] });
    expect(evaluateSpec('github:foo/bar#abc', s).result).toBe('UNKNOWN');
    expect(evaluateSpec('latest', s).result).toBe('UNKNOWN');
  });
  it('해석 못 한 범위가 있으면 미포함으로 단정하지 않는다', () => {
    const s = spec({ intervals: [{ introduced: '0', fixed: 'not-a-version' }] });
    expect(evaluateSpec('5.0.0', s).result).toBe('UNKNOWN');
    const withUnparsed = spec({ intervals: [{ introduced: '1.0.0', fixed: '1.1.0' }], unparsed: ['~> 2'] });
    expect(evaluateSpec('5.0.0', withUnparsed).result).toBe('UNKNOWN');
    expect(evaluateSpec('1.0.5', withUnparsed).result).toBe('AFFECTED');
  });
  it('범위 정보가 전혀 없으면 판단 불가다', () => {
    expect(evaluateSpec('1.0.0', spec({})).result).toBe('UNKNOWN');
  });
  it('명시 버전 목록에 있으면 일치다', () => {
    const s = spec({ versions: ['1.0.0', '1.0.1'] });
    expect(evaluateSpec('1.0.1', s).result).toBe('AFFECTED');
    expect(evaluateSpec('1.0.2', s).result).toBe('NOT_AFFECTED');
  });
});

describe('combineEvaluations', () => {
  const affected = { source: 'GHSA', result: 'AFFECTED' as const, reason: 'a' };
  const notAffected = { source: 'OSV', result: 'NOT_AFFECTED' as const, reason: 'n' };
  const unknown = { source: 'NVD', result: 'UNKNOWN' as const, reason: 'u' };

  it('출처가 서로 다르게 말하면 판단 불가다', () => {
    expect(combineEvaluations([affected, notAffected], null).result).toBe('UNKNOWN');
  });
  it('OSV 는 일치인데 로컬 평가가 전부 미포함이면 판단 불가다', () => {
    expect(combineEvaluations([notAffected], true).result).toBe('UNKNOWN');
    expect(combineEvaluations([notAffected], false).result).toBe('NOT_AFFECTED');
    expect(combineEvaluations([notAffected], null).result).toBe('NOT_AFFECTED');
  });
  it('일치와 판단 불가가 섞이면 일치다', () => {
    expect(combineEvaluations([affected, unknown], null).result).toBe('AFFECTED');
  });
  it('미포함과 판단 불가가 섞이면 미포함으로 단정하지 않는다', () => {
    expect(combineEvaluations([notAffected, unknown], null).result).toBe('UNKNOWN');
  });
  it('근거 데이터가 없으면 판단 불가다', () => {
    expect(combineEvaluations([], true).result).toBe('UNKNOWN');
  });
});

describe('suggestFix', () => {
  it('일치한 구간의 fixed 만 수정 버전으로 제시한다', () => {
    const s = spec({
      intervals: [
        { introduced: '2.0.0', fixed: '2.3.1' },
        { introduced: '3.0.0', fixed: '3.1.0' },
      ],
    });
    const e = evaluateSpec('2.1.0', s);
    expect(suggestFix('2.1.0', [e], [s])).toEqual({ kind: 'FIXED', version: '2.3.1', source: 'GHSA' });
  });
  it('현재 구간에 수정 버전이 없고 상위 계열에만 있으면 그 사실을 구분한다', () => {
    const s = spec({
      intervals: [
        { introduced: '1.0.0', lastAffected: '1.9.9' },
        { introduced: '2.0.0', fixed: '2.0.4' },
      ],
    });
    const e = evaluateSpec('1.5.0', s);
    expect(suggestFix('1.5.0', [e], [s])).toEqual({ kind: 'HIGHER_LINE_ONLY', version: '2.0.4', source: 'GHSA' });
  });
  it('정보가 없으면 버전을 추측하지 않는다', () => {
    const s = spec({ intervals: [{ introduced: '0' }] });
    const e = evaluateSpec('1.5.0', s);
    expect(suggestFix('1.5.0', [e], [s])).toEqual({ kind: 'UNCONFIRMED' });
  });
});

describe('범위 파서', () => {
  it('GHSA 범위 문자열을 구간으로 바꾼다', () => {
    expect(parseGhsaRange('>= 2.0.0, < 2.3.1')).toEqual({
      intervals: [{ introduced: '2.0.0', fixed: '2.3.1' }],
      versions: [],
      unparsed: [],
    });
    expect(parseGhsaRange('<= 1.4.2', '1.4.3').intervals).toEqual([
      { introduced: '0', lastAffected: '1.4.2', patched: '1.4.3' },
    ]);
    expect(parseGhsaRange('= 1.0.0')).toEqual({ intervals: [], versions: ['1.0.0'], unparsed: [] });
    expect(parseGhsaRange('> 1.0.0, <= 1.2.0').intervals[0]).toMatchObject({
      introduced: '1.0.0',
      introducedExclusive: true,
      lastAffected: '1.2.0',
    });
  });
  it('해석 못 한 표현은 unparsed 로 남긴다', () => {
    expect(parseGhsaRange('~> 1.2').unparsed).toEqual(['~> 1.2']);
    expect(parseGhsaRange('').unparsed.length).toBe(1);
  });
  it('OSV 이벤트를 여러 구간으로 바꾼다', () => {
    const parsed = parseOsvAffected(
      [
        {
          type: 'SEMVER',
          events: [{ introduced: '0' }, { fixed: '1.2.0' }, { introduced: '2.0.0' }, { last_affected: '2.4.0' }],
        },
      ],
      undefined,
    );
    expect(parsed.intervals).toEqual([
      { introduced: '0', fixed: '1.2.0' },
      { introduced: '2.0.0', lastAffected: '2.4.0' },
    ]);
  });
  it('GIT 범위만 있으면 판단 불가 사유가 된다', () => {
    const parsed = parseOsvAffected([{ type: 'GIT', events: [{ introduced: 'abc' }] }], undefined);
    expect(parsed.intervals).toEqual([]);
    expect(parsed.unparsed.length).toBe(1);
  });
});
