import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw, Unlink, XCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Pill } from '@/components/badges';
import { GITHUB_STATUS_LABEL, LOCKFILE_FORMAT_LABEL, useStartGithubImport } from '@/components/github-import';
import { GithubMark } from '@/components/github-mark';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, unwrap, type Schemas } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/labels';

type Project = Schemas['ProjectDto'];
type Snapshot = Schemas['SnapshotDto'];

const FILE_LABEL: Record<'NPM' | 'PNPM' | 'YARN', string> = { NPM: 'package-lock', PNPM: 'pnpm-lock', YARN: 'yarn.lock' };

/** 스냅샷 목록에 보일 짧은 설명 */
export function snapshotLabel(snapshot: Snapshot): string {
  if (snapshot.inputType === 'MANUAL') return '직접 입력';
  const file = snapshot.lockfileFormat ? `${FILE_LABEL[snapshot.lockfileFormat]} v${snapshot.lockfileVersion}` : `lockfile v${snapshot.lockfileVersion}`;
  return snapshot.source === 'GITHUB' ? `GitHub${snapshot.sourceRef ? ` ${snapshot.sourceRef.slice(0, 7)}` : ''} · ${file}` : file;
}

export function GithubSourceCard({ project }: { project: Project }) {
  const github = project.github;
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const relink = useStartGithubImport();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['project', project.id] });

  const sync = useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/projects/{id}/github/sync', { params: { path: { id: project.id } } })),
    onSuccess: () => {
      toast.success('GitHub 에서 lockfile 이 바뀌었는지 확인합니다. 바뀌었으면 새 구성으로 검사합니다.');
      // 확인은 백그라운드에서 끝나므로 잠시 뒤 다시 읽는다.
      for (const delay of [2_000, 6_000, 15_000]) setTimeout(refresh, delay);
    },
    onError: (error) => toast.error(error.message),
  });
  const disconnect = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/v1/projects/{id}/github', { params: { path: { id: project.id } } })),
    onSuccess: () => {
      toast.success('GitHub 연결을 해제했습니다. 지금까지의 구성과 분석 결과는 그대로 남습니다.');
      setConfirming(false);
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (error) => toast.error(error.message),
  });

  if (!github) return null;
  const format = project.currentSnapshot?.lockfileFormat;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <GithubMark /> GitHub 저장소
          <Pill
            tone={github.status === 'OK' ? 'green' : github.status === 'ERROR' ? 'amber' : 'red'}
            icon={github.status === 'OK' ? CheckCircle2 : github.status === 'ERROR' ? AlertTriangle : XCircle}
          >
            {GITHUB_STATUS_LABEL[github.status]}
          </Pill>
        </CardTitle>
        <CardDescription>저장소의 lockfile 을 자동으로 가져옵니다. 바뀌면 새 구성으로 등록하고 다시 검사합니다.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">저장소</dt>
          <dd>
            <a className="inline-flex items-center gap-1 underline-offset-2 hover:underline" href={github.url} target="_blank" rel="noreferrer noopener">
              {github.fullName} <ExternalLink aria-hidden className="size-3" />
            </a>
          </dd>
          <dt className="text-muted-foreground">lockfile</dt>
          <dd className="font-mono text-xs leading-5">
            {github.lockfilePath}
            {format ? <span className="ml-2 font-sans text-muted-foreground">{LOCKFILE_FORMAT_LABEL[format]}</span> : null}
          </dd>
          <dt className="text-muted-foreground">브랜치 · 커밋</dt>
          <dd>
            {github.branch}
            {github.commitSha ? <span className="ml-2 font-mono text-xs text-muted-foreground">{github.commitSha.slice(0, 7)}</span> : null}
          </dd>
          <dt className="text-muted-foreground">마지막 확인</dt>
          <dd title={github.lastCheckedAt ? formatDateTime(github.lastCheckedAt) : undefined}>
            {github.lastCheckedAt ? formatRelative(github.lastCheckedAt) : '아직 확인 전'}
            {github.lastChangedAt ? <span className="text-muted-foreground"> · 마지막 변경 반영 {formatRelative(github.lastChangedAt)}</span> : null}
          </dd>
        </dl>
        {github.error ? <p className={github.status === 'DISCONNECTED' ? 'text-sm text-destructive' : 'text-sm text-amber-700 dark:text-amber-400'}>{github.error}</p> : null}
        <div className="flex flex-wrap gap-2">
          {github.status === 'DISCONNECTED' ? (
            <Button size="sm" disabled={relink.isPending} onClick={() => relink.mutate()}>
              <GithubMark /> GitHub 로 다시 연결
            </Button>
          ) : null}
          <Button size="sm" variant="outline" disabled={sync.isPending} onClick={() => sync.mutate()}>
            <RefreshCw aria-hidden /> 지금 확인
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirming(true)}>
            <Unlink aria-hidden /> 연결 해제
          </Button>
        </div>
      </CardContent>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>GitHub 연결을 해제할까요?</DialogTitle>
            <DialogDescription>
              더 이상 저장소의 lockfile 을 확인하지 않습니다. 프로젝트와 지금까지의 구성·분석 결과는 남고, 이후에는 lockfile 을 직접 올려 검사할 수 있습니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              취소
            </Button>
            <Button variant="destructive" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
              연결 해제
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
