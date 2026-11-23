import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { PageHeader } from '@/components/app-shell';
import { PriorityBadge } from '@/components/badges';
import { NativeSelect } from '@/components/native-select';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, unwrap } from '@/lib/api';
import { useProjects } from '@/lib/queries';

export function PackagesPage() {
  const projects = useProjects();
  const [projectId, setProjectId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const groups = useQuery({
    queryKey: ['remediation-packages', projectId],
    queryFn: () => unwrap(api.GET('/api/v1/remediation/packages', { params: { query: projectId ? { projectId } : {} } })),
  });

  return (
    <>
      <PageHeader
        title="패키지별 조치"
        description="영향 버전 일치 항목을 패키지와 설치 버전으로 묶었습니다. 어떤 버전으로 올리면 몇 건이 해소되는지 보고, 효과가 큰 업그레이드부터 처리하세요."
        actions={
          <NativeSelect aria-label="프로젝트" className="w-56" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">모든 프로젝트</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </NativeSelect>
        }
      />
      {groups.isError ? (
        <ErrorState error={groups.error} onRetry={() => groups.refetch()} />
      ) : !groups.data ? (
        <LoadingState />
      ) : groups.data.items.length === 0 ? (
        <EmptyState title="조치할 패키지가 없습니다" description="현재 구성에서 영향 버전 일치 항목이 없습니다. 검사를 하지 않은 프로젝트는 여기에 나오지 않습니다." />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead>패키지</TableHead>
                <TableHead className="w-64">설치 버전 → 올릴 버전</TableHead>
                <TableHead className="w-44">해소되는 항목</TableHead>
                <TableHead className="w-56">영향 프로젝트</TableHead>
                <TableHead className="w-32">최고 우선순위</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.data.items.map((group) => {
                const key = `${group.packageName}@${group.installedVersion}`;
                const expanded = open === key;
                const fixable = group.findingCount - group.withoutFixCount;
                return [
                  <TableRow key={key} className="cursor-pointer align-top" onClick={() => setOpen(expanded ? null : key)}>
                    <TableCell className="whitespace-normal">
                      <span className="flex items-center gap-1.5 font-medium">
                        {expanded ? <ChevronDown aria-hidden className="size-4" /> : <ChevronRight aria-hidden className="size-4" />}
                        {group.packageName}
                        {group.hasKev ? <Badge variant="destructive">KEV</Badge> : null}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <span className="inline-flex items-center gap-1.5">
                        {group.installedVersion}
                        <ArrowRight aria-hidden className="size-3 text-muted-foreground" />
                        {group.targetVersion ?? <span className="font-sans text-muted-foreground">패치 미확인</span>}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm whitespace-normal">
                      {group.targetVersion ? `${fixable}건 해소` : '-'}
                      {group.withoutFixCount > 0 ? <p className="text-xs text-muted-foreground">패치 미확인 {group.withoutFixCount}건</p> : null}
                    </TableCell>
                    <TableCell className="text-sm whitespace-normal">
                      {group.projects.slice(0, 3).map((project) => project.name).join(', ')}
                      {group.projects.length > 3 ? ` 외 ${group.projects.length - 3}개` : ''}
                    </TableCell>
                    <TableCell>
                      <PriorityBadge priority={group.topPriority} />
                    </TableCell>
                  </TableRow>,
                  expanded ? (
                    <TableRow key={`${key}:detail`} className="bg-muted/30 hover:bg-muted/30">
                      <TableCell colSpan={5} className="whitespace-normal">
                        <ul className="space-y-1.5 py-1 text-sm">
                          {group.findings.map((finding) => (
                            <li key={finding.findingId} className="flex flex-wrap items-center gap-2">
                              <PriorityBadge priority={finding.priority} />
                              <Link to={`/findings/${finding.findingId}`} className="underline-offset-2 hover:underline">
                                {finding.title}
                              </Link>
                              <span className="text-xs text-muted-foreground">
                                {finding.projectName} · 수정 버전 {finding.fixedVersion ?? '미확인'}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </TableCell>
                    </TableRow>
                  ) : null,
                ];
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {groups.data?.truncated ? <p className="text-xs text-destructive">영향 항목이 너무 많아 일부만 묶었습니다. 프로젝트를 골라 좁혀 보세요.</p> : null}
      <p className="text-xs text-muted-foreground">
        올릴 버전은 이 설치 버전의 항목들에서 확인된 수정 버전 중 가장 높은 것입니다. 상위 계열로만 수정된 경우 호환성을 확인한 뒤 올리세요. 올린 뒤 새 lockfile 로 검사해야 해소로 바뀝니다.
      </p>
    </>
  );
}
