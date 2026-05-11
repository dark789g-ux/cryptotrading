import { API_BASE } from '../client'

export const indexCatalogApi = {
  syncRunUrl(): string {
    return `${API_BASE}/index-catalog/sync/run`
  },
}
