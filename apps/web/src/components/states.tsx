import { AlertTriangle, Ban, Clock, Inbox, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/** 로딩 / 빈 결과 / 오류 / 미지원 / 수집 지연을 서로 다른 모양으로 보여준다. */
export function LoadingState({ label = '불러오는 중…' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center">
      <Inbox className="size-6 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-prose text-sm text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.';
  return (
    <Alert variant="destructive" role="alert">
      <AlertTriangle aria-hidden />
      <AlertTitle>불러오지 못했습니다</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        <span>{message}</span>
        {onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            다시 시도
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function UnsupportedNote({ title = '미지원', children }: { title?: string; children: ReactNode }) {
  return (
    <Alert>
      <Ban aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export function LagNote({ children }: { children: ReactNode }) {
  return (
    <Alert className="border-amber-500/50 bg-amber-500/5">
      <Clock className="text-amber-600 dark:text-amber-400" aria-hidden />
      <AlertTitle>수집 지연</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
