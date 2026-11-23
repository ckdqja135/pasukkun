import { gzipSync } from 'node:zlib';
import { Injectable, Logger } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service.js';
import { normalizeEcosystem, normalizePackageName } from '../catalog/catalog.data.js';
import { computeTechnologyTags } from '../catalog/tagging.js';
import { stableHash } from '../common/crypto.js';
import { PrismaService, type Db } from '../db/prisma.service.js';
import { SEVERITY_RANK, severityFromScore, type SeverityLevel } from '../domain/cvss.js';
import type { Interval } from '../domain/version-match.js';
import { JobService } from '../jobs/job.service.js';
import { normalizeIdentifier, truncate, type NormalizedAdvisory, type TypedIdentifier } from './normalized.js';

export interface UpsertOptions {
  /** false 면 알림 이벤트를 만들지 않는다 (초기 적재, 프로젝트 검사 중 과거 공지 조회) */
  emitEvents: boolean;
}

export interface UpsertResult {
  vulnerabilityId: string;
  created: boolean;
  /** 출처 원본이 이전과 달라졌는지 */
  changed: boolean;
  rangeChanged: boolean;
}

interface AggregateSnapshot {
  rangeHash: string;
  patchStatus: string;
  withdrawn: boolean;
  meaningfulHash: string;
  tagIds: Set<string>;
  hasNpmPackage: boolean;
  publishedAt: Date | null;
  fixedHash: string;
}

const SOURCE_PRECEDENCE = ['GHSA', 'OSV', 'NVD'];
const NEW_VULN_WINDOW_MS = 30 * 86_400_000;
const MAX_REFERENCES = 20;
const HTTP_URL = /^https?:\/\/[^\s<>"']+$/i;

@Injectable()
export class VulnerabilityUpsertService {
  private readonly logger = new Logger(VulnerabilityUpsertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly jobs: JobService,
  ) {}

  /**
   * 출처 한 건을 저장한다. 같은 (source, sourceId) 는 한 행으로 유지되므로 재수집해도 중복되지 않는다.
   * 내용이 이전과 같으면 아무것도 바꾸지 않는다 (수정 시각만 바뀐 재수집 포함).
   */
  async upsert(advisory: NormalizedAdvisory, options: UpsertOptions): Promise<UpsertResult> {
    // 수정 시각만 바뀐 경우를 걸러내기 위해 정규화 결과로 해시를 만든다.
    const rawHash = stableHash({ ...advisory, raw: undefined, modifiedAt: undefined });
    const existing = await this.prisma.sourceRecord.findUnique({
      where: { source_sourceId: { source: advisory.source, sourceId: advisory.sourceId } },
      select: { id: true, rawHash: true, vulnerabilityId: true, sourceModifiedAt: true },
    });
    if (existing && existing.rawHash === rawHash) {
      // 내용은 같고 수정 시각만 달라진 경우: 시각만 기록하고 재평가·알림은 만들지 않는다.
      const modifiedAt = advisory.modifiedAt;
      if (modifiedAt && existing.sourceModifiedAt?.getTime() !== modifiedAt.getTime()) {
        await this.prisma.sourceRecord.update({ where: { id: existing.id }, data: { sourceModifiedAt: modifiedAt, fetchedAt: new Date() } });
        await this.prisma.vulnerability.updateMany({
          where: { id: existing.vulnerabilityId, OR: [{ modifiedAt: null }, { modifiedAt: { lt: modifiedAt } }] },
          data: { modifiedAt },
        });
      }
      return { vulnerabilityId: existing.vulnerabilityId, created: false, changed: false, rangeChanged: false };
    }

    const identifiers = dedupeIdentifiers(advisory.identifiers);
    if (identifiers.length === 0) throw new Error(`식별자를 해석할 수 없는 공지: ${advisory.source}:${advisory.sourceId}`);
    const mappings = await this.catalog.mappings();

    return this.prisma.$transaction(
      async (tx) => {
        // 1) 명시적 alias 로 연결된 기존 취약점을 찾는다. 제목 유사도로는 합치지 않는다.
        const linked = await tx.vulnerabilityIdentifier.findMany({
          where: { value: { in: identifiers.map((id) => id.value) } },
          select: { vulnerabilityId: true },
        });
        const candidateIds = new Set(linked.map((row) => row.vulnerabilityId));
        if (existing) candidateIds.add(existing.vulnerabilityId);

        let vulnerabilityId: string;
        let created = false;
        if (candidateIds.size === 0) {
          const vulnerability = await tx.vulnerability.create({ data: { title: advisory.title || advisory.sourceId } });
          vulnerabilityId = vulnerability.id;
          created = true;
        } else {
          const candidates = await tx.vulnerability.findMany({
            where: { id: { in: [...candidateIds] } },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          });
          vulnerabilityId = candidates[0].id;
          for (const other of candidates.slice(1)) {
            await this.merge(tx, vulnerabilityId, other.id, `${advisory.source}:${advisory.sourceId} 의 alias 로 연결됨`);
          }
        }

        const before = created ? null : await this.snapshot(tx, vulnerabilityId);

        // 2) 식별자
        for (const identifier of identifiers) {
          await tx.vulnerabilityIdentifier.upsert({
            where: { value: identifier.value },
            update: { vulnerabilityId },
            create: { vulnerabilityId, type: identifier.type, value: identifier.value },
          });
        }

        // 3) 출처 원본과 정규화 결과
        const sourceData = {
          vulnerabilityId,
          raw: new Uint8Array(gzipSync(JSON.stringify(advisory.raw))),
          rawHash,
          sourceModifiedAt: advisory.modifiedAt,
          withdrawn: advisory.withdrawn,
          title: truncate(advisory.title, 500),
          details: advisory.details,
          // 외부에서 온 주소는 http/https 만 남긴다 (javascript: 등은 화면의 링크가 될 수 없게 한다).
          references: dedupeReferences(advisory.references),
          publishedAt: advisory.publishedAt,
          severityLabel: advisory.severityLabel,
          htmlUrl: advisory.htmlUrl && HTTP_URL.test(advisory.htmlUrl) ? advisory.htmlUrl : null,
          fetchedAt: new Date(),
        };
        const record = await tx.sourceRecord.upsert({
          where: { source_sourceId: { source: advisory.source, sourceId: advisory.sourceId } },
          update: sourceData,
          create: { source: advisory.source, sourceId: advisory.sourceId, ...sourceData },
        });

        // 4) 이 출처가 제공한 영향 패키지 (한 취약점 ↔ 여러 패키지 관계를 그대로 보존)
        await tx.affectedPackage.deleteMany({ where: { sourceRecordId: record.id } });
        const grouped = new Map<string, { ecosystem: string; name: string; intervals: Interval[]; versions: string[]; unparsed: string[]; functions: string[] }>();
        for (const item of advisory.affected) {
          const ecosystem = normalizeEcosystem(item.ecosystem);
          const name = normalizePackageName(ecosystem, item.name);
          if (!name) continue;
          const key = `${ecosystem}\u0000${name}`;
          const current = grouped.get(key) ?? { ecosystem, name, intervals: [], versions: [], unparsed: [], functions: [] };
          current.intervals.push(...item.intervals);
          current.versions.push(...item.versions);
          current.unparsed.push(...item.unparsed);
          current.functions.push(...(item.functions ?? []));
          grouped.set(key, current);
        }
        for (const item of grouped.values()) {
          const pkg = await tx.package.upsert({
            where: { ecosystem_name: { ecosystem: item.ecosystem, name: item.name } },
            update: {},
            create: { ecosystem: item.ecosystem, name: item.name },
          });
          const versions = [...new Set(item.versions)];
          await tx.affectedPackage.create({
            data: {
              vulnerabilityId,
              packageId: pkg.id,
              sourceRecordId: record.id,
              intervals: item.intervals as object[],
              versions,
              unparsed: [...new Set(item.unparsed)],
              functions: [...new Set(item.functions)].slice(0, 50),
              rangeHash: stableHash({ intervals: item.intervals, versions, unparsed: item.unparsed }),
            },
          });
        }

        // 5) 이 출처의 CVSS (출처·버전별로 모두 보존)
        await tx.vulnerabilityCvss.deleteMany({
          where: { vulnerabilityId, OR: [{ source: advisory.source }, { source: { startsWith: `${advisory.source}:` } }] },
        });
        const seenCvss = new Set<string>();
        for (const cvss of advisory.cvss) {
          const key = `${cvss.source}|${cvss.version}`;
          if (seenCvss.has(key)) continue;
          seenCvss.add(key);
          await tx.vulnerabilityCvss.create({ data: { vulnerabilityId, ...cvss } });
        }

        // 6) CPE 제품
        if (advisory.source === 'NVD') {
          await tx.vulnerabilityProduct.deleteMany({ where: { vulnerabilityId } });
          const seenProducts = new Set<string>();
          for (const product of advisory.products) {
            const key = `${product.vendor}:${product.product}`;
            if (seenProducts.has(key)) continue;
            seenProducts.add(key);
            await tx.vulnerabilityProduct.create({ data: { vulnerabilityId, ...product } });
          }
        }

        // 7) 모든 출처를 합친 대표값 재계산
        const after = await this.recompute(tx, vulnerabilityId, mappings);
        const rangeChanged = !created && before !== null && before.rangeHash !== after.rangeHash;

        // 8) 알림 이벤트 (Outbox: 같은 트랜잭션에 기록)
        if (options.emitEvents && !after.withdrawn) {
          const gainedTags = [...after.tagIds].filter((id) => !before?.tagIds.has(id));
          const recent = after.publishedAt !== null && Date.now() - after.publishedAt.getTime() < NEW_VULN_WINDOW_MS;
          if (recent && gainedTags.length > 0) {
            await tx.notificationEvent.create({
              data: { type: 'TECH_NEW_VULN', vulnerabilityId, payload: {}, changeFingerprint: 'new' },
            });
          }
          if (rangeChanged && before!.rangeHash !== '') {
            await tx.notificationEvent.create({
              data: { type: 'AFFECTED_RANGE_CHANGED', vulnerabilityId, payload: {}, changeFingerprint: after.rangeHash },
            });
          }
          if (before && before.patchStatus !== 'AVAILABLE' && after.patchStatus === 'AVAILABLE') {
            await tx.notificationEvent.create({
              data: { type: 'PATCH_AVAILABLE', vulnerabilityId, payload: {}, changeFingerprint: after.fixedHash },
            });
          }
        }

        // 9) 의미 있는 변경이면 영향 프로젝트 재평가를 예약한다.
        if (after.hasNpmPackage && (created || before?.meaningfulHash !== after.meaningfulHash)) {
          await this.jobs.enqueue(
            'reassess-vulnerability',
            { vulnerabilityId, silent: !options.emitEvents },
            { dedupeKey: `reassess:${vulnerabilityId}:${options.emitEvents ? 'loud' : 'silent'}` },
            tx,
          );
        }

        return { vulnerabilityId, created, changed: true, rangeChanged };
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
  }

  private async snapshot(tx: Db, vulnerabilityId: string): Promise<AggregateSnapshot> {
    const vulnerability = await tx.vulnerability.findUniqueOrThrow({
      where: { id: vulnerabilityId },
      select: {
        rangeHash: true,
        patchStatus: true,
        withdrawnAt: true,
        meaningfulHash: true,
        publishedAt: true,
        technologies: { select: { technologyId: true } },
      },
    });
    return {
      rangeHash: vulnerability.rangeHash,
      patchStatus: vulnerability.patchStatus,
      withdrawn: vulnerability.withdrawnAt !== null,
      meaningfulHash: vulnerability.meaningfulHash,
      tagIds: new Set(vulnerability.technologies.map((row) => row.technologyId)),
      hasNpmPackage: false,
      publishedAt: vulnerability.publishedAt,
      fixedHash: '',
    };
  }

  /** 출처별 레코드로부터 취약점 대표값(제목, 심각도, 영향 범위 해시, 기술 태그, KEV)을 다시 계산한다. */
  async recompute(tx: Db, vulnerabilityId: string, mappings?: Awaited<ReturnType<CatalogService['mappings']>>): Promise<AggregateSnapshot> {
    const tagMappings = mappings ?? (await this.catalog.mappings());
    const current = await tx.vulnerability.findUniqueOrThrow({ where: { id: vulnerabilityId }, select: { withdrawnAt: true } });
    const sources = await tx.sourceRecord.findMany({
      where: { vulnerabilityId, source: { in: ['GHSA', 'OSV', 'NVD'] } },
      select: { source: true, withdrawn: true, title: true, publishedAt: true, sourceModifiedAt: true, severityLabel: true },
    });
    const byPrecedence = [...sources].sort((a, b) => SOURCE_PRECEDENCE.indexOf(a.source) - SOURCE_PRECEDENCE.indexOf(b.source));
    const active = byPrecedence.filter((source) => !source.withdrawn);
    const preferred = active.length > 0 ? active : byPrecedence;
    const activeSources = new Set(active.map((source) => source.source as string));

    const published = sources.map((s) => s.publishedAt).filter((d): d is Date => d !== null);
    const modified = sources.map((s) => s.sourceModifiedAt).filter((d): d is Date => d !== null);
    const publishedAt = published.length ? new Date(Math.min(...published.map((d) => d.getTime()))) : null;
    const modifiedAt = modified.length ? new Date(Math.max(...modified.map((d) => d.getTime()))) : null;
    // 모든 공지 출처가 철회·거부한 경우에만 취약점 자체를 철회로 본다.
    const withdrawn = sources.length > 0 && active.length === 0;
    const withdrawnAt = withdrawn ? (current.withdrawnAt ?? new Date()) : null;

    // 심각도: 유효한 출처의 CVSS 중 최고 점수 (v3 이상 우선, 없으면 v2). 점수가 없으면 출처 라벨.
    const cvssRows = (await tx.vulnerabilityCvss.findMany({ where: { vulnerabilityId } })).filter((row) =>
      activeSources.has(row.source.split(':')[0]),
    );
    const scored = cvssRows.filter((row) => row.score !== null && row.score > 0);
    const modern = scored.filter((row) => Number(row.version) >= 3);
    const pool = modern.length > 0 ? modern : scored;
    const best = pool.reduce<(typeof pool)[number] | null>((top, row) => (top === null || row.score! > top.score! ? row : top), null);
    let severity: SeverityLevel = severityFromScore(best?.score);
    if (severity === 'UNKNOWN') {
      for (const source of active) {
        if (SEVERITY_RANK[source.severityLabel] > SEVERITY_RANK[severity]) severity = source.severityLabel;
      }
    }

    const affected = await tx.affectedPackage.findMany({
      where: { vulnerabilityId },
      select: {
        intervals: true,
        versions: true,
        unparsed: true,
        package: { select: { ecosystem: true, name: true } },
        sourceRecord: { select: { source: true, withdrawn: true } },
      },
    });
    const activeAffected = affected.filter((row) => !row.sourceRecord.withdrawn);
    const rangeHash =
      activeAffected.length === 0
        ? ''
        : stableHash(
            activeAffected
              .map((row) => ({
                key: `${row.package.ecosystem}|${row.package.name}|${row.sourceRecord.source}`,
                intervals: row.intervals,
                versions: row.versions,
                unparsed: row.unparsed,
              }))
              .sort((a, b) => (a.key < b.key ? -1 : 1)),
          );
    const fixedVersions = new Set<string>();
    for (const row of activeAffected) {
      for (const interval of row.intervals as unknown as Interval[]) {
        const fixed = interval.fixed ?? interval.patched;
        if (fixed) fixedVersions.add(`${row.package.ecosystem}|${row.package.name}|${fixed}`);
      }
    }
    const patchStatus = fixedVersions.size > 0 ? 'AVAILABLE' : 'UNCONFIRMED';
    const fixedHash = stableHash([...fixedVersions].sort());

    const products = await tx.vulnerabilityProduct.findMany({ where: { vulnerabilityId }, select: { vendor: true, product: true } });
    const packages = activeAffected.map((row) => row.package);
    const tags = computeTechnologyTags({ packages, products }, tagMappings);
    await tx.vulnerabilityTechnology.deleteMany({ where: { vulnerabilityId } });
    for (const [technologyId, basis] of tags) {
      await tx.vulnerabilityTechnology.create({ data: { vulnerabilityId, technologyId, basis } });
    }

    const identifiers = await tx.vulnerabilityIdentifier.findMany({ where: { vulnerabilityId }, select: { type: true, value: true } });
    const cves = identifiers.filter((id) => id.type === 'CVE').map((id) => id.value);
    const kev = cves.length ? await tx.kevEntry.findFirst({ where: { cve: { in: cves } }, orderBy: { dateAdded: 'asc' } }) : null;

    const title = preferred.find((source) => source.title)?.title || identifiers[0]?.value || vulnerabilityId;
    const searchText = [
      ...identifiers.map((id) => id.value),
      ...new Set(packages.map((pkg) => pkg.name)),
      ...new Set(products.map((p) => `${p.vendor} ${p.product}`)),
      title,
    ]
      .join(' ')
      .toLowerCase();
    const meaningfulHash = stableHash({ rangeHash, withdrawn, severity, kev: kev?.cve ?? null, patchStatus });

    await tx.vulnerability.update({
      where: { id: vulnerabilityId },
      data: {
        title: truncate(title, 500),
        publishedAt,
        modifiedAt,
        withdrawnAt,
        severity,
        severityRank: SEVERITY_RANK[severity],
        cvssScore: best?.score ?? null,
        cvssVersion: best?.version ?? null,
        cvssVector: best?.vector ?? null,
        cvssSource: best?.source ?? null,
        kevAddedAt: kev?.dateAdded ?? null,
        kevDueDate: kev?.dueDate ?? null,
        kevRansomware: kev?.ransomwareUse ?? null,
        patchStatus,
        classified: tags.size > 0,
        searchText,
        rangeHash,
        meaningfulHash,
      },
    });

    return {
      rangeHash,
      patchStatus,
      withdrawn,
      meaningfulHash,
      tagIds: new Set(tags.keys()),
      hasNpmPackage: packages.some((pkg) => pkg.ecosystem === 'npm'),
      publishedAt,
      fixedHash,
    };
  }

  /**
   * 두 취약점이 명시적 alias 로 같은 것으로 확인되었을 때 하나로 합친다.
   * 출처 레코드는 각자의 식별자를 그대로 유지하고, 병합 사실은 VulnerabilityMerge 에 남긴다.
   */
  private async merge(tx: Db, survivorId: string, mergedId: string, reason: string): Promise<void> {
    await tx.vulnerabilityIdentifier.updateMany({ where: { vulnerabilityId: mergedId }, data: { vulnerabilityId: survivorId } });
    await tx.sourceRecord.updateMany({ where: { vulnerabilityId: mergedId }, data: { vulnerabilityId: survivorId } });
    await tx.affectedPackage.updateMany({ where: { vulnerabilityId: mergedId }, data: { vulnerabilityId: survivorId } });
    await tx.notificationEvent.updateMany({ where: { vulnerabilityId: mergedId }, data: { vulnerabilityId: survivorId } });

    for (const row of await tx.vulnerabilityCvss.findMany({ where: { vulnerabilityId: mergedId } })) {
      const clash = await tx.vulnerabilityCvss.findUnique({
        where: { vulnerabilityId_source_version: { vulnerabilityId: survivorId, source: row.source, version: row.version } },
      });
      if (clash) await tx.vulnerabilityCvss.delete({ where: { id: row.id } });
      else await tx.vulnerabilityCvss.update({ where: { id: row.id }, data: { vulnerabilityId: survivorId } });
    }
    for (const row of await tx.vulnerabilityProduct.findMany({ where: { vulnerabilityId: mergedId } })) {
      await tx.vulnerabilityProduct.upsert({
        where: { vulnerabilityId_vendor_product: { vulnerabilityId: survivorId, vendor: row.vendor, product: row.product } },
        update: {},
        create: { vulnerabilityId: survivorId, vendor: row.vendor, product: row.product },
      });
    }
    // 프로젝트별 분석 결과: 같은 (프로젝트, 패키지, 버전) 이 양쪽에 있으면 검토 이력을 살려 하나로 합친다.
    for (const finding of await tx.finding.findMany({ where: { vulnerabilityId: mergedId } })) {
      const clash = await tx.finding.findUnique({
        where: {
          projectId_vulnerabilityId_packageId_version: {
            projectId: finding.projectId,
            vulnerabilityId: survivorId,
            packageId: finding.packageId,
            version: finding.version,
          },
        },
      });
      if (clash) {
        // 남는 쪽이 아직 미검토면, 사라지는 쪽에서 정한 조치 상태(위험 수용 사유·기한, 조치 예정일)를 옮긴다.
        if (clash.remediationStatus === 'UNREVIEWED' && finding.remediationStatus !== 'UNREVIEWED') {
          await tx.finding.update({
            where: { id: clash.id },
            data: {
              remediationStatus: finding.remediationStatus,
              acceptReason: finding.acceptReason,
              reviewDueAt: finding.reviewDueAt,
              plannedFixAt: finding.plannedFixAt,
            },
          });
        }
        await tx.findingReview.updateMany({ where: { findingId: finding.id }, data: { findingId: clash.id } });
        await tx.findingStatusHistory.updateMany({ where: { findingId: finding.id }, data: { findingId: clash.id } });
        await tx.finding.delete({ where: { id: finding.id } });
      } else {
        await tx.finding.update({ where: { id: finding.id }, data: { vulnerabilityId: survivorId } });
      }
    }
    await tx.vulnerabilityMerge.create({ data: { survivorId, mergedId, reason } });
    await tx.vulnerability.delete({ where: { id: mergedId } });
    this.logger.log(`취약점 병합: ${mergedId} → ${survivorId} (${reason})`);
  }

  /** 카탈로그 매핑이 바뀌었을 때 전체 취약점의 기술 태그를 다시 계산한다. */
  async retagAll(): Promise<number> {
    const mappings = await this.catalog.mappings();
    let cursor: string | undefined;
    let count = 0;
    for (;;) {
      const batch = await this.prisma.vulnerability.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 200,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (batch.length === 0) break;
      await this.prisma.$transaction(
        async (tx) => {
          for (const row of batch) await this.recompute(tx, row.id, mappings);
        },
        { timeout: 120_000, maxWait: 30_000 },
      );
      count += batch.length;
      cursor = batch[batch.length - 1].id;
    }
    return count;
  }
}

function dedupeReferences(references: Array<{ url: string; type: string }>): Array<{ url: string; type: string }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; type: string }> = [];
  for (const reference of references) {
    if (typeof reference.url !== 'string' || !HTTP_URL.test(reference.url) || reference.url.length > 2000 || seen.has(reference.url)) continue;
    seen.add(reference.url);
    out.push({ url: reference.url, type: String(reference.type ?? 'WEB').slice(0, 30) });
    if (out.length >= MAX_REFERENCES) break;
  }
  return out;
}

function dedupeIdentifiers(raw: string[]): TypedIdentifier[] {
  const seen = new Map<string, TypedIdentifier>();
  for (const value of raw) {
    const normalized = normalizeIdentifier(value);
    if (normalized && !seen.has(normalized.value)) seen.set(normalized.value, normalized);
  }
  return [...seen.values()];
}
