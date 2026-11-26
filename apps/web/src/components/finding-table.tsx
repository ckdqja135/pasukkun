import { Link } from 'react-router';
import { ConditionBadge, KevBadge, MaliciousBadge, MatchBadge, PriorityBadge, SeverityBadge, StatusBadge } from '@/components/badges';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { Schemas } from '@/lib/api';
import { formatDate } from '@/lib/labels';

type Finding = Schemas['FindingListItemDto'];

/** 분석 결과 목록. 프로젝트 상세·전체 결과·대시보드가 같은 표를 쓴다. */
export function FindingTable({ items, showProject = true, compact = false }: { items: Finding[]; showProject?: boolean; compact?: boolean }) {
  if (compact) return <CompactFindingList items={items} />;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table className="table-fixed min-w-[960px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-36">대응 우선순위</TableHead>
            <TableHead>취약점</TableHead>
            <TableHead className="w-52">패키지 · 현재 버전</TableHead>
            <TableHead className="w-56">판단</TableHead>
            <TableHead className="w-28">조치 상태</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((finding) => (
            <TableRow key={finding.id} className={finding.resolvedAt ? 'align-top opacity-60' : 'align-top'}>
              <TableCell>
                <div className="flex flex-col items-start gap-1">
                  <PriorityBadge priority={finding.priority} />
                  <SeverityBadge severity={finding.severity} score={finding.cvssScore} />
                </div>
              </TableCell>
              <TableCell className="whitespace-normal">
                <Link to={`/findings/${finding.id}`} className="font-medium underline-offset-2 outline-none hover:underline focus-visible:underline">
                  {finding.vulnerabilityTitle}
                </Link>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-mono">{finding.identifiers.slice(0, 2).join(' · ')}</span>
                  {showProject ? <span>· {finding.projectName}</span> : null}
                  {finding.malicious ? <MaliciousBadge /> : null}
                  {finding.kevListed ? <KevBadge /> : null}
                </div>
              </TableCell>
              <TableCell className="whitespace-normal">
                <span className="font-mono text-xs break-all">
                  {finding.packageName}@{finding.version}
                </span>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge variant="outline">{finding.isDirect ? '직접 의존성' : '전이 의존성'}</Badge>
                  {finding.devOnly ? <Badge variant="outline" title="개발 의존성이라는 이유만으로 위험에서 제외하지 않습니다.">개발 의존성</Badge> : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{finding.fixedVersion ? `수정 버전 ${finding.fixedVersion}` : '패치 미확인'}</p>
              </TableCell>
              <TableCell className="whitespace-normal">
                <div className="flex flex-wrap gap-1">
                  <MatchBadge match={finding.versionMatch} />
                  <ConditionBadge condition={finding.exploitCondition} />
                </div>
                {finding.needsRecheck ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">재확인 필요: {finding.recheckReason}</p> : null}
                {finding.resolvedAt ? <p className="mt-1 text-xs text-muted-foreground">현재 구성에서 미검출 ({formatDate(finding.resolvedAt)})</p> : null}
              </TableCell>
              <TableCell>
                <StatusBadge status={finding.remediationStatus} />
                {finding.reviewDueAt ? <p className="mt-1 text-xs text-muted-foreground">재검토 {formatDate(finding.reviewDueAt)}</p> : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** 대시보드처럼 좁은 칸에 쓰는 목록. 표 대신 한 항목을 두 줄로 보여준다. */
function CompactFindingList({ items }: { items: Finding[] }) {
  return (
    <ul className="divide-y rounded-lg border">
      {items.map((finding) => (
        <li key={finding.id} className="space-y-1.5 p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <PriorityBadge priority={finding.priority} />
            <SeverityBadge severity={finding.severity} score={finding.cvssScore} />
            {finding.malicious ? <MaliciousBadge /> : null}
            {finding.kevListed ? <KevBadge /> : null}
          </div>
          <Link to={`/findings/${finding.id}`} className="block font-medium underline-offset-2 outline-none hover:underline focus-visible:underline">
            {finding.vulnerabilityTitle}
          </Link>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono text-foreground">
              {finding.packageName}@{finding.version}
            </span>
            <span>{finding.isDirect ? '직접 의존성' : '전이 의존성'}</span>
            {finding.devOnly ? <span>개발 의존성</span> : null}
            <span>· {finding.fixedVersion ? `수정 버전 ${finding.fixedVersion}` : '패치 미확인'}</span>
            <span>· {finding.projectName}</span>
          </p>
        </li>
      ))}
    </ul>
  );
}
