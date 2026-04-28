import { UserRole } from '../../auth/auth.types';

export interface CreateUserDto {
  email?: string;
  displayName?: string;
  role?: UserRole;
  password?: string;
  isActive?: boolean;
}

export interface PatchUserDto {
  email?: string;
  displayName?: string;
  role?: UserRole;
  isActive?: boolean;
}

export interface ResetPasswordDto {
  password?: string;
}

export interface CreateInvitationDto {
  email?: string;
  displayName?: string;
  role?: UserRole;
  expiresInDays?: number;
}
