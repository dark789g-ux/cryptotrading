import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request, Response } from 'express';
import { Repository } from 'typeorm';

import {
  REMEMBER_SESSION_TTL_MS,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
} from './auth.constants';
import { AuthSessionEntity } from './entities/auth-session.entity';
import { CurrentUser } from './auth.types';
import { generateToken, hashToken, newId, toAuthUser } from './auth.utils';
import { UserEntity } from '../users/entities/user.entity';

@Injectable()
export class SessionService {
  constructor(
    @InjectRepository(AuthSessionEntity)
    private readonly sessionsRepo: Repository<AuthSessionEntity>,
  ) {}

  async createSession(
    user: UserEntity,
    rememberMe: boolean,
    request: Request,
    response: Response,
  ): Promise<CurrentUser> {
    const token = generateToken();
    const ttl = rememberMe ? REMEMBER_SESSION_TTL_MS : SESSION_TTL_MS;
    const expiresAt = new Date(Date.now() + ttl);
    const userAgent = String(request.headers['user-agent'] ?? '').slice(0, 1000) || null;
    const forwardedFor = request.headers['x-forwarded-for'];
    const ip = Array.isArray(forwardedFor)
      ? forwardedFor[0]
      : String(forwardedFor || request.ip || '').split(',')[0].trim() || null;

    await this.sessionsRepo.save({
      id: newId(),
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
      revokedAt: null,
      lastSeenAt: null,
      userAgent,
      ip,
    });

    this.setCookie(response, token, ttl);
    return toAuthUser(user);
  }

  async validateToken(token: string): Promise<CurrentUser | null> {
    if (!token) {
      return null;
    }

    const session = await this.sessionsRepo
      .createQueryBuilder('session')
      .innerJoinAndSelect('session.user', 'user')
      .where('session.token_hash = :tokenHash', { tokenHash: hashToken(token) })
      .andWhere('session.revoked_at IS NULL')
      .andWhere('session.expires_at > :now', { now: new Date() })
      .andWhere('user.is_active = true')
      .getOne();

    if (!session) {
      return null;
    }

    await this.sessionsRepo.update(session.id, { lastSeenAt: new Date() });
    return toAuthUser(session.user);
  }

  async revokeToken(token: string | undefined): Promise<void> {
    if (!token) {
      return;
    }
    await this.sessionsRepo
      .createQueryBuilder()
      .update(AuthSessionEntity)
      .set({ revokedAt: new Date() })
      .where('token_hash = :tokenHash', { tokenHash: hashToken(token) })
      .andWhere('revoked_at IS NULL')
      .execute();
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.sessionsRepo
      .createQueryBuilder()
      .update(AuthSessionEntity)
      .set({ revokedAt: new Date() })
      .where('user_id = :userId', { userId })
      .andWhere('revoked_at IS NULL')
      .execute();
  }

  clearCookie(response: Response): void {
    response.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/api',
    });
  }

  private setCookie(response: Response, token: string, maxAge: number): void {
    response.cookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/api',
      maxAge,
    });
  }
}
