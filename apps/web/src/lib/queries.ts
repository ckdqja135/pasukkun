import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from './api';

export function useTechnologies() {
  return useQuery({ queryKey: ['technologies'], queryFn: () => unwrap(api.GET('/api/v1/technologies')), staleTime: 60 * 60_000 });
}

export function useInterests() {
  return useQuery({ queryKey: ['interests'], queryFn: () => unwrap(api.GET('/api/v1/me/interests')) });
}

export function useProjects() {
  return useQuery({ queryKey: ['projects'], queryFn: () => unwrap(api.GET('/api/v1/projects')) });
}

export function useIngestionStatus() {
  return useQuery({ queryKey: ['ingestion-status'], queryFn: () => unwrap(api.GET('/api/v1/status/ingestion')), refetchInterval: 30_000 });
}
