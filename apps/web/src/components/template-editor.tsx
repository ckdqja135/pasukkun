import { useQuery } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, unwrap } from '@/lib/api';

/**
 * 알림 문구 틀 편집기.
 * - 꺼져 있으면(null) 기본 형식으로 보낸다.
 * - 자리표시자를 눌러 커서 위치에 넣을 수 있고, 예시 데이터로 채운 미리보기를 보여준다.
 */
export function TemplateEditor({ kind, value, onChange }: { kind: 'TECH_INTEREST' | 'PROJECT_IMPACT'; value: string | null; onChange: (value: string | null) => void }) {
  const info = useQuery({ queryKey: ['template-info'], queryFn: () => unwrap(api.GET('/api/v1/rules/template-info')), staleTime: Infinity });
  const area = useRef<HTMLTextAreaElement>(null);
  const custom = value !== null;
  const [debounced, setDebounced] = useState(value ?? '');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value ?? ''), 300);
    return () => clearTimeout(timer);
  }, [value]);

  const preview = useQuery({
    queryKey: ['template-preview', kind, custom ? debounced : null],
    queryFn: () => unwrap(api.POST('/api/v1/rules/template-preview', { body: { kind, template: custom ? debounced : '' } })),
    enabled: custom,
    retry: false,
    placeholderData: (previous) => previous,
  });

  const insert = (key: string) => {
    const token = `{${key}}`;
    const element = area.current;
    const text = value ?? '';
    if (!element) return onChange(text + token);
    const start = element.selectionStart ?? text.length;
    const end = element.selectionEnd ?? text.length;
    onChange(text.slice(0, start) + token + text.slice(end));
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const defaultTemplate = info.data?.defaults[kind] ?? '';

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Switch id="tpl-custom" checked={custom} onCheckedChange={(checked) => onChange(checked ? defaultTemplate : null)} />
        <Label htmlFor="tpl-custom">알림 문구 직접 정하기</Label>
      </div>
      {!custom ? (
        <p className="text-xs text-muted-foreground">기본 형식으로 보냅니다 (제목, 식별자, 패키지와 현재 버전, 심각도, 우선순위, 판단 근거, 확인할 조건, 수정 버전, 링크).</p>
      ) : (
        <>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="tpl-text">문구 틀</Label>
              <Button type="button" size="sm" variant="ghost" onClick={() => onChange(defaultTemplate)}>
                <RotateCcw aria-hidden /> 기본 틀로 되돌리기
              </Button>
            </div>
            <Textarea id="tpl-text" ref={area} rows={8} maxLength={1500} className="font-mono text-xs" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
            <p className="text-xs text-muted-foreground">{(value ?? '').length} / 1500자</p>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium">자리표시자 (누르면 커서 위치에 넣습니다)</p>
            <div className="flex flex-wrap gap-1">
              {(info.data?.placeholders ?? []).map((placeholder) => (
                <button
                  key={placeholder.key}
                  type="button"
                  title={placeholder.description}
                  onClick={() => insert(placeholder.key)}
                  className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Badge variant="outline" className="cursor-pointer font-mono hover:bg-muted">{`{${placeholder.key}}`}</Badge>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium">미리보기 (예시 데이터)</p>
            {preview.isError ? (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                {preview.error instanceof ApiError ? preview.error.message : '미리보기를 만들지 못했습니다.'}
              </p>
            ) : (
              <pre className="max-h-56 overflow-auto rounded-md border bg-muted/50 p-3 text-xs whitespace-pre-wrap">{preview.data?.text ?? '…'}</pre>
            )}
            <p className="text-xs text-muted-foreground">
              즉시 알림에 이 문구를 씁니다. 여러 건을 모아 보내는 요약과 최초 분석 요약은 목록 형식으로 보냅니다. 값이 없는 자리표시자는 "-" 로 채웁니다.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
