import { UserRole } from '../auth.types';

export interface BootstrapDto {
  email?: string;
  displayName?: string;
  password?: string;
  rememberMe?: boolean;
}

export interface LoginDto {
  email?: string;
  password?: string;
  rememberMe?: boolean;
}

export interface ChangePasswordDto {
  currentPassword?: string;
  newPassword?: string;
}

export interface AcceptInvitationDto {
  displayName?: string;
  password?: string;
  rememberMe?: boolean;
}

export interface AuthUserDto {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
}
