import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { PageHeader } from '@/components/app-shell';
import { KevBadge, SeverityBadge } from '@/components/badges';
import { FindingTable } from '@/components/finding-table';
import { SourceStatusList } from '@/components/source-status';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, unwrap } from '@/lib/api';
import { formatDate, formatRelative, SCAN_STATUS_LABEL } from '@/lib/labels';

/** 카드가 쓰는 필터를 그대로 목록 화면의 주소로 바꾼다 (숫자와 목록이 같은 기준을 쓰게 하기 위함). */
export function findingQueryToSearch(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    params.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return params.toString();
}

export function DashboardPage() {
  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => unwrap(api.GET('/api/v1/dashboard/summary')),
    refetchInterval: 30_000,
  });

  if (dashboard.isError) return <ErrorState error={dashboard.error} onRetry={() => dashboard.refetch()} />;
  if (!dashboard.data) return <LoadingState />;
  const data = dashboard.data;
  const urgentCard = data.cards.find((card) => card.key === 'urgent');

  return (
    <>
      <PageHeader title="대시보드" description="내 프로젝트의 미조치 항목과 최근 공지, 데이터 수집 상태를 한눈에 봅니다." />

      <section aria-label="요약" className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {data.cards.map((card) => (
          <Link
            key={card.key}
            to={`/findings?${findingQueryToSearch(card.query)}`}
            className="rounded-xl border bg-card p-4 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
            title={card.description}
          >
            <p className="text-sm text-muted-foreground">{card.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{card.count.toLocaleString('ko-KR')}</p>
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{card.description}</p>
          </Link>
        ))}
      </section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>긴급 검토 항목</CardTitle>
              <CardDescription>위 '긴급 검토' 카드와 같은 기준입니다.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.urgentFindings.length === 0 ? (
                <EmptyState
                  title="긴급 검토 항목이 없습니다"
                  description={data.projects.length === 0 ? '프로젝트를 등록하고 package-lock.json 을 올리면 분석 결과가 여기에 나타납니다.' : '본 검사 범위에서 긴급으로 분류된 미조치 항목이 없습니다.'}
                  action={
                    data.projects.length === 0 ? (
                      <Button asChild size="sm">
                        <Link to="/projects">프로젝트 등록</Link>
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <>
                  <FindingTable items={data.urgentFindings} compact />
                  {urgentCard && urgentCard.count > data.urgentFindings.length ? (
                    <Button asChild variant="ghost" size="sm">
                      <Link to={`/findings?${findingQueryToSearch(urgentCard.query)}`}>
                        전체 {urgentCard.count}건 보기 <ArrowRight aria-hidden />
                      </Link>
                    </Button>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>최근 공개된 취약점</CardTitle>
              <CardDescription>
                {data.recentUsesInterests ? '저장된 관심 기술 기준입니다. 관련 공지일 뿐 프로젝트 영향을 뜻하지 않습니다.' : '저장된 관심 기술이 없어 수집된 전체에서 보여줍니다.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.recentVulnerabilities.length === 0 ? (
                <EmptyState
                  title="표시할 취약점이 없습니다"
                  description={
                    data.recentUsesInterests && (data.recentQuery as { groupMode?: string }).groupMode !== 'ANY_GROUP'
                      ? '저장된 관심 기술이 "모든 그룹에 해당(AND)" 방식이라, 고른 언어·프레임워크·런타임 등을 한 공지가 모두 만족해야 나옵니다. 각 기술의 공지를 모두 보려면 관심 기술 설정에서 "하나라도 해당(OR)"으로 바꿔 보세요.'
                      : data.recentUsesInterests
                        ? '저장된 관심 기술과 일치하는 최근 공지가 없습니다.'
                        : '아직 수집된 공지가 없습니다. 초기 수집이 진행 중일 수 있습니다.'
                  }
                  action={
                    data.recentUsesInterests ? (
                      <Button asChild size="sm" variant="outline">
                        <Link to="/interests">관심 기술 설정</Link>
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <ul className="divide-y">
                  {data.recentVulnerabilities.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                      <SeverityBadge severity={item.severity} score={item.cvssScore} />
                      <Link to={`/vulnerabilities/${item.id}`} className="min-w-0 flex-1 truncate text-sm font-medium underline-offset-2 hover:underline">
                        {item.title}
                      </Link>
                      {item.kevAddedAt ? <KevBadge /> : null}
                      <span className="text-xs text-muted-foreground">{formatDate(item.publishedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <Button asChild variant="ghost" size="sm" className="mt-2">
                <Link to="/vulnerabilities">
                  피드에서 더 보기 <ArrowRight aria-hidden />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>내 프로젝트</CardTitle>
              <CardDescription>{data.activeScans > 0 ? `검사 ${data.activeScans}건 진행 중` : '최근 검사 상태'}</CardDescription>
            </CardHeader>
            <CardContent>
              {data.projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">등록된 프로젝트가 없습니다.</p>
              ) : (
                <ul className="divide-y text-sm">
                  {data.projects.map((project) => (
                    <li key={project.id} className="py-2">
                      <div className="flex items-center justify-between gap-2">
                        <Link to={`/projects/${project.id}`} className="truncate font-medium underline-offset-2 hover:underline">
                          {project.name}
                        </Link>
                        {project.urgent > 0 ? <Badge variant="destructive">긴급 {project.urgent}</Badge> : null}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {!project.hasSnapshot
                          ? '구성 미등록 - 검사 전'
                          : project.lastScanStatus
                            ? `${SCAN_STATUS_LABEL[project.lastScanStatus]} · ${formatRelative(project.lastScanAt)} · 미조치 ${project.open}`
                            : '검사 전'}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>데이터 수집 상태</CardTitle>
              <CardDescription>수집 실패는 '취약점 없음'을 뜻하지 않습니다.</CardDescription>
            </CardHeader>
            <CardContent>
              <SourceStatusList sources={data.sources} />
              <Button asChild variant="ghost" size="sm" className="mt-2">
                <Link to="/status">
                  자세히 <ArrowRight aria-hidden />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}
