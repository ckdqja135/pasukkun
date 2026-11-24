import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { BellRing, Clock, ExternalLink, Megaphone, Sparkles } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PageHeader } from '@/components/app-shell';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, unwrap, type Schemas } from '@/lib/api';
import { DELIVERY_STATUS_LABEL, formatDateTime } from '@/lib/labels';
import { cn } from '@/lib/utils';

type Briefing = Schemas['BriefingDto'];
type ProjectCount = Schemas['ProjectCountDto'];

const TAG_TONE: Record<Briefing['items'][number]['tone'], string> = {
  urgent: 'bg-red-600 text-white',
  high: 'bg-orange-500 text-white',
  medium: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  low: 'bg-muted text-muted-foreground',
  info: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
};

const CHANNEL_STATUS: Record<string, string> = { SENT: '보냄', FAILED: '보내지 못함' };

const projectCounts = (list: ProjectCount[]) =>
  `${list
    .slice(0, 5)
    .map((p) => `${p.name} ${p.count}건`)
    .join(', ')}${list.length > 5 ? ` 외 ${list.length - 5}곳` : ''}`;

function BriefingBlock({ briefing, selected }: { briefing: Briefing; selected: boolean }) {
  const { patches } = briefing;
  return (
    <article id={`briefing-${briefing.id}`} className={cn('scroll-mt-20 space-y-2 rounded-lg p-4', selected && 'bg-primary/5 ring-2 ring-primary/40')}>
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="font-semibold">
          <Link to={`?id=${briefing.id}`} className="hover:underline">
            {briefing.title}
          </Link>
        </h3>
        <span className="text-xs text-muted-foreground">
          {formatDateTime(briefing.slotAt)}, {formatDateTime(briefing.fromAt)}부터 모은 것
        </span>
        {briefing.aiModel ? (
          <Badge variant="outline" title={briefing.aiModel}>
            <Sparkles aria-hidden /> AI 요약
          </Badge>
        ) : null}
      </header>
      <div className="space-y-2 border-l-2 pl-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="text-muted-foreground">{briefing.ruleName}</span>
          {briefing.channels.map((channel, index) => (
            <span key={index} className="inline-flex items-center gap-1.5">
              <span className="rounded border bg-muted px-1.5 py-0.5 font-medium">{channel.name}</span>
              <span className={channel.status === 'FAILED' ? 'text-destructive' : 'text-muted-foreground'}>{CHANNEL_STATUS[channel.status] ?? DELIVERY_STATUS_LABEL[channel.status] ?? channel.status}</span>
            </span>
          ))}
        </div>
        <p className="font-semibold">{briefing.headline}</p>
        <p className="text-sm text-muted-foreground">{briefing.summary}</p>
        {briefing.items.length > 0 ? (
          <ol className="space-y-1">
            {briefing.items.map((item, index) => (
              <li key={index} className="flex items-start gap-2 text-sm">
                <span className="w-6 shrink-0 text-right text-muted-foreground tabular-nums">{index + 1}.</span>
                <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold', TAG_TONE[item.tone])}>{item.tag}</span>
                <Link to={item.href} className="text-primary underline-offset-2 hover:underline">
                  {item.text}
                </Link>
              </li>
            ))}
          </ol>
        ) : null}
        {briefing.totalItems > briefing.items.length ? <p className="text-xs text-muted-foreground">외 {briefing.totalItems - briefing.items.length}건</p> : null}
        <div className="text-sm">
          <p className="font-medium">패치 확인 (지난 브리핑 이후 점검)</p>
          <ul className="text-muted-foreground">
            <li>- {patches.confirmed > 0 ? `패치 확인 ${patches.confirmed}건: ${projectCounts(patches.confirmedByProject)}` : '확인된 패치 없음'}</li>
            {patches.reported > 0 ? (
              <li>
                - 조치 보고 {patches.reported}건(다음 점검에서 버전 확인): {projectCounts(patches.reportedByProject)}
              </li>
            ) : null}
          </ul>
        </div>
        {briefing.notices.length > 0 ? (
          <div className="text-sm">
            <p className="font-medium">국내 보안공지 (KISA)</p>
            <ul>
              {briefing.notices.map((notice, index) => (
                <li key={index}>
                  <a href={notice.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
                    {notice.title} <ExternalLink aria-hidden className="size-3" />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {briefing.aiError ? <p className="text-xs text-muted-foreground">AI 요약 없이 정해진 틀로 보냈습니다: {briefing.aiError}</p> : null}
      </div>
    </article>
  );
}

export function BriefingsPage() {
  const [params] = useSearchParams();
  const selectedId = Number(params.get('id')) || null;

  const overview = useQuery({ queryKey: ['briefings', 'overview'], queryFn: () => unwrap(api.GET('/api/v1/briefings/overview')) });
  const list = useInfiniteQuery({
    queryKey: ['briefings', 'list'],
    queryFn: ({ pageParam }) => unwrap(api.GET('/api/v1/briefings', { params: { query: pageParam ? { cursor: pageParam } : {} } })),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const loaded = selectedId !== null && items.some((item) => item.id === selectedId);
  // 목록 첫 화면에 없는 브리핑을 주소로 열면 따로 불러 위에 보여준다.
  const single = useQuery({
    queryKey: ['briefings', 'one', selectedId],
    queryFn: () => unwrap(api.GET('/api/v1/briefings/{id}', { params: { path: { id: selectedId! } } })),
    enabled: selectedId !== null && list.isSuccess && !loaded,
  });

  useEffect(() => {
    if (selectedId === null) return;
    document.getElementById(`briefing-${selectedId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selectedId, loaded, single.data]);

  const pendingTotal = (overview.data?.pending ?? []).reduce((sum, row) => sum + row.count, 0);

  return (
    <>
      <PageHeader
        title="보안 브리핑"
        description="보안 브리핑 규칙이 정한 시각마다, 지난 브리핑 이후 들어온 이슈와 프로젝트 영향, 패치 현황을 정리해 채널로 보냅니다. 보낸 브리핑은 여기에 그대로 남습니다."
      />

      {overview.data && overview.data.ruleCount === 0 ? (
        <Alert>
          <AlertDescription>
            보안 브리핑 규칙이 없습니다.{' '}
            <Link to="/notifications" className="underline underline-offset-2">
              알림 설정
            </Link>
            에서 규칙의 받는 시간을 정하고, 모아 받는 형식을 "보안 브리핑"으로 고르세요.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock aria-hidden className="size-4" /> 다음 발송
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-bold tabular-nums">{overview.data?.nextSendAt ? formatDateTime(overview.data.nextSendAt) : '-'}</p>
            {(overview.data?.schedules ?? []).map((row, index) => (
              <p key={index} className="text-sm text-muted-foreground">
                {row.ruleName}: {row.text}
              </p>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BellRing aria-hidden className="size-4" /> 모인 알림
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-bold tabular-nums">
              {pendingTotal}
              <span className="ml-1 text-base font-normal text-muted-foreground">건</span>
            </p>
            {(overview.data?.pending ?? []).map((row, index) => (
              <p key={index} className="text-sm text-muted-foreground">
                {row.channelName} {row.count}건
              </p>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles aria-hidden className="size-4" /> AI 요약
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className={cn('text-2xl font-bold', overview.data?.ai.enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>{overview.data?.ai.enabled ? '켜짐' : '꺼짐'}</p>
            <p className="text-sm text-muted-foreground">
              {overview.data?.ai.enabled
                ? `${overview.data.ai.model}. 보내는 시각마다 1번 호출해 헤드라인, 요약, 항목 문구를 한국어로 다듬습니다.`
                : '서버 설정에 AI 요약 키가 없어 정해진 틀로 만듭니다.'}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Megaphone aria-hidden className="size-4" /> 지난 브리핑
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {list.isError ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          ) : !list.data ? (
            <LoadingState />
          ) : items.length === 0 && !single.data ? (
            <EmptyState title="아직 보낸 브리핑이 없습니다" description="보안 브리핑 규칙의 받는 시각이 지나면 여기에 쌓입니다." />
          ) : (
            <div className="divide-y">
              {single.data ? <BriefingBlock briefing={single.data} selected /> : null}
              {items.map((briefing) => (
                <BriefingBlock key={briefing.id} briefing={briefing} selected={briefing.id === selectedId} />
              ))}
            </div>
          )}
          {list.hasNextPage ? (
            <div className="flex justify-center pt-2">
              <Button variant="outline" size="sm" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
                더 보기
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
