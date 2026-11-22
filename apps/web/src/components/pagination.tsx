import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label="페이지 이동" className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
      <span aria-live="polite">
        전체 {total.toLocaleString('ko-KR')}건 중 {from.toLocaleString('ko-KR')}-{to.toLocaleString('ko-KR')}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft aria-hidden /> 이전
        </Button>
        <span className="tabular-nums">
          {page} / {pages}
        </span>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          다음 <ChevronRight aria-hidden />
        </Button>
      </div>
    </nav>
  );
}
