import { AlertTriangle, CheckCircle2, CircleDashed, Clock, Loader2 } from 'lucide-react';
import { Pill } from '@/components/badges';
import type { Schemas } from '@/lib/api';
import { formatRelative } from '@/lib/labels';

type Source = Schemas['SourceStatusDto'];

export function SourceStateBadge({ source }: { source: Source }) {
  if (source.running) return <Pill tone="blue" icon={Loader2}>수집 중</Pill>;
  if (source.status === 'FAILING') return <Pill tone="red" icon={AlertTriangle}>수집 실패</Pill>;
  if (source.status === 'NEVER_RUN') return <Pill tone="gray" icon={CircleDashed}>{source.key === 'OSV' ? '검사 전' : '수집 전'}</Pill>;
  if (source.lagging && source.key !== 'OSV') return <Pill tone="amber" icon={Clock}>지연</Pill>;
  return <Pill tone="green" icon={CheckCircle2}>정상</Pill>;
}

/** 대시보드용 소스 상태 요약 */
export function SourceStatusList({ sources }: { sources: Source[] }) {
  return (
    <ul className="divide-y text-sm">
      {sources.map((source) => (
        <li key={source.key} className="flex items-center justify-between gap-3 py-2">
          <div className="min-w-0">
            <p className="font-medium">{source.key}</p>
            <p className="truncate text-xs text-muted-foreground" title={source.lastError ?? source.role}>
              {source.status === 'FAILING' && source.lastError ? source.lastError : `마지막 성공 ${formatRelative(source.lastSuccessAt)}`}
            </p>
          </div>
          <SourceStateBadge source={source} />
        </li>
      ))}
    </ul>
  );
}
