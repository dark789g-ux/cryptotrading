import { API_BASE, del, post, put, request } from '../client'

export interface WatchlistItem {
  symbol: string
}

export interface Watchlist {
  id: string
  name: string
  items?: WatchlistItem[]
  createdAt: string
}

export interface WatchlistPayload {
  name: string
  symbols?: string[]
}

export const watchlistApi = {
  list: () => request<Watchlist[]>(`${API_BASE}/watchlists`),
  get: (id: string) => request<Watchlist>(`${API_BASE}/watchlists/${id}`),
  create: (body: WatchlistPayload) => post<Watchlist>(`${API_BASE}/watchlists`, body),
  update: (id: string, body: Partial<WatchlistPayload>) => put<Watchlist>(`${API_BASE}/watchlists/${id}`, body),
  delete: (id: string) => del<{ ok: true }>(`${API_BASE}/watchlists/${id}`),
  addSymbol: (id: string, symbol: string) => post<Watchlist>(`${API_BASE}/watchlists/${id}/symbols`, { symbol }),
  removeSymbol: (id: string, symbol: string) => del<{ ok: true }>(`${API_BASE}/watchlists/${id}/symbols/${encodeURIComponent(symbol)}`),
}
