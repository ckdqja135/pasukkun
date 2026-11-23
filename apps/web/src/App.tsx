import { Navigate, Route, Routes } from 'react-router';
import { AppShell } from '@/components/app-shell';
import { ErrorState, LoadingState } from '@/components/states';
import { useMe } from '@/lib/auth';
import { DashboardPage } from '@/pages/dashboard';
import { DeliveriesPage } from '@/pages/deliveries';
import { FeedPage } from '@/pages/feed';
import { FindingDetailPage } from '@/pages/finding-detail';
import { FindingsPage } from '@/pages/findings';
import { InterestsPage } from '@/pages/interests';
import { LoginPage } from '@/pages/login';
import { NotificationsPage } from '@/pages/notifications';
import { ProjectDetailPage } from '@/pages/project-detail';
import { ProjectsPage } from '@/pages/projects';
import { StatusPage } from '@/pages/status';
import { VulnerabilityDetailPage } from '@/pages/vulnerability-detail';
import { CalendarPage } from '@/pages/calendar';
import { PackagesPage } from '@/pages/packages';

export function App() {
  const me = useMe();
  if (me.isPending) return <LoadingState />;
  if (me.isError) {
    return (
      <div className="mx-auto max-w-md p-6">
        <ErrorState error={me.error} onRetry={() => me.refetch()} />
      </div>
    );
  }
  if (!me.data) return <LoginPage />;

  return (
    <Routes>
      <Route element={<AppShell me={me.data} />}>
        <Route index element={<DashboardPage />} />
        <Route path="vulnerabilities" element={<FeedPage />} />
        <Route path="vulnerabilities/:id" element={<VulnerabilityDetailPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:id" element={<ProjectDetailPage />} />
        <Route path="findings" element={<FindingsPage />} />
        <Route path="findings/:id" element={<FindingDetailPage />} />
        <Route path="packages" element={<PackagesPage />} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="interests" element={<InterestsPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="deliveries" element={<DeliveriesPage />} />
        <Route path="status" element={<StatusPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
