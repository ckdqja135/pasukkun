import { Injectable } from '@nestjs/common';
import { fetchWithRetry, type FetchOptions } from '../../common/http.js';
import { cvss3BaseScore, cvssVersion, severityFromLabel } from '../../domain/cvss.js';
import { parseOsvAffected } from '../../domain/range-parse.js';
import { parseDate, type NormalizedAdvisory } from '../normalized.js';

/**
 * OSV API.
 * 역할: 패키지 생태계·이름·실제 설치 버전에 대한 취약점 조회 (공개 시점과 무관).
 * 문서: https://google.github.io/osv.dev/api/
 * querybatch 는 취약점 ID 와 수정 시각만 돌려주므로 상세는 /v1/vulns/{id} 로 따로 조회해 캐시한다.
 * 이 호출로 패키지명과 버전이 외부(OSV)로 전송된다.
 */
const API = 'https://api.osv.dev';
/** 문서상 한 번에 최대 1000개 */
const BATCH_SIZE = 1000;
const MAX_PAGES = 20;

export interface OsvRecord {
  id: string;
  modified?: string;
  published?: string;
  withdrawn?: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  severity?: Array<{ type?: string; score?: string }>;
  affected?: Array<{
    package?: { ecosystem?: string; name?: string };
    severity?: Array<{ type?: string; score?: string }>;
    ranges?: Array<{ type?: string; events?: Array<Record<string, string>> }>;
    versions?: string[];
    ecosystem_specific?: { affected_functions?: unknown; imports?: Array<{ path?: string; symbols?: string[] }> } & Record<string, unknown>;
  }>;
  references?: Array<{ type?: string; url?: string }>;
  database_specific?: { severity?: string } & Record<string, unknown>;
}

export interface PackageQuery {
  name: string;
  version: string;
}

export interface BatchHit {
  id: string;
  modified: string | null;
}

export function normalizeOsv(record: OsvRecord): NormalizedAdvisory {
  const cvss: NormalizedAdvisory['cvss'] = [];
  const severities = [...(record.severity ?? []), ...(record.affected ?? []).flatMap((a) => a.severity ?? [])];
  for (const severity of severities) {
    if (!severity.score || !severity.type?.startsWith('CVSS')) continue;
    const version = cvssVersion(severity.score);
    if (!version) continue;
    // OSV 는 벡터만 준다. v3 는 공식으로 계산하고, 그 외는 점수를 추측하지 않는다.
    cvss.push({ source: 'OSV', version, vector: severity.score, score: cvss3BaseScore(severity.score) });
  }

  const affected: NormalizedAdvisory['affected'] = [];
  for (const item of record.affected ?? []) {
    if (!item.package?.ecosystem || !item.package.name) continue;
    affected.push({
      ecosystem: item.package.ecosystem,
      name: item.package.name,
      ...parseOsvAffected(item.ranges, item.versions),
      functions: [
        ...(Array.isArray(item.ecosystem_specific?.affected_functions)
          ? (item.ecosystem_specific.affected_functions as unknown[]).filter((fn): fn is string => typeof fn === 'string')
          : []),
        ...(item.ecosystem_specific?.imports ?? []).flatMap((entry) => (entry.symbols ?? []).map((symbol) => `${entry.path ?? ''}.${symbol}`)),
      ],
    });
  }

  return {
    source: 'OSV',
    sourceId: record.id,
    // aliases 만 같은 취약점으로 연결한다. related / upstream 은 다른 취약점일 수 있다.
    identifiers: [record.id, ...(record.aliases ?? [])],
    title: record.summary ?? record.id,
    details: record.details ?? '',
    htmlUrl: `https://osv.dev/vulnerability/${encodeURIComponent(record.id)}`,
    publishedAt: parseDate(record.published),
    modifiedAt: parseDate(record.modified),
    withdrawn: Boolean(record.withdrawn),
    severityLabel: severityFromLabel(record.database_specific?.severity),
    cvss,
    references: (record.references ?? [])
      .filter((reference) => typeof reference.url === 'string')
      .map((reference) => ({ url: reference.url as string, type: reference.type ?? 'WEB' })),
    affected,
    products: [],
    raw: record,
  };
}

interface BatchResponse {
  results?: Array<{ vulns?: Array<{ id?: string; modified?: string }>; next_page_token?: string }>;
}

@Injectable()
export class OsvClient {
  /** 테스트에서 네트워크를 대체하기 위한 주입점 */
  fetchImpl: (url: string, options?: FetchOptions) => Promise<Response> = fetchWithRetry;

  /**
   * (이름, 버전) 목록을 조회한다. 결과 배열은 입력과 같은 순서다.
   * 호출이 실패하면 예외를 던진다 - 실패를 "취약점 없음"으로 바꾸지 않는다.
   */
  async queryBatch(packages: PackageQuery[], ecosystem = 'npm'): Promise<BatchHit[][]> {
    const results: BatchHit[][] = packages.map(() => []);
    for (let offset = 0; offset < packages.length; offset += BATCH_SIZE) {
      // 페이지 토큰이 남은 질의만 다시 보낸다.
      let pending = packages.slice(offset, offset + BATCH_SIZE).map((pkg, index) => ({ index: offset + index, pkg, token: undefined as string | undefined }));
      for (let page = 0; pending.length > 0; page += 1) {
        if (page >= MAX_PAGES) throw new Error('OSV 응답 페이지가 예상보다 많아 조회를 중단했습니다.');
        const body = JSON.stringify({
          queries: pending.map((item) => ({
            package: { name: item.pkg.name, ecosystem },
            version: item.pkg.version,
            ...(item.token ? { page_token: item.token } : {}),
          })),
        });
        const response = await this.fetchImpl(`${API}/v1/querybatch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          timeoutMs: 60_000,
          redirect: 'error',
        });
        const data = (await response.json()) as BatchResponse;
        if (!Array.isArray(data.results) || data.results.length !== pending.length) {
          throw new Error('OSV querybatch 응답이 요청과 맞지 않습니다.');
        }
        const next: typeof pending = [];
        data.results.forEach((result, position) => {
          const item = pending[position];
          for (const vuln of result.vulns ?? []) {
            if (vuln.id) results[item.index].push({ id: vuln.id, modified: vuln.modified ?? null });
          }
          if (result.next_page_token) next.push({ ...item, token: result.next_page_token });
        });
        pending = next;
      }
    }
    return results;
  }

  async getVulnerability(id: string): Promise<OsvRecord> {
    const response = await this.fetchImpl(`${API}/v1/vulns/${encodeURIComponent(id)}`, { timeoutMs: 30_000, redirect: 'error' });
    const record = (await response.json()) as OsvRecord;
    if (!record?.id) throw new Error(`OSV 상세 응답 형식이 예상과 다릅니다: ${id}`);
    return record;
  }
}
