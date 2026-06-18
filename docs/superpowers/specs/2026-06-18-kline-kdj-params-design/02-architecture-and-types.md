# 2. 总体架构与类型/状态扩展

## 2.1 总体架构与数据流

```text
用户点击 KDJ 行右侧齿轮
           │
           ▼
┌─────────────────────────┐
│ KlineChartToolbar       │
│  仅 KDJ 行显示 [⚙]      │
│  Popover 内编辑 N/M1/M2 │
│  点确定 → 校验 → emit    │
└───────────┬─────────────┘
            │ update:prefs (含 params.KDJ)
            ▼
┌─────────────────────────┐
│ useKlineChartPrefs      │
│  持久化到 localStorage   │
└───────────┬─────────────┘
            │ update:prefs (含 params.KDJ)
            ▼
┌─────────────────────────┐
│ KlineChart              │
│  发现 params 变化        │
│  调用父组件传入的回调     │
└───────────┬─────────────┘
            │ recalcIndicators(params)
            ▼
┌─────────────────────────┐
│ 父页面 / Drawer         │
│  调后端 recalc 接口      │
│  成功后替换 data         │
│  失败则抛出错误          │
└───────────┬─────────────┘
            │ POST /api/klines/.../recalc
            │ 或 POST /api/a-shares/.../klines/recalc
            ▼
┌─────────────────────────┐
│ 后端                    │
│  读原始 OHLC，按新参数    │
│  重算 KDJ，返回完整 bars │
└─────────────────────────┘
```

**约定**：Toolbar 只负责改参数并通知出去；真正的后端请求由持有 `symbol/interval/range` 的父页面完成，保持 `KlineChart` 通用。

## 2.2 类型与状态扩展

**文件**：`apps/web/src/composables/kline/subplotConfig.ts`

新增类型与常量：

```ts
export interface KdjSubplotParams {
  n: number
  m1: number
  m2: number
}

export type IndicatorSubplotParams = {
  KDJ?: KdjSubplotParams
}

export interface SubplotPrefs {
  order: SubplotKey[]
  visibility: Record<SubplotKey, boolean>
  heightPct: Record<SubplotKey, number>
  params?: IndicatorSubplotParams   // 仅非默认时存在
}

export const DEFAULT_KDJ_PARAMS: KdjSubplotParams = { n: 9, m1: 3, m2: 3 }
export const KDJ_PARAM_RANGES = {
  n: [2, 99] as const,
  m1: [1, 50] as const,
  m2: [1, 50] as const,
}
```

新增工具函数：

- `isDefaultKdjParams(p?)`：判断是否等于 `9/3/3`；
- `normalizeIndicatorParams(p?)`：清理越界/非法字段，等于默认时返回 `undefined`。

`normalizePrefs()` 增加对 `params` 的合并与校验：
- 旧 localStorage 无 `params` 时忽略；
- 默认值不写 `params`；
- 越界值回退到默认。

**文件**：`apps/web/src/composables/kline/useKlineChartPrefs.ts`

`update()` 支持 `params` 合并：

```ts
update({ params: { KDJ: { n: 6, m1: 2, m2: 2 } } })
```

语义约定：
- 传入具体 `params` 对象 → 合并/替换；
- 传入 `params: undefined` → 清除已持久化的自定义参数（用于回滚或恢复默认）。

## 2.3 关键边界

- `params` 是可选字段，保证旧 `localStorage` 数据向前兼容；
- 当 `params.KDJ` 等于默认值时，应删除或保持 `undefined`，避免无意义的持久化差异；
- `KlineChart` 内部通过 `localPrefs.params` 变化触发回调，而不是监听整个 `prefs` 对象，避免 visibility/height 改动也触发后端请求。
