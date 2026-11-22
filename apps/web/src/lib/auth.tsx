import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, ApiError, setCsrfToken, setUnauthorizedHandler, unwrap, type Schemas } from './api';

export type Me = Schemas['MeDto'];
export const ME_KEY = ['me'] as const;

/** 로그인 상태. 로그인하지 않았으면 data 가 null 이다. */
export function useMe() {
  const queryClient = useQueryClient();
  useEffect(() => {
    setUnauthorizedHandler(() => queryClient.setQueryData(ME_KEY, null));
  }, [queryClient]);

  return useQuery({
    queryKey: ME_KEY,
    queryFn: async (): Promise<Me | null> => {
      try {
        const me = await unwrap(api.GET('/api/v1/auth/me'));
        setCsrfToken(me.csrfToken);
        return me;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}
