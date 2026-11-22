import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service.js';
import { CATALOG } from './catalog.data.js';
import type { MappingKind, MappingRow } from './tagging.js';

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);
  private mappingCache: MappingRow[] | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** 코드에 정의된 카탈로그를 DB 에 반영한다. 매핑이 바뀌었으면 true 를 돌려준다. */
  async syncCatalog(): Promise<boolean> {
    let changed = false;
    for (const [index, entry] of CATALOG.entries()) {
      const data = {
        name: entry.name,
        group: entry.group,
        aliases: entry.aliases ?? [],
        scanSupport: entry.scanSupport ?? 'FEED_ONLY',
        sortOrder: index,
      } as const;
      const technology = await this.prisma.technology.upsert({
        where: { slug: entry.slug },
        update: data,
        create: { slug: entry.slug, ...data },
      });

      const desired: Array<{ kind: MappingKind; ecosystem: string | null; pattern: string | null }> = [
        ...(entry.ecosystems ?? []).map((ecosystem) => ({ kind: 'ECOSYSTEM' as const, ecosystem, pattern: null })),
        ...(entry.packages ?? []).map(([ecosystem, pattern]) => ({ kind: 'PACKAGE' as const, ecosystem, pattern })),
        ...(entry.cpes ?? []).map((pattern) => ({ kind: 'CPE' as const, ecosystem: null, pattern })),
      ];
      const key = (m: { kind: string; ecosystem: string | null; pattern: string | null }) =>
        `${m.kind}|${m.ecosystem ?? ''}|${m.pattern ?? ''}`;
      const existing = await this.prisma.technologyMapping.findMany({ where: { technologyId: technology.id } });
      const existingKeys = new Set(existing.map(key));
      const desiredKeys = new Set(desired.map(key));
      for (const mapping of desired) {
        if (existingKeys.has(key(mapping))) continue;
        await this.prisma.technologyMapping.create({ data: { technologyId: technology.id, ...mapping } });
        changed = true;
      }
      for (const mapping of existing) {
        if (desiredKeys.has(key(mapping))) continue;
        await this.prisma.technologyMapping.delete({ where: { id: mapping.id } });
        changed = true;
      }
    }
    const slugs = CATALOG.map((entry) => entry.slug);
    const removed = await this.prisma.technology.deleteMany({ where: { slug: { notIn: slugs } } });
    if (removed.count > 0) changed = true;
    this.mappingCache = null;
    if (changed) this.logger.log('기술 카탈로그 매핑이 변경되었습니다.');
    return changed;
  }

  async mappings(): Promise<MappingRow[]> {
    this.mappingCache ??= await this.prisma.technologyMapping.findMany({
      select: { technologyId: true, kind: true, ecosystem: true, pattern: true },
    });
    return this.mappingCache;
  }

  listTechnologies() {
    return this.prisma.technology.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  async getInterests(userId: string): Promise<string[]> {
    const rows = await this.prisma.userTechnologyInterest.findMany({ where: { userId }, select: { technologyId: true } });
    return rows.map((row) => row.technologyId);
  }

  async setInterests(userId: string, technologyIds: string[]): Promise<string[]> {
    const unique = [...new Set(technologyIds)];
    const known = await this.prisma.technology.count({ where: { id: { in: unique } } });
    if (known !== unique.length) throw new BadRequestException('알 수 없는 기술 항목이 포함되어 있습니다.');
    await this.prisma.$transaction([
      this.prisma.userTechnologyInterest.deleteMany({ where: { userId } }),
      ...unique.map((technologyId) => this.prisma.userTechnologyInterest.create({ data: { userId, technologyId } })),
    ]);
    return unique;
  }

  /**
   * 선택된 기술을 그룹별로 묶는다. 같은 그룹 안은 OR, 그룹 사이는 AND(기본) 로 쓰인다.
   */
  async groupByTechGroup(technologyIds: string[]): Promise<string[][]> {
    if (technologyIds.length === 0) return [];
    const rows = await this.prisma.technology.findMany({
      where: { id: { in: technologyIds } },
      select: { id: true, group: true },
    });
    const groups = new Map<string, string[]>();
    for (const row of rows) groups.set(row.group, [...(groups.get(row.group) ?? []), row.id]);
    return [...groups.values()];
  }
}
