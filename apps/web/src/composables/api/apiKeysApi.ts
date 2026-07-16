import { API_BASE, del, post, request } from '../../api/client'

export interface ApiKeyView {
  id: string
  name: string
  keyPrefix: string
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
}

export interface CreatedApiKey {
  id: string
  name: string
  keyPrefix: string
  plaintextKey: string
  createdAt: string
}

export interface CreateApiKeyBody {
  name: string
}

export const apiKeysApi = {
  list: () => request<ApiKeyView[]>(`${API_BASE}/api-keys`),
  create: (body: CreateApiKeyBody) => post<CreatedApiKey>(`${API_BASE}/api-keys`, body),
  revoke: (id: string) => del<{ ok: true }>(`${API_BASE}/api-keys/${id}`),
}
