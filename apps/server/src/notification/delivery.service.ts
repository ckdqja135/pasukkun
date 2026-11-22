import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomToken } from '../common/crypto.js';
import type { AppEnv } from '../config/env.js';
import { APP_ENV } from '../db/db.module.js';
import { PrismaService } from '../db/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ChannelService } from './channel.service.js';
import { MessageBuilder } from './message-builder.service.js';
import { EVENT_HEADINGS } from './message.js';
import type { DeliveryDto, DeliveryListDto, DeliveryQueryDto } from './notification.dto.js';
import { dedupeKey, matchesInterests, passesMinSeverity, quietUntil, retryDelayMs } from './rules.js';
import { describeSchedule, digestDue, validateSchedule, type DeliverySchedule } from './schedule.js';
import { renderTemplate } from './template.js';

const VULNERABILITY_EVENTS = new Set(['TECH_NEW_VULN', 'KEV_ADDED', 'PATCH_AVAILABLE', 'AFFECTED_RANGE_CHANGED']);
const SEND_LOCK_MS = 2 * 60_000;

const ruleInclude = {
  channels: { include: { channel: { select: { id: true, status: true } } } },
} satisfies Prisma.SubscriptionRuleInclude;
type RuleRow = Prisma.SubscriptionRuleGetPayload<{ include: typeof ruleInclude }>;

interface Target {
  rule: RuleRow;
  projectId: string | null;
}

/**
 * 알림 발송.
 * - relay: Outbox 이벤트를 구독 규칙과 대조해 발송 건(NotificationDelivery)으로 펼친다.
 * - processDue: 발송 건을 채널로 보낸다. 실패는 재시도하고 한도를 넘으면 최종 실패로 남긴다.
 * 외부 서비스 전송이므로 "정확히 한 번"은 보장하지 않는다. 최소 한 번 전달하되 중복을 억제한다.
 */
@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelService,
    private readonly messages: MessageBuilder,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  // - Outbox relay -

  async relayPending(limit = 50): Promise<number> {
    const events = await this.prisma.notificationEvent.findMany({ where: { relayedAt: null }, orderBy: { createdAt: 'asc' }, take: limit });
    for (const event of events) {
      try {
        await this.relayOne(event);
      } catch (error) {
        this.logger.warn(`이벤트 ${event.id} 중계 실패: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return events.length;
  }

  private async relayOne(event: Prisma.NotificationEventGetPayload<object>): Promise<void> {
    const targets: Target[] = [];
    let title = EVENT_HEADINGS[event.type] ?? event.type;
    const hasType = (rule: RuleRow) => ((rule.eventTypes ?? []) as string[]).includes(event.type);
    const coversProject = (rule: RuleRow, projectId: string) => {
      const ids = (rule.projectIds ?? []) as string[];
      return ids.length === 0 || ids.includes(projectId);
    };

    const vulnerability = event.vulnerabilityId
      ? await this.prisma.vulnerability.findUnique({
          where: { id: event.vulnerabilityId },
          select: { id: true, title: true, severity: true, withdrawnAt: true, technologies: { select: { technologyId: true } } },
        })
      : null;
    if (vulnerability) title = `${title}: ${vulnerability.title}`;

    if (VULNERABILITY_EVENTS.has(event.type)) {
      if (vulnerability && !vulnerability.withdrawnAt) {
        const techIds = new Set(vulnerability.technologies.map((row) => row.technologyId));
        // (A) 관심 기술 규칙 - 저장된 관심 기술과 일치할 때만
        const techRules = await this.prisma.subscriptionRule.findMany({ where: { kind: 'TECH_INTEREST', enabled: true }, include: ruleInclude });
        const interestCache = new Map<string, { groups: string[][]; mode: 'ALL_GROUPS' | 'ANY_GROUP' }>();
        for (const rule of techRules) {
          if (!hasType(rule) || !passesMinSeverity(vulnerability.severity, rule.minSeverity)) continue;
          let interests = interestCache.get(rule.userId);
          if (!interests) {
            const [rows, settings] = await Promise.all([
              this.prisma.userTechnologyInterest.findMany({ where: { userId: rule.userId }, select: { technology: { select: { id: true, group: true } } } }),
              this.prisma.userSettings.findUnique({ where: { userId: rule.userId }, select: { interestMatchMode: true } }),
            ]);
            const byGroup = new Map<string, string[]>();
            for (const row of rows) byGroup.set(row.technology.group, [...(byGroup.get(row.technology.group) ?? []), row.technology.id]);
            interests = { groups: [...byGroup.values()], mode: settings?.interestMatchMode ?? 'ALL_GROUPS' };
            interestCache.set(rule.userId, interests);
          }
          if (matchesInterests(techIds, interests.groups, interests.mode)) targets.push({ rule, projectId: null });
        }
        // (B) 프로젝트 영향 규칙 - 그 취약점에 영향 버전 일치가 있는 프로젝트마다
        const projectRules = await this.prisma.subscriptionRule.findMany({ where: { kind: 'PROJECT_IMPACT', enabled: true }, include: ruleInclude });
        for (const rule of projectRules) {
          if (!hasType(rule) || !passesMinSeverity(vulnerability.severity, rule.minSeverity)) continue;
          const matched = await this.prisma.finding.findMany({
            where: { vulnerabilityId: vulnerability.id, resolvedAt: null, versionMatch: 'AFFECTED', project: { userId: rule.userId } },
            select: { projectId: true },
            distinct: ['projectId'],
          });
          for (const row of matched) if (coversProject(rule, row.projectId)) targets.push({ rule, projectId: row.projectId });
        }
      }
    } else if (event.projectId) {
      const project = await this.prisma.project.findUnique({ where: { id: event.projectId }, select: { id: true, userId: true, name: true } });
      if (project) {
        if (!vulnerability) title = `${title}: ${project.name}`;
        const rules = await this.prisma.subscriptionRule.findMany({
          where: { userId: project.userId, kind: 'PROJECT_IMPACT', enabled: true },
          include: ruleInclude,
        });
        for (const rule of rules) {
          if (!hasType(rule) || !coversProject(rule, project.id)) continue;
          if (vulnerability && !passesMinSeverity(vulnerability.severity, rule.minSeverity)) continue;
          targets.push({ rule, projectId: project.id });
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      for (const target of targets) {
        for (const link of target.rule.channels) {
          // 일시 중지한 채널로는 발송 건을 만들지 않는다.
          if (link.channel.status === 'PAUSED') continue;
          const key = dedupeKey({
            userId: target.rule.userId,
            channelId: link.channelId,
            eventType: event.type,
            vulnerabilityId: event.vulnerabilityId,
            projectId: target.projectId,
            fingerprint: event.changeFingerprint,
          });
          const base = {
            eventId: event.id,
            userId: target.rule.userId,
            ruleId: target.rule.id,
            channelId: link.channelId,
            projectId: target.projectId,
            kind: 'EVENT',
            title: title.slice(0, 300),
          };
          const duplicate = await tx.notificationDelivery.findUnique({ where: { dedupeKey: key }, select: { eventId: true, ruleId: true } });
          if (duplicate) {
            // 같은 의미의 알림이 이미 있다 (재수집, 다른 출처, 겹치는 규칙). 보내지 않고 이력만 남긴다.
            if (duplicate.eventId !== event.id || duplicate.ruleId !== target.rule.id) {
              await tx.notificationDelivery.create({
                data: { ...base, dedupeKey: `${key}:dup:${randomToken(9)}`, status: 'SUPPRESSED', lastError: '같은 내용의 알림이 이미 발송 대상에 있어 억제됨' },
              });
            }
            continue;
          }
          await tx.notificationDelivery.create({
            data:
              link.channel.status === 'ERROR'
                ? { ...base, dedupeKey: key, status: 'FAILED', lastError: '채널 연결이 끊긴 상태입니다. 알림 설정에서 다시 연결해 주세요.' }
                : { ...base, dedupeKey: key, status: (target.rule.schedule as { type?: string } | null)?.type === 'IMMEDIATE' ? 'PENDING' : 'DIGEST_PENDING' },
          });
        }
      }
      await tx.notificationEvent.update({ where: { id: event.id }, data: { relayedAt: new Date() } });
    });
  }

  // - 전송 -

  /** 보낼 때가 된 발송 건을 처리한다. 채널당 한 번에 한 건만 보내 채널별 요청 제한을 지킨다. */
  async processDue(now = new Date(), limit = 50): Promise<number> {
    const due = await this.prisma.notificationDelivery.findMany({
      where: {
        OR: [
          { status: { in: ['PENDING', 'RETRYING', 'HELD'] }, nextAttemptAt: { lte: now } },
          // 전송 중 프로세스가 중단된 건: 잠금이 풀리면 다시 시도한다 (드물게 중복 전달될 수 있다).
          { status: 'SENDING', lockedUntil: { lt: now } },
        ],
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: limit,
    });
    const seen = new Set<string>();
    let processed = 0;
    for (const delivery of due) {
      if (seen.has(delivery.channelId)) continue;
      seen.add(delivery.channelId);
      try {
        await this.attempt(delivery, now);
        processed += 1;
      } catch (error) {
        this.logger.warn(`발송 ${delivery.id} 처리 중 오류: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return processed;
  }

  private async attempt(delivery: Prisma.NotificationDeliveryGetPayload<object>, now: Date): Promise<void> {
    const claimed = await this.prisma.notificationDelivery.updateMany({
      where: { id: delivery.id, status: delivery.status, attempts: delivery.attempts },
      data: { status: 'SENDING', lockedUntil: new Date(now.getTime() + SEND_LOCK_MS) },
    });
    if (claimed.count !== 1) return;
    const finish = (data: Prisma.NotificationDeliveryUpdateInput) =>
      this.prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { lockedUntil: null, ...data } });

    const channel = await this.prisma.notificationChannel.findUnique({ where: { id: delivery.channelId } });
    if (!channel || channel.status === 'PAUSED') {
      await finish({ status: 'CANCELLED', lastError: '채널이 일시 중지되었거나 삭제되어 취소됨' });
      return;
    }
    if (channel.status === 'ERROR') {
      await finish({ status: 'FAILED', lastError: `채널 연결이 끊겨 보내지 못했습니다: ${channel.lastError ?? '다시 연결해 주세요.'}` });
      return;
    }
    const message = await this.messages.build(delivery);
    if (!message) {
      await finish({ status: 'CANCELLED', lastError: '알릴 대상이 더 이상 유효하지 않아 취소됨 (공지 철회, 프로젝트 삭제, 이미 해소됨 등)' });
      return;
    }

    const settings = await this.prisma.userSettings.findUnique({ where: { userId: delivery.userId } });
    if (settings) {
      const until = quietUntil(now, {
        enabled: settings.quietHoursEnabled,
        startMinute: settings.quietStartMinute,
        endMinute: settings.quietEndMinute,
        timezone: settings.timezone,
      });
      const bypass = settings.urgentBypassQuiet && message.tone === 'urgent';
      if (until && !bypass) {
        await finish({ status: 'HELD', nextAttemptAt: until, lastError: '방해 금지 시간으로 보류됨' });
        return;
      }
    }

    // 규칙에 사용자 문구 틀이 있으면 그 틀로, 없으면 기본 형식으로 보낸다.
    const rule = delivery.kind === 'EVENT' && delivery.ruleId ? await this.prisma.subscriptionRule.findUnique({ where: { id: delivery.ruleId }, select: { template: true } }) : null;
    const result = await this.channels.send(channel, message, rule?.template && message.values ? renderTemplate(rule.template, message.values) : null);
    const attempts = delivery.attempts + 1;

    if (result.status === 'SENT') {
      await this.prisma.$transaction([
        this.prisma.notificationDelivery.update({
          where: { id: delivery.id },
          data: { status: 'SENT', attempts, sentAt: new Date(), lockedUntil: null, lastError: null, lastStatusCode: 200, providerMessageId: result.providerMessageId },
        }),
        this.prisma.notificationChannel.update({
          where: { id: channel.id },
          data: { lastSuccessAt: new Date(), lastError: null, lastErrorAt: null, status: 'ACTIVE' },
        }),
      ]);
      return;
    }
    if (result.status === 'RETRY') {
      if (attempts >= this.env.notifyMaxAttempts) {
        await finish({ status: 'FAILED', attempts, lastError: `재시도 한도(${this.env.notifyMaxAttempts}회) 초과: ${result.error}`, lastStatusCode: result.statusCode });
        return;
      }
      // 429 는 서버가 알려준 대기 시간을 따른다.
      const delay = result.retryAfterMs ?? retryDelayMs(attempts);
      await finish({ status: 'RETRYING', attempts, nextAttemptAt: new Date(Date.now() + delay), lastError: result.error, lastStatusCode: result.statusCode });
      return;
    }
    await finish({ status: 'FAILED', attempts, lastError: result.error, lastStatusCode: result.statusCode });
    if (result.channelBroken) {
      await this.prisma.notificationChannel.update({
        where: { id: channel.id },
        data: { status: 'ERROR', lastError: result.error, lastErrorAt: new Date() },
      });
    }
  }

  // - 일일 요약 -

  /**
   * 요약 규칙마다, 마지막 요약 뒤에 예정 시각(사용자 시간대)이 지났으면
   * 기다리던 알림을 채널별 요약 한 건으로 묶는다.
   */
  async createDueDigests(now = new Date()): Promise<number> {
    const waiting = await this.prisma.notificationDelivery.findMany({
      where: { status: 'DIGEST_PENDING' },
      select: { ruleId: true },
      distinct: ['ruleId'],
    });
    let created = 0;
    for (const { ruleId } of waiting) {
      if (!ruleId) continue;
      const rule = await this.prisma.subscriptionRule.findUnique({ where: { id: ruleId } });
      if (!rule) continue;
      const settings = await this.prisma.userSettings.upsert({ where: { userId: rule.userId }, update: {}, create: { userId: rule.userId } });
      let schedule: DeliverySchedule;
      try {
        schedule = validateSchedule(rule.schedule);
      } catch {
        continue;
      }
      const slot = digestDue(now, schedule, settings.timezone, rule.lastDigestAt ?? rule.createdAt);
      if (!slot) continue;
      await this.prisma.$transaction(async (tx) => {
        const pending = await tx.notificationDelivery.findMany({ where: { ruleId, status: 'DIGEST_PENDING' }, select: { id: true, channelId: true } });
        const byChannel = new Map<string, string[]>();
        for (const row of pending) byChannel.set(row.channelId, [...(byChannel.get(row.channelId) ?? []), row.id]);
        for (const [channelId, ids] of byChannel) {
          const key = `digest:${ruleId}:${channelId}:${slot.toISOString()}`;
          const digest =
            (await tx.notificationDelivery.findUnique({ where: { dedupeKey: key }, select: { id: true } })) ??
            (await tx.notificationDelivery.create({
              data: {
                userId: rule.userId,
                ruleId,
                channelId,
                kind: 'DIGEST',
                dedupeKey: key,
                status: 'PENDING',
                title: `${rule.name} 요약 (${ids.length}건, ${describeSchedule(schedule)})`.slice(0, 300),
              },
              select: { id: true },
            }));
          await tx.notificationDelivery.updateMany({ where: { id: { in: ids } }, data: { status: 'DIGESTED', digestId: digest.id } });
          created += 1;
        }
        await tx.subscriptionRule.update({ where: { id: ruleId }, data: { lastDigestAt: now } });
      });
    }
    return created;
  }

  // - 발송 이력 -

  async list(userId: string, query: DeliveryQueryDto): Promise<DeliveryListDto> {
    const where: Prisma.NotificationDeliveryWhereInput = { userId };
    if (query.statuses?.length) where.status = { in: query.statuses };
    if (query.channelId) where.channelId = query.channelId;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const [total, rows] = await Promise.all([
      this.prisma.notificationDelivery.count({ where }),
      this.prisma.notificationDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: deliveryInclude,
      }),
    ]);
    const projectIds = [...new Set(rows.map((row) => row.projectId).filter((id): id is string => id !== null))];
    const projects = new Map(
      (await this.prisma.project.findMany({ where: { userId, id: { in: projectIds } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]),
    );
    return { items: rows.map((row) => toDeliveryDto(row, projects)), total, page, pageSize };
  }

  async get(userId: string, id: string): Promise<DeliveryDto> {
    const row = await this.prisma.notificationDelivery.findFirst({ where: { id, userId }, include: deliveryInclude });
    if (!row) throw new NotFoundException('발송 이력을 찾을 수 없습니다.');
    const project = row.projectId ? await this.prisma.project.findFirst({ where: { id: row.projectId, userId }, select: { id: true, name: true } }) : null;
    return toDeliveryDto(row, new Map(project ? [[project.id, project.name]] : []));
  }

  async purge(olderThan: Date): Promise<void> {
    await this.prisma.notificationDelivery.deleteMany({
      where: { createdAt: { lt: olderThan }, status: { in: ['SENT', 'FAILED', 'SUPPRESSED', 'DIGESTED', 'CANCELLED'] } },
    });
    await this.prisma.notificationEvent.deleteMany({ where: { createdAt: { lt: olderThan }, relayedAt: { not: null } } });
  }
}

const deliveryInclude = {
  channel: { select: { name: true, type: true } },
  rule: { select: { name: true } },
  event: { select: { type: true, vulnerabilityId: true } },
} satisfies Prisma.NotificationDeliveryInclude;

function toDeliveryDto(row: Prisma.NotificationDeliveryGetPayload<{ include: typeof deliveryInclude }>, projects: Map<string, string>): DeliveryDto {
  const waiting = row.status === 'PENDING' || row.status === 'RETRYING' || row.status === 'HELD';
  return {
    id: row.id,
    kind: row.kind,
    eventType: row.event?.type ?? null,
    title: row.title,
    channelId: row.channelId,
    channelName: row.channel.name,
    channelType: row.channel.type,
    ruleName: row.rule?.name ?? null,
    vulnerabilityId: row.event?.vulnerabilityId ?? null,
    projectId: row.projectId,
    projectName: row.projectId ? (projects.get(row.projectId) ?? null) : null,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: waiting ? row.nextAttemptAt.toISOString() : null,
    lastError: row.lastError,
    lastStatusCode: row.lastStatusCode,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
  };
}
