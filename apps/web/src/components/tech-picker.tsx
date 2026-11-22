import { Check } from 'lucide-react';
import type { Schemas } from '@/lib/api';
import { GROUP_LABEL } from '@/lib/labels';
import { cn } from '@/lib/utils';

type Technology = Schemas['TechnologyDto'];
const GROUP_ORDER = ['LANGUAGE', 'FRAMEWORK', 'RUNTIME', 'INFRA', 'DATABASE'];

/**
 * 그룹별 기술 선택. 같은 그룹 안에서 여러 개를 고르면 OR, 그룹 사이는 AND(기본)로 적용된다.
 */
export function TechPicker({
  technologies,
  selected,
  onChange,
  showSupport = false,
}: {
  technologies: Technology[];
  selected: string[];
  onChange: (ids: string[]) => void;
  showSupport?: boolean;
}) {
  const set = new Set(selected);
  const toggle = (id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(technologies.filter((t) => next.has(t.id)).map((t) => t.id));
  };

  return (
    <div className="space-y-3">
      {GROUP_ORDER.map((group) => {
        const items = technologies.filter((t) => t.group === group);
        if (items.length === 0) return null;
        return (
          <fieldset key={group} className="space-y-1.5">
            <legend className="text-xs font-medium text-muted-foreground">{GROUP_LABEL[group]}</legend>
            <div className="flex flex-wrap gap-1.5">
              {items.map((technology) => {
                const active = set.has(technology.id);
                return (
                  <button
                    key={technology.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggle(technology.id)}
                    title={technology.scanSupport === 'PRECISE' ? 'npm 설치 버전 정밀 검사 지원' : '피드 관련성 표시만 지원 (정밀 검사 미지원)'}
                    className={cn(
                      'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
                    )}
                  >
                    {active ? <Check className="size-3" aria-hidden /> : null}
                    {technology.name}
                    {showSupport ? (
                      <span className={cn('ml-0.5 rounded px-1 text-[10px]', active ? 'bg-primary-foreground/20' : 'bg-muted text-muted-foreground')}>
                        {technology.scanSupport === 'PRECISE' ? '정밀 검사' : '피드만'}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
