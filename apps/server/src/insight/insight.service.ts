import { BadRequestException, Injectable } from '@nestjs/common';
import semver from 'semver';
import { PrismaService } from '../db/prisma.service.js';
import { PRIORITY_RANK } from '../domain/priority.js';
import { VulnerabilityService } from '../vulnerability/vulnerability.service.js';
import type { CalendarDto, CalendarEventDto, CalendarQueryDto, PackageRemediationDto, PackageRemediationListDto, PublicNoticeDto } from './insight.dto.js';

type PriorityLevel = keyof typeof PRIORITY_RANK;
const DAY_MS = 86_400_000;
const MAX_EVENTS = 1500;
const TONE_ORDER: Record<CalendarEventDto['tone'], number> = { URGENT: 0, KEV: 1, NOTICE: 2, HIGH: 3, PLAN: 4, REVIEW: 5, NORMAL: 6 };

/** 시각 → 사용자 시간대의 날짜 */
function localDate(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}
/** 날짜만 있는 값(KEV 등재일·조치 기한)은 저장된 날짜 그대로 쓴다 */
const dateOnly = (value: Date) => value.toISOString().slice(0, 10);
const MAX_FINDINGS = 5000;
const MAX_PACKAGE_FINDINGS = 20_000;
const MAX_KEV = 500;
const MAX_NOTICES = 300;

@Injectable()
export class InsightService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vulnerabilities: VulnerabilityService,
  ) {}

  /** 영향 버전 일치 항목을 (패키지, 설치 버전)으로 묶어 "무엇을 올리면 몇 건이 해소되는지" 보여준다. */
  async packages(userId: string, projectId?: string): Promise<PackageRemediationListDto> {
    const rows = await this.prisma.finding.findMany({
      where: { project: { userId, ...(projectId ? { id: projectId } : {}) }, resolvedAt: null, versionMatch: 'AFFECTED' },
      select: {
        id: true,
        version: true,
        fixedVersion: true,
        priority: true,
        package: { select: { name: true } },
        project: { select: { id: true, name: true } },
        vulnerability: { select: { id: true, title: true, kevAddedAt: true } },
      },
      orderBy: [{ priorityRank: 'desc' }, { id: 'asc' }],
      take: MAX_PACKAGE_FINDINGS + 1,
    });
    const truncated = rows.length > MAX_PACKAGE_FINDINGS;
    if (truncated) rows.length = MAX_PACKAGE_FINDINGS;
    const groups = new Map<string, PackageRemediationDto>();
    for (const row of rows) {
      const key = `${row.package.name}@${row.version}`;
      const group =
        groups.get(key) ??
        ({ packageName: row.package.name, installedVersion: row.version, targetVersion: null, findingCount: 0, withoutFixCount: 0, projects: [], topPriority: 'LOW', hasKev: false, findings: [] } as PackageRemediationDto);
      groups.set(key, group);
      group.findingCount += 1;
      const fixed = row.fixedVersion && semver.valid(row.fixedVersion) ? row.fixedVersion : null;
      if (!fixed) group.withoutFixCount += 1;
      else if (!group.targetVersion || semver.gt(fixed, group.targetVersion)) group.targetVersion = fixed;
      if (!group.projects.some((p) => p.id === row.project.id)) group.projects.push(row.project);
      if (PRIORITY_RANK[row.priority as PriorityLevel] > PRIORITY_RANK[group.topPriority]) group.topPriority = row.priority as PriorityLevel;
      const kev = row.vulnerability.kevAddedAt !== null;
      group.hasKev ||= kev;
      group.findings.push({
        findingId: row.id,
        vulnerabilityId: row.vulnerability.id,
        title: row.vulnerability.title,
        projectId: row.project.id,
        projectName: row.project.name,
        priority: row.priority as PriorityLevel,
        fixedVersion: row.fixedVersion,
        kev,
      });
    }
    const items = [...groups.values()].sort(
      (a, b) => PRIORITY_RANK[b.topPriority] - PRIORITY_RANK[a.topPriority] || Number(b.hasKev) - Number(a.hasKev) || b.findingCount - a.findingCount,
    );
    return { items, truncated };
  }

  async notices(limit: number): Promise<PublicNoticeDto[]> {
    const rows = await this.prisma.publicNotice.findMany({ orderBy: [{ publishedAt: 'desc' }, { firstSeenAt: 'desc' }], take: Math.min(Math.max(limit, 1), 50) });
    // 게시 날짜는 한국 날짜로 기록된 값이다. 브라우저 시간대와 무관하게 같은 날짜를 보여준다.
    return rows.map((row) => ({ id: row.id, source: row.source, title: row.title, url: row.url, publishedAt: row.publishedAt.toISOString(), publishedDate: localDate(row.publishedAt, 'Asia/Seoul') }));
  }

  async calendar(userId: string, query: CalendarQueryDto): Promise<CalendarDto> {
    const from = new Date(`${query.from}T00:00:00Z`);
    const to = new Date(`${query.to}T00:00:00Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from || to.getTime() - from.getTime() > 62 * DAY_MS) {
      throw new BadRequestException('기간은 62일 이내로 지정해 주세요.');
    }
    // 시간대 차이를 감안해 앞뒤로 하루씩 넓게 읽고, 날짜로 바꾼 뒤 다시 거른다.
    const window = { gte: new Date(from.getTime() - DAY_MS), lt: new Date(to.getTime() + 2 * DAY_MS) };
    const settings = await this.prisma.userSettings.findUnique({ where: { userId } });
    const timeZone = settings?.timezone || 'Asia/Seoul';
    const events: CalendarEventDto[] = [];
    let needsInterests = false;
    let truncated = false;
    /** 상한보다 하나 더 읽어 잘렸는지 알아낸다 */
    const cap = <T>(rows: T[], limit: number): T[] => {
      if (rows.length > limit) {
        truncated = true;
        return rows.slice(0, limit);
      }
      return rows;
    };
    const severityTone = (severity: string): CalendarEventDto['tone'] => (severity === 'CRITICAL' ? 'URGENT' : severity === 'HIGH' ? 'HIGH' : 'NORMAL');

    if (query.view === 'PROJECT') {
      const findings = cap(await this.prisma.finding.findMany({
        where: {
          project: { userId },
          resolvedAt: null,
          versionMatch: { in: ['AFFECTED', 'UNKNOWN'] },
          OR: [{ vulnerability: { publishedAt: window } }, { vulnerability: { kevDueDate: window } }, { reviewDueAt: window }, { plannedFixAt: window }],
        },
        select: {
          id: true,
          version: true,
          fixedVersion: true,
          priority: true,
          remediationStatus: true,
          reviewDueAt: true,
          plannedFixAt: true,
          package: { select: { name: true } },
          project: { select: { name: true } },
          vulnerability: { select: { id: true, title: true, publishedAt: true, kevDueDate: true } },
        },
        orderBy: [{ priorityRank: 'desc' }, { id: 'asc' }],
        take: MAX_FINDINGS + 1,
      }), MAX_FINDINGS);
      const byVuln = new Map<string, typeof findings>();
      for (const finding of findings) byVuln.set(finding.vulnerability.id, [...(byVuln.get(finding.vulnerability.id) ?? []), finding]);
      for (const [vulnId, group] of byVuln) {
        const vuln = group[0].vulnerability;
        const top = group.reduce((best, f) => (PRIORITY_RANK[f.priority as PriorityLevel] > PRIORITY_RANK[best.priority as PriorityLevel] ? f : best));
        const packages = [...new Set(group.map((f) => f.package.name))].join(', ');
        const projects = [...new Set(group.map((f) => f.project.name))];
        const href = group.length === 1 ? `/findings/${group[0].id}` : `/vulnerabilities/${vulnId}`;
        const detail = `${projects.slice(0, 3).join(', ')}${projects.length > 3 ? ` 외 ${projects.length - 3}개` : ''}`;
        if (vuln.publishedAt) {
          events.push({ id: `pub:${vulnId}`, date: localDate(vuln.publishedAt, timeZone), kind: 'PUBLISHED', tone: top.priority === 'URGENT' ? 'URGENT' : top.priority === 'HIGH' ? 'HIGH' : 'NORMAL', title: `${packages}: ${vuln.title}`, detail, href, external: false });
        }
        if (vuln.kevDueDate) {
          events.push({ id: `kev:${vulnId}`, date: dateOnly(vuln.kevDueDate), kind: 'KEV_DUE', tone: 'KEV', title: `KEV 기한: ${vuln.title}`, detail, href, external: false });
        }
      }
      for (const finding of findings) {
        const target = `${finding.package.name}@${finding.version}`;
        if (finding.remediationStatus === 'RISK_ACCEPTED' && finding.reviewDueAt) {
          // 재검토 기한·조치 예정일은 사용자가 고른 날짜(그 시간대 기준)로 저장된 시각이다.
          events.push({ id: `review:${finding.id}`, date: localDate(finding.reviewDueAt, timeZone), kind: 'REVIEW_DUE', tone: 'REVIEW', title: `재검토: ${target}`, detail: `${finding.project.name} · ${finding.vulnerability.title}`, href: `/findings/${finding.id}`, external: false });
        }
        if (finding.remediationStatus === 'PLANNED' && finding.plannedFixAt) {
          events.push({ id: `plan:${finding.id}`, date: localDate(finding.plannedFixAt, timeZone), kind: 'PLANNED_FIX', tone: 'PLAN', title: `조치 예정: ${target}${finding.fixedVersion ? ` → ${finding.fixedVersion}` : ''}`, detail: `${finding.project.name} · ${finding.vulnerability.title}`, href: `/findings/${finding.id}`, external: false });
        }
      }
    } else {
      const interests = await this.prisma.userTechnologyInterest.findMany({ where: { userId }, select: { technologyId: true } });
      const interestWhere = interests.length
        ? await this.vulnerabilities.buildWhere(userId, {
            technologyIds: interests.map((i) => i.technologyId),
            groupMode: settings?.interestMatchMode === 'ANY_GROUP' ? 'ANY_GROUP' : 'ALL_GROUPS',
          })
        : null;
      needsInterests = query.view === 'INTEREST' && !interestWhere;
      // 관심 기술 보기: 관심 기술의 공지 전체 / 중요 이슈 보기: 관심 기술의 치명적 공지만 (없으면 건너뜀)
      const where = interestWhere
        ? { AND: [interestWhere, { publishedAt: window }, ...(query.view === 'IMPORTANT' ? [{ severity: 'CRITICAL' as const }] : [])] }
        : null;
      if (where) {
        const vulns = cap(
          await this.prisma.vulnerability.findMany({
            where,
            select: { id: true, title: true, publishedAt: true, severity: true, kevAddedAt: true },
            orderBy: { publishedAt: 'desc' },
            take: MAX_EVENTS + 1,
          }),
          MAX_EVENTS,
        );
        for (const vuln of vulns) {
          if (!vuln.publishedAt) continue;
          events.push({ id: `pub:${vuln.id}`, date: localDate(vuln.publishedAt, timeZone), kind: 'PUBLISHED', tone: query.view === 'IMPORTANT' ? 'HIGH' : vuln.kevAddedAt ? 'URGENT' : severityTone(vuln.severity), title: vuln.title, detail: vuln.kevAddedAt ? 'KEV 등재' : null, href: `/vulnerabilities/${vuln.id}`, external: false });
        }
      }
      if (query.view === 'IMPORTANT') {
        const added = cap(await this.prisma.vulnerability.findMany({ where: { kevAddedAt: window }, select: { id: true, title: true, kevAddedAt: true }, orderBy: { kevAddedAt: 'desc' }, take: MAX_KEV + 1 }), MAX_KEV);
        for (const vuln of added) {
          events.push({ id: `kevadd:${vuln.id}`, date: dateOnly(vuln.kevAddedAt!), kind: 'KEV_ADDED', tone: 'URGENT', title: `KEV 등재: ${vuln.title}`, detail: '실제 악용이 확인되어 CISA KEV 에 등재됨', href: `/vulnerabilities/${vuln.id}`, external: false });
        }
        const due = cap(await this.prisma.vulnerability.findMany({ where: { kevDueDate: window }, select: { id: true, title: true, kevDueDate: true }, orderBy: { kevDueDate: 'asc' }, take: MAX_KEV + 1 }), MAX_KEV);
        for (const vuln of due) {
          events.push({ id: `kev:${vuln.id}`, date: dateOnly(vuln.kevDueDate!), kind: 'KEV_DUE', tone: 'KEV', title: `KEV 기한: ${vuln.title}`, detail: null, href: `/vulnerabilities/${vuln.id}`, external: false });
        }
        const notices = cap(await this.prisma.publicNotice.findMany({ where: { publishedAt: window }, orderBy: { publishedAt: 'desc' }, take: MAX_NOTICES + 1 }), MAX_NOTICES);
        for (const notice of notices) {
          events.push({ id: `notice:${notice.id}`, date: localDate(notice.publishedAt, 'Asia/Seoul'), kind: 'NOTICE', tone: 'NOTICE', title: notice.title, detail: 'KISA 보호나라 보안공지', href: notice.url, external: true });
        }
      }
    }

    const inRange = events
      .filter((event) => event.date >= query.from && event.date <= query.to)
      .sort((a, b) => a.date.localeCompare(b.date) || TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || a.title.localeCompare(b.title));
    return { from: query.from, to: query.to, view: query.view, events: inRange.slice(0, MAX_EVENTS), truncated: truncated || inRange.length > MAX_EVENTS, needsInterests };
  }
}
