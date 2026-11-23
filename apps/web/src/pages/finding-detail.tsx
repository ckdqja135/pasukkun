import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { ConditionBadge, KevBadge, MatchBadge, PriorityBadge, SeverityBadge, StatusBadge } from '@/components/badges';
import { NativeSelect } from '@/components/native-select';
import { ErrorState, LoadingState } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, unwrap, type Schemas } from '@/lib/api';
import { CONDITION_LABEL, formatDate, formatDateTime, formatEpss, MATCH_LABEL, RESOLUTION_LABEL, STATUS_LABEL } from '@/lib/labels';

type Detail = Schemas['FindingDetailDto'];
type Verdict = 'MET' | 'NOT_MET' | 'NEEDS_CHECK';
type Status = Detail['remediationStatus'];
type CheckState = 'CONFIRMED' | 'NOT_APPLICABLE' | 'UNKNOWN';

interface Evidence {
  reason?: string;
  osvReported?: boolean | null;
  evaluations?: Array<{ source: string; result: string; reason: string; matchedRange: string | null }>;
  ranges?: Array<{ source: string; ranges: string[]; versions: string[]; unparsed: string[] }>;
  fix?: { kind: 'FIXED' | 'HIGHER_LINE_ONLY' | 'UNCONFIRMED'; version?: string; source?: string };
  conditionChecks?: Array<{ key: string; label: string; detail: string; basis: string }>;
  installCount?: number;
  installPaths?: Array<{ installPath: string; isDirect: boolean; isDev: boolean; isOptional: boolean; dependencyPath: string[] }>;
  sources?: string[];
  analyzedAt?: string;
  lastScan?: { osvReported: boolean; at: string } | null;
}
interface PriorityReasons {
  ruleId?: string;
  adjustments?: string[];
  explanation?: string[];
  action?: 'UPDATE_AVAILABLE' | 'MITIGATION_NEEDED';
}

const CHECK_STATE_LABEL: Record<CheckState, string> = { CONFIRMED: '해당함', NOT_APPLICABLE: '해당 없음', UNKNOWN: '확인 못 함' };

export function FindingDetailPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['finding', id],
    queryFn: () => unwrap(api.GET('/api/v1/findings/{id}', { params: { path: { id } } })),
  });
  const refresh = (data: Detail) => {
    queryClient.setQueryData(['finding', id], data);
    void queryClient.invalidateQueries({ queryKey: ['findings'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ['project', data.projectId] });
    void queryClient.invalidateQueries({ queryKey: ['calendar'] });
    void queryClient.invalidateQueries({ queryKey: ['remediation-packages'] });
  };

  if (detail.isError) return <ErrorState error={detail.error} onRetry={() => detail.refetch()} />;
  if (!detail.data) return <LoadingState />;
  const f = detail.data;
  const evidence = (f.evidence ?? {}) as Evidence;
  const reasons = (f.priorityReasons ?? {}) as PriorityReasons;

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to={`/projects/${f.projectId}`}>
          <ArrowLeft aria-hidden /> {f.projectName}
        </Link>
      </Button>
      <PageHeader
        title={f.vulnerabilityTitle}
        description={
          <>
            <span className="font-mono">{f.identifiers.join(' · ')}</span> ·{' '}
            <Link to={`/vulnerabilities/${f.vulnerabilityId}`} className="text-primary underline underline-offset-2">
              취약점 상세
            </Link>
          </>
        }
      />
      <div className="flex flex-wrap gap-1.5">
        <MatchBadge match={f.versionMatch} />
        <ConditionBadge condition={f.exploitCondition} />
        <PriorityBadge priority={f.priority} />
        <SeverityBadge severity={f.severity} score={f.cvssScore} />
        {f.kevListed ? <KevBadge /> : null}
        <StatusBadge status={f.remediationStatus} />
      </div>

      {f.resolvedAt ? (
        <Alert>
          <AlertTitle>현재 구성에서는 검출되지 않습니다</AlertTitle>
          <AlertDescription>
            {formatDateTime(f.resolvedAt)} 재평가에서 확인됨 - {RESOLUTION_LABEL[f.resolution ?? ''] ?? f.resolution}. 아래는 당시 기록입니다.
          </AlertDescription>
        </Alert>
      ) : null}
      {f.needsRecheck ? (
        <Alert className="border-amber-500/50 bg-amber-500/5">
          <AlertTitle>기존 검토의 재확인이 필요합니다</AlertTitle>
          <AlertDescription>{f.recheckReason} - 이전 검토 결과는 우선순위에 반영하지 않고 있습니다. 조건을 다시 확인해 검토를 새로 기록해 주세요.</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_24rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>확인된 사실 - 버전 매칭</CardTitle>
              <CardDescription>
                설치 버전 <span className="font-mono">{f.packageName}@{f.version}</span> 을 공지의 영향 범위와 비교한 결과입니다. 분석 시각 {formatDateTime(f.analyzedAt)}.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p>
                <span className="font-medium">{MATCH_LABEL[f.versionMatch]}</span> - {evidence.reason ?? '-'}
              </p>
              {f.versionMatch === 'UNKNOWN' ? (
                <Alert>
                  <AlertTitle>판단 불가</AlertTitle>
                  <AlertDescription>영향 여부를 확정할 근거가 부족합니다. 아래 출처별 평가에서 부족한 정보를 확인하고, 공지 원문과 설치 버전을 직접 대조해 주세요.</AlertDescription>
                </Alert>
              ) : null}
              {evidence.evaluations?.length ? (
                <div>
                  <h3 className="mb-1 font-medium">출처별 평가</h3>
                  <ul className="space-y-1.5">
                    {evidence.evaluations.map((evaluation) => (
                      <li key={evaluation.source} className="rounded-md border p-2 text-xs">
                        <span className="font-medium">{evaluation.source}</span> · {MATCH_LABEL[evaluation.result] ?? evaluation.result}
                        {evaluation.matchedRange ? <span className="font-mono"> · 일치 구간 {evaluation.matchedRange}</span> : null}
                        <p className="text-muted-foreground">{evaluation.reason}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {evidence.ranges?.length ? (
                <div>
                  <h3 className="mb-1 font-medium">공지의 영향 범위</h3>
                  <ul className="space-y-1 font-mono text-xs">
                    {evidence.ranges.map((range) => (
                      <li key={range.source}>
                        <span className="font-sans font-medium">{range.source}</span>: {[...range.ranges, ...range.versions.map((v) => `= ${v}`)].join(' / ') || '-'}
                        {range.unparsed.length ? <span className="font-sans text-amber-700 dark:text-amber-400"> (해석 못 한 표현: {range.unparsed.join(', ')})</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                사용한 데이터: {(evidence.sources ?? []).join(', ') || '-'}
                {evidence.lastScan
                  ? ` · 최근 검사(${formatDateTime(evidence.lastScan.at)})의 OSV 조회: ${evidence.lastScan.osvReported ? '일치로 보고됨' : '보고되지 않음'}`
                  : ' · OSV 조회 기록 없음'}
              </p>
              {evidence.installPaths?.length ? (
                <div>
                  <h3 className="mb-1 font-medium">설치 위치와 의존성 경로 ({evidence.installCount}곳)</h3>
                  <ul className="space-y-1 text-xs">
                    {evidence.installPaths.map((path) => (
                      <li key={path.installPath} className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline">{path.isDirect ? '직접' : '전이'}</Badge>
                        {path.isDev ? <Badge variant="outline">개발</Badge> : null}
                        <span className="font-mono text-muted-foreground">{path.dependencyPath.join(' → ') || path.installPath}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-muted-foreground">개발 의존성이라는 이유만으로 위험에서 제외하지 않습니다. 빌드·CI 환경에서 실행되는지 확인하세요.</p>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <ReviewCard finding={f} evidence={evidence} onSaved={refresh} />

          <Card>
            <CardHeader>
              <CardTitle>검토 및 조치 이력</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {f.reviews.length === 0 && f.history.length === 0 ? <p className="text-muted-foreground">아직 기록이 없습니다.</p> : null}
              {f.reviews.length > 0 ? (
                <div>
                  <h3 className="mb-1 font-medium">수동 검토</h3>
                  <ul className="space-y-2">
                    {f.reviews.map((review) => (
                      <li key={review.id} className="rounded-md border p-3">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <ConditionBadge condition={review.verdict} />
                          <span>@{review.authorName}</span>
                          <span>{formatDateTime(review.createdAt)}</span>
                        </div>
                        <p className="mt-2 whitespace-pre-wrap">{review.rationale}</p>
                        {(review.checks as Array<{ label: string; state: CheckState; note?: string }>).length > 0 ? (
                          <ul className="mt-2 list-disc pl-4 text-xs text-muted-foreground">
                            {(review.checks as Array<{ label: string; state: CheckState; note?: string }>).map((check) => (
                              <li key={check.label}>
                                {check.label}: {CHECK_STATE_LABEL[check.state]}
                                {check.note ? ` - ${check.note}` : ''}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {f.history.length > 0 ? (
                <div>
                  <h3 className="mb-1 font-medium">조치 상태 변경</h3>
                  <ul className="space-y-1 text-xs">
                    {f.history.map((entry) => (
                      <li key={entry.id}>
                        {formatDateTime(entry.createdAt)} · @{entry.authorName} · {STATUS_LABEL[entry.fromStatus]} → {STATUS_LABEL[entry.toStatus]}
                        {entry.reason ? ` - ${entry.reason}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>대응 방법</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {evidence.fix?.kind === 'FIXED' ? (
                <p>
                  확인된 수정 버전: <span className="font-mono font-medium">{f.packageName}@{evidence.fix.version}</span>
                  <span className="block text-xs text-muted-foreground">현재 설치 버전이 속한 영향 구간의 경계에서 확인했습니다 (출처 {evidence.fix.source}).</span>
                </p>
              ) : evidence.fix?.kind === 'HIGHER_LINE_ONLY' ? (
                <p>
                  현재 릴리스 계열의 수정 버전은 확인되지 않았습니다. 더 높은 계열 <span className="font-mono">{evidence.fix.version}</span> 에서만 수정이 확인됩니다 (출처 {evidence.fix.source}). 주 버전 업그레이드 영향 여부를 검토하세요.
                </p>
              ) : (
                <p>패치 미확인 - 수정 버전 정보가 없습니다. 버전을 추측하지 않으니 공지 원문에서 완화 방법을 확인하세요.</p>
              )}
              {!f.isDirect ? <p className="text-xs text-muted-foreground">전이 의존성입니다. 어떤 직접 의존성을 올려야 하는지는 자동으로 계산하지 않습니다. 위 의존성 경로를 참고하세요.</p> : null}
              <p className="text-xs text-muted-foreground">패키지를 올린 뒤에는 새 package-lock.json 을 등록해 재검사로 해소를 확인하세요.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>대응 우선순위</CardTitle>
              <CardDescription>
                규칙 {reasons.ruleId}
                {reasons.adjustments?.length ? ` + 보정 ${reasons.adjustments.join(', ')}` : ''} · 버전 {f.ruleVersion} ·{' '}
                <Link to="/status#rules" className="text-primary underline underline-offset-2">
                  규칙 보기
                </Link>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <PriorityBadge priority={f.priority} />
              <ul className="list-disc space-y-1 pl-4 text-xs">
                {(reasons.explanation ?? []).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                EPSS {formatEpss(f.epssScore)} (30일 내 악용 활동 관측 확률 추정) · KEV {f.kevListed ? '등재' : '미등재(악용 없음을 뜻하지 않음)'}
              </p>
            </CardContent>
          </Card>

          <StatusCard finding={f} onSaved={refresh} />
        </aside>
      </div>
    </>
  );
}

function ReviewCard({ finding, evidence, onSaved }: { finding: Detail; evidence: Evidence; onSaved: (data: Detail) => void }) {
  const checks = evidence.conditionChecks ?? [];
  const [verdict, setVerdict] = useState<Verdict>('NEEDS_CHECK');
  const [rationale, setRationale] = useState('');
  const [states, setStates] = useState<Record<string, CheckState>>({});
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/findings/{id}/reviews', {
          params: { path: { id: finding.id } },
          body: { verdict, rationale, checks: checks.map((check) => ({ label: check.label, state: states[check.key] ?? 'UNKNOWN' })) },
        }),
      ),
    onSuccess: (data) => {
      onSaved(data);
      setRationale('');
      toast.success('검토를 기록했습니다.');
    },
    onError: (error) => toast.error(error.message),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>아직 확인하지 못한 조건 - 악용 조건 검토</CardTitle>
        <CardDescription>
          현재: {CONDITION_LABEL[finding.exploitCondition]}. 버전 일치만으로 실제 악용 가능성을 확정하지 않습니다. 취약 기능을 실제로 쓰는지(코드 도달 가능성)는 자동으로 판정하지 않으므로 직접 확인해 기록합니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4 text-sm">
          {checks.length === 0 ? (
            <p className="text-muted-foreground">공지의 구조화된 데이터에서 뽑아낼 수 있는 조건이 없습니다. 공지 원문의 전제 조건을 읽고 판단을 기록해 주세요.</p>
          ) : (
            <ul className="space-y-2">
              {checks.map((check) => (
                <li key={check.key} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_10rem]">
                  <div>
                    <p className="font-medium">{check.label}</p>
                    <p className="text-xs text-muted-foreground">{check.detail}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">근거: {check.basis === 'CVSS' ? 'CVSS 벡터' : '공지에 명시된 취약 함수'}</p>
                  </div>
                  <div>
                    <Label htmlFor={`check-${check.key}`} className="sr-only">
                      {check.label} 확인 결과
                    </Label>
                    <NativeSelect id={`check-${check.key}`} value={states[check.key] ?? 'UNKNOWN'} onChange={(e) => setStates((current) => ({ ...current, [check.key]: e.target.value as CheckState }))}>
                      {(Object.keys(CHECK_STATE_LABEL) as CheckState[]).map((state) => (
                        <option key={state} value={state}>
                          {CHECK_STATE_LABEL[state]}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
            <div className="space-y-1.5">
              <Label htmlFor="verdict">판정</Label>
              <NativeSelect id="verdict" value={verdict} onChange={(e) => setVerdict(e.target.value as Verdict)}>
                <option value="NEEDS_CHECK">확인 필요 (아직 결론 없음)</option>
                <option value="MET">조건 충족 - 우리 환경에서 성립</option>
                <option value="NOT_MET">조건 불충족 - 우리 환경에서 성립하지 않음</option>
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rationale">판단 근거 (필수)</Label>
              <Textarea id="rationale" rows={3} required minLength={5} maxLength={4000} value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="무엇을 확인했고 왜 그렇게 판단했는지 적어 주세요." />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">검토에는 작성자·시각과 검토 당시의 구성·영향 범위가 함께 기록됩니다. 이후 구성이나 공지가 바뀌면 재확인 필요로 표시됩니다.</p>
          <Button type="submit" disabled={save.isPending || rationale.trim().length < 5}>
            검토 기록
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function StatusCard({ finding, onSaved }: { finding: Detail; onSaved: (data: Detail) => void }) {
  const [status, setStatus] = useState<Status>(finding.remediationStatus);
  const [reason, setReason] = useState('');
  const [due, setDue] = useState(localYmd(finding.reviewDueAt));
  const savedPlan = localYmd(finding.plannedFixAt);
  const [plan, setPlan] = useState(savedPlan);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH('/api/v1/findings/{id}/status', {
          params: { path: { id: finding.id } },
          body: {
            status,
            reason: reason || undefined,
            reviewDueAt: status === 'RISK_ACCEPTED' && due ? new Date(`${due}T23:59:59`).toISOString() : undefined,
            plannedFixAt: status === 'PLANNED' && plan ? new Date(`${plan}T12:00:00`).toISOString() : undefined,
          },
        }),
      ),
    onSuccess: (data) => {
      onSaved(data);
      setReason('');
      toast.success('조치 상태를 변경했습니다.');
    },
    onError: (error) => toast.error(error.message),
  });
  const accepting = status === 'RISK_ACCEPTED';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>조치 상태</CardTitle>
        <CardDescription>상태를 바꿔도 버전 매칭 결과는 달라지지 않습니다. '조치 완료'는 재검사로 확인됩니다.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3 text-sm">
          <div className="space-y-1.5">
            <Label htmlFor="status">상태</Label>
            <NativeSelect id="status" value={status} onChange={(e) => setStatus(e.target.value as Status)}>
              {(Object.keys(STATUS_LABEL) as Status[]).map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABEL[value]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reason">{accepting ? '수용 사유 (필수)' : '메모'}</Label>
            <Textarea id="reason" rows={2} required={accepting} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {accepting ? (
            <div className="space-y-1.5">
              <Label htmlFor="due">재검토 기한 (필수)</Label>
              <Input id="due" type="date" required min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
          ) : null}
          {status === 'PLANNED' ? (
            <div className="space-y-1.5">
              <Label htmlFor="plan">조치 예정일 (선택)</Label>
              <Input id="plan" type="date" value={plan} onChange={(e) => setPlan(e.target.value)} />
              <p className="text-xs text-muted-foreground">정하면 비상 달력에 표시됩니다.</p>
            </div>
          ) : null}
          {finding.remediationStatus === 'PLANNED' && finding.plannedFixAt ? (
            <p className="text-xs text-muted-foreground">현재 조치 예정일: {formatDate(finding.plannedFixAt)}</p>
          ) : null}
          {finding.remediationStatus === 'RISK_ACCEPTED' && finding.acceptReason ? (
            <p className="text-xs text-muted-foreground">
              현재 수용 사유: {finding.acceptReason} · 재검토 {formatDate(finding.reviewDueAt)}
            </p>
          ) : null}
          <Button type="submit" variant="outline" disabled={
              save.isPending ||
              (status === finding.remediationStatus && !accepting && !(status === 'PLANNED' && plan !== savedPlan)) ||
              (accepting && (!reason.trim() || !due))
            }>
            상태 변경
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** 저장된 시각을 이 브라우저의 날짜(YYYY-MM-DD)로. UTC 로 자르면 시간대에 따라 하루 어긋난다. */
function localYmd(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
