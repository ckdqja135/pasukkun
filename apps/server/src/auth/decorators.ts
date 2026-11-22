import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { AuthedRequest, AuthUser } from './auth.types.js';

export const IS_PUBLIC = 'isPublic';
/** 로그인 없이 접근할 수 있는 경로 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthUser => {
  const request = context.switchToHttp().getRequest<AuthedRequest>();
  return request.user as AuthUser;
});
