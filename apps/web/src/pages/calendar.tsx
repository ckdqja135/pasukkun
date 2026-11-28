import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { PageHeader } from '@/components/app-shell';
import { ErrorState } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, unwrap, type Schemas } from '@/lib/api';
import { cn } from '@/lib/utils';

type CalendarEvent = Schemas['CalendarEventDto'];
type View = 'PROJECT' | 'IMPORTANT' | 'INTEREST';

const VIEWS: Array<{ value: View; label: string }> = [
  { value: 'PROJECT', label: '내 프로젝트 영향' },
  { value: 'IMPORTANT', label: '중요 이슈' },
  { value: 'INTEREST', label: '관심 기술' },
];

const TONE: Record<CalendarEvent['tone'], { label: string; chip: string; dot: string }> = {
  URGENT: { label: '긴급', chip: 'bg-red-600 text-white', dot: 'bg-red-600' },
  HIGH: { label: '높음', chip: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200', dot: 'bg-red-200' },
  NORMAL: { label: '보통', chip: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200', dot: 'bg-amber-200' },
  KEV: { label: 'KEV 조치 기한', chip: 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900', dot: 'bg-zinc-900 dark:bg-zinc-100' },
  PLAN: { label: '조치 예정', chip: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200', dot: 'bg-blue-200' },
  REVIEW: { label: '재검토 기한', chip: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200', dot: 'bg-violet-200' },
  NOTICE: { label: '보안공지 (KISA, AWS)', chip: 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200', dot: 'bg-slate-300' },
};

const LEGEND: Record<View, Array<CalendarEvent['tone']>> = {
  PROJECT: ['URGENT', 'HIGH', 'NORMAL', 'KEV', 'PLAN', 'REVIEW'],
  IMPORTANT: ['URGENT', 'HIGH', 'KEV', 'NOTICE'],
  INTEREST: ['URGENT', 'HIGH', 'NORMAL'],
};

/** 보기마다 같은 색이 뜻하는 바가 다르면 범례 이름을 바꾼다 */
const LEGEND_LABEL: Partial<Record<View, Partial<Record<CalendarEvent['tone'], string>>>> = {
  IMPORTANT: { URGENT: 'KEV 신규 등재', HIGH: '치명적 (관심 기술)' },
};

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const MAX_CHIPS = 3;

const ymd = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

function EventChip({ event, full = false }: { event: CalendarEvent; full?: boolean }) {
  const className = cn('block rounded px-1.5 py-0.5 text-xs font-medium hover:opacity-80', TONE[event.tone].chip, full ? 'whitespace-normal' : 'truncate');
  const title = [event.title, event.detail].filter(Boolean).join(' - ');
  return event.external ? (
    <a href={event.href} target="_blank" rel="noreferrer noopener" className={className} title={title}>
      {event.title} {full ? <ExternalLink aria-hidden className="inline size-3" /> : null}
    </a>
  ) : (
    <Link to={event.href} className={className} title={title}>
      {event.title}
    </Link>
  );
}

export function CalendarPage() {
  const today = new Date();
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [view, setView] = useState<View>('PROJECT');
  const [openDay, setOpenDay] = useState<string | null>(null);

  const days = useMemo(() => {
    const start = addDays(month, -month.getDay());
    const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    const end = addDays(last, 6 - last.getDay());
    const list: Date[] = [];
    for (let day = start; day <= end; day = addDays(day, 1)) list.push(day);
    return list;
  }, [month]);
  const from = ymd(days[0]);
  const to = ymd(days[days.length - 1]);

  const calendar = useQuery({
    queryKey: ['calendar', from, to, view],
    queryFn: () => unwrap(api.GET('/api/v1/calendar', { params: { query: { from, to, view } } })),
    placeholderData: keepPreviousData,
  });
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of calendar.data?.events ?? []) map.set(event.date, [...(map.get(event.date) ?? []), event]);
    return map;
  }, [calendar.data]);
  const todayKey = ymd(today);

  return (
    <>
      <PageHeader title="비상 달력" description="언제 어떤 취약점이 공개되었는지, KEV 조치 기한과 재검토 기한, 조치 예정일을 한눈에 봅니다." />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="이전 달" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
            <ChevronLeft aria-hidden />
          </Button>
          <h2 className="min-w-32 text-center text-lg font-semibold tabular-nums">
            {month.getFullYear()}년 {month.getMonth() + 1}월
          </h2>
          <Button variant="outline" size="icon" aria-label="다음 달" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
            <ChevronRight aria-hidden />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}>
            오늘
          </Button>
        </div>
        <div role="tablist" aria-label="보기" className="inline-flex rounded-lg bg-muted p-1">
          {VIEWS.map((item) => (
            <button
              key={item.value}
              role="tab"
              aria-selected={view === item.value}
              onClick={() => setView(item.value)}
              className={cn('rounded-md px-3 py-1 text-sm', view === item.value ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="범례">
        {LEGEND[view].map((tone) => (
          <li key={tone} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn('size-2.5 rounded-sm', TONE[tone].dot)} />
            {LEGEND_LABEL[view]?.[tone] ?? TONE[tone].label}
          </li>
        ))}
      </ul>

      {calendar.data?.needsInterests ? (
        <Alert>
          <AlertDescription>
            저장된 관심 기술이 없습니다. <Link to="/interests" className="underline underline-offset-2">관심 기술</Link>을 고르면 관련 공지를 달력에 보여줍니다.
          </AlertDescription>
        </Alert>
      ) : null}
      {calendar.data?.truncated ? <p className="text-xs text-muted-foreground">항목이 너무 많아 일부만 표시합니다.</p> : null}

      {calendar.isError ? (
        <ErrorState error={calendar.error} onRetry={() => calendar.refetch()} />
      ) : (
        <div className="overflow-x-auto">
          <div className={cn('grid min-w-[760px] grid-cols-7 overflow-hidden rounded-lg border', calendar.isFetching && 'opacity-70')}>
            {WEEKDAYS.map((weekday) => (
              <div key={weekday} className="border-b bg-muted/50 py-2 text-center text-xs font-medium text-muted-foreground">
                {weekday}
              </div>
            ))}
            {days.map((day) => {
              const key = ymd(day);
              const events = byDay.get(key) ?? [];
              const inMonth = day.getMonth() === month.getMonth();
              return (
                <div key={key} className={cn('min-h-28 border-r border-b p-1.5 [&:nth-child(7n)]:border-r-0', !inMonth && 'bg-muted/40')}>
                  <div className="mb-1 flex items-center justify-between">
                    <span
                      className={cn(
                        'inline-flex size-6 items-center justify-center rounded-full text-xs tabular-nums',
                        key === todayKey ? 'bg-primary font-semibold text-primary-foreground' : inMonth ? 'font-medium' : 'text-muted-foreground',
                      )}
                    >
                      {day.getDate()}
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    {events.slice(0, MAX_CHIPS).map((event) => (
                      <EventChip key={event.id} event={event} />
                    ))}
                    {events.length > MAX_CHIPS ? (
                      <button className="px-1 text-xs font-medium text-primary hover:underline" onClick={() => setOpenDay(key)}>
                        +{events.length - MAX_CHIPS}건
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <Dialog open={openDay !== null} onOpenChange={(open) => !open && setOpenDay(null)}>
        <DialogContent className="max-h-[80svh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{openDay}</DialogTitle>
          </DialogHeader>
          <ul className="space-y-1.5">
            {(openDay ? (byDay.get(openDay) ?? []) : []).map((event) => (
              <li key={event.id}>
                <EventChip event={event} full />
                {event.detail ? <p className="px-1.5 text-xs text-muted-foreground">{event.detail}</p> : null}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
