import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { AppEnv } from '../config/env.js';
import { APP_ENV } from '../db/db.module.js';
import { PrismaService } from '../db/prisma.service.js';
import type { Interval } from '../domain/version-match.js';
import { BriefingAi, BriefingAiError, type BriefingAiInput } from './briefing-ai.js';
import type { BriefingDto, BriefingListDto, BriefingOverviewDto } from './briefing.dto.js';
import { PRIORITY_LABEL, SEVERITY_LABEL, type NotificationMessage } from './message.js';
import { describeSchedule, nextSlot, validateSchedule, zonedParts } from './schedule.js';

type Tone = NotificationMessage['tone'];

export interface BriefingItem {
  i: number;
  tag: string;
  tone: Tone;
  text: string;
  href: string;
  kev: boolean;
  affected: number;
}

export interface ProjectCount {
  name: string;
  count: number;
}

/** 저장되는 브리핑 내용. 화면과 메시지가 같은 내용을 쓴다. */
export interface BriefingContent {
  items: BriefingItem[];
  totalItems: number;
  kevCount: number;
  affectedProjects: number;
  patches: { confirmed: number; confirmedByProject: ProjectCount[]; reported: number; reportedByProject: ProjectCount[] };
  notices: Array<{ title: string; url: string }>;
  /** 이 브리핑에 넣은 취약점 (전체 신규 취약점 브리핑이 같은 항목을 다시 넣지 않게) */
  vulnerabilityIds?: string[];
}

const MAX_ITEMS = 50;
const PRIORITY_RANK: Record<string, number> = { URGENT: 5, HIGH: 4, NEEDS_CHECK: 3, MEDIUM: 2, LOW: 1 };
const SEVERITY_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };
const PRIORITY_TONE: Record<string, Tone> = { URGENT: 'urgent', HIGH: 'high', NEEDS_CHECK: 'high', MEDIUM: 'medium', LOW: 'low' };
const SEVERITY_TONE: Record<string, Tone> = { CRITICAL: 'urgent', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', UNKNOWN: 'info' };
const IDENTIFIER_ORDER: Record<string, number> = { CVE: 0, GHSA: 1, OSV: 2 };
const OPEN_STATUSES = ['UNREVIEWED', 'IN_REVIEW', 'PLANNED'];
const DAY_MS = 86_400_000;
/** 전체 신규 취약점: 처음 수집된 뒤 이 기간 안에 기준을 넘으면 넣는다 (심각도가 늦게 매겨지는 공지를 위해). */
const NEW_LOOKBACK_MS = 3 * DAY_MS;
/** 오래전에 공개된 공지를 새로 수집한 것은 신규로 보지 않는다. */
const NEW_PUBLISHED_MS = 30 * DAY_MS;
const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

type NewRule = { id: string; createdAt: Date; eventTypes: Prisma.JsonValue; minSeverity: string | null };

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** 시큐리티 허브 방식의 제목: 아침(밤사이 발생분), 오후(오늘 발생분), 주말 */
export function briefingTitle(slotAt: Date, fromAt: Date, timeZone: string): { title: string; scope: string } {
  const slot = zonedParts(slotAt, timeZone);
  if (slot.weekday >= 6) return { title: '주말 보안 브리핑', scope: '이번 주말' };
  const period = slot.hour < 6 ? '새벽' : slot.hour < 12 ? '아침' : slot.hour < 18 ? '오후' : '저녁';
  const from = zonedParts(fromAt, timeZone);
  const sameDay = from.year === slot.year && from.month === slot.month && from.day === slot.day;
  if (sameDay) return { title: `${period} 보안 브리핑(오늘 발생분)`, scope: '오늘' };
  if (slot.hour < 12) return { title: `${period} 보안 브리핑(밤사이 발생분)`, scope: '밤사이' };
  return { title: `${period} 보안 브리핑(지난 브리핑 이후)`, scope: '지난 브리핑 이후' };
}

const byProject = (rows: Array<{ project: { name: string } }>): ProjectCount[] => {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.project.name, (counts.get(row.project.name) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
};

export const describeProjectCounts = (list: ProjectCount[]) =>
  `${list
    .slice(0, 5)
    .map((p) => `${p.name} ${p.count}건`)
    .join(', ')}${list.length > 5 ? ` 외 ${list.length - 5}곳` : ''}`;

@Injectable()
export class BriefingService {
  private readonly logger = new Logger(BriefingService.name);
  private readonly ai: BriefingAi | null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {
    this.ai = env.briefingAi ? new BriefingAi(env.briefingAi.apiKey, env.briefingAi.model) : null;
  }

  /**
   * 예정 시각의 브리핑을 만들고 채널별 발송 건을 만든다 (작업 처리기).
   * 같은 규칙·시각으로 다시 불려도 브리핑과 발송 건은 한 번만 만든다.
   */
  async build(ruleId: string, slotAt: Date, fromAt: Date): Promise<void> {
    const rule = await this.prisma.subscriptionRule.findUnique({
      where: { id: ruleId },
      include: { channels: { include: { channel: { select: { id: true, status: true, lastError: true } } } } },
    });
    if (!rule) return;
    const from = new Date(Math.max(fromAt.getTime(), slotAt.getTime() - 8 * DAY_MS));
    const briefing =
      (await this.prisma.briefing.findUnique({ where: { ruleId_slotAt: { ruleId, slotAt } } })) ??
      (await this.prisma.briefing.create({ data: { userId: rule.userId, ruleId, ruleName: rule.name, slotAt, fromAt: from } }));

    if (briefing.status !== 'READY') {
      // 기다리던 알림을 이 브리핑으로 모은다.
      await this.prisma.notificationDelivery.updateMany({
        where: { ruleId, status: 'DIGEST_PENDING' },
        data: { status: 'DIGESTED', briefingId: briefing.id },
      });
      const timeZone = (await this.prisma.userSettings.findUnique({ where: { userId: rule.userId }, select: { timezone: true } }))?.timezone ?? 'Asia/Seoul';
      const composed = await this.compose(briefing.id, rule, from, slotAt, timeZone);
      let { headline, summary } = composed;
      let aiModel: string | null = null;
      let aiError: string | null = null;
      if (this.ai) {
        try {
          const refined = await this.ai.refine(composed.aiInput);
          headline = refined.headline;
          summary = refined.summary;
          for (const item of composed.content.items) item.text = refined.items.get(item.i) ?? item.text;
          aiModel = this.ai.model;
        } catch (error) {
          aiError = error instanceof BriefingAiError ? error.message : 'AI 요약 실패';
          this.logger.warn(`브리핑 ${briefing.id} AI 요약 실패, 정해진 틀로 보냄: ${aiError}`);
        }
      }
      await this.prisma.briefing.update({
        where: { id: briefing.id },
        data: {
          status: 'READY',
          title: composed.title,
          headline,
          summary,
          tone: composed.tone,
          content: composed.content as unknown as Prisma.InputJsonValue,
          aiModel,
          aiError,
        },
      });
    }

    const ready = await this.prisma.briefing.findUniqueOrThrow({ where: { id: briefing.id }, select: { title: true, headline: true } });
    for (const link of rule.channels) {
      if (link.channel.status === 'PAUSED') continue;
      const dedupeKey = `briefing:${briefing.id}:${link.channelId}`;
      if (await this.prisma.notificationDelivery.findUnique({ where: { dedupeKey }, select: { id: true } })) continue;
      const base = { userId: rule.userId, ruleId, channelId: link.channelId, kind: 'DIGEST', dedupeKey, briefingId: briefing.id, title: `${ready.title} - ${ready.headline}`.slice(0, 300) };
      await this.prisma.notificationDelivery.create({
        data:
          link.channel.status === 'ERROR'
            ? { ...base, status: 'FAILED', lastError: '채널 연결이 끊긴 상태입니다. 알림 설정에서 다시 연결해 주세요.' }
            : { ...base, status: 'PENDING' },
      });
    }
  }

  /**
   * 전체 신규 취약점 브리핑에 넣을 취약점: 기준 심각도 이상으로 새로 들어온 공지와 KEV 에 새로 오른 공지 중
   * 이 규칙의 지난 브리핑에 아직 넣지 않은 것. 심각도 미제공은 점수가 매겨진 뒤의 브리핑에 넣는다.
   */
  private async newVulnerabilityIds(rule: NewRule, slotAt: Date): Promise<string[]> {
    const since = new Date(Math.max(rule.createdAt.getTime(), slotAt.getTime() - NEW_LOOKBACK_MS));
    const types = Array.isArray(rule.eventTypes) ? (rule.eventTypes as string[]) : [];
    const severities = SEVERITY_ORDER.slice(0, SEVERITY_ORDER.indexOf((rule.minSeverity ?? 'CRITICAL') as (typeof SEVERITY_ORDER)[number]) + 1);
    const conditions: Prisma.VulnerabilityWhereInput[] = [
      ...(types.includes('TECH_NEW_VULN') ? [{ createdAt: { gt: since, lte: slotAt }, publishedAt: { gt: new Date(slotAt.getTime() - NEW_PUBLISHED_MS) }, severity: { in: [...severities] } }] : []),
      ...(types.includes('KEV_ADDED') ? [{ kevAddedAt: { gt: since, lte: slotAt } }] : []),
    ];
    if (conditions.length === 0) return [];
    const [rows, earlier] = await Promise.all([
      this.prisma.vulnerability.findMany({ where: { withdrawnAt: null, OR: conditions }, select: { id: true } }),
      this.prisma.briefing.findMany({ where: { ruleId: rule.id, status: 'READY', slotAt: { gt: since, lt: slotAt } }, select: { content: true } }),
    ]);
    const covered = new Set(earlier.flatMap((row) => ((row.content ?? {}) as unknown as Partial<BriefingContent>).vulnerabilityIds ?? []));
    return rows.map((row) => row.id).filter((id) => !covered.has(id));
  }

  /** 모인 알림과 현재 상태로 브리핑 내용을 만든다 (정해진 틀). */
  private async compose(briefingId: number, rule: NewRule & { userId: string; kind: string; projectIds: Prisma.JsonValue }, from: Date, slotAt: Date, timeZone: string) {
    const scoped = Array.isArray(rule.projectIds) ? (rule.projectIds as string[]) : [];
    const projectWhere: Prisma.ProjectWhereInput = { userId: rule.userId, ...(rule.kind === 'PROJECT_IMPACT' && scoped.length > 0 ? { id: { in: scoped } } : {}) };

    const collected = await this.prisma.notificationDelivery.findMany({
      where: { briefingId, kind: 'EVENT' },
      select: { title: true, event: { select: { vulnerabilityId: true } } },
    });
    const vulnerabilityIds =
      rule.kind === 'ALL_NEW'
        ? await this.newVulnerabilityIds(rule, slotAt)
        : [...new Set(collected.map((row) => row.event?.vulnerabilityId).filter((id): id is string => !!id))];
    const otherTitles = [...new Set(collected.filter((row) => !row.event?.vulnerabilityId).map((row) => row.title))];
    const [vulnerabilities, findings, patched, reported, notices] = await Promise.all([
      this.prisma.vulnerability.findMany({
        where: { id: { in: vulnerabilityIds }, withdrawnAt: null },
        orderBy: { cvssScore: 'desc' },
        select: {
          id: true,
          title: true,
          severity: true,
          kevAddedAt: true,
          identifiers: { select: { type: true, value: true } },
          affected: { select: { intervals: true, package: { select: { name: true } } } },
          sources: { where: { withdrawn: false }, select: { details: true } },
        },
      }),
      this.prisma.finding.findMany({
        where: { vulnerabilityId: { in: vulnerabilityIds }, resolvedAt: null, versionMatch: 'AFFECTED', project: projectWhere },
        select: { id: true, vulnerabilityId: true, priority: true, remediationStatus: true, fixedVersion: true, projectId: true, project: { select: { name: true } } },
      }),
      this.prisma.finding.findMany({
        where: { resolution: 'NOT_IN_CURRENT_SNAPSHOT', resolvedAt: { gt: from, lte: slotAt }, project: projectWhere },
        select: { project: { select: { name: true } } },
      }),
      this.prisma.finding.findMany({
        where: { remediationStatus: 'DONE', resolvedAt: null, versionMatch: 'AFFECTED', project: projectWhere },
        select: { project: { select: { name: true } } },
      }),
      this.prisma.publicNotice.findMany({ where: { firstSeenAt: { gt: from, lte: slotAt } }, orderBy: { publishedAt: 'desc' }, take: 5, select: { title: true, url: true } }),
    ]);

    const ranked = vulnerabilities
      .map((vulnerability) => {
        const hits = findings.filter((finding) => finding.vulnerabilityId === vulnerability.id);
        const projects = [...new Map(hits.map((hit) => [hit.projectId, hit.project.name])).values()];
        const best = hits.reduce<string | null>((top, hit) => ((PRIORITY_RANK[hit.priority] ?? 0) > (PRIORITY_RANK[top ?? ''] ?? 0) ? hit.priority : top), null);
        const kev = vulnerability.kevAddedAt !== null;
        const identifier = [...vulnerability.identifiers].sort((a, b) => (IDENTIFIER_ORDER[a.type] ?? 9) - (IDENTIFIER_ORDER[b.type] ?? 9))[0]?.value ?? null;
        const fixedVersions = [
          ...new Set([
            ...hits.map((hit) => hit.fixedVersion).filter((v): v is string => !!v),
            ...vulnerability.affected.flatMap((row) => ((row.intervals ?? []) as unknown as Interval[]).map((interval) => interval.fixed).filter((v): v is string => !!v)),
          ]),
        ].slice(0, 3);
        const action = projects.length === 0 ? '참고' : hits.some((hit) => OPEN_STATUSES.includes(hit.remediationStatus)) ? '조치 필요' : '처리 중';
        const impact = projects.length === 0 ? '영향 자산 없음' : `영향 프로젝트 ${projects.length}곳(${projects.slice(0, 3).join(', ')}${projects.length > 3 ? ' 외' : ''})`;
        const name = truncate([identifier, vulnerability.title].filter(Boolean).join(' '), 90);
        const parts = [name, ...(kev ? ['실제 악용(KEV)'] : []), ...(fixedVersions.length > 0 ? [`${fixedVersions.join('/')}에서 수정`] : []), impact, ...(projects.length > 0 ? [action] : [])];
        return {
          vulnerability,
          identifier,
          projects,
          kev,
          fixedVersions,
          action,
          critical: vulnerability.severity === 'CRITICAL',
          tag: best ? PRIORITY_LABEL[best] : kev ? '긴급' : SEVERITY_LABEL[vulnerability.severity],
          tone: best ? PRIORITY_TONE[best] : kev ? 'urgent' : SEVERITY_TONE[vulnerability.severity],
          href: hits[0] ? `/findings/${hits[0].id}` : `/vulnerabilities/${vulnerability.id}`,
          text: parts.join(', '),
          rank: (kev ? 100 : 0) + (projects.length > 0 ? 50 : 0) + (best ? (PRIORITY_RANK[best] ?? 0) * 5 : 0) + (SEVERITY_RANK[vulnerability.severity] ?? 0),
        };
      })
      .sort((a, b) => b.rank - a.rank);

    const items: BriefingItem[] = [
      ...ranked.map((row) => ({ tag: row.tag, tone: row.tone as Tone, text: row.text, href: row.href, kev: row.kev, affected: row.projects.length })),
      ...otherTitles.map((title) => ({ tag: '분석', tone: 'info' as Tone, text: truncate(title, 120), href: '/projects', kev: false, affected: 0 })),
    ]
      .slice(0, MAX_ITEMS)
      .map((item, i) => ({ i, ...item }));
    const totalItems = ranked.length + otherTitles.length;
    const kevCount = ranked.filter((row) => row.kev).length;
    const affectedProjects = new Set(findings.map((finding) => finding.projectId)).size;
    const allCritical = ranked.length > 0 && otherTitles.length === 0 && ranked.every((row) => row.critical);

    const { title, scope } = briefingTitle(slotAt, from, timeZone);
    const headline =
      totalItems > 0
        ? `${scope} ${allCritical ? '치명 ' : ''}이슈 ${totalItems}건${kevCount > 0 ? `(KEV ${kevCount}건)` : ''}, ${affectedProjects > 0 ? `우리 프로젝트 ${affectedProjects}곳 영향` : '우리 자산 영향은 없습니다'}`
        : patched.length > 0
          ? `새 이슈 없음, 패치 ${patched.length}건 확인`
          : '새 이슈 없음';
    const sentences =
      totalItems > 0
        ? [
            `${scope} ${allCritical ? '치명 등급 ' : '새 '}이슈 ${totalItems}건이 들어왔습니다.`,
            kevCount > 0 ? `KEV(실제 악용) 등재 이슈가 ${kevCount}건 있습니다.` : 'KEV 등재 이슈는 없습니다.',
            affectedProjects > 0 ? `등록된 프로젝트 ${affectedProjects}곳에서 영향이 확인되었습니다.` : '등록된 자산 중 영향이 확인된 곳은 없습니다.',
          ]
        : [`${scope} 새 이슈가 없습니다.`];
    sentences.push(`지난 브리핑 이후 점검에서 패치 ${patched.length}건을 확인했습니다.`);
    if (reported.length > 0) sentences.push(`조치 보고 ${reported.length}건은 다음 점검에서 버전을 확인합니다.`);

    const content: BriefingContent = {
      items,
      totalItems,
      kevCount,
      affectedProjects,
      patches: { confirmed: patched.length, confirmedByProject: byProject(patched), reported: reported.length, reportedByProject: byProject(reported) },
      notices,
      vulnerabilityIds: ranked.map((row) => row.vulnerability.id),
    };
    const aiInput: BriefingAiInput = {
      title,
      counts: { items: totalItems, kev: kevCount, affectedProjects, patchesConfirmed: patched.length, reported: reported.length },
      items: ranked.slice(0, MAX_ITEMS).map((row, i) => ({
        i,
        identifier: row.identifier,
        title: truncate(row.vulnerability.title, 200),
        description: truncate(
          (row.vulnerability.sources.map((source) => source.details).sort((a, b) => b.length - a.length)[0] ?? '').replace(/\s+/g, ' ').trim(),
          500,
        ),
        packages: [...new Set(row.vulnerability.affected.map((affected) => affected.package.name))].slice(0, 3),
        severity: row.vulnerability.severity,
        kev: row.kev,
        fixedVersions: row.fixedVersions,
        affectedProjects: row.projects,
        action: row.action,
      })),
      notices: notices.map((notice) => notice.title),
    };
    const tone: Tone = ranked.some((row) => row.kev || row.tone === 'urgent') && affectedProjects > 0 ? 'urgent' : kevCount > 0 || affectedProjects > 0 ? 'high' : 'info';
    return { title, headline, summary: sentences.join(' '), tone, content, aiInput };
  }

  // - 화면 -

  async list(userId: string, cursor?: number, limit = 20): Promise<BriefingListDto> {
    const rows = await this.prisma.briefing.findMany({
      where: { userId, status: 'READY', ...(cursor ? { id: { lt: cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: limit + 1,
      include: { deliveries: { where: { kind: 'DIGEST' }, select: { status: true, channel: { select: { name: true, type: true } } } } },
    });
    const items = rows.slice(0, limit).map((row) => this.toDto(row));
    return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
  }

  async get(userId: string, id: number): Promise<BriefingDto> {
    const row = await this.prisma.briefing.findFirst({
      where: { id, userId, status: 'READY' },
      include: { deliveries: { where: { kind: 'DIGEST' }, select: { status: true, channel: { select: { name: true, type: true } } } } },
    });
    if (!row) throw new NotFoundException('브리핑을 찾을 수 없습니다.');
    return this.toDto(row);
  }

  async overview(userId: string): Promise<BriefingOverviewDto> {
    const [rules, settings] = await Promise.all([
      this.prisma.subscriptionRule.findMany({
        where: { userId, enabled: true, digestFormat: 'BRIEFING' },
        select: { id: true, name: true, schedule: true, channels: { select: { channelId: true, channel: { select: { name: true } } } } },
      }),
      this.prisma.userSettings.findUnique({ where: { userId }, select: { timezone: true } }),
    ]);
    const timeZone = settings?.timezone ?? 'Asia/Seoul';
    const now = new Date();
    let next: { at: Date; ruleName: string } | null = null;
    const schedules: BriefingOverviewDto['schedules'] = [];
    for (const rule of rules) {
      let schedule;
      try {
        schedule = validateSchedule(rule.schedule);
      } catch {
        continue;
      }
      schedules.push({ ruleName: rule.name, text: describeSchedule(schedule) });
      const at = nextSlot(now, schedule, timeZone);
      if (at && (!next || at < next.at)) next = { at, ruleName: rule.name };
    }
    const pending = await this.prisma.notificationDelivery.groupBy({
      by: ['channelId'],
      where: { userId, status: 'DIGEST_PENDING', ruleId: { in: rules.map((rule) => rule.id) } },
      _count: { _all: true },
    });
    const channelNames = new Map(rules.flatMap((rule) => rule.channels.map((link) => [link.channelId, link.channel.name] as const)));
    return {
      ruleCount: rules.length,
      nextSendAt: next?.at.toISOString() ?? null,
      nextRuleName: next?.ruleName ?? null,
      schedules,
      pending: [...channelNames].map(([channelId, name]) => ({ channelName: name, count: pending.find((row) => row.channelId === channelId)?._count._all ?? 0 })),
      ai: { enabled: this.ai !== null, model: this.ai?.model ?? null },
    };
  }

  /** 오래된 브리핑 정리 */
  async purge(olderThan: Date): Promise<number> {
    return (await this.prisma.briefing.deleteMany({ where: { createdAt: { lt: olderThan } } })).count;
  }

  private toDto(row: Prisma.BriefingGetPayload<{ include: { deliveries: { select: { status: true; channel: { select: { name: true; type: true } } } } } }>): BriefingDto {
    const content = (row.content ?? {}) as unknown as Partial<BriefingContent>;
    return {
      id: row.id,
      title: row.title,
      ruleName: row.ruleName,
      slotAt: row.slotAt.toISOString(),
      fromAt: row.fromAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      headline: row.headline,
      summary: row.summary,
      tone: row.tone as BriefingDto['tone'],
      aiModel: row.aiModel,
      aiError: row.aiError,
      items: (content.items ?? []).map((item) => ({ tag: item.tag, tone: item.tone, text: item.text, href: item.href, kev: item.kev, affected: item.affected })),
      totalItems: content.totalItems ?? 0,
      patches: content.patches ?? { confirmed: 0, confirmedByProject: [], reported: 0, reportedByProject: [] },
      notices: content.notices ?? [],
      channels: row.deliveries.map((delivery) => ({ name: delivery.channel.name, type: delivery.channel.type, status: delivery.status })),
    };
  }
}
