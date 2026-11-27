import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { RuleDto, RuleInputDto, ScheduleDto, TemplateInfoDto, TemplatePreviewDto, TemplatePreviewInputDto } from './notification.dto.js';
import { ALL_NEW_EVENT_TYPES, PROJECT_EVENT_TYPES, TECH_EVENT_TYPES } from './rules.js';
import { describeSchedule, ScheduleError, validateSchedule, type DeliverySchedule } from './schedule.js';
import { DEFAULT_TEMPLATES, PLACEHOLDERS, renderTemplate, TemplateError, validateTemplate, type TemplateValues } from './template.js';

/** 미리보기용 예시 값 (실제 데이터가 아님) */
const SAMPLE_VALUES: Record<'TECH_INTEREST' | 'PROJECT_IMPACT', TemplateValues> = {
  PROJECT_IMPACT: {
    이벤트: '신규 영향 버전 일치',
    제목: 'lodash vulnerable to Code Injection via `_.template` imports key names',
    식별자: 'CVE-2026-4800 · GHSA-r5fr-rjxr-66jc',
    심각도: '치명적',
    CVSS: '9.8',
    우선순위: '긴급',
    프로젝트: 'my-api',
    패키지: 'lodash',
    현재버전: '4.17.20',
    수정버전: '4.18.0',
    영향패키지: 'lodash@4.17.20 - 영향 버전 일치 · 수정 버전 4.18.0',
    판단: '4.17.20 이 영향 구간(>= 4.0.0, < 4.18.0)에 포함됨',
    악용조건: '확인 필요',
    확인할조건: '취약 기능 사용 여부',
    KEV: '미등재',
    EPSS: '2.9%',
    링크: 'https://pasukkun.example/findings/example',
    원문: 'https://github.com/advisories/GHSA-r5fr-rjxr-66jc',
  },
  TECH_INTEREST: {
    이벤트: '신규 취약점',
    제목: 'Next.js middleware authorization bypass',
    식별자: 'CVE-2026-1234 · GHSA-xxxx-xxxx-xxxx',
    심각도: '높음',
    CVSS: '8.1',
    관련기술: 'Next.js, TypeScript',
    패키지: 'next',
    수정버전: '15.2.3',
    영향패키지: 'npm:next - 확인된 수정 버전 15.2.3',
    KEV: '미등재',
    EPSS: '1.2%',
    링크: 'https://pasukkun.example/vulnerabilities/example',
    원문: 'https://github.com/advisories/GHSA-xxxx-xxxx-xxxx',
  },
};

const KIND_EVENT_TYPES: Record<RuleInputDto['kind'], readonly string[]> = { TECH_INTEREST: TECH_EVENT_TYPES, PROJECT_IMPACT: PROJECT_EVENT_TYPES, ALL_NEW: ALL_NEW_EVENT_TYPES };
const KIND_LABEL: Record<RuleInputDto['kind'], string> = { TECH_INTEREST: '관심 기술', PROJECT_IMPACT: '프로젝트 영향', ALL_NEW: '전체 신규 취약점' };

type RuleRow = Prisma.SubscriptionRuleGetPayload<{ include: { channels: { include: { channel: { select: { id: true; status: true; name: true } } } } } }>;
const include = { channels: { include: { channel: { select: { id: true, status: true, name: true } } } } } as const;

@Injectable()
export class RuleService {
  constructor(private readonly prisma: PrismaService) {}

  private async toDto(row: RuleRow, interestCount: number): Promise<RuleDto> {
    const warnings: string[] = [];
    if (row.kind === 'TECH_INTEREST' && interestCount === 0) {
      warnings.push('저장된 관심 기술이 없어 이 규칙으로는 알림이 발송되지 않습니다. 관심 기술 설정에서 항목을 저장해 주세요.');
    }
    for (const link of row.channels) {
      if (link.channel.status === 'PAUSED') warnings.push(`채널 "${link.channel.name}" 이 일시 중지 상태입니다.`);
      if (link.channel.status === 'ERROR') warnings.push(`채널 "${link.channel.name}" 에 연결 오류가 있습니다.`);
    }
    if (!row.enabled) warnings.push('규칙이 꺼져 있습니다.');
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      eventTypes: (row.eventTypes ?? []) as string[],
      minSeverity: row.minSeverity,
      projectIds: (row.projectIds ?? []) as string[],
      schedule: row.schedule as unknown as ScheduleDto,
      scheduleText: describeSchedule(row.schedule as unknown as DeliverySchedule),
      digestFormat: row.digestFormat === 'BRIEFING' ? 'BRIEFING' : 'LIST',
      template: row.template,
      channelIds: row.channels.map((link) => link.channelId),
      enabled: row.enabled,
      warnings,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** 입력 검증: 이벤트 종류가 규칙 유형에 맞는지, 채널·프로젝트가 본인 소유인지 확인한다. */
  private async validate(
    userId: string,
    dto: RuleInputDto,
  ): Promise<{ channelIds: string[]; projectIds: string[]; eventTypes: string[]; schedule: DeliverySchedule; template: string | null }> {
    let schedule: DeliverySchedule;
    let template: string | null;
    try {
      schedule = validateSchedule(dto.schedule);
      template = validateTemplate(dto.template);
    } catch (error) {
      if (error instanceof ScheduleError || error instanceof TemplateError) throw new BadRequestException(error.message);
      throw error;
    }
    if (dto.digestFormat === 'BRIEFING' && schedule.type === 'IMMEDIATE') {
      throw new BadRequestException('보안 브리핑은 받는 시간을 정해 모아 받을 때만 쓸 수 있습니다.');
    }
    if (dto.kind === 'ALL_NEW') {
      // 하루 수백 건이 공개되므로 받는 시각에 모아 브리핑으로만 보낸다.
      if (schedule.type === 'IMMEDIATE' || dto.digestFormat !== 'BRIEFING') throw new BadRequestException('전체 신규 취약점은 받는 시간을 정해 보안 브리핑으로만 받을 수 있습니다.');
      if (!dto.minSeverity) throw new BadRequestException('전체 신규 취약점은 심각도 기준을 골라야 합니다.');
      template = null;
    }
    const allowed = KIND_EVENT_TYPES[dto.kind];
    const eventTypes = [...new Set(dto.eventTypes)];
    const invalid = eventTypes.filter((type) => !allowed.includes(type));
    if (invalid.length > 0) {
      throw new BadRequestException(`${KIND_LABEL[dto.kind]} 규칙에서 쓸 수 없는 이벤트입니다: ${invalid.join(', ')}`);
    }
    const channelIds = [...new Set(dto.channelIds)];
    const channels = await this.prisma.notificationChannel.count({ where: { userId, id: { in: channelIds } } });
    if (channels !== channelIds.length) throw new BadRequestException('알 수 없는 알림 채널이 포함되어 있습니다.');
    const projectIds = dto.kind === 'PROJECT_IMPACT' ? [...new Set(dto.projectIds ?? [])] : [];
    if (projectIds.length > 0) {
      const projects = await this.prisma.project.count({ where: { userId, id: { in: projectIds } } });
      if (projects !== projectIds.length) throw new BadRequestException('알 수 없는 프로젝트가 포함되어 있습니다.');
    }
    return { channelIds, projectIds, eventTypes, schedule, template };
  }

  async list(userId: string): Promise<RuleDto[]> {
    const [rows, interestCount] = await Promise.all([
      this.prisma.subscriptionRule.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, include }),
      this.prisma.userTechnologyInterest.count({ where: { userId } }),
    ]);
    return Promise.all(rows.map((row) => this.toDto(row, interestCount)));
  }

  private async load(userId: string, ruleId: string): Promise<RuleDto> {
    const row = await this.prisma.subscriptionRule.findFirst({ where: { id: ruleId, userId }, include });
    if (!row) throw new NotFoundException('구독 규칙을 찾을 수 없습니다.');
    return this.toDto(row, await this.prisma.userTechnologyInterest.count({ where: { userId } }));
  }

  async create(userId: string, dto: RuleInputDto): Promise<RuleDto> {
    if ((await this.prisma.subscriptionRule.count({ where: { userId } })) >= 50) {
      throw new BadRequestException('구독 규칙은 계정당 50개까지 만들 수 있습니다.');
    }
    const { channelIds, projectIds, eventTypes, schedule, template } = await this.validate(userId, dto);
    const row = await this.prisma.subscriptionRule.create({
      data: {
        userId,
        name: dto.name.trim(),
        kind: dto.kind,
        eventTypes,
        minSeverity: dto.minSeverity ?? null,
        projectIds,
        schedule: schedule as object,
        digestFormat: dto.digestFormat ?? 'LIST',
        template,
        lastDigestAt: new Date(),
        enabled: dto.enabled ?? true,
        channels: { create: channelIds.map((channelId) => ({ channelId })) },
      },
    });
    return this.load(userId, row.id);
  }

  async update(userId: string, ruleId: string, dto: RuleInputDto): Promise<RuleDto> {
    const existing = await this.prisma.subscriptionRule.findFirst({ where: { id: ruleId, userId }, select: { id: true } });
    if (!existing) throw new NotFoundException('구독 규칙을 찾을 수 없습니다.');
    const { channelIds, projectIds, eventTypes, schedule, template } = await this.validate(userId, dto);
    await this.prisma.$transaction([
      // 요약에서 즉시로 바꾸면, 요약을 기다리던 알림은 바로 보낸다.
      ...(schedule.type === 'IMMEDIATE'
        ? [this.prisma.notificationDelivery.updateMany({ where: { ruleId, status: 'DIGEST_PENDING' }, data: { status: 'PENDING', nextAttemptAt: new Date() } })]
        : []),
      this.prisma.ruleChannel.deleteMany({ where: { ruleId } }),
      this.prisma.subscriptionRule.update({
        where: { id: ruleId },
        data: {
          name: dto.name.trim(),
          kind: dto.kind,
          eventTypes,
          minSeverity: dto.minSeverity ?? null,
          projectIds,
          schedule: schedule as object,
          digestFormat: dto.digestFormat ?? 'LIST',
          template,
          enabled: dto.enabled ?? true,
          channels: { create: channelIds.map((channelId) => ({ channelId })) },
        },
      }),
    ]);
    return this.load(userId, ruleId);
  }

  async remove(userId: string, ruleId: string): Promise<void> {
    const existing = await this.prisma.subscriptionRule.findFirst({ where: { id: ruleId, userId }, select: { id: true } });
    if (!existing) throw new NotFoundException('구독 규칙을 찾을 수 없습니다.');
    await this.prisma.$transaction([
      this.prisma.notificationDelivery.updateMany({ where: { ruleId, status: 'DIGEST_PENDING' }, data: { status: 'CANCELLED', lastError: '규칙이 삭제되어 취소됨' } }),
      this.prisma.subscriptionRule.delete({ where: { id: ruleId } }),
    ]);
  }

  templateInfo(): TemplateInfoDto {
    return { placeholders: PLACEHOLDERS.map((p) => ({ key: p.key, description: p.description })), defaults: { ...DEFAULT_TEMPLATES } };
  }

  /** 예시 데이터로 문구 틀을 채워 본다. 알 수 없는 자리표시자는 오류로 알려준다. */
  previewTemplate(dto: TemplatePreviewInputDto): TemplatePreviewDto {
    try {
      const template = validateTemplate(dto.template) ?? DEFAULT_TEMPLATES[dto.kind];
      return { text: renderTemplate(template, SAMPLE_VALUES[dto.kind]) };
    } catch (error) {
      if (error instanceof TemplateError) throw new BadRequestException(error.message);
      throw error;
    }
  }
}
