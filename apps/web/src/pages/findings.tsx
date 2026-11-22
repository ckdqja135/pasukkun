import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/app-shell';
import { FindingFilters, findingFilterToQuery, parseFindingFilter, writeFindingFilter } from '@/components/finding-filters';
import { FindingTable } from '@/components/finding-table';
import { NativeSelect } from '@/components/native-select';
import { Pagination } from '@/components/pagination';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { api, unwrap } from '@/lib/api';
import { useProjects } from '@/lib/queries';

export function FindingsPage() {
  const [params, setParams] = useSearchParams();
  const projects = useProjects();
  const filter = parseFindingFilter(params);
  const projectId = params.get('projectId') ?? '';
  const page = Number(params.get('page') ?? '1') || 1;
  const query = { ...findingFilterToQuery(filter), projectId: projectId || undefined, page, pageSize: 25 };

  const findings = useQuery({
    queryKey: ['findings', query],
    queryFn: () => unwrap(api.GET('/api/v1/findings', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="분석 결과"
        description="내 모든 프로젝트의 영향도 분석 결과입니다. 대시보드의 숫자를 누르면 같은 필터가 적용된 이 목록으로 옵니다."
      />
      <Card>
        <CardContent className="space-y-4">
          <div className="max-w-xs space-y-1">
            <Label htmlFor="fd-project" className="text-xs">
              프로젝트
            </Label>
            <NativeSelect
              id="fd-project"
              value={projectId}
              onChange={(e) => {
                const next = new URLSearchParams(params);
                if (e.target.value) next.set('projectId', e.target.value);
                else next.delete('projectId');
                next.delete('page');
                setParams(next);
              }}
            >
              <option value="">전체 프로젝트</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <FindingFilters value={filter} onChange={(value) => setParams(writeFindingFilter(params, value))} />
        </CardContent>
      </Card>

      {findings.isError ? (
        <ErrorState error={findings.error} onRetry={() => findings.refetch()} />
      ) : !findings.data ? (
        <LoadingState />
      ) : findings.data.total === 0 ? (
        <EmptyState
          title="조건에 맞는 분석 결과가 없습니다"
          description="검사를 마친 프로젝트 범위에서 이 조건에 해당하는 항목이 없다는 뜻입니다. 검사하지 않았거나 지원하지 않는 범위는 포함되지 않습니다."
        />
      ) : (
        <div className="space-y-3" aria-busy={findings.isFetching}>
          <FindingTable items={findings.data.items} />
          <Pagination
            page={findings.data.page}
            pageSize={findings.data.pageSize}
            total={findings.data.total}
            onPage={(next) => {
              const copy = new URLSearchParams(params);
              copy.set('page', String(next));
              setParams(copy);
            }}
          />
        </div>
      )}
    </>
  );
}
