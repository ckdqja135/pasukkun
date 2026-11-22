import {
  AlertOctagon,
  ArrowDown,
  ArrowUp,
  Ban,
  Check,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  Clock,
  Equal,
  Eye,
  Flame,
  HelpCircle,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { CONDITION_LABEL, MATCH_LABEL, PRIORITY_LABEL, SEVERITY_LABEL, STATUS_LABEL } from '@/lib/labels';

/**
 * 상태 배지. 색만으로 구분하지 않도록 항상 아이콘과 텍스트를 함께 쓴다.
 */
type Tone = 'red' | 'orange' | 'amber' | 'blue' | 'green' | 'gray' | 'violet';

const TONE: Record<Tone, string> = {
  red: 'border-red-600/30 bg-red-600/10 text-red-700 dark:text-red-300',
  orange: 'border-orange-600/30 bg-orange-600/10 text-orange-700 dark:text-orange-300',
  amber: 'border-amber-600/30 bg-amber-500/10 text-amber-800 dark:text-amber-300',
  blue: 'border-sky-600/30 bg-sky-600/10 text-sky-700 dark:text-sky-300',
  green: 'border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300',
  gray: 'border-border bg-muted text-muted-foreground',
  violet: 'border-violet-600/30 bg-violet-600/10 text-violet-700 dark:text-violet-300',
};

export function Pill({ tone, icon: Icon, children, title, className }: { tone: Tone; icon: LucideIcon; children: React.ReactNode; title?: string; className?: string }) {
  return (
    <span
      title={title}
      className={cn('inline-flex h-5.5 shrink-0 items-center gap-1 rounded-md border px-1.5 text-xs font-medium whitespace-nowrap', TONE[tone], className)}
    >
      <Icon className="size-3" aria-hidden />
      {children}
    </span>
  );
}

const SEVERITY: Record<string, { tone: Tone; icon: LucideIcon }> = {
  CRITICAL: { tone: 'red', icon: AlertOctagon },
  HIGH: { tone: 'orange', icon: ArrowUp },
  MEDIUM: { tone: 'amber', icon: Equal },
  LOW: { tone: 'gray', icon: ArrowDown },
  UNKNOWN: { tone: 'violet', icon: CircleHelp },
};

/** 취약점 자체의 심각도 */
export function SeverityBadge({ severity, score }: { severity: string; score?: number | null }) {
  const style = SEVERITY[severity] ?? SEVERITY.UNKNOWN;
  return (
    <Pill tone={style.tone} icon={style.icon} title={severity === 'UNKNOWN' ? '심각도 점수가 제공되지 않았습니다. 낮은 위험을 뜻하지 않습니다.' : '취약점 자체의 심각도'}>
      심각도 {SEVERITY_LABEL[severity] ?? severity}
      {score !== null && score !== undefined ? ` ${score.toFixed(1)}` : ''}
    </Pill>
  );
}

const PRIORITY: Record<string, { tone: Tone; icon: LucideIcon }> = {
  URGENT: { tone: 'red', icon: Flame },
  HIGH: { tone: 'orange', icon: ArrowUp },
  NEEDS_CHECK: { tone: 'violet', icon: ShieldQuestion },
  MEDIUM: { tone: 'amber', icon: Equal },
  LOW: { tone: 'gray', icon: ArrowDown },
};

/** 프로젝트 관점의 대응 우선순위 (심각도와 별개) */
export function PriorityBadge({ priority }: { priority: string }) {
  const style = PRIORITY[priority] ?? PRIORITY.LOW;
  return (
    <Pill tone={style.tone} icon={style.icon} title="프로젝트 관점의 대응 우선순위">
      우선순위 {PRIORITY_LABEL[priority] ?? priority}
    </Pill>
  );
}

const MATCH: Record<string, { tone: Tone; icon: LucideIcon }> = {
  AFFECTED: { tone: 'red', icon: ShieldAlert },
  NOT_AFFECTED: { tone: 'green', icon: ShieldCheck },
  UNKNOWN: { tone: 'violet', icon: ShieldQuestion },
  NOT_SCANNED: { tone: 'gray', icon: CircleDashed },
};

export function MatchBadge({ match }: { match: string }) {
  const style = MATCH[match] ?? MATCH.UNKNOWN;
  return (
    <Pill tone={style.tone} icon={style.icon}>
      {MATCH_LABEL[match] ?? match}
    </Pill>
  );
}

const CONDITION: Record<string, { tone: Tone; icon: LucideIcon }> = {
  MET: { tone: 'red', icon: Check },
  NOT_MET: { tone: 'green', icon: Ban },
  NEEDS_CHECK: { tone: 'amber', icon: Eye },
  NOT_ANALYZED: { tone: 'gray', icon: HelpCircle },
};

export function ConditionBadge({ condition }: { condition: string }) {
  const style = CONDITION[condition] ?? CONDITION.NOT_ANALYZED;
  return (
    <Pill tone={style.tone} icon={style.icon} title="악용 조건 확인 결과 (수동 검토로만 충족/불충족이 정해집니다)">
      악용 조건: {CONDITION_LABEL[condition] ?? condition}
    </Pill>
  );
}

const STATUS: Record<string, { tone: Tone; icon: LucideIcon }> = {
  UNREVIEWED: { tone: 'gray', icon: CircleDashed },
  IN_REVIEW: { tone: 'blue', icon: Eye },
  PLANNED: { tone: 'amber', icon: Clock },
  RISK_ACCEPTED: { tone: 'violet', icon: ShieldQuestion },
  DONE: { tone: 'green', icon: CheckCircle2 },
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS[status] ?? STATUS.UNREVIEWED;
  return (
    <Pill tone={style.tone} icon={style.icon}>
      {STATUS_LABEL[status] ?? status}
    </Pill>
  );
}

export function KevBadge({ date }: { date?: string | null }) {
  return (
    <Pill tone="red" icon={Flame} title="CISA KEV 에 등재되어 실제 악용이 확인된 취약점입니다.">
      KEV 등재{date ? ` ${date.slice(0, 10)}` : ''}
    </Pill>
  );
}

export function PatchBadge({ status }: { status: string }) {
  return status === 'AVAILABLE' ? (
    <Pill tone="green" icon={Wrench} title="공지에서 수정 버전이 확인되었습니다.">
      수정 버전 확인
    </Pill>
  ) : (
    <Pill tone="gray" icon={XCircle} title="출처에서 수정 버전이 확인되지 않았습니다.">
      패치 미확인
    </Pill>
  );
}
