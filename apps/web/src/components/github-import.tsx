import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Lock, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { GithubMark } from '@/components/github-mark';
import { EmptyState, LoadingState } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, unwrap, type Schemas } from '@/lib/api';

type InspectRepo = Schemas['GithubInspectRepoDto'];

const MAX_REPOS = 20;

export const GITHUB_ERRORS: Record<string, string> = {
  expired: 'GitHub 연결 시간이 지났습니다. 다시 시도해 주세요.',
  session: '연결을 시작한 로그인 상태에서 끝내지 못했습니다. 다시 시도해 주세요.',
  denied: 'GitHub 에서 취소했습니다.',
  github: 'GitHub 에서 저장소 목록을 받아오지 못했습니다. 잠시 후 다시 시도해 주세요.',
  not_configured: '이 서버에는 GitHub 앱이 설정되지 않았습니다.',
};

export const LOCKFILE_FORMAT_LABEL: Record<'NPM' | 'PNPM' | 'YARN', string> = { NPM: 'npm', PNPM: 'pnpm', YARN: 'Yarn' };

export function useGithubStatus() {
  return useQuery({ queryKey: ['github-status'], queryFn: () => unwrap(api.GET('/api/v1/github/status')), staleTime: 5 * 60_000 });
}

/** GitHub 인증으로 이동한다. 돌아오면 /projects?github_link=… 로 온다. */
export function useStartGithubImport() {
  return useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/github/link')),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (error) => toast.error(error.message),
  });
}

export function GithubImportButton({ size, variant = 'outline' }: { size?: 'sm' | 'default'; variant?: 'outline' | 'default' }) {
  const status = useGithubStatus();
  const start = useStartGithubImport();
  const disabled = !status.data?.enabled || start.isPending;
  return (
    <Button
      size={size}
      variant={variant}
      disabled={disabled}
      title={status.data && !status.data.enabled ? '이 서버에는 GitHub 앱이 설정되지 않았습니다. 서비스 운영자에게 문의하세요.' : undefined}
      onClick={() => start.mutate()}
    >
      <GithubMark /> GitHub 저장소 가져오기
    </Button>
  );
}

export function GithubImportDialog({ linkId, onClose }: { linkId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const start = useStartGithubImport();
  const status = useGithubStatus();
  const syncHours = Math.max(1, Math.round((status.data?.syncMinutes ?? 360) / 60));
  const link = useQuery({
    queryKey: ['github-link', linkId],
    queryFn: () => unwrap(api.GET('/api/v1/github/links/{id}', { params: { path: { id: linkId } } })),
    retry: false,
  });
  const [step, setStep] = useState<'repos' | 'files'>('repos');
  const [query, setQuery] = useState('');
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [inspected, setInspected] = useState<InspectRepo[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);

  const repos = link.data?.repos ?? [];
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? repos.filter((repo) => repo.fullName.toLowerCase().includes(q) || repo.description.toLowerCase().includes(q)) : repos;
  }, [repos, query]);

  const inspect = useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/github/links/{id}/inspect', { params: { path: { id: linkId } }, body: { repoIds: selectedRepos } })),
    onSuccess: (data) => {
      setInspected(data.repos);
      // 저장소 맨 위의 lockfile 을 먼저 고른다. 맨 위에 없으면 찾은 것을 모두 고른다.
      const picks: string[] = [];
      for (const repo of data.repos) {
        const open = repo.lockfiles.filter((file) => !file.imported);
        const root = open.filter((file) => !file.path.includes('/'));
        for (const file of root.length > 0 ? root : open) picks.push(`${repo.repoId}:${file.path}`);
      }
      setSelectedFiles(picks);
      setStep('files');
    },
    onError: (error) => toast.error(error.message),
  });

  const importRepos = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/github/links/{id}/import', {
          params: { path: { id: linkId } },
          body: {
            items: selectedFiles.map((key) => {
              const at = key.indexOf(':');
              return { repoId: key.slice(0, at), lockfilePath: key.slice(at + 1) };
            }),
          },
        }),
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      if (data.created.length > 0) toast.success(`프로젝트 ${data.created.length}개를 만들었습니다. lockfile 을 가져와 첫 검사를 시작합니다.`);
      for (const skipped of data.skipped) toast.error(`${skipped.lockfilePath}: ${skipped.reason}`);
      onClose();
    },
    onError: (error) => toast.error(error.message),
  });

  const toggle = (list: string[], value: string, on: boolean) => (on ? [...new Set([...list, value])] : list.filter((item) => item !== value));
  const installUrl = link.data?.installUrl ?? null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>GitHub 저장소 가져오기</DialogTitle>
          <DialogDescription>
            {step === 'repos'
              ? '프로젝트로 만들 저장소를 고르세요. 서비스 GitHub 앱이 설치된 저장소 중 내가 접근할 수 있는 것만 보입니다.'
              : '저장소에서 찾은 lockfile 입니다. 고른 lockfile 마다 프로젝트가 하나씩 만들어집니다.'}
          </DialogDescription>
        </DialogHeader>

        {link.isError || (link.data && link.data.status !== 'READY') ? (
          <Alert variant="destructive">
            <AlertTitle>{link.data?.status === 'COMPLETED' ? '이미 가져오기를 마쳤습니다' : '연결을 이어갈 수 없습니다'}</AlertTitle>
            <AlertDescription>
              <p>{link.data?.error ?? '연결 시간이 지났거나 이미 처리되었습니다.'}</p>
              <Button size="sm" variant="outline" className="mt-2" disabled={start.isPending} onClick={() => start.mutate()}>
                다시 시작
              </Button>
            </AlertDescription>
          </Alert>
        ) : !link.data ? (
          <LoadingState />
        ) : step === 'repos' ? (
          repos.length === 0 ? (
            <EmptyState
              title="가져올 수 있는 저장소가 없습니다"
              description="GitHub 에서 서비스 앱을 설치하고 분석할 저장소를 고르면 여기에 나타납니다."
              action={
                installUrl ? (
                  <Button size="sm" onClick={() => (window.location.href = installUrl)}>
                    <GithubMark /> GitHub 에서 저장소 추가
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="space-y-3">
              <div className="relative">
                <Search aria-hidden className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
                <Input className="pl-8" placeholder="저장소 이름으로 찾기" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="저장소 찾기" />
              </div>
              <ul className="max-h-[45svh] divide-y overflow-y-auto rounded-lg border">
                {visible.map((repo) => {
                  const checked = selectedRepos.includes(repo.repoId);
                  const full = !checked && selectedRepos.length >= MAX_REPOS;
                  return (
                    <li key={repo.repoId}>
                      <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-muted/50">
                        <Checkbox
                          className="mt-0.5"
                          checked={checked}
                          disabled={full}
                          onCheckedChange={(on) => setSelectedRepos((list) => toggle(list, repo.repoId, on === true))}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                            {repo.fullName}
                            {repo.private ? (
                              <Badge variant="outline" className="gap-1">
                                <Lock aria-hidden className="size-3" /> 비공개
                              </Badge>
                            ) : null}
                            {repo.importedPaths.length > 0 ? <Badge variant="secondary">가져옴 {repo.importedPaths.length}</Badge> : null}
                          </span>
                          {repo.description ? <span className="block truncate text-xs text-muted-foreground">{repo.description}</span> : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
                {visible.length === 0 ? <li className="px-3 py-6 text-center text-sm text-muted-foreground">찾는 저장소가 없습니다.</li> : null}
              </ul>
              <p className="text-xs text-muted-foreground">
                한 번에 {MAX_REPOS}개까지 고를 수 있습니다.{' '}
                {installUrl ? (
                  <a className="inline-flex items-center gap-0.5 underline underline-offset-2" href={installUrl}>
                    목록에 없는 저장소 추가 <ExternalLink aria-hidden className="size-3" />
                  </a>
                ) : null}
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={onClose}>
                  취소
                </Button>
                <Button disabled={selectedRepos.length === 0 || inspect.isPending} onClick={() => inspect.mutate()}>
                  {inspect.isPending ? 'lockfile 찾는 중…' : `다음 (${selectedRepos.length})`}
                </Button>
              </DialogFooter>
            </div>
          )
        ) : (
          <div className="space-y-3">
            {inspected.map((repo) => (
              <section key={repo.repoId} className="rounded-lg border p-3">
                <h3 className="text-sm font-medium">
                  {repo.fullName} <span className="font-normal text-muted-foreground">· {repo.defaultBranch} 브랜치</span>
                </h3>
                {repo.error ? (
                  <p className="mt-1 text-sm text-destructive">{repo.error}</p>
                ) : repo.lockfiles.length === 0 ? (
                  <p className="mt-1 text-sm text-muted-foreground">지원하는 lockfile(package-lock.json, pnpm-lock.yaml, yarn.lock)이 없습니다.</p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {repo.lockfiles.map((file) => {
                      const key = `${repo.repoId}:${file.path}`;
                      return (
                        <li key={key}>
                          <label className="flex cursor-pointer items-center gap-2 text-sm">
                            <Checkbox
                              checked={selectedFiles.includes(key)}
                              disabled={file.imported}
                              onCheckedChange={(on) => setSelectedFiles((list) => toggle(list, key, on === true))}
                            />
                            <span className="font-mono text-xs">{file.path}</span>
                            <Badge variant="outline">{LOCKFILE_FORMAT_LABEL[file.format]}</Badge>
                            {file.imported ? <span className="text-xs text-muted-foreground">이미 가져옴</span> : null}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {repo.truncated ? <p className="mt-1 text-xs text-muted-foreground">저장소가 커서 일부 폴더에서만 찾았습니다.</p> : null}
              </section>
            ))}
            <Alert>
              <AlertTitle>읽는 파일</AlertTitle>
              <AlertDescription>
                GitHub 권한상 앱은 고른 저장소의 파일을 읽을 수 있지만, pasukkun 은 고른 lockfile 과 그 옆의 package.json 만 읽습니다. 소스코드는 읽지 않고, GitHub 토큰은 저장하지
                않습니다. 이후 {syncHours}시간마다 lockfile 이 바뀌었는지 확인해 바뀌었으면 다시 검사합니다.
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep('repos')}>
                뒤로
              </Button>
              <Button disabled={selectedFiles.length === 0 || importRepos.isPending} onClick={() => importRepos.mutate()}>
                가져오기 ({selectedFiles.length})
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 프로젝트 상세의 GitHub 연결 상태 표시에 쓰는 라벨 */
export const GITHUB_STATUS_LABEL: Record<'OK' | 'ERROR' | 'DISCONNECTED', string> = { OK: '연결됨', ERROR: '확인 실패', DISCONNECTED: '연결 끊김' };

