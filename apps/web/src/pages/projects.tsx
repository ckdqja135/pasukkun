import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { GITHUB_ERRORS, GithubImportButton, GithubImportDialog, useStartGithubImport } from '@/components/github-import';
import { GithubMark } from '@/components/github-mark';
import { ProjectForm, type ProjectInput } from '@/components/project-form';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, unwrap } from '@/lib/api';
import { ENVIRONMENT_LABEL, EXPOSURE_LABEL, formatRelative, SCAN_STATUS_LABEL } from '@/lib/labels';
import { useProjects } from '@/lib/queries';

export function ProjectsPage() {
  const projects = useProjects();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const githubLink = params.get('github_link');
  const startGithub = useStartGithubImport();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    const error = params.get('github_error');
    const installed = params.get('github') === 'installed';
    if (!error && !installed) return;
    handled.current = true;
    const next = new URLSearchParams(params);
    next.delete('github_error');
    next.delete('github');
    setParams(next, { replace: true });
    if (error) toast.error(GITHUB_ERRORS[error] ?? 'GitHub 연결을 마치지 못했습니다.');
    // GitHub 에서 앱 설치·저장소 선택을 마치고 돌아오면 저장소 목록을 다시 받는다.
    if (installed) startGithub.mutate();
  }, [params, setParams, startGithub]);

  const closeGithub = () => {
    const next = new URLSearchParams(params);
    next.delete('github_link');
    setParams(next, { replace: true });
  };

  const create = useMutation({
    mutationFn: (body: ProjectInput) => unwrap(api.POST('/api/v1/projects', { body })),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      setOpen(false);
      toast.success('프로젝트를 등록했습니다. 이어서 의존성을 등록하세요.');
      void navigate(`/projects/${project.id}?tab=config`);
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <>
      <PageHeader
        title="프로젝트"
        description="프로젝트별로 구성(의존성)을 등록하고 설치 버전이 알려진 취약점의 영향 범위에 포함되는지 검사합니다."
        actions={
          <>
            <GithubImportButton />
            <Button onClick={() => setOpen(true)}>
              <Plus aria-hidden /> 프로젝트 등록
            </Button>
          </>
        }
      />

      {projects.isError ? (
        <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
      ) : !projects.data ? (
        <LoadingState />
      ) : projects.data.length === 0 ? (
        <EmptyState
          title="등록된 프로젝트가 없습니다"
          description="GitHub 저장소를 고르면 lockfile 을 알아서 가져와 검사합니다. 직접 등록하고 lockfile 을 올려도 됩니다."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <GithubImportButton size="sm" variant="default" />
              <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
                <Plus aria-hidden /> 직접 등록
              </Button>
            </div>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table className="table-fixed min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>프로젝트</TableHead>
                <TableHead className="w-48">환경 · 노출</TableHead>
                <TableHead className="w-56">최근 검사</TableHead>
                <TableHead className="w-72">분석 결과 (현재 구성)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.data.map((project) => (
                <TableRow key={project.id} className="align-top">
                  <TableCell className="whitespace-normal">
                    <Link to={`/projects/${project.id}`} className="font-medium underline-offset-2 hover:underline">
                      {project.name}
                    </Link>
                    {project.github ? (
                      <p className="flex items-center gap-1 text-xs text-muted-foreground">
                        <GithubMark className="size-3" /> {project.github.fullName}
                        {project.github.lockfilePath.includes('/') ? ` · ${project.github.lockfilePath}` : ''}
                        {project.github.status !== 'OK' ? <span className="text-destructive"> · {project.github.status === 'DISCONNECTED' ? '연결 끊김' : '확인 실패'}</span> : null}
                      </p>
                    ) : null}
                    {project.description ? <p className="text-xs text-muted-foreground">{project.description}</p> : null}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <div className="flex flex-wrap gap-1">
                      {project.environments.map((environment) => (
                        <Badge key={environment} variant="secondary">
                          {ENVIRONMENT_LABEL[environment]}
                        </Badge>
                      ))}
                      <Badge variant="outline">노출: {EXPOSURE_LABEL[project.exposure]}</Badge>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm whitespace-normal">
                    {!project.currentSnapshot ? (
                      <span className="text-muted-foreground">구성 미등록 - 검사 전</span>
                    ) : project.lastScan ? (
                      <>
                        {SCAN_STATUS_LABEL[project.lastScan.status]} · {formatRelative(project.lastScan.finishedAt ?? project.lastScan.createdAt)}
                        <p className="text-xs text-muted-foreground">
                          구성 #{project.lastScan.snapshotSeq} · 패키지 버전 {project.lastScan.packagesScanned}/{project.lastScan.packagesTotal}
                        </p>
                      </>
                    ) : (
                      <span className="text-muted-foreground">검사 전</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm whitespace-normal">
                    {project.lastScan && ['SUCCEEDED', 'PARTIAL'].includes(project.lastScan.status) ? (
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={project.counts.urgent ? 'destructive' : 'outline'}>긴급 {project.counts.urgent}</Badge>
                        <Badge variant="outline">영향 버전 일치 {project.counts.affected}</Badge>
                        <Badge variant="outline">판단 불가 {project.counts.unknown}</Badge>
                        <Badge variant="outline">미조치 {project.counts.open}</Badge>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">검사가 끝나야 결과를 볼 수 있습니다</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {githubLink ? <GithubImportDialog linkId={githubLink} onClose={closeGithub} /> : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>프로젝트 등록</DialogTitle>
            <DialogDescription>기본 정보를 입력한 뒤 다음 화면에서 lockfile 을 올립니다. GitHub 저장소라면 [GitHub 저장소 가져오기]가 더 간단합니다.</DialogDescription>
          </DialogHeader>
          <ProjectForm submitLabel="등록" pending={create.isPending} onSubmit={(value) => create.mutate(value)} onCancel={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
