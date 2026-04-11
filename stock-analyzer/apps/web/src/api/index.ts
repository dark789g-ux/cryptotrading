import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
})

export interface Stock {
  tsCode: string
  symbol: string
  name: string
  area: string
  industry: string
  market: string
  listDate: string
}

export interface StockPrice {
  tsCode: string
  tradeDate: string
  open: number
  high: number
  low: number
  close: number
  vol: number
  amount: number
  pctChg: number
}

export interface Indicator {
  tsCode: string
  tradeDate: string
  ma5: number
  ma10: number
  ma20: number
  ma60: number
  macdDif: number
  macdDea: number
  macdBar: number
  kdjK: number
  kdjD: number
  kdjJ: number
  rsi6: number
  rsi12: number
  rsi24: number
  bollUpper: number
  bollMid: number
  bollLower: number
}

export interface BacktestResult {
  summary: {
    initialCapital: number
    finalCapital: number
    totalReturn: number
    annualizedReturn: number
    maxDrawdown: number
    winRate: number
    totalTrades: number
    winningTrades: number
    losingTrades: number
  }
  trades: {
    date: string
    type: 'buy' | 'sell'
    price: number
    shares: number
    amount: number
    reason: string
  }[]
  dailyValues: { date: string; value: number }[]
}

export const stockApi = {
  getStocks: (params?: any) => api.get('/stocks', { params }),
  searchStocks: (keyword: string) => api.get('/stocks/search', { params: { keyword } }),
  getStock: (tsCode: string) => api.get(`/stocks/${tsCode}`),
  getPrices: (tsCode: string, params: any) => api.get(`/stocks/${tsCode}/prices`, { params }),
  getIndicators: (tsCode: string, params: any) => api.get(`/stocks/${tsCode}/indicators`, { params }),
  filterStocks: (params: any) => api.get('/stocks/filter', { params }),
}

export const watchlistApi = {
  getWatchlists: () => api.get('/watchlists'),
  getWatchlist: (id: string) => api.get(`/watchlists/${id}`),
  createWatchlist: (data: any) => api.post('/watchlists', data),
  updateWatchlist: (id: string, data: any) => api.put(`/watchlists/${id}`, data),
  deleteWatchlist: (id: string) => api.delete(`/watchlists/${id}`),
  addItem: (id: string, data: any) => api.post(`/watchlists/${id}/items`, data),
  removeItem: (id: string, itemId: string) => api.delete(`/watchlists/${id}/items/${itemId}`),
}

export const backtestApi = {
  run: (data: any) => api.post('/backtest/run', data),
}

export default api
