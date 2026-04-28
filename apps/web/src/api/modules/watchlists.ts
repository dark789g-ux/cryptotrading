import { API_BASE, del, post, put, request } from '../client'
import type { SymbolRow } from './symbols'

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

export interface WatchlistQuotesResult {
  items: SymbolRow[]
  total: number
  page: number
  page_size: number
}

export const watchlistApi = {
  list: () => request<Watchlist[]>(`${API_BASE}/watchlists`),
  get: (id: string) => request<Watchlist>(`${API_BASE}/watchlists/${id}`),
  create: (body: WatchlistPayload) => post<Watchlist>(`${API_BASE}/watchlists`, body),
  update: (id: string, body: Partial<WatchlistPayload>) => put<Watchlist>(`${API_BASE}/watchlists/${id}`, body),
  delete: (id: string) => del<{ ok: true }>(`${API_BASE}/watchlists/${id}`),
  addSymbol: (id: string, symbol: string) => post<Watchlist>(`${API_BASE}/watchlists/${id}/symbols`, { symbol }),
  removeSymbol: (id: string, symbol: string) => del<{ ok: true }>(`${API_BASE}/watchlists/${id}/symbols/${encodeURIComponent(symbol)}`),

  quotes: (id: string, params: {
    interval?: string
    page?: number
    pageSize?: number
    sort?: { field?: string | null; order?: 'ascend' | 'descend' | null }
  }) => {
    const query = new URLSearchParams()
    query.set('interval', params.interval ?? '1h')
    query.set('page', String(params.page ?? 1))
    query.set('page_size', String(params.pageSize ?? 20))
    if (params.sort?.field) {
      query.set('sort', JSON.stringify(params.sort))
    }
    return request<WatchlistQuotesResult>(`${API_BASE}/watchlists/${id}/quotes?${query.toString()}`)
  },

  reorder: (ids: string[]) =>
    put<{ ok: true }>(`${API_BASE}/watchlists/reorder`, { ids }),

  reorderItems: (id: string, symbols: string[]) =>
    put<{ ok: true }>(`${API_BASE}/watchlists/${id}/reorder`, { symbols }),
}
