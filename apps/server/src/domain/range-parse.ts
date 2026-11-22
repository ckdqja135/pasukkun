import type { Interval } from './version-match.js';

export interface ParsedRange {
  intervals: Interval[];
  versions: string[];
  unparsed: string[];
}

/**
 * GitHub Advisory 의 vulnerable_version_range 문자열을 구간으로 바꾼다.
 * 예: ">= 2.0.0, < 2.3.1", "<= 1.4.2", "= 1.0.0"
 */
export function parseGhsaRange(range: string | null | undefined, firstPatched?: string | null): ParsedRange {
  const out: ParsedRange = { intervals: [], versions: [], unparsed: [] };
  const text = (range ?? '').trim();
  if (!text) {
    out.unparsed.push('(범위 미제공)');
    return out;
  }
  const interval: Interval = { introduced: '0' };
  let hasBound = false;
  for (const part of text.split(',')) {
    const match = /^(<=|>=|<|>|=)\s*(\S+)$/.exec(part.trim());
    if (!match) {
      out.unparsed.push(text);
      return out;
    }
    const [, op, version] = match;
    if (op === '=') {
      out.versions.push(version);
      continue;
    }
    hasBound = true;
    if (op === '>=') interval.introduced = version;
    else if (op === '>') {
      interval.introduced = version;
      interval.introducedExclusive = true;
    } else if (op === '<') interval.fixed = version;
    else interval.lastAffected = version;
  }
  if (hasBound) {
    if (firstPatched && !interval.fixed) interval.patched = firstPatched;
    out.intervals.push(interval);
  }
  return out;
}

interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}
interface OsvRange {
  type?: string;
  events?: OsvEvent[];
}

/** OSV affected[].ranges 와 versions 를 구간으로 바꾼다. GIT 범위는 버전 비교에 쓰지 않는다. */
export function parseOsvAffected(ranges: OsvRange[] | undefined, versions: string[] | undefined): ParsedRange {
  const out: ParsedRange = { intervals: [], versions: [...(versions ?? [])], unparsed: [] };
  let sawVersionRange = false;
  for (const range of ranges ?? []) {
    if (range.type !== 'SEMVER' && range.type !== 'ECOSYSTEM') continue;
    sawVersionRange = true;
    let current: Interval | null = null;
    for (const event of range.events ?? []) {
      if (event.introduced !== undefined) {
        if (current) out.intervals.push(current);
        current = { introduced: event.introduced };
      } else if (event.fixed !== undefined) {
        out.intervals.push({ ...(current ?? { introduced: '0' }), fixed: event.fixed });
        current = null;
      } else if (event.last_affected !== undefined) {
        out.intervals.push({ ...(current ?? { introduced: '0' }), lastAffected: event.last_affected });
        current = null;
      } else if (event.limit !== undefined) {
        out.intervals.push({ ...(current ?? { introduced: '0' }), fixed: event.limit });
        current = null;
      }
    }
    if (current) out.intervals.push(current);
  }
  if (!sawVersionRange && out.versions.length === 0) {
    out.unparsed.push((ranges ?? []).length > 0 ? '(버전 비교가 불가능한 범위 형식)' : '(범위 미제공)');
  }
  return out;
}
