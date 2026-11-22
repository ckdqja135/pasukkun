import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, Bell, FolderKanban, LayoutDashboard, ListChecks, LogOut, Moon, Send, ShieldAlert, Sparkles, Sun } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';
import { Button } from '@/components/ui/button';
import { api, unwrap } from '@/lib/api';
import { ME_KEY, type Me } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: '대시보드', icon: LayoutDashboard, end: true },
  { to: '/vulnerabilities', label: '취약점 피드', icon: ShieldAlert },
  { to: '/projects', label: '프로젝트', icon: FolderKanban },
  { to: '/findings', label: '분석 결과', icon: ListChecks },
  { to: '/interests', label: '관심 기술', icon: Sparkles },
  { to: '/notifications', label: '알림 설정', icon: Bell },
  { to: '/deliveries', label: '발송 이력', icon: Send },
  { to: '/status', label: '수집 상태', icon: Activity },
];

export function AppShell({ me }: { me: Me }) {
  const { theme, toggle } = useTheme();
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/auth/logout')),
    onSettled: () => {
      queryClient.clear();
      queryClient.setQueryData(ME_KEY, null);
    },
  });

  return (
    <div className="flex min-h-svh">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:ring-2">
        본문으로 건너뛰기
      </a>
      <aside className="sticky top-0 flex h-svh w-56 shrink-0 flex-col border-r bg-sidebar max-md:w-14">
        <div className="flex h-14 items-center gap-2 border-b px-4 max-md:justify-center max-md:px-0">
          <ShieldAlert className="size-5" aria-hidden />
          <span className="font-semibold tracking-tight max-md:hidden">pasukkun</span>
        </div>
        <nav aria-label="주 메뉴" className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={item.label}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:justify-center',
                  isActive ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
                )
              }
            >
              <item.icon className="size-4 shrink-0" aria-hidden />
              <span className="max-md:sr-only">{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="space-y-1 border-t p-2">
          <p className="truncate px-2 text-xs text-muted-foreground max-md:hidden" title={me.name ?? me.githubLogin}>
            @{me.githubLogin}
          </p>
          <div className="flex gap-1 max-md:flex-col">
            <Button variant="ghost" size="sm" className="flex-1 justify-start max-md:justify-center" onClick={toggle} aria-label={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}>
              {theme === 'dark' ? <Sun aria-hidden /> : <Moon aria-hidden />}
              <span className="max-md:sr-only">{theme === 'dark' ? '라이트' : '다크'}</span>
            </Button>
            <Button variant="ghost" size="sm" className="flex-1 justify-start max-md:justify-center" onClick={() => logout.mutate()} disabled={logout.isPending}>
              <LogOut aria-hidden />
              <span className="max-md:sr-only">로그아웃</span>
            </Button>
          </div>
        </div>
      </aside>
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 outline-none">
        <div className="mx-auto max-w-[1400px] space-y-6 p-6 max-md:p-4">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="max-w-3xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
