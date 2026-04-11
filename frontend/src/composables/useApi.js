// API 封装
const API_BASE = '/api'

// 策略相关 API
export const strategyApi = {
  // 获取策略类型列表
  getStrategyTypes: async () => {
    const res = await fetch(`${API_BASE}/strategy-types`)
    if (!res.ok) throw new Error('获取策略类型失败')
    return res.json()
  },

  // 获取策略列表
  getStrategies: async () => {
    const res = await fetch(`${API_BASE}/strategies`)
    if (!res.ok) throw new Error('获取策略列表失败')
    return res.json()
  },

  // 创建策略
  createStrategy: async (data) => {
    const res = await fetch(`${API_BASE}/strategies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
    if (!res.ok) throw new Error('创建策略失败')
    return res.json()
  },

  // 更新策略
  updateStrategy: async (id, data) => {
    const res = await fetch(`${API_BASE}/strategies/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
    if (!res.ok) throw new Error('更新策略失败')
    return res.json()
  },

  // 删除策略
  deleteStrategy: async (id) => {
    const res = await fetch(`${API_BASE}/strategies/${id}`, {
      method: 'DELETE'
    })
    if (!res.ok) throw new Error('删除策略失败')
  },

  // 获取回测结果
  getBacktestResult: async (strategyId) => {
    const res = await fetch(`${API_BASE}/backtest/${strategyId}/result`)
    if (!res.ok) throw new Error('获取回测结果失败')
    return res.json()
  },

  // 运行回测（返回 SSE 连接）
  runBacktest: (strategyId) => {
    return new EventSource(`${API_BASE}/backtest/${strategyId}/run`, {
      method: 'POST'
    })
  }
}

// 标的相关 API
export const symbolApi = {
  // 获取标的列表
  getSymbols: async (params = {}) => {
    const query = new URLSearchParams(params).toString()
    const res = await fetch(`${API_BASE}/symbols${query ? '?' + query : ''}`)
    if (!res.ok) throw new Error('获取标的列表失败')
    return res.json()
  },

  // 获取单个标的 K 线 (CSV 格式)
  getKlines: async (symbol, timeframe = '1d') => {
    const res = await fetch(`${API_BASE}/klines/${timeframe}/${symbol}`)
    if (!res.ok) throw new Error('获取 K 线数据失败')
    return res.text()  // 返回 CSV 文本
  }
}

// 同步相关 API
export const syncApi = {
  // 获取同步状态
  getStatus: async () => {
    const res = await fetch(`${API_BASE}/sync/status`)
    if (!res.ok) throw new Error('获取同步状态失败')
    return res.json()
  },

  // 获取同步进度（SSE）
  getProgress: () => {
    return new EventSource(`${API_BASE}/sync/progress`)
  },

  // 开始同步
  startSync: async (params) => {
    const res = await fetch(`${API_BASE}/sync/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    })
    if (!res.ok) throw new Error('启动同步失败')
    return res.json()
  },

  // 停止同步
  stopSync: async () => {
    const res = await fetch(`${API_BASE}/sync/stop`, {
      method: 'POST'
    })
    if (!res.ok) throw new Error('停止同步失败')
    return res.json()
  }
}
