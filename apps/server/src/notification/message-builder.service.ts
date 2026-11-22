import { Inject, Injectable } from '@nestjs/common';
import type { AppEnv } from '../config/env.js';
import { APP_ENV } from '../db/db.module.js';
import { PrismaService } from '../db/prisma.service.js';
import type { Interval } from '../domain/version-match.js';
import type { TemplateValues } from './template.js';
import {
  CONDITION_LABEL,
  EVENT_HEADINGS,
  MATCH_LABEL,
  PRIORITY_LABEL,
  SEVERITY_LABEL,
  type NotificationMessage,
} from './message.js';

interface DeliveryRef {
  id: string;
  kind: string;
  eventId: string | null;
  userId: string;
  projectId: string | null;
}

const PRIORITY_TONE: Record<string, NotificationMessage['tone']> = { URGENT: 'urgent', HIGH: 'high', NEEDS_CHECK: 'high', MEDIUM: 'medium', LOW: 'low' };
const SEVERITY_TONE: Record<string, NotificationMessage['tone']> = { CRITICAL: 'urgent', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', UNKNOWN: 'info' };
const PRIORITY_RANK: Record<string, number> = { URGENT: 5, HIGH: 4, NEEDS_CHECK: 3, MEDIUM: 2, LOW: 1 };
const IDENTIFIER_ORDER: Record<string, number> = { CVE: 0, GHSA: 1, OSV: 2 };

/** 발송 직전에 최신 데이터로 알림 내용을 만든다. 알림에는 필요한 정보만 담는다. */
@Injectable()
export class MessageBuilder {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /** 대상이 사라졌거나 더 이상 유효하지 않으면 null (발송 취소). */
  async build(delivery: DeliveryRef): Promise<NotificationMessage | null> {
    if (delivery.kind === 'DIGEST') return this.buildDigest(delivery);
    if (!delivery.eventId) return null;
    const event = await this.prisma.notificationEvent.findUnique({ where: { id: delivery.eventId } });
    if (!event) return null;
    if (event.type === 'INITIAL_SCAN_SUMMARY') return this.buildInitialSummary(event.projectId, (event.payload ?? {}) as Record<string, unknown>);
    if (!event.vulnerabilityId) return null;
    const projectId = delivery.projectId ?? event.projectId;
    return projectId
      ? this.buildProjectMessage(event.type, event.vulnerabilityId, projectId, (event.payload ?? {}) as Record<string, unknown>)
      : this.buildTechMessage(event.type, event.vulnerabilityId, delivery.userId);
  }

  private async loadVulnerability(id: string) {
    return this.prisma.vulnerability.findUnique({
      where: { id },
      include: {
        identifiers: { select: { type: true, value: true } },
        technologies: { select: { technology: { select: { id: true, name: true } } } },
        sources: { select: { source: true, htmlUrl: true, withdrawn: true } },
        affected: {
          select: { intervals: true, package: { select: { ecosystem: true, name: true } }, sourceRecord: { select: { withdrawn: true } } },
        },
      },
    });
  }

  private commonFields(v: NonNullable<Awaited<ReturnType<MessageBuilder['loadVulnerability']>>>): Array<{ label: string; value: string }> {
    const fields: Array<{ label: string; value: string }> = [];
    const score = v.cvssScore !== null ? ` · CVSS ${v.cvssVersion ?? ''} ${v.cvssScore.toFixed(1)}`.replace('  ', ' ') : ' · CVSS 미제공';
    fields.push({ label: '심각도', value: `${SEVERITY_LABEL[v.severity]}${score}` });
    if (v.kevAddedAt) fields.push({ label: '실제 악용', value: `CISA KEV 등재 (${v.kevAddedAt.toISOString().slice(0, 10)})` });
    if (v.epssScore !== null) {
      fields.push({ label: 'EPSS', value: `${v.epssScore.toFixed(3)} - 30일 내 악용 활동이 관측될 확률 추정 (기준일 ${v.epssDate ?? '-'})` });
    }
    return fields;
  }

  private original(v: { sources: Array<{ source: string; htmlUrl: string | null }> }) {
    const order = ['GHSA', 'NVD', 'OSV'];
    return [...v.sources].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source)).find((s) => s.htmlUrl);
  }

  private commonValues(v: NonNullable<Awaited<ReturnType<MessageBuilder['loadVulnerability']>>>): TemplateValues {
    return {
      제목: v.title,
      식별자: this.identifiers(v).join(' · '),
      심각도: SEVERITY_LABEL[v.severity],
      CVSS: v.cvssScore !== null ? v.cvssScore.toFixed(1) : '미제공',
      KEV: v.kevAddedAt ? `등재 (${v.kevAddedAt.toISOString().slice(0, 10)})` : '미등재',
      EPSS: v.epssScore !== null ? `${(v.epssScore * 100).toFixed(1)}%` : '-',
      원문: this.original(v)?.htmlUrl ?? '-',
    };
  }

  private links(v: { id: string; sources: Array<{ source: string; htmlUrl: string | null }> }, servicePath: string) {
    const original = this.original(v);
    return [
      ...(original?.htmlUrl ? [{ label: `원문 (${original.source})`, url: original.htmlUrl }] : []),
      { label: '상세 보기', url: `${this.env.appOrigin}${servicePath}` },
    ];
  }

  private identifiers(v: { identifiers: Array<{ type: string; value: string }> }): string[] {
    return [...v.identifiers].sort((a, b) => IDENTIFIER_ORDER[a.type] - IDENTIFIER_ORDER[b.type]).map((id) => id.value).slice(0, 4);
  }

  /** 관심 기술 알림: 관련 공지를 알리되 프로젝트 영향 여부는 확정하지 않는다. */
  private async buildTechMessage(type: string, vulnerabilityId: string, userId: string): Promise<NotificationMessage | null> {
    const v = await this.loadVulnerability(vulnerabilityId);
    if (!v || v.withdrawnAt) return null;
    const interests = new Set((await this.prisma.userTechnologyInterest.findMany({ where: { userId }, select: { technologyId: true } })).map((row) => row.technologyId));
    const related = v.technologies.filter((t) => interests.has(t.technology.id)).map((t) => t.technology.name);

    const packages = new Map<string, Set<string>>();
    for (const item of v.affected) {
      if (item.sourceRecord.withdrawn) continue;
      const key = `${item.package.ecosystem}:${item.package.name}`;
      const fixed = packages.get(key) ?? new Set<string>();
      for (const interval of (item.intervals ?? []) as unknown as Interval[]) {
        const version = interval.fixed ?? interval.patched;
        if (version) fixed.add(version);
      }
      packages.set(key, fixed);
    }
    const packageLines = [...packages.entries()].slice(0, 5).map(([name, fixed]) => `${name} - ${fixed.size ? `확인된 수정 버전 ${[...fixed].slice(0, 3).join(', ')}` : '패치 미확인'}`);

    const fields = [
      { label: '관련 기술', value: related.length ? related.join(', ') : v.technologies.map((t) => t.technology.name).join(', ') || '-' },
      ...(packageLines.length ? [{ label: '영향 패키지', value: `${packageLines.join('\n')}${packages.size > 5 ? `\n외 ${packages.size - 5}개` : ''}` }] : []),
      ...this.commonFields(v),
      { label: '프로젝트 영향', value: '확정되지 않음 - 관심 기술과 일치하는 공지입니다. 실제 영향은 프로젝트 검사 결과에서 확인하세요.' },
    ];
    const [firstPackage, firstFixed] = [...packages.entries()][0] ?? [];
    return {
      heading: `[관심 기술] ${EVENT_HEADINGS[type] ?? type}`,
      title: v.title,
      identifiers: this.identifiers(v),
      fields,
      links: this.links(v, `/vulnerabilities/${v.id}`),
      tone: v.kevAddedAt ? 'urgent' : SEVERITY_TONE[v.severity],
      footer: 'pasukkun · 관심 기술 알림',
      values: {
        ...this.commonValues(v),
        이벤트: EVENT_HEADINGS[type] ?? type,
        관련기술: related.length ? related.join(', ') : v.technologies.map((t) => t.technology.name).join(', '),
        영향패키지: `${packageLines.join('\n')}${packages.size > 5 ? `\n외 ${packages.size - 5}개` : ''}`,
        패키지: firstPackage ? firstPackage.slice(firstPackage.indexOf(':') + 1) : undefined,
        수정버전: firstFixed ? (firstFixed.size ? [...firstFixed].slice(0, 3).join(', ') : '패치 미확인') : undefined,
        링크: `${this.env.appOrigin}/vulnerabilities/${v.id}`,
      },
    };
  }

  /** 프로젝트 영향 알림: 현재 구성에서 확인된 사실과 아직 확인하지 못한 조건을 함께 담는다. */
  private async buildProjectMessage(type: string, vulnerabilityId: string, projectId: string, payload: Record<string, unknown>): Promise<NotificationMessage | null> {
    const [v, project] = await Promise.all([
      this.loadVulnerability(vulnerabilityId),
      this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } }),
    ]);
    if (!v || !project || v.withdrawnAt) return null;
    const findings = await this.prisma.finding.findMany({
      where: { projectId, vulnerabilityId, resolvedAt: null, versionMatch: { in: ['AFFECTED', 'UNKNOWN'] } },
      include: { package: { select: { name: true } } },
      orderBy: { priorityRank: 'desc' },
    });
    if (findings.length === 0) return null;
    const top = findings[0];
    const evidence = (top.evidence ?? {}) as {
      reason?: string;
      fix?: { kind?: string; version?: string };
      conditionChecks?: Array<{ label: string }>;
    };

    const packageLines = findings.slice(0, 5).map((finding) => {
      const fix = ((finding.evidence ?? {}) as { fix?: { kind?: string; version?: string } }).fix;
      const fixText =
        fix?.kind === 'FIXED' ? `수정 버전 ${fix.version}` : fix?.kind === 'HIGHER_LINE_ONLY' ? `상위 계열 ${fix.version} 에서만 수정 확인` : '패치 미확인';
      return `${finding.package.name}@${finding.version} - ${MATCH_LABEL[finding.versionMatch]} · ${fixText}`;
    });
    const checks = (evidence.conditionChecks ?? []).slice(0, 4).map((check) => check.label);
    const fields = [
      { label: '프로젝트', value: project.name },
      { label: '영향 패키지와 현재 버전', value: `${packageLines.join('\n')}${findings.length > 5 ? `\n외 ${findings.length - 5}건` : ''}` },
      ...this.commonFields(v),
      {
        label: '대응 우선순위',
        value:
          type === 'PRIORITY_RAISED' && typeof payload.from === 'string'
            ? `${PRIORITY_LABEL[payload.from] ?? payload.from} → ${PRIORITY_LABEL[top.priority]}`
            : PRIORITY_LABEL[top.priority],
      },
      { label: '판단 근거', value: evidence.reason ?? '-' },
      { label: '악용 조건', value: `${CONDITION_LABEL[top.exploitCondition]}${checks.length ? ` - 확인할 항목: ${checks.join(', ')}` : ''}` },
    ];
    const maxPriority = findings.reduce((max, finding) => (PRIORITY_RANK[finding.priority] > PRIORITY_RANK[max] ? finding.priority : max), top.priority);
    const priorityText =
      type === 'PRIORITY_RAISED' && typeof payload.from === 'string'
        ? `${PRIORITY_LABEL[payload.from] ?? payload.from} → ${PRIORITY_LABEL[top.priority]}`
        : PRIORITY_LABEL[top.priority];
    const values: TemplateValues = {
      ...this.commonValues(v),
      이벤트: EVENT_HEADINGS[type] ?? type,
      우선순위: priorityText,
      프로젝트: project.name,
      패키지: top.package.name,
      현재버전: top.version,
      수정버전: evidence.fix?.kind === 'FIXED' || evidence.fix?.kind === 'HIGHER_LINE_ONLY' ? evidence.fix.version : '패치 미확인',
      영향패키지: `${packageLines.join('\n')}${findings.length > 5 ? `\n외 ${findings.length - 5}건` : ''}`,
      판단: evidence.reason,
      악용조건: CONDITION_LABEL[top.exploitCondition],
      확인할조건: checks.join(', '),
      링크: `${this.env.appOrigin}/findings/${top.id}`,
    };
    return {
      values,
      heading: `[프로젝트 영향] ${EVENT_HEADINGS[type] ?? type}`,
      title: v.title,
      identifiers: this.identifiers(v),
      fields,
      links: this.links(v, `/findings/${top.id}`),
      tone: PRIORITY_TONE[maxPriority],
      footer: 'pasukkun · 버전 일치만으로 실제 악용 가능성을 확정하지 않습니다',
    };
  }

  private async buildInitialSummary(projectId: string | null, payload: Record<string, unknown>): Promise<NotificationMessage | null> {
    if (!projectId) return null;
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
    if (!project) return null;
    const byPriority = (payload.byPriority ?? {}) as Record<string, number>;
    const breakdown = ['URGENT', 'HIGH', 'NEEDS_CHECK', 'MEDIUM', 'LOW']
      .filter((key) => byPriority[key])
      .map((key) => `${PRIORITY_LABEL[key]} ${byPriority[key]}`)
      .join(' · ');
    const affected = Number(payload.affected ?? 0);
    const unknown = Number(payload.unknown ?? 0);
    const partial = payload.status === 'PARTIAL';
    return {
      heading: '[프로젝트 영향] 최초 분석 요약',
      title: project.name,
      identifiers: [],
      lead:
        affected + unknown === 0
          ? partial
            ? '일부 조회가 실패해 검사가 완전하지 않습니다. 결과가 없다고 해서 취약점이 없다는 뜻은 아닙니다.'
            : '본 검사 범위에서 알려진 취약점 일치가 없습니다.'
          : '기존 항목은 개별 알림 대신 이 요약 한 건으로 알려드립니다.',
      fields: [
        { label: '검사한 패키지 버전', value: `${Number(payload.packages ?? 0)}개` },
        { label: '영향 버전 일치', value: `${affected}건` },
        { label: '판단 불가', value: `${unknown}건` },
        ...(breakdown ? [{ label: '대응 우선순위', value: breakdown }] : []),
        ...(partial ? [{ label: '검사 상태', value: '부분 완료 - 일부 외부 조회 실패' }] : []),
      ],
      links: [{ label: '분석 결과 보기', url: `${this.env.appOrigin}/projects/${project.id}` }],
      tone: byPriority.URGENT ? 'urgent' : byPriority.HIGH ? 'high' : 'info',
      footer: 'pasukkun · 검사 범위: npm 패키지 설치 버전',
    };
  }

  private async buildDigest(delivery: DeliveryRef): Promise<NotificationMessage | null> {
    const items = await this.prisma.notificationDelivery.findMany({
      where: { digestId: delivery.id },
      orderBy: { createdAt: 'asc' },
      select: { title: true, projectId: true },
    });
    if (items.length === 0) return null;
    const projectIds = [...new Set(items.map((item) => item.projectId).filter((id): id is string => id !== null))];
    const projects = new Map((await this.prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
    const lines = items.slice(0, 15).map((item) => `• ${item.title}${item.projectId ? ` (${projects.get(item.projectId) ?? '프로젝트'})` : ''}`);
    return {
      heading: '알림 요약',
      title: `${items.length}건의 알림`,
      identifiers: [],
      fields: [{ label: '내용', value: `${lines.join('\n')}${items.length > 15 ? `\n외 ${items.length - 15}건` : ''}` }],
      links: [{ label: '발송 이력에서 전체 보기', url: `${this.env.appOrigin}/deliveries` }],
      tone: 'info',
      footer: 'pasukkun · 알림 요약',
    };
  }
}
