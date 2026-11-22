import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/app-shell';
import { SourceStateBadge } from '@/components/source-status';
import { ErrorState, LoadingState, UnsupportedNote } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, unwrap } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/labels';
import { useIngestionStatus } from '@/lib/queries';

export function StatusPage() {
  const status = useIngestionStatus();
  const rules = useQuery({ queryKey: ['priority-rules'], queryFn: () => unwrap(api.GET('/api/v1/priority-rules')), staleTime: Infinity });

  if (status.isError) return <ErrorState error={status.error} onRetry={() => status.refetch()} />;
  if (!status.data) return <LoadingState />;

  return (
    <>
      <PageHeader
        title="수집 상태"
        description={`수집된 취약점 ${status.data.vulnerabilityCount.toLocaleString('ko-KR')}건 · 최초 적재 범위 최근 ${status.data.initialFeedDays}일 · 대기 중인 백그라운드 작업 ${status.data.pendingJobs}건`}
      />

      <Card>
        <CardHeader>
          <CardTitle>데이터 소스</CardTitle>
          <CardDescription>소스 수집이 실패하거나 지연되면 그 사실을 그대로 표시합니다. 수집 실패를 '취약점 없음'으로 처리하지 않습니다.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">소스</TableHead>
                  <TableHead>역할</TableHead>
                  <TableHead className="w-28">상태</TableHead>
                  <TableHead className="w-40">마지막 성공</TableHead>
                  <TableHead className="w-28">주기</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {status.data.sources.map((source) => (
                  <TableRow key={source.key} className="align-top">
                    <TableCell className="font-medium">{source.key}</TableCell>
                    <TableCell className="text-sm whitespace-normal">
                      {source.role}
                      {source.lastError ? <p className="mt-1 text-xs text-destructive">최근 오류: {source.lastError} (연속 {source.consecutiveFailures}회)</p> : null}
                      {!source.backfillDone ? <p className="mt-1 text-xs text-muted-foreground">초기 적재가 아직 끝나지 않았습니다.</p> : null}
                    </TableCell>
                    <TableCell>
                      <SourceStateBadge source={source} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground" title={formatDateTime(source.lastSuccessAt)}>
                      {formatRelative(source.lastSuccessAt)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {source.key === 'OSV' ? '검사 시 조회' : source.intervalMinutes >= 60 ? `${source.intervalMinutes / 60}시간` : `${source.intervalMinutes}분`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>최근 수집 실행</CardTitle>
        </CardHeader>
        <CardContent>
          {status.data.recentRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">아직 실행된 수집이 없습니다. Worker 프로세스가 실행 중인지 확인하세요.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">소스</TableHead>
                    <TableHead className="w-24">결과</TableHead>
                    <TableHead className="w-44">시작</TableHead>
                    <TableHead>수집 구간</TableHead>
                    <TableHead className="w-56">조회 / 저장 / 변경</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {status.data.recentRuns.map((run) => (
                    <TableRow key={run.id} className="align-top">
                      <TableCell className="font-medium">{run.source}</TableCell>
                      <TableCell>
                        <Badge variant={run.status === 'FAILED' ? 'destructive' : run.status === 'RUNNING' ? 'outline' : 'secondary'}>
                          {run.status === 'SUCCEEDED' ? '성공' : run.status === 'FAILED' ? '실패' : '실행 중'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(run.startedAt)}</TableCell>
                      <TableCell className="text-xs whitespace-normal text-muted-foreground">
                        {run.windowFrom ? `${formatDateTime(run.windowFrom)} ~ ${formatDateTime(run.windowTo)}` : run.status === 'RUNNING' ? '진행 중' : '전체 파일'}
                        {run.error ? <p className="text-destructive">{run.error}</p> : null}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {run.fetched.toLocaleString('ko-KR')} / {run.upserted.toLocaleString('ko-KR')} / {run.changed.toLocaleString('ko-KR')}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card id="rules">
        <CardHeader>
          <CardTitle>대응 우선순위 규칙</CardTitle>
          <CardDescription>
            {rules.data ? `규칙 버전 ${rules.data.version} · EPSS 임계값 ${rules.data.epssThreshold}. 영향 버전 일치 항목에 위에서부터 첫 일치를 적용한 뒤 보정을 더합니다.` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {rules.data ? (
            <>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">규칙</TableHead>
                      <TableHead>조건</TableHead>
                      <TableHead className="w-64">결과</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...rules.data.rules, ...rules.data.adjustments].map((rule) => (
                      <TableRow key={rule.id}>
                        <TableCell className="font-mono text-xs">{rule.id}</TableCell>
                        <TableCell className="text-sm whitespace-normal">{rule.condition}</TableCell>
                        <TableCell className="text-sm whitespace-normal">{rule.result}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {rules.data.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </>
          ) : (
            <LoadingState />
          )}
        </CardContent>
      </Card>

      <UnsupportedNote title="현재 지원하지 않는 범위">
        npm 외 생태계(pnpm·Yarn lockfile, Python, Java, Go, Rust)의 정밀 검사, 런타임·OS 버전의 자동 매칭, SBOM 업로드, 저장소 연동, 컨테이너 이미지 분석, 코드 도달
        가능성 분석, AI 요약은 제공하지 않습니다. 고지: This product uses the NVD API but is not endorsed or certified by the NVD.
      </UnsupportedNote>
    </>
  );
}
