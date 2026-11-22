import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Play, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { FindingFilters, findingFilterToQuery, parseFindingFilter, writeFindingFilter } from '@/components/finding-filters';
import { FindingTable } from '@/components/finding-table';
import { GithubMark } from '@/components/github-mark';
import { GithubSourceCard, snapshotLabel } from '@/components/github-source-card';
import { NativeSelect } from '@/components/native-select';
import { Pagination } from '@/components/pagination';
import { ProjectForm } from '@/components/project-form';
import { SnapshotUploader } from '@/components/snapshot-uploader';
import { EmptyState, ErrorState, LoadingState, UnsupportedNote } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, unwrap, type Schemas } from '@/lib/api';
import { ENVIRONMENT_LABEL, EXPOSURE_LABEL, formatDateTime, formatRelative, SCAN_STATUS_LABEL } from '@/lib/labels';

type Scan = Schemas['ScanSummaryDto'];
interface ScanScope {
  packagesInSnapshot?: number;
  distinctVersionsQueried?: number;
  skipped?: Array<{ reason: string; count: number }>;
  sources?: string[];
  notCovered?: string[];
}
interface ScanSummary {
  affected?: number;
  unknown?: number;
  newFindings?: number;
  resolved?: number;
  problems?: string[];
}

const scanActive = (scan: Scan | null | undefined) => scan?.status === 'QUEUED' || scan?.status === 'RUNNING';

export function ProjectDetailPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const tab = params.get('tab') ?? 'findings';
  const [confirmDelete, setConfirmDelete] = useState(false);

  const project = useQuery({
    queryKey: ['project', id],
    queryFn: () => unwrap(api.GET('/api/v1/projects/{id}', { params: { path: { id } } })),
    // 검사가 진행 중이면 상태를 주기적으로 다시 읽는다.
    refetchInterval: (query) => (scanActive(query.state.data?.lastScan) ? 2000 : false),
  });

  const requestScan = useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/projects/{id}/scans', { params: { path: { id } } })),
    onSuccess: () => {
      toast.success('검사를 요청했습니다.');
      void queryClient.invalidateQueries({ queryKey: ['project', id] });
      void queryClient.invalidateQueries({ queryKey: ['scans', id] });
    },
    onError: (error) => toast.error(error.message),
  });

  const update = useMutation({
    mutationFn: (body: Schemas['ProjectUpdateDto']) => unwrap(api.PATCH('/api/v1/projects/{id}', { params: { path: { id } }, body })),
    onSuccess: (data) => {
      queryClient.setQueryData(['project', id], data);
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('프로젝트 정보를 저장했습니다. 환경이 바뀌었다면 우선순위를 다시 계산합니다.');
    },
    onError: (error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/v1/projects/{id}', { params: { path: { id } } })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('프로젝트를 삭제했습니다.');
      void navigate('/projects');
    },
    onError: (error) => toast.error(error.message),
  });

  if (project.isError) return <ErrorState error={project.error} onRetry={() => project.refetch()} />;
  if (!project.data) return <LoadingState />;
  const p = project.data;
  const scan = p.lastScan;
  const setTab = (next: string) => {
    const copy = new URLSearchParams(params);
    copy.set('tab', next);
    copy.delete('page');
    setParams(copy);
  };

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/projects">
          <ArrowLeft aria-hidden /> 프로젝트 목록
        </Link>
      </Button>
      <PageHeader
        title={p.name}
        description={p.description || undefined}
        actions={
          <Button onClick={() => requestScan.mutate()} disabled={!p.currentSnapshot || requestScan.isPending || scanActive(scan)}>
            <Play aria-hidden /> {scanActive(scan) ? '검사 중…' : '검사 실행'}
          </Button>
        }
      />
      <div className="flex flex-wrap gap-1.5">
        {p.environments.length === 0 ? <Badge variant="outline">환경 미지정</Badge> : p.environments.map((e) => <Badge key={e} variant="secondary">{ENVIRONMENT_LABEL[e]}</Badge>)}
        <Badge variant="outline">인터넷 노출: {EXPOSURE_LABEL[p.exposure]}</Badge>
        {p.github ? (
          <Badge variant="outline" className="gap-1">
            <GithubMark className="size-3" /> {p.github.fullName}
          </Badge>
        ) : null}
        {p.runtime ? <Badge variant="outline">{p.runtime} {p.runtimeVersion}</Badge> : null}
        {p.os ? <Badge variant="outline">{[p.os, p.distro, p.arch].filter(Boolean).join(' · ')}</Badge> : null}
      </div>

      <ScanBanner project={p} />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="findings">분석 결과</TabsTrigger>
          <TabsTrigger value="config">구성 · 의존성</TabsTrigger>
          <TabsTrigger value="scans">검사 이력</TabsTrigger>
          <TabsTrigger value="overview">프로젝트 정보</TabsTrigger>
        </TabsList>

        <TabsContent value="findings" className="space-y-4">
          <ProjectFindings projectId={id} scan={scan} hasSnapshot={Boolean(p.currentSnapshot)} />
        </TabsContent>

        <TabsContent value="config" className="space-y-6">
          <GithubSourceCard project={p} />
          <Card>
            <CardHeader>
              <CardTitle>{p.github ? 'lockfile 직접 올리기' : '구성 등록'}</CardTitle>
              <CardDescription>
                {p.github
                  ? '필요하면 lockfile 을 직접 올릴 수도 있습니다. 저장소의 lockfile 이 바뀌면 다음 확인 때 그 내용으로 다시 등록됩니다.'
                  : '새 구성을 저장하면 스냅샷으로 남고, 그 구성으로 검사를 시작합니다.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SnapshotUploader projectId={id} />
            </CardContent>
          </Card>
          <SnapshotSection projectId={id} currentSnapshotId={p.currentSnapshot?.id ?? null} />
        </TabsContent>

        <TabsContent value="scans">
          <ScanHistory projectId={id} />
        </TabsContent>

        <TabsContent value="overview" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>프로젝트 정보</CardTitle>
            </CardHeader>
            <CardContent>
              <ProjectForm
                key={p.updatedAt}
                initial={{ ...p, environments: p.environments as ('PRODUCTION' | 'DEVELOPMENT' | 'TEST')[] }}
                submitLabel="저장"
                pending={update.isPending}
                onSubmit={(value) => update.mutate(value)}
              />
            </CardContent>
          </Card>
          <UnsupportedNote title="런타임 · OS 는 자동 판정하지 않습니다">
            등록한 런타임과 운영체제 버전은 기록과 수동 검토용입니다. 관련 공지는 취약점 상세의 '수동 검토 대상'으로 안내하며, 해당 버전이 영향을 받는지는
            공지 원문과 대조해 직접 확인해야 합니다.
          </UnsupportedNote>
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle>프로젝트 삭제</CardTitle>
              <CardDescription>구성 스냅샷, 검사 이력, 분석 결과와 검토 기록이 모두 삭제됩니다.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 aria-hidden /> 삭제
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>"{p.name}" 을 삭제할까요?</DialogTitle>
            <DialogDescription>되돌릴 수 없습니다. 검토 기록과 조치 이력도 함께 삭제됩니다.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              취소
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
              삭제
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 최근 검사에 사용된 구성과 시각, 진행 상태 */
function ScanBanner({ project }: { project: Schemas['ProjectDto'] }) {
  const scan = project.lastScan;
  if (!project.currentSnapshot) {
    return (
      <Alert>
        <AlertTitle>검사 전 - 구성이 등록되지 않았습니다</AlertTitle>
        <AlertDescription>'구성 · 의존성' 탭에서 package-lock.json 을 올리거나 패키지를 직접 입력하세요. 구성이 없으면 분석 결과도 없습니다.</AlertDescription>
      </Alert>
    );
  }
  if (!scan) return null;
  const summary = (scan.summary ?? {}) as ScanSummary;
  if (scanActive(scan)) {
    return (
      <Alert role="status" aria-live="polite">
        <AlertTitle>{SCAN_STATUS_LABEL[scan.status]}</AlertTitle>
        <AlertDescription>
          구성 #{scan.snapshotSeq} 을 검사하고 있습니다{scan.packagesTotal ? ` (패키지 버전 ${scan.packagesTotal.toLocaleString('ko-KR')}개)` : ''}. 끝날 때까지 아래 결과는 이전 검사 기준입니다.
        </AlertDescription>
      </Alert>
    );
  }
  if (scan.status === 'FAILED') {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTriangle aria-hidden />
        <AlertTitle>최근 검사 실패 - 결과가 최신이 아닙니다</AlertTitle>
        <AlertDescription>{scan.error ?? '원인을 알 수 없는 오류'} · 검사 실패는 '취약점 없음'을 뜻하지 않습니다. 다시 실행해 주세요.</AlertDescription>
      </Alert>
    );
  }
  if (scan.status === 'PARTIAL') {
    return (
      <Alert className="border-amber-500/50 bg-amber-500/5" role="alert">
        <AlertTriangle className="text-amber-600" aria-hidden />
        <AlertTitle>부분 완료 - 일부 조회가 실패했습니다</AlertTitle>
        <AlertDescription>
          <ul className="list-disc pl-4">
            {(summary.problems ?? [scan.error ?? '']).map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          결과에 나타나지 않은 항목을 '일치 없음'으로 해석하면 안 됩니다.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      최근 검사: {formatDateTime(scan.finishedAt)} · 구성 #{scan.snapshotSeq} ({project.currentSnapshot.id === scan.snapshotId ? '현재 구성' : '이전 구성'}) · 패키지 버전{' '}
      {scan.packagesScanned.toLocaleString('ko-KR')}개 조회
    </p>
  );
}

function ProjectFindings({ projectId, scan, hasSnapshot }: { projectId: string; scan: Scan | null; hasSnapshot: boolean }) {
  const [params, setParams] = useSearchParams();
  const filter = parseFindingFilter(params);
  const page = Number(params.get('page') ?? '1') || 1;
  const query = { ...findingFilterToQuery(filter), projectId, page, pageSize: 25 };
  const findings = useQuery({
    queryKey: ['findings', query, scan?.id, scan?.status],
    queryFn: () => unwrap(api.GET('/api/v1/findings', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const filtered = Object.values(findingFilterToQuery(filter)).some((value) => value !== undefined);
  const completed = scan?.status === 'SUCCEEDED';

  return (
    <>
      <Card>
        <CardContent>
          <FindingFilters value={filter} onChange={(value) => setParams(writeFindingFilter(params, value))} />
        </CardContent>
      </Card>
      {findings.isError ? (
        <ErrorState error={findings.error} onRetry={() => findings.refetch()} />
      ) : !findings.data ? (
        <LoadingState />
      ) : findings.data.total === 0 ? (
        filtered ? (
          <EmptyState title="조건에 맞는 분석 결과가 없습니다" description="필터를 줄여 보세요." />
        ) : !hasSnapshot || !scan ? (
          <EmptyState title="검사 미완료" description="아직 검사한 적이 없어 결과가 없습니다. 결과가 없다는 것이 취약점이 없다는 뜻은 아닙니다." />
        ) : completed ? (
          <EmptyState
            title="본 검사 범위에서 알려진 취약점 일치 없음"
            description="검사 범위: npm 패키지의 설치 버전. 런타임·OS, npm 외 생태계, 코드 도달 가능성은 포함되지 않습니다. 검사 불가 항목은 '구성 · 의존성' 탭에서 확인하세요."
          />
        ) : (
          <EmptyState title="검사 미완료" description="최근 검사가 끝나지 않았거나 실패했습니다. 지금 결과가 비어 있어도 '일치 없음'으로 볼 수 없습니다." />
        )
      ) : (
        <div className="space-y-3" aria-busy={findings.isFetching}>
          <FindingTable items={findings.data.items} showProject={false} />
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

function SnapshotSection({ projectId, currentSnapshotId }: { projectId: string; currentSnapshotId: string | null }) {
  const snapshots = useQuery({
    queryKey: ['snapshots', projectId],
    queryFn: () => unwrap(api.GET('/api/v1/projects/{id}/snapshots', { params: { path: { id: projectId } } })),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const snapshotId = selected ?? currentSnapshotId;
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const packages = useQuery({
    queryKey: ['snapshot-packages', snapshotId, q, filter, page],
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/snapshots/{id}/packages', {
          params: { path: { id: snapshotId ?? '' }, query: { q: q || undefined, filter: (filter || undefined) as 'unsupported' | 'direct' | 'dev' | undefined, page, pageSize: 50 } },
        }),
      ),
    enabled: Boolean(snapshotId),
    placeholderData: keepPreviousData,
  });

  if (snapshots.isError) return <ErrorState error={snapshots.error} />;
  if (!snapshots.data) return <LoadingState />;
  if (snapshots.data.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>구성 스냅샷</CardTitle>
        <CardDescription>검사 결과에는 어떤 스냅샷과 시점이 쓰였는지 기록됩니다.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="snap-select" className="text-xs font-medium">
              스냅샷
            </label>
            <NativeSelect id="snap-select" className="w-80" value={snapshotId ?? ''} onChange={(e) => { setSelected(e.target.value); setPage(1); }}>
              {snapshots.data.map((snapshot) => (
                <option key={snapshot.id} value={snapshot.id}>
                  #{snapshot.seq} · {formatDateTime(snapshot.createdAt)} · {snapshotLabel(snapshot)}
                  {snapshot.isCurrent ? ' (현재)' : ''}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <label htmlFor="snap-q" className="text-xs font-medium">
              패키지 검색
            </label>
            <Input id="snap-q" className="w-56" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          </div>
          <div className="space-y-1">
            <label htmlFor="snap-filter" className="text-xs font-medium">
              보기
            </label>
            <NativeSelect id="snap-filter" className="w-44" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(1); }}>
              <option value="">전체</option>
              <option value="unsupported">검사 불가 항목</option>
              <option value="direct">직접 의존성</option>
              <option value="dev">개발 의존성</option>
            </NativeSelect>
          </div>
        </div>
        {packages.isError ? (
          <ErrorState error={packages.error} />
        ) : !packages.data ? (
          <LoadingState />
        ) : packages.data.total === 0 ? (
          <EmptyState title="해당하는 패키지가 없습니다" />
        ) : (
          <>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>패키지</TableHead>
                    <TableHead className="w-32">설치 버전</TableHead>
                    <TableHead className="w-56">구분</TableHead>
                    <TableHead>의존성 경로</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {packages.data.items.map((pkg) => (
                    <TableRow key={pkg.id} className="align-top">
                      <TableCell className="font-mono text-xs whitespace-normal">{pkg.name}</TableCell>
                      <TableCell className="font-mono text-xs">{pkg.version || '-'}</TableCell>
                      <TableCell className="whitespace-normal">
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="outline">{pkg.isDirect ? '직접' : '전이'}</Badge>
                          {pkg.isDev ? <Badge variant="outline">개발</Badge> : null}
                          {pkg.isOptional ? <Badge variant="outline">선택</Badge> : null}
                          {pkg.refKind === 'ALIAS' ? <Badge variant="outline">별칭</Badge> : null}
                          {!pkg.scannable ? <Badge variant="destructive">검사 불가</Badge> : null}
                        </div>
                        {pkg.unsupportedReason ? <p className="mt-1 text-xs text-muted-foreground">{pkg.unsupportedReason}</p> : null}
                      </TableCell>
                      <TableCell className="font-mono text-xs whitespace-normal text-muted-foreground">{pkg.dependencyPath.join(' → ') || pkg.installPath}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pagination page={packages.data.page} pageSize={packages.data.pageSize} total={packages.data.total} onPage={setPage} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ScanHistory({ projectId }: { projectId: string }) {
  const scans = useQuery({
    queryKey: ['scans', projectId],
    queryFn: () => unwrap(api.GET('/api/v1/projects/{id}/scans', { params: { path: { id: projectId } } })),
    refetchInterval: (query) => (query.state.data?.some((scan) => scanActive(scan)) ? 2000 : false),
  });
  if (scans.isError) return <ErrorState error={scans.error} />;
  if (!scans.data) return <LoadingState />;
  if (scans.data.length === 0) return <EmptyState title="검사 이력이 없습니다" description="구성을 등록하면 첫 검사가 자동으로 시작됩니다." />;
  return (
    <ul className="space-y-3">
      {scans.data.map((scan) => {
        const scope = (scan.scope ?? {}) as ScanScope;
        const summary = (scan.summary ?? {}) as ScanSummary;
        const freshness = (scan.sourceFreshness ?? {}) as Record<string, { status: string; lastSuccessAt: string | null; lagging: boolean }>;
        return (
          <li key={scan.id} className="rounded-lg border p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={scan.status === 'FAILED' ? 'destructive' : scan.status === 'SUCCEEDED' ? 'secondary' : 'outline'}>{SCAN_STATUS_LABEL[scan.status]}</Badge>
              <span className="font-medium">구성 #{scan.snapshotSeq}</span>
              <span className="text-muted-foreground">
                {formatDateTime(scan.createdAt)} · {{ MANUAL: '수동 실행', SNAPSHOT_CREATED: '구성 등록', SCHEDULED: '정기 재검사' }[scan.trigger]}
                {scan.isInitial ? ' · 최초 검사' : ''}
              </span>
            </div>
            {scan.error ? <p className="mt-2 text-xs text-destructive">{scan.error}</p> : null}
            {scan.finishedAt && scan.status !== 'FAILED' ? (
              <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                <div>
                  <dt className="inline text-muted-foreground">결과: </dt>
                  <dd className="inline">
                    영향 버전 일치 {summary.affected ?? 0} · 판단 불가 {summary.unknown ?? 0} · 신규 {summary.newFindings ?? 0} · 해소 {summary.resolved ?? 0}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">범위: </dt>
                  <dd className="inline">
                    설치 항목 {scope.packagesInSnapshot ?? '-'}개 중 서로 다른 패키지 버전 {scope.distinctVersionsQueried ?? '-'}개 조회
                  </dd>
                </div>
                {scope.skipped?.length ? (
                  <div className="sm:col-span-2">
                    <dt className="inline text-muted-foreground">검사하지 못한 항목: </dt>
                    <dd className="inline">{scope.skipped.map((item) => `${item.reason} ${item.count}건`).join(' / ')}</dd>
                  </div>
                ) : null}
                {scope.notCovered?.length ? (
                  <div className="sm:col-span-2">
                    <dt className="inline text-muted-foreground">검사 범위 밖: </dt>
                    <dd className="inline">{scope.notCovered.join(' / ')}</dd>
                  </div>
                ) : null}
                <div className="sm:col-span-2">
                  <dt className="inline text-muted-foreground">검사 시점의 데이터 출처 상태: </dt>
                  <dd className="inline">
                    {Object.entries(freshness)
                      .map(([key, value]) => `${key} ${value.status === 'OK' ? (value.lagging ? '지연' : '정상') : value.status === 'FAILING' ? '실패' : '미수집'}${value.lastSuccessAt ? `(${formatRelative(value.lastSuccessAt)})` : ''}`)
                      .join(' · ')}
                  </dd>
                </div>
              </dl>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
