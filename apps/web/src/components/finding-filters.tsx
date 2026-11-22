import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MATCH_LABEL, PRIORITY_LABEL, STATUS_LABEL } from '@/lib/labels';

export interface FindingFilterValue {
  versionMatch: string[];
  priorities: string[];
  statuses: string[];
  needsRecheck: boolean;
  reviewOverdue: boolean;
  includeResolved: boolean;
}

export const EMPTY_FINDING_FILTER: FindingFilterValue = {
  versionMatch: [],
  priorities: [],
  statuses: [],
  needsRecheck: false,
  reviewOverdue: false,
  includeResolved: false,
};

const MATCHES = ['AFFECTED', 'UNKNOWN'];
const PRIORITIES = ['URGENT', 'HIGH', 'NEEDS_CHECK', 'MEDIUM', 'LOW'];
const STATUSES = ['UNREVIEWED', 'IN_REVIEW', 'PLANNED', 'RISK_ACCEPTED', 'DONE'];

export function parseFindingFilter(params: URLSearchParams): FindingFilterValue {
  const list = (key: string) => (params.get(key) ?? '').split(',').filter(Boolean);
  return {
    versionMatch: list('versionMatch'),
    priorities: list('priorities'),
    statuses: list('statuses'),
    needsRecheck: params.get('needsRecheck') === 'true',
    reviewOverdue: params.get('reviewOverdue') === 'true',
    includeResolved: params.get('includeResolved') === 'true',
  };
}

export function writeFindingFilter(params: URLSearchParams, value: FindingFilterValue): URLSearchParams {
  const next = new URLSearchParams(params);
  const put = (key: string, items: string[]) => (items.length ? next.set(key, items.join(',')) : next.delete(key));
  put('versionMatch', value.versionMatch);
  put('priorities', value.priorities);
  put('statuses', value.statuses);
  for (const key of ['needsRecheck', 'reviewOverdue', 'includeResolved'] as const) {
    if (value[key]) next.set(key, 'true');
    else next.delete(key);
  }
  next.delete('page');
  return next;
}

function Group({ legend, options, labels, selected, onToggle }: { legend: string; options: string[]; labels: Record<string, string>; selected: string[]; onToggle: (value: string) => void }) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-xs font-medium text-muted-foreground">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <Button key={option} size="sm" variant={selected.includes(option) ? 'default' : 'outline'} aria-pressed={selected.includes(option)} onClick={() => onToggle(option)}>
            {labels[option]}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}

export function FindingFilters({ value, onChange }: { value: FindingFilterValue; onChange: (value: FindingFilterValue) => void }) {
  const toggle = (key: 'versionMatch' | 'priorities' | 'statuses', item: string) =>
    onChange({ ...value, [key]: value[key].includes(item) ? value[key].filter((x) => x !== item) : [...value[key], item] });
  const flag = (key: 'needsRecheck' | 'reviewOverdue' | 'includeResolved', label: string) => (
    <Button size="sm" variant={value[key] ? 'default' : 'outline'} aria-pressed={value[key]} onClick={() => onChange({ ...value, [key]: !value[key] })}>
      {label}
    </Button>
  );
  const active = value.versionMatch.length + value.priorities.length + value.statuses.length + Number(value.needsRecheck) + Number(value.reviewOverdue) + Number(value.includeResolved);
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
      <Group legend="버전 매칭" options={MATCHES} labels={MATCH_LABEL} selected={value.versionMatch} onToggle={(item) => toggle('versionMatch', item)} />
      <Group legend="대응 우선순위" options={PRIORITIES} labels={PRIORITY_LABEL} selected={value.priorities} onToggle={(item) => toggle('priorities', item)} />
      <Group legend="조치 상태" options={STATUSES} labels={STATUS_LABEL} selected={value.statuses} onToggle={(item) => toggle('statuses', item)} />
      <fieldset className="space-y-1">
        <legend className="text-xs font-medium text-muted-foreground">기타</legend>
        <div className="flex flex-wrap gap-1.5">
          {flag('needsRecheck', '재확인 필요')}
          {flag('reviewOverdue', '재검토 기한 경과')}
          {flag('includeResolved', '해소된 항목 포함')}
        </div>
      </fieldset>
      {active > 0 ? (
        <Button size="sm" variant="ghost" onClick={() => onChange(EMPTY_FINDING_FILTER)}>
          <RotateCcw aria-hidden /> 전체 초기화
        </Button>
      ) : null}
    </div>
  );
}

/** 필터 값을 API 질의로 바꾼다. 목록과 개수가 같은 값을 쓴다. */
export function findingFilterToQuery(value: FindingFilterValue) {
  return {
    versionMatch: value.versionMatch.length ? (value.versionMatch as ('AFFECTED' | 'NOT_AFFECTED' | 'UNKNOWN')[]) : undefined,
    priorities: value.priorities.length ? (value.priorities as ('URGENT' | 'HIGH' | 'NEEDS_CHECK' | 'MEDIUM' | 'LOW')[]) : undefined,
    statuses: value.statuses.length ? (value.statuses as ('UNREVIEWED' | 'IN_REVIEW' | 'PLANNED' | 'RISK_ACCEPTED' | 'DONE')[]) : undefined,
    needsRecheck: value.needsRecheck ? true : undefined,
    reviewOverdue: value.reviewOverdue ? true : undefined,
    includeResolved: value.includeResolved ? true : undefined,
  };
}
