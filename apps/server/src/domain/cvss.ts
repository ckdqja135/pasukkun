/** CVSS v3.x 기본 점수 계산 (FIRST 명세의 공식). OSV 는 벡터만 주므로 점수를 여기서 계산한다. */
const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Record<string, number> = { L: 0.77, H: 0.44 };
const UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

function roundUp(value: number): number {
  const scaled = Math.round(value * 100000);
  return scaled % 10000 === 0 ? scaled / 100000 : (Math.floor(scaled / 10000) + 1) / 10;
}

export function cvssVersion(vector: string): string | null {
  const match = /^CVSS:(\d\.\d)\//.exec(vector);
  if (match) return match[1];
  // 접두어가 없는 벡터는 v2 형식이다 (AV:N/AC:L/Au:N/...)
  return /^AV:[NAL]\/AC:[HML]\/Au:/.test(vector) ? '2.0' : null;
}

/** v3.0 / v3.1 벡터만 계산한다. 그 외(v2, v4)는 null - 점수를 추측하지 않는다. */
export function cvss3BaseScore(vector: string): number | null {
  const version = cvssVersion(vector);
  if (version !== '3.0' && version !== '3.1') return null;
  const metrics = Object.fromEntries(
    vector
      .split('/')
      .slice(1)
      .map((part) => part.split(':') as [string, string]),
  );
  const scopeChanged = metrics.S === 'C';
  const pr = { N: 0.85, L: scopeChanged ? 0.68 : 0.62, H: scopeChanged ? 0.5 : 0.27 }[metrics.PR as 'N' | 'L' | 'H'];
  const av = AV[metrics.AV];
  const ac = AC[metrics.AC];
  const ui = UI[metrics.UI];
  const c = CIA[metrics.C];
  const i = CIA[metrics.I];
  const a = CIA[metrics.A];
  if ([av, ac, pr, ui, c, i, a].some((value) => value === undefined) || (metrics.S !== 'U' && metrics.S !== 'C')) return null;

  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = scopeChanged ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  const exploitability = 8.22 * av * ac * (pr as number) * ui;
  if (impact <= 0) return 0;
  return scopeChanged ? roundUp(Math.min(1.08 * (impact + exploitability), 10)) : roundUp(Math.min(impact + exploitability, 10));
}

export type SeverityLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export const SEVERITY_RANK: Record<SeverityLevel, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

export function severityFromScore(score: number | null | undefined): SeverityLevel {
  if (score === null || score === undefined || Number.isNaN(score)) return 'UNKNOWN';
  if (score >= 9) return 'CRITICAL';
  if (score >= 7) return 'HIGH';
  if (score >= 4) return 'MEDIUM';
  if (score > 0) return 'LOW';
  return 'UNKNOWN';
}

export function severityFromLabel(label: string | null | undefined): SeverityLevel {
  switch ((label ?? '').toUpperCase()) {
    case 'CRITICAL':
      return 'CRITICAL';
    case 'HIGH':
      return 'HIGH';
    case 'MODERATE':
    case 'MEDIUM':
      return 'MEDIUM';
    case 'LOW':
      return 'LOW';
    default:
      return 'UNKNOWN';
  }
}
