import { Injectable } from '@nestjs/common';
import { cvssVersion, severityFromLabel } from '../../domain/cvss.js';
import { parseGhsaRange } from '../../domain/range-parse.js';
import type { IngestContext, SourceAdapter } from '../context.js';
import { parseDate, type NormalizedAdvisory } from '../normalized.js';

/**
 * GitHub Advisory Database - REST "List global security advisories".
 * 역할: 오픈소스 패키지 보안 공지와 영향 버전 정보 (검토 완료된 공지만).
 * 문서: https://docs.github.com/en/rest/security-advisories/global-advisories
 * 데이터 라이선스: CC-BY 4.0
 */
const API = 'https://api.github.com/advisories';
const API_VERSION = '2026-03-10';
/** 재개 시 겹쳐 읽는 구간. 같은 공지는 (source, sourceId) 로 한 행만 유지된다. */
const OVERLAP_MS = 60 * 60_000;

interface GhsaCvss {
  vector_string?: string | null;
  score?: number | null;
}
export interface GhsaAdvisory {
  ghsa_id: string;
  cve_id?: string | null;
  html_url?: string | null;
  summary?: string | null;
  description?: string | null;
  severity?: string | null;
  identifiers?: Array<{ type?: string; value?: string }> | null;
  references?: string[] | null;
  published_at?: string | null;
  updated_at?: string | null;
  withdrawn_at?: string | null;
  vulnerabilities?: Array<{
    package?: { ecosystem?: string | null; name?: string | null } | null;
    vulnerable_version_range?: string | null;
    first_patched_version?: string | { identifier?: string } | null;
    vulnerable_functions?: string[] | null;
  }> | null;
  cvss_severities?: { cvss_v3?: GhsaCvss | null; cvss_v4?: GhsaCvss | null } | null;
}

export function normalizeGhsa(item: GhsaAdvisory): NormalizedAdvisory {
  const identifiers = [item.ghsa_id, item.cve_id ?? '', ...(item.identifiers ?? []).map((id) => id.value ?? '')].filter(Boolean);

  const cvss: NormalizedAdvisory['cvss'] = [];
  for (const entry of [item.cvss_severities?.cvss_v3, item.cvss_severities?.cvss_v4]) {
    // 점수가 없는 버전은 { vector_string: null, score: 0.0 } 으로 온다.
    if (!entry?.vector_string) continue;
    const version = cvssVersion(entry.vector_string);
    if (!version) continue;
    cvss.push({
      source: 'GHSA',
      version,
      vector: entry.vector_string,
      score: typeof entry.score === 'number' && entry.score > 0 ? entry.score : null,
    });
  }

  const affected: NormalizedAdvisory['affected'] = [];
  for (const vulnerability of item.vulnerabilities ?? []) {
    const ecosystem = vulnerability.package?.ecosystem;
    const name = vulnerability.package?.name;
    if (!ecosystem || !name) continue;
    const patched =
      typeof vulnerability.first_patched_version === 'string'
        ? vulnerability.first_patched_version
        : (vulnerability.first_patched_version?.identifier ?? null);
    affected.push({
      ecosystem,
      name,
      ...parseGhsaRange(vulnerability.vulnerable_version_range, patched),
      functions: (vulnerability.vulnerable_functions ?? []).filter((fn) => typeof fn === 'string'),
    });
  }

  const references = [
    ...(item.html_url ? [{ url: item.html_url, type: 'ADVISORY' }] : []),
    ...(item.references ?? []).filter((url) => typeof url === 'string').map((url) => ({ url, type: 'WEB' })),
  ];

  return {
    source: 'GHSA',
    sourceId: item.ghsa_id,
    identifiers,
    title: item.summary ?? item.ghsa_id,
    details: item.description ?? '',
    htmlUrl: item.html_url ?? null,
    publishedAt: parseDate(item.published_at),
    modifiedAt: parseDate(item.updated_at),
    withdrawn: Boolean(item.withdrawn_at),
    severityLabel: severityFromLabel(item.severity),
    cvss,
    references,
    affected,
    products: [],
    raw: item,
  };
}

/** Link 헤더에서 rel="next" 주소를 꺼낸다. 다른 호스트로는 따라가지 않는다. */
export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match && match[1].startsWith(`${API}?`)) return match[1];
  }
  return null;
}

const isoSeconds = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

@Injectable()
export class GhsaAdapter implements SourceAdapter {
  readonly key = 'GHSA' as const;

  async run(context: IngestContext): Promise<void> {
    const checkpoint = await context.getCheckpoint<{ modifiedSince: string }>('reviewed');
    const now = new Date();
    const from = checkpoint
      ? new Date(Date.parse(checkpoint.modifiedSince) - OVERLAP_MS)
      : new Date(now.getTime() - context.env.initialFeedDays * 86_400_000);
    context.setWindow(from, now);

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
    };
    if (context.env.githubToken) headers.Authorization = `Bearer ${context.env.githubToken}`;

    const params = new URLSearchParams({
      type: 'reviewed',
      per_page: '100',
      sort: 'updated',
      direction: 'asc',
      modified: `${isoSeconds(from)}..${isoSeconds(now)}`,
    });
    let url: string | null = `${API}?${params.toString()}`;
    while (url) {
      // 토큰이 다른 호스트로 넘어가지 않도록 리다이렉트를 따르지 않는다.
      const response = await context.fetch(url, { headers, redirect: 'error' });
      const page = (await response.json()) as GhsaAdvisory[];
      if (!Array.isArray(page)) throw new Error('GitHub Advisory 응답 형식이 예상과 다릅니다.');
      let lastUpdated: string | null = null;
      for (const item of page) {
        if (!item?.ghsa_id) continue;
        context.count('fetched');
        const result = await context.upsert(normalizeGhsa(item));
        if (result.changed) context.count('upserted');
        if (result.changed && !result.created) context.count('changed');
        if (item.updated_at) lastUpdated = item.updated_at;
      }
      // updated 오름차순이므로 이 페이지까지 저장된 범위만큼만 체크포인트를 옮긴다.
      if (lastUpdated) await context.setCheckpoint('reviewed', { modifiedSince: lastUpdated });
      await context.heartbeat();
      url = nextLink(response.headers.get('link'));
    }
    await context.setCheckpoint('reviewed', { modifiedSince: now.toISOString() });
  }
}
