import type { SeverityLevel } from '../domain/cvss.js';
import type { Interval } from '../domain/version-match.js';

export type AdvisorySource = 'GHSA' | 'OSV' | 'NVD';

/** 출처별 원본을 공통 형태로 바꾼 결과. 원본(raw)은 그대로 함께 보존한다. */
export interface NormalizedAdvisory {
  source: AdvisorySource;
  sourceId: string;
  /** 자기 ID 와 출처가 명시한 alias. related/upstream 은 넣지 않는다. */
  identifiers: string[];
  title: string;
  details: string;
  htmlUrl: string | null;
  publishedAt: Date | null;
  modifiedAt: Date | null;
  withdrawn: boolean;
  severityLabel: SeverityLevel;
  cvss: Array<{ source: string; version: string; vector: string; score: number | null }>;
  references: Array<{ url: string; type: string }>;
  affected: Array<{ ecosystem: string; name: string; intervals: Interval[]; versions: string[]; unparsed: string[]; functions?: string[] }>;
  /** NVD CPE 에서 추출한 vendor:product */
  products: Array<{ vendor: string; product: string }>;
  raw: unknown;
}

export interface TypedIdentifier {
  type: 'CVE' | 'GHSA' | 'OSV';
  value: string;
}

/** 식별자를 전역 고유한 표준 표기로 맞춘다. */
export function normalizeIdentifier(raw: string): TypedIdentifier | null {
  const value = raw.trim();
  if (!value || value.length > 100) return null;
  if (/^CVE-\d{4}-\d{4,}$/i.test(value)) return { type: 'CVE', value: value.toUpperCase() };
  if (/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/i.test(value)) return { type: 'GHSA', value: `GHSA-${value.slice(5).toLowerCase()}` };
  if (/^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9._:-]+$/.test(value)) return { type: 'OSV', value: value.toUpperCase() };
  return null;
}

export function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value === '') return null;
  // NVD 는 시간대 표기 없이 UTC 시각을 준다.
  const text = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
