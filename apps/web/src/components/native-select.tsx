import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** 필터용 기본 select. 키보드·스크린리더 동작을 브라우저 기본에 맡긴다. */
export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30',
        className,
      )}
      {...props}
    />
  );
}
