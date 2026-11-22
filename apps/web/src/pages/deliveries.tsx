import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Ban, CheckCircle2, Clock, CopyMinus, Loader2, MoonStar, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { PageHeader } from '@/components/app-shell';
import { Pill } from '@/components/badges';
import { NativeSelect } from '@/components/native-select';
import { Pagination } from '@/components/pagination';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, unwrap, type Schemas } from '@/lib/api';
import { DELIVERY_STATUS_LABEL, EVENT_LABEL, formatDateTime, formatRelative } from '@/lib/labels';

type Delivery = Schemas['DeliveryDto'];
type Status = Delivery['status'];

function DeliveryStatus({ status }: { status: Status }) {
  const label = DELIVERY_STATUS_LABEL[status];
  switch (status) {
    case 'SENT':
    case 'DIGESTED':
      return <Pill tone="green" icon={CheckCircle2}>{label}</Pill>;
    case 'FAILED':
      return <Pill tone="red" icon={AlertTriangle}>{label}</Pill>;
    case 'RETRYING':
      return <Pill tone="amber" icon={RefreshCw}>{label}</Pill>;
    case 'SUPPRESSED':
      return <Pill tone="gray" icon={CopyMinus}>{label}</Pill>;
    case 'HELD':
      return <Pill tone="violet" icon={MoonStar}>{label}</Pill>;
    case 'CANCELLED':
      return <Pill tone="gray" icon={Ban}>{label}</Pill>;
    case 'SENDING':
      return <Pill tone="blue" icon={Loader2}>{label}</Pill>;
    default:
      return <Pill tone="blue" icon={Clock}>{label}</Pill>;
  }
}

const FILTERS: Array<{ value: string; label: string; statuses?: Status[] }> = [
  { value: '', label: '전체' },
  { value: 'sent', label: '발송됨', statuses: ['SENT', 'DIGESTED'] },
  { value: 'waiting', label: '대기 · 재시도 중', statuses: ['PENDING', 'SENDING', 'RETRYING', 'HELD', 'DIGEST_PENDING'] },
  { value: 'failed', label: '최종 실패', statuses: ['FAILED'] },
  { value: 'suppressed', label: '중복 억제 · 취소', statuses: ['SUPPRESSED', 'CANCELLED'] },
];

export function DeliveriesPage() {
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const statuses = FILTERS.find((item) => item.value === filter)?.statuses;
  const deliveries = useQuery({
    queryKey: ['deliveries', filter, page],
    queryFn: () => unwrap(api.GET('/api/v1/deliveries', { params: { query: { statuses, page, pageSize: 25 } } })),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });

  return (
    <>
      <PageHeader
        title="발송 이력"
        description="알림이 실제로 나갔는지, 재시도 중인지, 최종 실패했는지 확인합니다. 외부 서비스로의 전송은 최소 한 번 전달을 목표로 하며, 드물게 같은 알림이 두 번 도착할 수 있습니다."
      />
      <div className="max-w-xs space-y-1">
        <Label htmlFor="dl-filter" className="text-xs">
          상태
        </Label>
        <NativeSelect id="dl-filter" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(1); }}>
          {FILTERS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      {deliveries.isError ? (
        <ErrorState error={deliveries.error} onRetry={() => deliveries.refetch()} />
      ) : !deliveries.data ? (
        <LoadingState />
      ) : deliveries.data.total === 0 ? (
        <EmptyState title="발송 이력이 없습니다" description="채널과 구독 규칙을 설정하면 조건에 맞는 변화가 생길 때 여기에 기록됩니다." />
      ) : (
        <div className="space-y-3">
          <div className="overflow-x-auto rounded-lg border">
            <Table className="table-fixed min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-36">상태</TableHead>
                  <TableHead>내용</TableHead>
                  <TableHead className="w-48">채널 · 규칙</TableHead>
                  <TableHead className="w-24">시도</TableHead>
                  <TableHead className="w-44">시각</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.data.items.map((delivery) => (
                  <TableRow key={delivery.id} className="align-top">
                    <TableCell>
                      <DeliveryStatus status={delivery.status} />
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {delivery.vulnerabilityId ? (
                        <Link to={`/vulnerabilities/${delivery.vulnerabilityId}`} className="font-medium underline-offset-2 hover:underline">
                          {delivery.title}
                        </Link>
                      ) : (
                        <span className="font-medium">{delivery.title}</span>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {delivery.kind === 'TEST' ? '연결 테스트' : delivery.kind === 'DIGEST' ? '일일 요약' : (EVENT_LABEL[delivery.eventType ?? ''] ?? delivery.eventType)}
                        {delivery.projectName ? ` · ${delivery.projectName}` : ''}
                      </p>
                      {delivery.lastError ? (
                        <p className={delivery.status === 'FAILED' ? 'mt-1 text-xs text-destructive' : 'mt-1 text-xs text-muted-foreground'}>
                          {delivery.lastError}
                          {delivery.lastStatusCode && delivery.lastStatusCode !== 200 ? ` (HTTP ${delivery.lastStatusCode})` : ''}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm whitespace-normal">
                      {delivery.channelName}
                      <p className="text-xs text-muted-foreground">{delivery.ruleName ?? '-'}</p>
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {delivery.attempts}회
                      {delivery.nextAttemptAt ? <p className="text-xs text-muted-foreground">다음 {formatRelative(delivery.nextAttemptAt)}</p> : null}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      생성 {formatDateTime(delivery.createdAt)}
                      {delivery.sentAt ? <p>발송 {formatDateTime(delivery.sentAt)}</p> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination page={deliveries.data.page} pageSize={deliveries.data.pageSize} total={deliveries.data.total} onPage={setPage} />
        </div>
      )}
    </>
  );
}
