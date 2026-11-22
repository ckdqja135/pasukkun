import { useState, type FormEvent } from 'react';
import { NativeSelect } from '@/components/native-select';
import { TechPicker } from '@/components/tech-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { Schemas } from '@/lib/api';
import { ENVIRONMENT_LABEL, EXPOSURE_LABEL } from '@/lib/labels';
import { useTechnologies } from '@/lib/queries';

export type ProjectInput = Schemas['ProjectInputDto'];
type Environment = NonNullable<ProjectInput['environments']>[number];
const ENVIRONMENTS: Environment[] = ['PRODUCTION', 'DEVELOPMENT', 'TEST'];

export function ProjectForm({
  initial,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  initial?: Partial<ProjectInput>;
  submitLabel: string;
  pending: boolean;
  onSubmit: (value: ProjectInput) => void;
  onCancel?: () => void;
}) {
  const technologies = useTechnologies();
  const [value, setValue] = useState<ProjectInput>({
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    environments: initial?.environments ?? [],
    exposure: initial?.exposure ?? 'UNKNOWN',
    runtime: initial?.runtime ?? '',
    runtimeVersion: initial?.runtimeVersion ?? '',
    os: initial?.os ?? '',
    distro: initial?.distro ?? '',
    arch: initial?.arch ?? '',
    notes: initial?.notes ?? '',
    technologyIds: initial?.technologyIds ?? [],
  });
  const set = <K extends keyof ProjectInput>(key: K, next: ProjectInput[K]) => setValue((current) => ({ ...current, [key]: next }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(value);
  };
  const environments = value.environments ?? [];

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="p-name">프로젝트명</Label>
          <Input id="p-name" required maxLength={100} value={value.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="p-desc">설명</Label>
          <Input id="p-desc" maxLength={2000} value={value.description} onChange={(e) => set('description', e.target.value)} />
        </div>
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">환경 (복수 선택)</legend>
          <div className="flex flex-wrap gap-1.5">
            {ENVIRONMENTS.map((environment) => {
              const active = environments.includes(environment);
              return (
                <Button
                  key={environment}
                  type="button"
                  size="sm"
                  variant={active ? 'default' : 'outline'}
                  aria-pressed={active}
                  onClick={() => set('environments', active ? environments.filter((e) => e !== environment) : [...environments, environment])}
                >
                  {ENVIRONMENT_LABEL[environment]}
                </Button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">선택하지 않으면 운영 환경을 포함하는 것으로 보수적으로 봅니다.</p>
        </fieldset>
        <div className="space-y-1.5">
          <Label htmlFor="p-exposure">인터넷 공개 여부</Label>
          <NativeSelect id="p-exposure" value={value.exposure} onChange={(e) => set('exposure', e.target.value as ProjectInput['exposure'])}>
            {(['UNKNOWN', 'PUBLIC', 'INTERNAL'] as const).map((exposure) => (
              <option key={exposure} value={exposure}>
                {EXPOSURE_LABEL[exposure]}
              </option>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">'알 수 없음'은 우선순위 계산에서 '공개'와 같게 취급합니다.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-runtime">런타임</Label>
          <Input id="p-runtime" placeholder="예: Node.js" maxLength={60} value={value.runtime} onChange={(e) => set('runtime', e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-runtime-version">런타임 정확한 버전</Label>
          <Input id="p-runtime-version" placeholder="예: 22.11.0" maxLength={60} value={value.runtimeVersion} onChange={(e) => set('runtimeVersion', e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-os">운영체제</Label>
          <Input id="p-os" placeholder="예: Linux" maxLength={60} value={value.os} onChange={(e) => set('os', e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="p-distro">배포판</Label>
            <Input id="p-distro" placeholder="예: Debian 12" maxLength={60} value={value.distro} onChange={(e) => set('distro', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-arch">아키텍처</Label>
            <Input id="p-arch" placeholder="예: arm64" maxLength={30} value={value.arch} onChange={(e) => set('arch', e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>언어 · 프레임워크 등 사용 기술</Label>
          {technologies.data ? (
            <TechPicker technologies={technologies.data} selected={value.technologyIds ?? []} onChange={(ids) => set('technologyIds', ids)} showSupport />
          ) : null}
          <p className="text-xs text-muted-foreground">
            런타임·OS 버전은 기록용입니다. 이 값으로 자동 판정하지 않으며, 관련 공지는 수동 검토 대상으로 안내합니다.
          </p>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="p-notes">담당 메모</Label>
          <Textarea id="p-notes" rows={3} maxLength={5000} value={value.notes} onChange={(e) => set('notes', e.target.value)} />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            취소
          </Button>
        ) : null}
        <Button type="submit" disabled={pending || !value.name.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
