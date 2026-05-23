import { API_BASE, post, request } from './apiClient'

export type UserRole = 'admin' | 'user'

export interface AuthUser {
  id: string
  email: string
  displayName: string
  role: UserRole
  /**
   * factor-registry-frontend spec：后端基于 `ADMIN_USER_IDS` 白名单计算的 admin 标识。
   * 与 role 不强耦合（admin 名单走 env，不引入 roles 表）。snake_case 与后端响应直接对齐。
   * 未升级 server 时此字段缺省，前端回退到 `role === 'admin'` 判定。
   */
  is_admin?: boolean
}

export interface BootstrapStatus {
  initialized: boolean
}

export interface LoginBody {
  email: string
  password: string
  rememberMe?: boolean
}

export interface BootstrapBody extends LoginBody {
  displayName: string
}

export interface InvitationInfo {
  id?: string
  email: string
  displayName?: string
  role: UserRole
  expiresAt: string
  acceptedAt?: string | null
  revokedAt?: string | null
}

export interface AuthResponse {
  user: AuthUser
}

export const authApi = {
  getBootstrapStatus: () =>
    request<BootstrapStatus>(`${API_BASE}/auth/bootstrap-status`, { skipAuthRedirect: true }),
  bootstrap: (body: BootstrapBody) => post<AuthResponse>(`${API_BASE}/auth/bootstrap`, body),
  login: (body: LoginBody) => post<AuthResponse>(`${API_BASE}/auth/login`, body),
  logout: () => post<{ ok: true }>(`${API_BASE}/auth/logout`, undefined, { skipAuthRedirect: true }),
  me: () => request<AuthResponse | AuthUser>(`${API_BASE}/auth/me`, { skipAuthRedirect: true }),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    post<{ ok: true }>(`${API_BASE}/auth/change-password`, body),
  getInvitation: (token: string) =>
    request<InvitationInfo>(`${API_BASE}/auth/invitations/${encodeURIComponent(token)}`, {
      skipAuthRedirect: true,
    }),
  acceptInvitation: (token: string, body: { displayName: string; password: string; rememberMe?: boolean }) =>
    post<AuthResponse>(`${API_BASE}/auth/invitations/${encodeURIComponent(token)}/accept`, body),
}
