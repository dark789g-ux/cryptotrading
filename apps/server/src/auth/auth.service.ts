import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request, Response } from 'express';
import { DataSource, Repository } from 'typeorm';

import { UserEntity } from '../users/entities/user.entity';
import { UserInvitationEntity } from '../users/entities/user-invitation.entity';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import {
  assertEmail,
  hashToken,
  newId,
  normalizeEmail,
  toAuthUser,
} from './auth.utils';
import {
  AcceptInvitationDto,
  AuthUserDto,
  BootstrapDto,
  ChangePasswordDto,
  LoginDto,
} from './dto/auth.dto';

const OWNED_TABLES = [
  'strategies',
  'backtest_runs',
  'watchlists',
  'symbol_presets',
  'a_share_filter_presets',
];

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly usersRepo: Repository<UserEntity>,
    @InjectRepository(UserInvitationEntity)
    private readonly invitationsRepo: Repository<UserInvitationEntity>,
    private readonly dataSource: DataSource,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
  ) {}

  async bootstrapStatus(): Promise<{ initialized: boolean }> {
    const count = await this.usersRepo.count();
    return { initialized: count > 0 };
  }

  async bootstrap(
    dto: BootstrapDto,
    request: Request,
    response: Response,
  ): Promise<{ user: AuthUserDto }> {
    const email = this.parseEmail(dto.email);
    const displayName = this.parseDisplayName(dto.displayName, email);
    const password = this.parsePassword(dto.password);

    const user = await this.dataSource.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext('cryptotrading.bootstrap_admin'))`);
      const count = await manager.getRepository(UserEntity).count();
      if (count > 0) {
        throw new ConflictException('系统已初始化');
      }

      const admin = await manager.getRepository(UserEntity).save({
        id: newId(),
        email,
        displayName,
        role: 'admin',
        passwordHash: await this.passwords.hashPassword(password),
        isActive: true,
      });

      await this.backfillExistingData(manager, admin.id);
      return admin;
    });

    return {
      user: await this.sessions.createSession(user, Boolean(dto.rememberMe), request, response),
    };
  }

  async login(
    dto: LoginDto,
    request: Request,
    response: Response,
  ): Promise<{ user: AuthUserDto }> {
    const email = normalizeEmail(dto.email || '');
    const user = await this.usersRepo
      .createQueryBuilder('user')
      .where('LOWER(user.email) = :email', { email })
      .getOne();
    const passwordOk = user
      ? await this.passwords.verifyPassword(String(dto.password || ''), user.passwordHash)
      : false;

    if (!user || !passwordOk || !user.isActive) {
      throw new UnauthorizedException('账号或密码不正确');
    }

    return {
      user: await this.sessions.createSession(user, Boolean(dto.rememberMe), request, response),
    };
  }

  async logout(token: string | undefined, response: Response): Promise<{ ok: true }> {
    await this.sessions.revokeToken(token);
    this.sessions.clearCookie(response);
    return { ok: true };
  }

  me(user: AuthUserDto): { user: AuthUserDto } {
    return { user };
  }

  async changePassword(
    currentUser: AuthUserDto,
    dto: ChangePasswordDto,
  ): Promise<{ ok: true }> {
    const user = await this.usersRepo.findOne({ where: { id: currentUser.id } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('未登录或登录已过期');
    }

    const currentOk = await this.passwords.verifyPassword(
      String(dto.currentPassword || ''),
      user.passwordHash,
    );
    if (!currentOk) {
      throw new BadRequestException('当前密码不正确');
    }

    user.passwordHash = await this.passwords.hashPassword(this.parsePassword(dto.newPassword));
    await this.usersRepo.save(user);
    await this.sessions.revokeAllForUser(user.id);
    return { ok: true };
  }

  async invitationInfo(token: string): Promise<{
    email: string;
    displayName: string;
    role: string;
    expiresAt: Date;
  }> {
    const invitation = await this.getValidInvitation(token);
    return {
      email: invitation.email,
      displayName: invitation.email.split('@')[0],
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    };
  }

  async acceptInvitation(
    token: string,
    dto: AcceptInvitationDto,
    request: Request,
    response: Response,
  ): Promise<{ user: AuthUserDto }> {
    const invitation = await this.getValidInvitation(token);
    const existingUser = await this.usersRepo
      .createQueryBuilder('user')
      .where('LOWER(user.email) = :email', { email: invitation.email })
      .getExists();
    if (existingUser) {
      throw new ConflictException('邮箱已存在');
    }

    const user = await this.dataSource.transaction(async (manager) => {
      const lockedInvitation = await manager
        .getRepository(UserInvitationEntity)
        .createQueryBuilder('invitation')
        .setLock('pessimistic_write')
        .where('invitation.token_hash = :tokenHash', { tokenHash: hashToken(token || '') })
        .andWhere('invitation.accepted_at IS NULL')
        .andWhere('invitation.revoked_at IS NULL')
        .getOne();
      if (!lockedInvitation || lockedInvitation.expiresAt <= new Date()) {
        throw new BadRequestException('邀请不存在或已失效');
      }

      const created = await manager.getRepository(UserEntity).save({
        id: newId(),
        email: lockedInvitation.email,
        displayName: this.parseDisplayName(dto.displayName, lockedInvitation.email),
        role: lockedInvitation.role,
        passwordHash: await this.passwords.hashPassword(this.parsePassword(dto.password)),
        isActive: true,
      });

      lockedInvitation.acceptedAt = new Date();
      await manager.getRepository(UserInvitationEntity).save(lockedInvitation);
      return created;
    });

    return {
      user: await this.sessions.createSession(user, Boolean(dto.rememberMe), request, response),
    };
  }

  private async getValidInvitation(token: string): Promise<UserInvitationEntity> {
    const invitation = await this.invitationsRepo
      .createQueryBuilder('invitation')
      .where('invitation.token_hash = :tokenHash', { tokenHash: hashToken(token || '') })
      .andWhere('invitation.accepted_at IS NULL')
      .andWhere('invitation.revoked_at IS NULL')
      .getOne();
    if (!invitation || invitation.expiresAt <= new Date()) {
      throw new BadRequestException('邀请不存在或已失效');
    }
    return invitation;
  }

  private async backfillExistingData(manager, userId: string): Promise<void> {
    for (const table of OWNED_TABLES) {
      const exists = await manager.query(
        `
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = $1
            AND column_name = 'user_id'
          LIMIT 1
        `,
        [table],
      );
      if (exists.length > 0) {
        await manager.query(`UPDATE ${table} SET user_id = $1 WHERE user_id IS NULL`, [userId]);
      }
    }
  }

  private parseEmail(value: string | undefined): string {
    const email = normalizeEmail(value || '');
    try {
      assertEmail(email);
    } catch {
      throw new BadRequestException('邮箱格式不正确');
    }
    return email;
  }

  private parsePassword(value: string | undefined): string {
    const password = String(value || '');
    this.passwords.assertPassword(password);
    return password;
  }

  private parseDisplayName(value: string | undefined, fallback: string): string {
    const displayName = String(value || '').trim() || fallback.split('@')[0] || fallback;
    if (displayName.length > 120) {
      throw new BadRequestException('显示名称过长');
    }
    return displayName;
  }
}
