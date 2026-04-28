import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import {
  assertEmail,
  assertRole,
  generateToken,
  hashToken,
  newId,
  normalizeEmail,
} from '../auth/auth.utils';
import { UserRole } from '../auth/auth.types';
import { UserInvitationEntity } from './entities/user-invitation.entity';
import { UserEntity } from './entities/user.entity';
import { CreateInvitationDto } from './dto/users.dto';

@Injectable()
export class InvitationsService {
  constructor(
    @InjectRepository(UserInvitationEntity)
    private readonly invitationsRepo: Repository<UserInvitationEntity>,
    @InjectRepository(UserEntity)
    private readonly usersRepo: Repository<UserEntity>,
  ) {}

  async list(): Promise<UserInvitationEntity[]> {
    return this.invitationsRepo.find({ order: { createdAt: 'DESC' } });
  }

  async create(
    dto: CreateInvitationDto,
    createdByUserId: string,
  ): Promise<{ invitation: UserInvitationEntity; token: string }> {
    const email = this.parseEmail(dto.email);
    const role = this.parseRole(dto.role ?? 'user');
    const existingUser = await this.usersRepo
      .createQueryBuilder('user')
      .where('LOWER(user.email) = :email', { email })
      .getExists();
    if (existingUser) {
      throw new ConflictException('邮箱已存在');
    }

    const activeInvitation = await this.invitationsRepo
      .createQueryBuilder('invitation')
      .where('LOWER(invitation.email) = :email', { email })
      .andWhere('invitation.accepted_at IS NULL')
      .andWhere('invitation.revoked_at IS NULL')
      .andWhere('invitation.expires_at > :now', { now: new Date() })
      .getExists();
    if (activeInvitation) {
      throw new ConflictException('该邮箱已有有效邀请');
    }

    const token = generateToken();
    const expiresInDays = Math.max(1, Math.min(30, Number(dto.expiresInDays || 7)));
    const invitation = await this.invitationsRepo.save({
      id: newId(),
      email,
      role,
      tokenHash: hashToken(token),
      createdByUserId,
      expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
      acceptedAt: null,
      revokedAt: null,
    });

    return { invitation, token };
  }

  async getValidByToken(token: string): Promise<UserInvitationEntity> {
    const invitation = await this.invitationsRepo.findOne({
      where: {
        tokenHash: hashToken(token || ''),
        acceptedAt: IsNull(),
        revokedAt: IsNull(),
      },
    });
    if (!invitation || invitation.expiresAt <= new Date()) {
      throw new NotFoundException('邀请不存在或已失效');
    }
    return invitation;
  }

  async revoke(id: string): Promise<{ ok: true }> {
    const invitation = await this.invitationsRepo.findOne({ where: { id } });
    if (!invitation) {
      throw new NotFoundException('邀请不存在');
    }
    if (!invitation.revokedAt && !invitation.acceptedAt) {
      invitation.revokedAt = new Date();
      await this.invitationsRepo.save(invitation);
    }
    return { ok: true };
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

  private parseRole(value: string): UserRole {
    try {
      assertRole(value as UserRole);
    } catch {
      throw new BadRequestException('角色不正确');
    }
    return value as UserRole;
  }

}
