export type UserRole = 'admin' | 'user';

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  authType?: 'session' | 'apikey';
}

export interface RequestWithUser {
  user?: CurrentUser;
  cookies?: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}
