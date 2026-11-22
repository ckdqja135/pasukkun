import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { GithubMark } from '@/components/github-mark';
import { api, unwrap } from '@/lib/api';

/** GitHub 로그인 실패 사유 (서버가 ?login_error= 로 알려준다) */
const LOGIN_ERRORS: Record<string, string> = {
  denied: 'GitHub 에서 로그인을 취소했습니다.',
  state_mismatch: '로그인 요청이 만료되었거나 다른 창에서 시작되었습니다. 다시 시도해 주세요.',
  github_error: 'GitHub 와 통신하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  invalid_profile: 'GitHub 계정 정보를 확인하지 못했습니다.',
  not_allowed: '이 서버는 허용된 GitHub 계정만 사용할 수 있습니다. 서버 관리자에게 문의하세요.',
  not_configured: 'GitHub 로그인이 아직 설정되지 않았습니다.',
};

export function LoginPage() {
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => unwrap(api.GET('/api/v1/auth/status')) });
  const [error] = useState(() => new URLSearchParams(window.location.search).get('login_error'));

  // 오류 표시 후 주소창의 ?login_error 는 지운다 (새로고침해도 다시 뜨지 않게).
  useEffect(() => {
    if (error) window.history.replaceState(null, '', window.location.pathname);
  }, [error]);

  const configured = status.data?.githubEnabled;

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ShieldAlert className="size-5" aria-hidden /> pasukkun
          </CardTitle>
          <CardDescription>취약점 모니터링 및 프로젝트 영향도 분석</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{LOGIN_ERRORS[error] ?? '로그인하지 못했습니다. 다시 시도해 주세요.'}</AlertDescription>
            </Alert>
          ) : null}

          {configured === false ? (
            <Alert>
              <AlertTitle>GitHub 로그인이 설정되지 않았습니다</AlertTitle>
              <AlertDescription>
                서버 관리자가 GitHub OAuth App 을 등록하고 서버 설정(.env)에 GITHUB_OAUTH_CLIENT_ID 와 GITHUB_OAUTH_CLIENT_SECRET 을 넣어야 로그인할 수 있습니다.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <Button asChild size="lg" className="w-full" disabled={!configured}>
                {/* 서버가 GitHub 로 보낸다. 화면 이동이므로 일반 링크를 쓴다. */}
                <a href="/api/v1/auth/github" aria-disabled={!configured}>
                  <GithubMark /> GitHub 로 계속하기
                </a>
              </Button>
              <ul className="space-y-1 text-xs text-muted-foreground">
                <li>처음이면 자동으로 가입됩니다. 따로 비밀번호를 만들지 않습니다.</li>
                <li>GitHub 공개 프로필(아이디, 이름)만 읽습니다. 저장소나 이메일에는 접근하지 않습니다.</li>
              </ul>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
