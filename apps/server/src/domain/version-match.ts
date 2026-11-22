import semver from 'semver';

/**
 * 영향 버전 구간. 경계 비교는 semver 2.0 우선순위를 그대로 따른다.
 * (npm range 의 "prerelease 제외" 규칙은 쓰지 않는다. 1.2.3-rc.1 < 1.2.3 이다.)
 */
export interface Interval {
  /** "0" 은 처음부터를 뜻한다 */
  introduced: string;
  /** true 면 introduced 초과(>) */
  introducedExclusive?: boolean;
  /** 이 버전 미만까지 영향 */
  fixed?: string;
  /** 이 버전 이하까지 영향 */
  lastAffected?: string;
  /** 출처가 명시한 첫 수정 버전 (구간 경계에서 유도할 수 없을 때) */
  patched?: string;
}

export interface AffectedSpec {
  /** 범위를 제공한 출처 (GHSA, OSV, ...) */
  source: string;
  intervals: Interval[];
  /** 명시적으로 나열된 영향 버전 */
  versions: string[];
  /** 해석하지 못한 범위 표현 */
  unparsed: string[];
}

export type MatchResult = 'AFFECTED' | 'NOT_AFFECTED' | 'UNKNOWN';

export interface SourceEvaluation {
  source: string;
  result: MatchResult;
  matchedInterval?: Interval;
  matchedExactVersion?: string;
  reason: string;
}

export interface CombinedEvaluation {
  result: MatchResult;
  reason: string;
  evaluations: SourceEvaluation[];
}

/** "1.2" 처럼 자리수가 부족한 경계만 보정한다. 그 외 비표준 표기는 해석하지 않는다. */
export function parseBound(raw: string): semver.SemVer | null {
  const value = raw.trim().replace(/^v(?=\d)/, '');
  const strict = semver.parse(value);
  if (strict) return strict;
  if (/^\d+$/.test(value)) return semver.parse(`${value}.0.0`);
  if (/^\d+\.\d+$/.test(value)) return semver.parse(`${value}.0`);
  return null;
}

export function describeInterval(interval: Interval): string {
  const parts: string[] = [];
  if (interval.introduced !== '0') {
    parts.push(`${interval.introducedExclusive ? '>' : '>='} ${interval.introduced}`);
  }
  if (interval.fixed) parts.push(`< ${interval.fixed}`);
  else if (interval.lastAffected) parts.push(`<= ${interval.lastAffected}`);
  if (parts.length === 0) return '모든 버전';
  return parts.join(', ');
}

/** 한 출처의 영향 범위에 대해 설치 버전을 평가한다. */
export function evaluateSpec(installedVersion: string, spec: AffectedSpec): SourceEvaluation {
  const installed = semver.parse(installedVersion.trim());
  if (!installed) {
    return {
      source: spec.source,
      result: 'UNKNOWN',
      reason: `설치 버전 "${installedVersion}" 이 semver 형식이 아니어서 비교할 수 없음`,
    };
  }

  for (const listed of spec.versions) {
    const parsed = parseBound(listed);
    const same = parsed ? semver.compare(installed, parsed) === 0 : listed.trim() === installedVersion.trim();
    if (same) {
      return {
        source: spec.source,
        result: 'AFFECTED',
        matchedExactVersion: listed,
        reason: `영향 버전 목록에 ${listed} 이 명시됨`,
      };
    }
  }

  let unparseable = spec.unparsed.length > 0;
  for (const interval of spec.intervals) {
    const lower = interval.introduced === '0' ? null : parseBound(interval.introduced);
    if (interval.introduced !== '0' && !lower) {
      unparseable = true;
      continue;
    }
    const upperRaw = interval.fixed ?? interval.lastAffected;
    const upper = upperRaw === undefined ? null : parseBound(upperRaw);
    if (upperRaw !== undefined && !upper) {
      unparseable = true;
      continue;
    }
    if (lower) {
      const cmp = semver.compare(installed, lower);
      if (interval.introducedExclusive ? cmp <= 0 : cmp < 0) continue;
    }
    if (upper) {
      const cmp = semver.compare(installed, upper);
      if (interval.fixed !== undefined ? cmp >= 0 : cmp > 0) continue;
    }
    return {
      source: spec.source,
      result: 'AFFECTED',
      matchedInterval: interval,
      reason: `${installed.version} 이 영향 구간(${describeInterval(interval)})에 포함됨`,
    };
  }

  if (unparseable) {
    return {
      source: spec.source,
      result: 'UNKNOWN',
      reason: '영향 범위 일부를 해석할 수 없어 포함 여부를 확정할 수 없음',
    };
  }
  if (spec.intervals.length === 0 && spec.versions.length === 0) {
    return { source: spec.source, result: 'UNKNOWN', reason: '출처가 영향 버전 범위를 제공하지 않음' };
  }
  return {
    source: spec.source,
    result: 'NOT_AFFECTED',
    reason: `${installed.version} 은 확인된 영향 범위에 포함되지 않음`,
  };
}

/**
 * 여러 출처의 평가를 하나로 합친다.
 * @param osvReported OSV 조회가 이 버전을 일치로 보고했는지 (조회하지 않았으면 null)
 */
export function combineEvaluations(
  evaluations: SourceEvaluation[],
  osvReported: boolean | null,
): CombinedEvaluation {
  const affected = evaluations.filter((e) => e.result === 'AFFECTED');
  const notAffected = evaluations.filter((e) => e.result === 'NOT_AFFECTED');

  if (evaluations.length === 0) {
    return {
      result: 'UNKNOWN',
      reason: osvReported
        ? 'OSV 가 일치로 보고했으나 로컬에 검증할 영향 범위 데이터가 없음'
        : '검증할 영향 범위 데이터가 없음',
      evaluations,
    };
  }
  if (affected.length > 0 && notAffected.length > 0) {
    return {
      result: 'UNKNOWN',
      reason: `출처 간 영향 범위 불일치 (일치: ${affected.map((e) => e.source).join(', ')} / 미포함: ${notAffected
        .map((e) => e.source)
        .join(', ')})`,
      evaluations,
    };
  }
  if (affected.length > 0) {
    return { result: 'AFFECTED', reason: affected[0].reason, evaluations };
  }
  if (notAffected.length === evaluations.length) {
    if (osvReported === true) {
      return {
        result: 'UNKNOWN',
        reason: 'OSV 조회 결과(일치)와 로컬 범위 평가(미포함)가 서로 다름',
        evaluations,
      };
    }
    return { result: 'NOT_AFFECTED', reason: notAffected[0].reason, evaluations };
  }
  const unknown = evaluations.find((e) => e.result === 'UNKNOWN');
  return { result: 'UNKNOWN', reason: unknown?.reason ?? '판단 근거 부족', evaluations };
}

export type FixSuggestion =
  /** 현재 버전이 속한 구간에서 확인된 수정 버전 */
  | { kind: 'FIXED'; version: string; source: string }
  /** 현재 구간에는 수정 버전이 없고 더 높은 릴리스 계열에서만 확인됨 */
  | { kind: 'HIGHER_LINE_ONLY'; version: string; source: string }
  /** 패치 미확인 - 버전을 추측하지 않는다 */
  | { kind: 'UNCONFIRMED' };

/** 수정 버전 제안. 일치한 구간의 경계만 사용하고, 없으면 추측하지 않는다. */
export function suggestFix(
  installedVersion: string,
  evaluations: SourceEvaluation[],
  specs: AffectedSpec[],
): FixSuggestion {
  const installed = semver.parse(installedVersion.trim());
  if (!installed) return { kind: 'UNCONFIRMED' };

  for (const evaluation of evaluations) {
    if (evaluation.result !== 'AFFECTED' || !evaluation.matchedInterval) continue;
    const candidate = evaluation.matchedInterval.fixed ?? evaluation.matchedInterval.patched;
    const parsed = candidate ? parseBound(candidate) : null;
    if (candidate && parsed && semver.compare(parsed, installed) > 0) {
      return { kind: 'FIXED', version: candidate, source: evaluation.source };
    }
  }

  let best: { version: string; parsed: semver.SemVer; source: string } | null = null;
  for (const spec of specs) {
    for (const interval of spec.intervals) {
      const candidate = interval.fixed ?? interval.patched;
      const parsed = candidate ? parseBound(candidate) : null;
      if (!candidate || !parsed || semver.compare(parsed, installed) <= 0) continue;
      if (!best || semver.compare(parsed, best.parsed) < 0) best = { version: candidate, parsed, source: spec.source };
    }
  }
  if (best) return { kind: 'HIGHER_LINE_ONLY', version: best.version, source: best.source };
  return { kind: 'UNCONFIRMED' };
}
