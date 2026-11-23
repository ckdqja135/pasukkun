import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { RotateCcw, Save, Search, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { KevBadge, MatchBadge, PatchBadge, PriorityBadge, SeverityBadge } from '@/components/badges';
import { NativeSelect } from '@/components/native-select';
import { Pagination } from '@/components/pagination';
import { EmptyState, ErrorState, LagNote, LoadingState } from '@/components/states';
import { TechPicker } from '@/components/tech-picker';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, unwrap } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { BASIS_LABEL, formatDate, formatEpss, MATCH_LABEL, SEVERITY_LABEL, STATUS_LABEL } from '@/lib/labels';
import { useIngestionStatus, useInterests, useProjects, useTechnologies } from '@/lib/queries';

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const;
const PROJECT_MATCHES = ['AFFECTED', 'UNKNOWN', 'NOT_SCANNED'] as const;
const STATUSES = ['UNREVIEWED', 'IN_REVIEW', 'PLANNED', 'RISK_ACCEPTED', 'DONE'] as const;
type Severity = (typeof SEVERITIES)[number];

const list = (value: string | null) => (value ? value.split(',').filter(Boolean) : []);
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((item) => b.includes(item));

export function FeedPage() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const me = useMe();
  const technologies = useTechnologies();
  const interests = useInterests();
  const projects = useProjects();
  const ingestion = useIngestionStatus();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchText, setSearchText] = useState(params.get('q') ?? '');
  const urlQuery = params.get('q') ?? '';
  // 상단 검색으로 같은 화면에 다시 들어오면 검색어를 맞춘다.
  useEffect(() => setSearchText(urlQuery), [urlQuery]);

  // 화면 필터는 URL 에만 있는 임시 상태다. 처음 들어올 때만 저장된 관심 기술로 채운다.
  const techInitialized = params.has('tech');
  useEffect(() => {
    if (techInitialized || !interests.data || !me.data) return;
    const next = new URLSearchParams(params);
    next.set('tech', interests.data.technologyIds.join(','));
    if (interests.data.technologyIds.length > 0) next.set('mode', me.data.settings.interestMatchMode);
    setParams(next, { replace: true });
  }, [techInitialized, interests.data, me.data, params, setParams]);

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') {
        // tech 는 "비움"과 "아직 초기화 안 됨"을 구분하기 위해 빈 값으로 남긴다.
        if (key === 'tech') next.set('tech', '');
        else next.delete(key);
      } else next.set(key, value);
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next);
  };

  const tech = list(params.get('tech'));
  const mode: 'ALL_GROUPS' | 'ANY_GROUP' = params.get('mode') === 'ANY_GROUP' ? 'ANY_GROUP' : 'ALL_GROUPS';
  const severities = list(params.get('sev')) as Severity[];
  const projectId = params.get('project') ?? '';
  const projectMatch = list(params.get('pmatch')) as (typeof PROJECT_MATCHES)[number][];
  const remediation = list(params.get('rstatus')) as (typeof STATUSES)[number][];
  const page = Number(params.get('page') ?? '1') || 1;
  const sort = (params.get('sort') ?? 'published') as 'published' | 'modified' | 'severity' | 'epss';
  const order: 'asc' | 'desc' = params.get('order') === 'asc' ? 'asc' : 'desc';

  const query = useMemo(
    () => ({
      q: params.get('q') || undefined,
      technologyIds: tech.length ? tech : undefined,
      groupMode: tech.length ? mode : undefined,
      unclassifiedOnly: params.get('unclassified') === '1' ? true : undefined,
      severities: severities.length ? severities : undefined,
      kev: params.get('kev') === '1' ? true : params.get('kev') === '0' ? false : undefined,
      patchAvailable: params.get('patch') === '1' ? true : params.get('patch') === '0' ? false : undefined,
      publishedFrom: params.get('from') || undefined,
      publishedTo: params.get('to') || undefined,
      modifiedFrom: params.get('mfrom') || undefined,
      modifiedTo: params.get('mto') || undefined,
      includeWithdrawn: params.get('withdrawn') === '1' ? true : undefined,
      projectId: projectId || undefined,
      projectMatch: projectId && projectMatch.length ? projectMatch : undefined,
      remediationStatuses: projectId && remediation.length ? remediation : undefined,
      sort,
      order,
      page,
      pageSize: 25,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params.toString()],
  );

  const feed = useQuery({
    queryKey: ['vulnerabilities', query],
    queryFn: () => unwrap(api.GET('/api/v1/vulnerabilities', { params: { query } })),
    enabled: techInitialized,
    placeholderData: keepPreviousData,
  });

  const saveInterests = useMutation({
    mutationFn: () => unwrap(api.PUT('/api/v1/me/interests', { body: { technologyIds: tech } })),
    onSuccess: (data) => {
      queryClient.setQueryData(['interests'], data);
      toast.success('현재 선택을 관심 기술로 저장했습니다.');
    },
    onError: (error) => toast.error(error.message),
  });

  const techById = new Map((technologies.data ?? []).map((t) => [t.id, t]));
  const saved = interests.data?.technologyIds ?? [];
  const differsFromSaved = techInitialized && !sameSet(tech, saved);
  // OSV(검사 때 조회)와 KISA(국내 공지, 피드 목록에 쓰지 않음)는 피드 완전성과 무관하다.
  const feedSources = (ingestion.data?.sources ?? []).filter((s) => s.key !== 'OSV' && s.key !== 'KISA');
  const initializing = feedSources.filter((s) => s.status === 'NEVER_RUN');
  const lagging = feedSources.filter((s) => s.status !== 'NEVER_RUN' && (s.lagging || s.status === 'FAILING'));

  const chips: Array<{ key: string; label: string; clear: () => void }> = [
    ...tech.map((id) => ({ key: `tech-${id}`, label: techById.get(id)?.name ?? id, clear: () => update({ tech: tech.filter((t) => t !== id).join(',') }) })),
    ...severities.map((s) => ({ key: `sev-${s}`, label: `심각도 ${SEVERITY_LABEL[s]}`, clear: () => update({ sev: severities.filter((x) => x !== s).join(',') }) })),
    ...(params.get('q') ? [{ key: 'q', label: `검색: ${params.get('q')}`, clear: () => { setSearchText(''); update({ q: null }); } }] : []),
    ...(params.get('kev') ? [{ key: 'kev', label: params.get('kev') === '1' ? 'KEV 등재' : 'KEV 미등재', clear: () => update({ kev: null }) }] : []),
    ...(params.get('patch') ? [{ key: 'patch', label: params.get('patch') === '1' ? '수정 버전 확인' : '패치 미확인', clear: () => update({ patch: null }) }] : []),
    ...(params.get('from') || params.get('to') ? [{ key: 'pub', label: `공개일 ${params.get('from') ?? ''}~${params.get('to') ?? ''}`, clear: () => update({ from: null, to: null }) }] : []),
    ...(params.get('mfrom') || params.get('mto') ? [{ key: 'mod', label: `수정일 ${params.get('mfrom') ?? ''}~${params.get('mto') ?? ''}`, clear: () => update({ mfrom: null, mto: null }) }] : []),
    ...(params.get('unclassified') === '1' ? [{ key: 'unc', label: '미분류만', clear: () => update({ unclassified: null }) }] : []),
    ...(params.get('withdrawn') === '1' ? [{ key: 'wd', label: '철회 공지 포함', clear: () => update({ withdrawn: null }) }] : []),
    ...(projectId ? [{ key: 'project', label: `프로젝트: ${projects.data?.find((p) => p.id === projectId)?.name ?? ''}`, clear: () => update({ project: null, pmatch: null, rstatus: null }) }] : []),
    ...projectMatch.map((m) => ({ key: `pm-${m}`, label: MATCH_LABEL[m], clear: () => update({ pmatch: projectMatch.filter((x) => x !== m).join(',') }) })),
    ...remediation.map((s) => ({ key: `rs-${s}`, label: `조치 ${STATUS_LABEL[s]}`, clear: () => update({ rstatus: remediation.filter((x) => x !== s).join(',') }) })),
  ];

  const toggleIn = (key: string, current: string[], value: string) =>
    update({ [key]: (current.includes(value) ? current.filter((x) => x !== value) : [...current, value]).join(',') });

  return (
    <>
      <PageHeader
        title="취약점 피드"
        description={
          <>
            서비스가 수집한 범위(최근 {ingestion.data?.initialFeedDays ?? 90}일 동안 공개되거나 수정된 공지 + 프로젝트 검사에서 확인된 공지, 총{' '}
            {(ingestion.data?.vulnerabilityCount ?? 0).toLocaleString('ko-KR')}건)를 보여줍니다. 관심 기술 일치는 관련 공지라는 뜻이며,
            프로젝트가 실제로 영향받는지는 프로젝트 검사 결과로 확인합니다.
          </>
        }
      />

      {initializing.length > 0 ? (
        <Alert role="status">
          <AlertTitle>초기 수집 진행 중</AlertTitle>
          <AlertDescription>
            {initializing.map((s) => s.key).join(', ')} 의 첫 수집이 아직 끝나지 않았습니다. 지금 보이는 목록은 전체가 아니며, 심각도·KEV·EPSS 정보가 비어 있을 수 있습니다.
          </AlertDescription>
        </Alert>
      ) : null}
      {lagging.length > 0 ? (
        <LagNote>
          {lagging.map((s) => s.key).join(', ')} 수집이 지연되거나 실패하고 있습니다. 최근 공지가 빠져 있을 수 있습니다.{' '}
          <Link to="/status" className="underline underline-offset-2">
            수집 상태 보기
          </Link>
        </LagNote>
      ) : null}

      <Card>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <form
              className="flex min-w-64 flex-1 items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                update({ q: searchText.trim() || null });
              }}
            >
              <div className="flex-1 space-y-1">
                <Label htmlFor="feed-q">검색</Label>
                <Input id="feed-q" placeholder="CVE / GHSA 식별자, 패키지명, 제목" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
              </div>
              <Button type="submit" variant="outline">
                <Search aria-hidden /> 검색
              </Button>
            </form>
            <div className="space-y-1">
              <Label htmlFor="feed-sort">정렬</Label>
              <NativeSelect id="feed-sort" className="w-40" value={`${sort}:${order}`} onChange={(e) => { const [s, o] = e.target.value.split(':'); update({ sort: s, order: o }); }}>
                <option value="published:desc">공개일 최신순</option>
                <option value="published:asc">공개일 오래된순</option>
                <option value="modified:desc">최근 수정순</option>
                <option value="severity:desc">심각도 높은순</option>
                <option value="epss:desc">EPSS 높은순</option>
              </NativeSelect>
            </div>
            <Button variant={pickerOpen ? 'default' : 'outline'} onClick={() => setPickerOpen((open) => !open)} aria-expanded={pickerOpen} aria-controls="feed-filters">
              <SlidersHorizontal aria-hidden /> 필터 {chips.length ? `(${chips.length})` : ''}
            </Button>
          </div>

          {pickerOpen ? (
            <div id="feed-filters" className="grid grid-cols-1 gap-5 border-t pt-4 lg:grid-cols-[1fr_22rem]">
              <section aria-labelledby="feed-tech" className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id="feed-tech" className="text-sm font-medium">
                    관심 기술
                  </h2>
                  <div className="flex items-center gap-2 text-xs">
                    <Label htmlFor="feed-mode" className="text-xs text-muted-foreground">
                      그룹 간 결합
                    </Label>
                    <NativeSelect id="feed-mode" className="h-7 w-44 text-xs" value={mode} onChange={(e) => update({ mode: e.target.value })}>
                      <option value="ALL_GROUPS">모든 그룹 충족 (AND)</option>
                      <option value="ANY_GROUP">하나라도 일치 (OR)</option>
                    </NativeSelect>
                  </div>
                </div>
                {technologies.data ? (
                  <TechPicker technologies={technologies.data} selected={tech} onChange={(ids) => update({ tech: ids.join(',') })} />
                ) : (
                  <LoadingState />
                )}
                <p className="text-xs text-muted-foreground">
                  같은 그룹 안에서는 하나라도 일치하면 되고(OR), 서로 다른 그룹 사이는 위 설정을 따릅니다. 아무것도 고르지 않으면 수집된 전체를 보여줍니다.
                </p>
              </section>

              <section aria-label="추가 필터" className="space-y-3">
                <fieldset className="space-y-1.5">
                  <legend className="text-xs font-medium text-muted-foreground">심각도</legend>
                  <div className="flex flex-wrap gap-1.5">
                    {SEVERITIES.map((s) => (
                      <Button key={s} size="sm" variant={severities.includes(s) ? 'default' : 'outline'} aria-pressed={severities.includes(s)} onClick={() => toggleIn('sev', severities, s)}>
                        {SEVERITY_LABEL[s]}
                      </Button>
                    ))}
                  </div>
                </fieldset>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="f-kev" className="text-xs">실제 악용 확인 (KEV)</Label>
                    <NativeSelect id="f-kev" value={params.get('kev') ?? ''} onChange={(e) => update({ kev: e.target.value || null })}>
                      <option value="">전체</option>
                      <option value="1">등재됨</option>
                      <option value="0">미등재</option>
                    </NativeSelect>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="f-patch" className="text-xs">패치 제공</Label>
                    <NativeSelect id="f-patch" value={params.get('patch') ?? ''} onChange={(e) => update({ patch: e.target.value || null })}>
                      <option value="">전체</option>
                      <option value="1">수정 버전 확인</option>
                      <option value="0">패치 미확인</option>
                    </NativeSelect>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="f-from" className="text-xs">공개일 시작</Label>
                    <Input id="f-from" type="date" value={params.get('from') ?? ''} onChange={(e) => update({ from: e.target.value || null })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="f-to" className="text-xs">공개일 끝</Label>
                    <Input id="f-to" type="date" value={params.get('to') ?? ''} onChange={(e) => update({ to: e.target.value || null })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="f-mfrom" className="text-xs">최근 수정일 시작</Label>
                    <Input id="f-mfrom" type="date" value={params.get('mfrom') ?? ''} onChange={(e) => update({ mfrom: e.target.value || null })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="f-mto" className="text-xs">최근 수정일 끝</Label>
                    <Input id="f-mto" type="date" value={params.get('mto') ?? ''} onChange={(e) => update({ mto: e.target.value || null })} />
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant={params.get('unclassified') === '1' ? 'default' : 'outline'} aria-pressed={params.get('unclassified') === '1'} onClick={() => update({ unclassified: params.get('unclassified') === '1' ? null : '1' })}>
                    미분류만 보기
                  </Button>
                  <Button size="sm" variant={params.get('withdrawn') === '1' ? 'default' : 'outline'} aria-pressed={params.get('withdrawn') === '1'} onClick={() => update({ withdrawn: params.get('withdrawn') === '1' ? null : '1' })}>
                    철회 공지 포함
                  </Button>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="f-project" className="text-xs">프로젝트와의 관련 상태 보기</Label>
                  <NativeSelect id="f-project" value={projectId} onChange={(e) => update({ project: e.target.value || null, pmatch: null, rstatus: null })}>
                    <option value="">선택 안 함</option>
                    {(projects.data ?? []).map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                {projectId ? (
                  <>
                    <fieldset className="space-y-1.5">
                      <legend className="text-xs font-medium text-muted-foreground">버전 매칭 결과</legend>
                      <div className="flex flex-wrap gap-1.5">
                        {PROJECT_MATCHES.map((m) => (
                          <Button key={m} size="sm" variant={projectMatch.includes(m) ? 'default' : 'outline'} aria-pressed={projectMatch.includes(m)} onClick={() => toggleIn('pmatch', projectMatch, m)}>
                            {MATCH_LABEL[m]}
                          </Button>
                        ))}
                      </div>
                    </fieldset>
                    <fieldset className="space-y-1.5">
                      <legend className="text-xs font-medium text-muted-foreground">조치 상태</legend>
                      <div className="flex flex-wrap gap-1.5">
                        {STATUSES.map((s) => (
                          <Button key={s} size="sm" variant={remediation.includes(s) ? 'default' : 'outline'} aria-pressed={remediation.includes(s)} onClick={() => toggleIn('rstatus', remediation, s)}>
                            {STATUS_LABEL[s]}
                          </Button>
                        ))}
                      </div>
                    </fieldset>
                  </>
                ) : null}
              </section>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-1.5 border-t pt-3" aria-label="적용된 필터">
            {chips.length === 0 ? (
              <span className="text-sm text-muted-foreground">필터 없음 - 수집된 전체 취약점</span>
            ) : (
              <>
                {chips.map((chip) => (
                  <Badge key={chip.key} variant="secondary" className="h-6 gap-1 pr-1">
                    {chip.label}
                    <button type="button" onClick={chip.clear} aria-label={`${chip.label} 필터 해제`} className="rounded-sm p-0.5 outline-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring">
                      <X className="size-3" aria-hidden />
                    </button>
                  </Badge>
                ))}
                <Button size="sm" variant="ghost" onClick={() => { setSearchText(''); setParams(new URLSearchParams({ tech: '' })); }}>
                  <RotateCcw aria-hidden /> 전체 초기화
                </Button>
              </>
            )}
          </div>

          {differsFromSaved ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
              <span>
                지금 선택은 이 화면에만 적용되는 임시 필터입니다. 저장된 관심 기술({saved.length}개)과 다르며, 알림 조건은 저장된 관심 기술을 따릅니다.
              </span>
              <Button size="sm" variant="outline" onClick={() => update({ tech: saved.join(','), mode: me.data?.settings.interestMatchMode ?? 'ALL_GROUPS' })}>
                저장된 관심 기술로 되돌리기
              </Button>
              <Button size="sm" variant="outline" disabled={saveInterests.isPending} onClick={() => saveInterests.mutate()}>
                <Save aria-hidden /> 현재 선택을 관심 기술로 저장
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {feed.isError ? (
        <ErrorState error={feed.error} onRetry={() => feed.refetch()} />
      ) : !feed.data ? (
        <LoadingState />
      ) : feed.data.total === 0 ? (
        <EmptyState
          title="조건에 맞는 취약점이 없습니다"
          description={
            chips.length
              ? '수집된 범위 안에서 이 필터에 맞는 항목이 없다는 뜻입니다. 필터를 줄이거나 그룹 간 결합을 "하나라도 일치"로 바꿔 보세요.'
              : '아직 수집된 취약점이 없습니다. 초기 수집이 진행 중일 수 있습니다.'
          }
        />
      ) : (
        <div className="space-y-3" aria-busy={feed.isFetching}>
          <div className="overflow-x-auto rounded-lg border">
            <Table className="table-fixed min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-36">심각도</TableHead>
                  <TableHead>취약점</TableHead>
                  <TableHead className="w-56">영향 기술 · 패키지</TableHead>
                  <TableHead className="w-28">공개일</TableHead>
                  <TableHead className="w-44">악용 · 패치</TableHead>
                  {projectId ? <TableHead className="w-44">프로젝트 관련 상태</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {feed.data.items.map((item) => (
                  <TableRow key={item.id} className="align-top">
                    <TableCell>
                      <SeverityBadge severity={item.severity} score={item.cvssScore} />
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <Link to={`/vulnerabilities/${item.id}`} className="font-medium underline-offset-2 outline-none hover:underline focus-visible:underline">
                        {item.title}
                      </Link>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        <span className="font-mono">{item.identifiers.slice(0, 3).join(' · ')}</span>
                        {item.withdrawn ? <Badge variant="outline">철회됨</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="flex flex-wrap gap-1">
                        {item.technologies.length === 0 ? (
                          <Badge variant="outline" title="기술 카탈로그에 매핑되지 않은 항목입니다.">미분류</Badge>
                        ) : (
                          item.technologies.slice(0, 4).map((t) => (
                            <Badge key={t.id} variant="secondary" title={`근거: ${BASIS_LABEL[t.basis]}`}>
                              {t.name}
                            </Badge>
                          ))
                        )}
                      </div>
                      {item.packages.length ? (
                        <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={item.packages.join(', ')}>
                          {item.packages.slice(0, 2).join(', ')}
                          {item.packageCount > 2 ? ` 외 ${item.packageCount - 2}` : ''}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatDate(item.publishedAt)}</TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="flex flex-wrap gap-1">
                        {item.kevAddedAt ? <KevBadge /> : null}
                        <PatchBadge status={item.patchStatus} />
                      </div>
                      {item.epssScore !== null ? (
                        <p className="mt-1 text-xs text-muted-foreground" title={`30일 내 악용 활동이 관측될 확률 추정 (기준일 ${item.epssDate ?? '-'})`}>
                          EPSS {formatEpss(item.epssScore)}
                        </p>
                      ) : null}
                    </TableCell>
                    {projectId ? (
                      <TableCell className="whitespace-normal">
                        {item.projectRelation ? (
                          <div className="flex flex-col items-start gap-1">
                            <MatchBadge match={item.projectRelation.state} />
                            {item.projectRelation.priority ? <PriorityBadge priority={item.projectRelation.priority} /> : null}
                            {item.projectRelation.findingIds[0] ? (
                              <Link to={`/findings/${item.projectRelation.findingIds[0]}`} className="text-xs text-primary underline underline-offset-2">
                                분석 결과 보기
                              </Link>
                            ) : null}
                          </div>
                        ) : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination page={feed.data.page} pageSize={feed.data.pageSize} total={feed.data.total} onPage={(next) => update({ page: String(next) })} />
        </div>
      )}
    </>
  );
}
