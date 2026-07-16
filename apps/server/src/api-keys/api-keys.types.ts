import type { CurrentUser as BaseCurrentUser } from '../auth/shared/auth.types';

export interface ApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreateApiKeyDto {
  name?: string;
}

export interface CreatedApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  plaintextKey: string;
  createdAt: string;
}

export interface ApiKeyValidatedUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'user';
}

export interface CurrentUserWithAuthType extends BaseCurrentUser {
  authType?: 'session' | 'apikey';
}
