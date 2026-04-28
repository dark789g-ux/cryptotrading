import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { CurrentUser as CurrentUserType } from '../auth.types';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserType | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);

export const CurrentUserParam = CurrentUser;
