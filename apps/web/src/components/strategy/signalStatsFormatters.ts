// 信号逐笔明细共享格式化纯函数

export function fmtTradeDate(s: string): string {
  if (!s || s.length !== 8) return s
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

export function fmtRetPct(v: string): string {
  const n = parseFloat(v)
  if (isNaN(n)) return v
  return (n * 100).toFixed(2) + '%'
}

export function exitReasonLabel(reason: string): string {
  const labelMap: Record<string, string> = {
    max_hold: '强平',
    signal: '信号',
    delist: '退市',
    stop: '止损',
    ma5_exit: 'MA5离场',
  }
  return labelMap[reason] ?? reason
}

export function retColor(ret: string): string {
  const n = parseFloat(ret)
  return n >= 0 ? '#18a058' : '#d03050'
}
