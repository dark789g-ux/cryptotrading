import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PasswordService } from '../auth/password.service';
import {
  assertEmail,
  assertRole,
  generateTemporaryPassword,
  newId,
  normalizeEmail,
  toAuthUser,
} from '../auth/auth.utils';
import { AuthUserDto } from '../auth/dto/auth.dto';
import {
  CreateUserDto,
  PatchUserDto,
  ResetPasswordDto,
} from './dto/users.dto';
import { UserEntity } from './entities/user.entity';
import { SessionService } from '../auth/session.service';

export interface AdminUserDto extends AuthUserDto {
  isActive: boolean;
  createdAt: Date;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly usersRepo: Repository<UserEntity>,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
  ) {}

  async list(): Promise<AdminUserDto[]> {
    const users = await this.usersRepo.find({ order: { createdAt: 'ASC' } });
    return users.map(this.toAdminUser);
  }

  async create(dto: CreateUserDto): Promise<{ user: AdminUserDto; initialPassword?: string }> {
    const email = this.parseEmail(dto.email);
    const role = this.parseRole(dto.role ?? 'user');
    const displayName = this.parseDisplayName(dto.displayName, email);
    await this.ensureEmailAvailable(email);

    const initialPassword = dto.password || generateTemporaryPassword();
    const user = await this.usersRepo.save({
      id: newId(),
      email,
      displayName,
      role,
      passwordHash: await this.passwords.hashPassword(initialPassword),
      isActive: dto.isActive ?? true,
    });

    return {
      user: this.toAdminUser(user),
      initialPassword: dto.password ? undefined : initialPassword,
    };
  }

  async patch(id: string, dto: PatchUserDto): Promise<AdminUserDto> {
    const user = await this.getById(id);

    if (dto.email !== undefined) {
      const email = this.parseEmail(dto.email);
      if (email !== user.email) {
        await this.ensureEmailAvailable(email, user.id);
        user.email = email;
      }
    }
    if (dto.displayName !== undefined) {
      user.displayName = this.parseDisplayName(dto.displayName, user.email);
    }
    if (dto.role !== undefined) {
      user.role = this.parseRole(dto.role);
    }
    if (dto.isActive !== undefined) {
      user.isActive = Boolean(dto.isActive);
    }

    const saved = await this.usersRepo.save(user);
    if (!saved.isActive) {
      await this.sessions.revokeAllForUser(saved.id);
    }
    return this.toAdminUser(saved);
  }

  async resetPassword(id: string, dto: ResetPasswordDto): Promise<{ initialPassword: string }> {
    const user = await this.getById(id);
    const initialPassword = dto.password || generateTemporaryPassword();
    user.passwordHash = await this.passwords.hashPassword(initialPassword);
    await this.usersRepo.save(user);
    await this.sessions.revokeAllForUser(user.id);
    return { initialPassword };
  }

  async getById(id: string): Promise<UserEntity> {
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    return user;
  }

  async findByEmail(email: string): Promise<UserEntity | null> {
    return this.usersRepo
      .createQueryBuilder('user')
      .where('LOWER(user.email) = :email', { email: normalizeEmail(email) })
      .getOne();
  }

  private async ensureEmailAvailable(email: string, exceptUserId?: string): Promise<void> {
    const query = this.usersRepo
      .createQueryBuilder('user')
      .where('LOWER(user.email) = :email', { email });
    if (exceptUserId) {
      query.andWhere('user.id <> :exceptUserId', { exceptUserId });
    }
    const exists = await query.getExists();
    if (exists) {
      throw new ConflictException('邮箱已存在');
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

  private parseRole(value: string): 'admin' | 'user' {
    try {
      assertRole(value as 'admin' | 'user');
    } catch {
      throw new BadRequestException('角色不正确');
    }
    return value as 'admin' | 'user';
  }

  private parseDisplayName(value: string | undefined, email: string): string {
    const displayName = String(value || '').trim() || email.split('@')[0];
    if (displayName.length > 120) {
      throw new BadRequestException('显示名称过长');
    }
    return displayName;
  }

  private toAdminUser(user: UserEntity): AdminUserDto {
    return {
      ...toAuthUser(user),
      isActive: user.isActive,
      createdAt: user.createdAt,
    };
  }
}
