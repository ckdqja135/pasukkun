import { Injectable } from '@nestjs/common';
import { parseCpe } from '../../catalog/tagging.js';
import type { IngestContext, SourceAdapter } from '../context.js';
import { parseDate, truncate, type NormalizedAdvisory } from '../normalized.js';

/**
 * NVD CVE API 2.0.
 * 역할: CVE 정보와 제공되는 CVSS, 제품(CPE) 정보 보완.
 * 문서: https://nvd.nist.gov/developers/vulnerabilities
 * 고지: This product uses the NVD API but is not endorsed or certified by the NVD.
 */
const API = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
const PAGE_SIZE = 2000;
/** 날짜 범위 최대 120일 제한보다 작게 잘라 체크포인트를 자주 남긴다. */
const CHUNK_MS = 7 * 86_400_000;
const OVERLAP_MS = 10 * 60_000;
/** 키 없음: 30초당 5회 → 6초 간격 권장. 키 있음: 30초당 50회. */
const PAUSE_NO_KEY_MS = 6500;
const PAUSE_WITH_KEY_MS = 800;

interface NvdCvssEntry {
  source?: string;
  type?: string;
  cvssData?: { version?: string; vectorString?: string; baseScore?: number };
}
export interface NvdCve {
  id: string;
  vulnStatus?: string;
  published?: string;
  lastModified?: string;
  descriptions?: Array<{ lang?: string; value?: string }>;
  references?: Array<{ url?: string; tags?: string[] }>;
  metrics?: {
    cvssMetricV40?: NvdCvssEntry[];
    cvssMetricV31?: NvdCvssEntry[];
    cvssMetricV30?: NvdCvssEntry[];
    cvssMetricV2?: NvdCvssEntry[];
  };
  configurations?: Array<{ nodes?: Array<{ cpeMatch?: Array<{ vulnerable?: boolean; criteria?: string }> }> }>;
}
interface NvdResponse {
  resultsPerPage?: number;
  startIndex?: number;
  totalResults?: number;
  vulnerabilities?: Array<{ cve?: NvdCve }>;
}

export function normalizeNvd(cve: NvdCve): NormalizedAdvisory {
  const description = (cve.descriptions ?? []).find((d) => d.lang === 'en')?.value ?? cve.descriptions?.[0]?.value ?? '';
  const firstSentence = description.split(/(?<=[.!?])\s/)[0] ?? '';

  const cvss: NormalizedAdvisory['cvss'] = [];
  const metrics = cve.metrics ?? {};
  for (const entry of [
    ...(metrics.cvssMetricV40 ?? []),
    ...(metrics.cvssMetricV31 ?? []),
    ...(metrics.cvssMetricV30 ?? []),
    ...(metrics.cvssMetricV2 ?? []),
  ]) {
    const data = entry.cvssData;
    if (!data?.version || !data.vectorString) continue;
    cvss.push({
      // 점수를 준 주체(NVD 자체 또는 CNA)를 구분해 남긴다.
      source: `NVD:${entry.source ?? 'unknown'}`,
      version: data.version,
      vector: data.vectorString,
      score: typeof data.baseScore === 'number' ? data.baseScore : null,
    });
  }

  const products: NormalizedAdvisory['products'] = [];
  for (const configuration of cve.configurations ?? []) {
    for (const node of configuration.nodes ?? []) {
      for (const match of node.cpeMatch ?? []) {
        if (match.vulnerable === false || !match.criteria) continue;
        const parsed = parseCpe(match.criteria);
        if (parsed) products.push(parsed);
      }
    }
  }

  return {
    source: 'NVD',
    sourceId: cve.id,
    identifiers: [cve.id],
    title: truncate(firstSentence || cve.id, 200),
    details: description,
    htmlUrl: `https://nvd.nist.gov/vuln/detail/${cve.id}`,
    publishedAt: parseDate(cve.published),
    modifiedAt: parseDate(cve.lastModified),
    withdrawn: cve.vulnStatus === 'Rejected',
    severityLabel: 'UNKNOWN',
    cvss,
    references: (cve.references ?? [])
      .filter((reference) => typeof reference.url === 'string')
      .map((reference) => ({ url: reference.url as string, type: reference.tags?.includes('Patch') ? 'FIX' : 'WEB' })),
    affected: [],
    products,
    raw: cve,
  };
}

@Injectable()
export class NvdAdapter implements SourceAdapter {
  readonly key = 'NVD' as const;

  async run(context: IngestContext): Promise<void> {
    const checkpoint = await context.getCheckpoint<{ lastModEnd: string }>('cves');
    const now = new Date();
    const from = checkpoint
      ? new Date(Date.parse(checkpoint.lastModEnd) - OVERLAP_MS)
      : new Date(now.getTime() - context.env.initialFeedDays * 86_400_000);
    context.setWindow(from, now);

    const headers: Record<string, string> = {};
    if (context.env.nvdApiKey) headers.apiKey = context.env.nvdApiKey;
    const pause = context.env.nvdApiKey ? PAUSE_WITH_KEY_MS : PAUSE_NO_KEY_MS;
    const feedStart = now.getTime() - context.env.initialFeedDays * 86_400_000;

    let first = true;
    for (let start = from.getTime(); start < now.getTime(); start += CHUNK_MS) {
      const end = Math.min(start + CHUNK_MS, now.getTime());
      let startIndex = 0;
      for (;;) {
        if (!first) await context.sleep(pause);
        first = false;
        const params = new URLSearchParams({
          lastModStartDate: new Date(start).toISOString(),
          lastModEndDate: new Date(end).toISOString(),
          startIndex: String(startIndex),
          resultsPerPage: String(PAGE_SIZE),
        });
        // API 키 헤더가 다른 호스트로 넘어가지 않도록 리다이렉트를 따르지 않는다.
        const response = await context.fetch(`${API}?${params.toString()}`, { headers, timeoutMs: 120_000, redirect: 'error' });
        const body = (await response.json()) as NvdResponse;
        if (!Array.isArray(body.vulnerabilities) || typeof body.totalResults !== 'number') {
          throw new Error('NVD 응답 형식이 예상과 다릅니다.');
        }
        for (const entry of body.vulnerabilities) {
          if (!entry.cve?.id) continue;
          context.count('fetched');
          // 피드 범위(최근 N일 공개분)이거나 이미 알고 있는 CVE 만 저장한다.
          // NVD 는 오래된 CVE 도 자주 일괄 수정하므로, 전부 저장하면 관련 없는 과거 항목으로 DB 가 불어난다.
          const published = parseDate(entry.cve.published);
          const recent = published !== null && published.getTime() >= feedStart;
          if (!recent && !(await context.hasIdentifier(entry.cve.id))) continue;
          const result = await context.upsert(normalizeNvd(entry.cve));
          if (result.changed) context.count('upserted');
          if (result.changed && !result.created) context.count('changed');
        }
        await context.heartbeat();
        startIndex += body.resultsPerPage ?? body.vulnerabilities.length;
        if (startIndex >= body.totalResults || body.vulnerabilities.length === 0) break;
      }
      // 이 구간의 모든 페이지를 저장한 뒤에만 체크포인트를 옮긴다.
      await context.setCheckpoint('cves', { lastModEnd: new Date(end).toISOString() });
    }
  }
}
