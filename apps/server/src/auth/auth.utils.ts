import { randomBytes, randomUUID, createHash } from 'crypto';

import { AuthUserDto } from './dto/auth.dto';
import { UserEntity } from '../users/entities/user.entity';
import { UserRole } from './auth.types';

export function newId(): string {
  return randomUUID();
}

export function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

export function assertEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new Error('invalid_email');
  }
}

export function assertRole(role: UserRole): void {
  if (role !== 'admin' && role !== 'user') {
    throw new Error('invalid_role');
  }
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function generateTemporaryPassword(): string {
  return randomBytes(12).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function toAuthUser(user: UserEntity): AuthUserDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
  };
}
