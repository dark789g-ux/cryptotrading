import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  AUTH_ADMIN_ONLY_KEY,
  AUTH_PUBLIC_KEY,
  SESSION_COOKIE_NAME,
} from './auth.constants';
import { SessionService } from './session.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(AUTH_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    const user = await this.sessions.validateToken(token);
    if (!user) {
      throw new UnauthorizedException('未登录或登录已过期');
    }

    request.user = user;

    const adminOnly = this.reflector.getAllAndOverride<boolean>(AUTH_ADMIN_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (adminOnly && user.role !== 'admin') {
      throw new ForbiddenException('无权限');
    }

    return true;
  }
}
