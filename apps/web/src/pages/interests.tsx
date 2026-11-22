import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { NativeSelect } from '@/components/native-select';
import { ErrorState, LoadingState, UnsupportedNote } from '@/components/states';
import { TechPicker } from '@/components/tech-picker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { api, unwrap } from '@/lib/api';
import { ME_KEY, useMe } from '@/lib/auth';
import { useInterests, useTechnologies } from '@/lib/queries';

export function InterestsPage() {
  const queryClient = useQueryClient();
  const me = useMe();
  const technologies = useTechnologies();
  const interests = useInterests();
  const [selected, setSelected] = useState<string[] | null>(null);
  const [mode, setMode] = useState<'ALL_GROUPS' | 'ANY_GROUP' | null>(null);

  useEffect(() => {
    if (interests.data && selected === null) setSelected(interests.data.technologyIds);
  }, [interests.data, selected]);
  useEffect(() => {
    if (me.data && mode === null) setMode(me.data.settings.interestMatchMode);
  }, [me.data, mode]);

  const save = useMutation({
    mutationFn: async () => {
      const saved = await unwrap(api.PUT('/api/v1/me/interests', { body: { technologyIds: selected ?? [] } }));
      const settings = await unwrap(api.PATCH('/api/v1/me/settings', { body: { interestMatchMode: mode ?? 'ALL_GROUPS' } }));
      return { saved, settings };
    },
    onSuccess: ({ saved, settings }) => {
      queryClient.setQueryData(['interests'], saved);
      queryClient.setQueryData(ME_KEY, (current: typeof me.data) => (current ? { ...current, settings } : current));
      void queryClient.invalidateQueries({ queryKey: ['rules'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('관심 기술을 저장했습니다.');
    },
    onError: (error) => toast.error(error.message),
  });

  if (technologies.isError || interests.isError) return <ErrorState error={technologies.error ?? interests.error} />;
  if (!technologies.data || selected === null || mode === null) return <LoadingState />;
  const dirty =
    JSON.stringify([...selected].sort()) !== JSON.stringify([...(interests.data?.technologyIds ?? [])].sort()) || mode !== me.data?.settings.interestMatchMode;

  return (
    <>
      <PageHeader
        title="관심 기술"
        description="계정에 저장되는 관심 기술입니다. 피드의 기본 필터와 '관심 기술의 신규 취약점' 알림에 쓰입니다. 피드 화면에서 임시로 바꾼 필터는 여기에 영향을 주지 않습니다."
        actions={
          <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            저장
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>기술 선택</CardTitle>
          <CardDescription>아무것도 선택하지 않으면 피드는 수집된 전체를 보여주고, 관심 기술 알림은 발송되지 않습니다.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <TechPicker technologies={technologies.data} selected={selected} onChange={setSelected} showSupport />
          <div className="max-w-md space-y-1.5 border-t pt-4">
            <Label htmlFor="interest-mode">그룹 간 결합 방식</Label>
            <NativeSelect id="interest-mode" value={mode} onChange={(e) => setMode(e.target.value as 'ALL_GROUPS' | 'ANY_GROUP')}>
              <option value="ALL_GROUPS">선택한 모든 그룹에 해당 (AND, 기본)</option>
              <option value="ANY_GROUP">선택한 항목 중 하나라도 해당 (OR)</option>
            </NativeSelect>
            <p className="text-xs text-muted-foreground">
              같은 그룹 안에서는 항상 하나라도 일치하면 됩니다. 예를 들어 언어에서 TypeScript, 데이터베이스에서 PostgreSQL 을 고르면 AND 는 두 그룹 모두에
              해당하는 공지만 남기므로 PostgreSQL 서버 자체의 공지는 빠집니다. 선택한 기술 각각의 공지를 모두 받고 싶다면 OR 를 쓰세요.
            </p>
          </div>
        </CardContent>
      </Card>
      <UnsupportedNote title="관심 기술과 정밀 검사는 다릅니다">
        관심 기술은 관련 공지를 골라 보여주는 기준일 뿐, 프로젝트가 영향을 받는지 판정하지 않습니다. 설치 버전을 비교하는 정밀 검사는 현재 npm
        (package-lock.json) 만 지원합니다. '피드만'으로 표시된 언어·런타임·OS·데이터베이스는 관련 공지 표시와 수동 검토만 가능합니다.
      </UnsupportedNote>
    </>
  );
}
