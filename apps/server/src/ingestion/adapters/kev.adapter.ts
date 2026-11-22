import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';
import { JobService } from '../../jobs/job.service.js';
import type { IngestContext, SourceAdapter } from '../context.js';
import { parseDate } from '../normalized.js';
import { VulnerabilityUpsertService } from '../upsert.service.js';

/**
 * CISA Known Exploited Vulnerabilities 카탈로그.
 * 역할: 실제 악용이 확인된 취약점 여부 보완. (미등재가 "악용 없음"을 뜻하지는 않는다.)
 * 출처: https://www.cisa.gov/known-exploited-vulnerabilities-catalog - CC0 1.0
 */
const FEED = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';

export interface KevFeedEntry {
  cveID?: string;
  vendorProject?: string;
  product?: string;
  vulnerabilityName?: string;
  dateAdded?: string;
  dueDate?: string;
  requiredAction?: string;
  knownRansomwareCampaignUse?: string;
}
export interface KevFeed {
  catalogVersion?: string;
  count?: number;
  vulnerabilities?: KevFeedEntry[];
}

export interface KevRow {
  cve: string;
  vendorProject: string;
  product: string;
  name: string;
  dateAdded: Date;
  dueDate: Date | null;
  ransomwareUse: string;
  requiredAction: string;
}

export function normalizeKev(feed: KevFeed): KevRow[] {
  if (!Array.isArray(feed.vulnerabilities)) throw new Error('KEV 응답 형식이 예상과 다릅니다.');
  const rows: KevRow[] = [];
  for (const entry of feed.vulnerabilities) {
    const dateAdded = parseDate(entry.dateAdded ? `${entry.dateAdded}T00:00:00Z` : null);
    if (!entry.cveID || !/^CVE-\d{4}-\d{4,}$/i.test(entry.cveID) || !dateAdded) continue;
    rows.push({
      cve: entry.cveID.toUpperCase(),
      vendorProject: entry.vendorProject ?? '',
      product: entry.product ?? '',
      name: entry.vulnerabilityName ?? '',
      dateAdded,
      dueDate: parseDate(entry.dueDate ? `${entry.dueDate}T00:00:00Z` : null),
      ransomwareUse: entry.knownRansomwareCampaignUse ?? 'Unknown',
      requiredAction: entry.requiredAction ?? '',
    });
  }
  return rows;
}

@Injectable()
export class KevAdapter implements SourceAdapter {
  readonly key = 'KEV' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly upserts: VulnerabilityUpsertService,
    private readonly jobs: JobService,
  ) {}

  async run(context: IngestContext): Promise<void> {
    const response = await context.fetch(FEED, { timeoutMs: 60_000 });
    if (response.url && !new URL(response.url).hostname.endsWith('cisa.gov')) {
      throw new Error(`KEV 파일이 예상하지 않은 호스트로 리다이렉트되었습니다: ${new URL(response.url).hostname}`);
    }
    const feed = (await response.json()) as KevFeed;
    const rows = normalizeKev(feed);
    context.setWindow(null, new Date());
    context.count('fetched', rows.length);
    // 전체 파일이 비정상적으로 비어 있으면 저장된 등재 정보를 건드리지 않는다.
    if (rows.length === 0) throw new Error('KEV 카탈로그가 비어 있습니다 - 수집 실패로 처리합니다.');

    const known = new Set((await this.prisma.kevEntry.findMany({ select: { cve: true } })).map((row) => row.cve));
    for (const row of rows) {
      if (known.has(row.cve)) continue;
      await this.prisma.$transaction(async (tx) => {
        await tx.kevEntry.create({ data: row });
        const identifier = await tx.vulnerabilityIdentifier.findUnique({ where: { value: row.cve } });
        if (!identifier) return;
        const vulnerabilityId = identifier.vulnerabilityId;
        const before = await tx.vulnerability.findUniqueOrThrow({ where: { id: vulnerabilityId }, select: { kevAddedAt: true } });
        const after = await this.upserts.recompute(tx, vulnerabilityId);
        if (before.kevAddedAt !== null) return;
        context.count('changed');
        if (context.emitEvents) {
          await tx.notificationEvent.create({
            data: {
              type: 'KEV_ADDED',
              vulnerabilityId,
              payload: { cve: row.cve, dateAdded: row.dateAdded.toISOString(), dueDate: row.dueDate?.toISOString() ?? null },
              changeFingerprint: `kev:${row.dateAdded.toISOString().slice(0, 10)}`,
            },
          });
        }
        if (after.hasNpmPackage) {
          await this.jobs.enqueue(
            'reassess-vulnerability',
            { vulnerabilityId, silent: !context.emitEvents },
            { dedupeKey: `reassess:${vulnerabilityId}:${context.emitEvents ? 'loud' : 'silent'}` },
            tx,
          );
        }
      });
      context.count('upserted');
    }
    await context.setCheckpoint('catalog', { catalogVersion: feed.catalogVersion ?? null, count: rows.length });
  }
}
