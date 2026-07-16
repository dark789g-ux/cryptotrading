import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ApiKeysService } from '../api-keys/api-keys.service';
import {
  AUTH_ADMIN_ONLY_KEY,
  AUTH_PUBLIC_KEY,
  API_KEY_PREFIX,
  SESSION_COOKIE_NAME,
} from './shared/auth.constants';
import { SessionService } from './services/session.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly apiKeys: ApiKeysService,
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

    // Path 1: session (cookie) first
    const cookieToken = request.cookies?.[SESSION_COOKIE_NAME];
    let user = cookieToken ? await this.sessions.validateToken(cookieToken) : null;
    let authType: 'session' | 'apikey' = 'session';

    // Path 2: fallback to API Key (Authorization: Bearer <key>)
    if (!user) {
      const bearer = extractBearerToken(request.headers?.authorization);
      if (bearer && bearer.startsWith(API_KEY_PREFIX)) {
        const keyUser = await this.apiKeys.validateKey(bearer);
        if (keyUser) {
          user = keyUser;
          authType = 'apikey';
        }
      }
    }

    if (!user) {
      throw new UnauthorizedException('未登录或 API Key 无效');
    }

    request.user = { ...user, authType };

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

function extractBearerToken(authHeader: unknown): string | null {
  if (typeof authHeader !== 'string') return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
