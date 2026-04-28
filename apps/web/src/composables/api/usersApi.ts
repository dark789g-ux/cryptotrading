import { API_BASE, patch, post, request } from './apiClient'
import type { AuthUser, UserRole } from './authApi'

export interface UserListItem extends AuthUser {
  isActive: boolean
  createdAt: string
  updatedAt?: string
}

export interface CreateUserBody {
  email: string
  displayName: string
  password: string
  role: UserRole
}

export interface InvitationListItem {
  id: string
  email: string
  role: UserRole
  token?: string
  inviteUrl?: string
  expiresAt: string
  acceptedAt?: string | null
  revokedAt?: string | null
  createdAt: string
}

export interface CreateInvitationResponse {
  invitation: InvitationListItem
  token: string
}

export const usersApi = {
  list: () => request<UserListItem[]>(`${API_BASE}/users`),
  create: (body: CreateUserBody) => post<UserListItem>(`${API_BASE}/users`, body),
  update: (id: string, body: { displayName?: string; role?: UserRole; isActive?: boolean }) =>
    patch<UserListItem>(`${API_BASE}/users/${id}`, body),
  resetPassword: (id: string, body: { password: string }) =>
    post<{ ok: true }>(`${API_BASE}/users/${id}/reset-password`, body),
  listInvitations: () => request<InvitationListItem[]>(`${API_BASE}/users/invitations`),
  createInvitation: (body: { email: string; role: UserRole }) =>
    post<CreateInvitationResponse>(`${API_BASE}/users/invitations`, body),
  revokeInvitation: (id: string) => post<{ ok: true }>(`${API_BASE}/users/invitations/${id}/revoke`),
}
