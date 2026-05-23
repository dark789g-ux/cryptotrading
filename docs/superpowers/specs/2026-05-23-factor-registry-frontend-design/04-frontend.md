# 04 · 前端

← 回到 [index.md](./index.md)

## 路由

`apps/web/src/router/index.ts` 追加：

```text
{ path: '/quant/factors',
  name: 'quant-factors',
  component: () => import('@/views/quant/QuantFactorsView.vue'),
  meta: { requireAuth: true, requireAdmin: true } }
```

**所有 `/quant/*` 既有路由**统一加 `meta.requireAdmin = true`：

- `quant-overview` (`/quant`)
- `quant-scores` (`/quant/scores`)
- `quant-runs` (`/quant/runs`)
- `quant-run-detail` (`/quant/runs/:id`)
- `quant-jobs` (`/quant/jobs`)
- `quant-quality-detail` (`/quant/quality/:date`)
- `quant-factors` (`/quant/factors`) ← 新增

**`beforeEach` 守卫**：

```text
router.beforeEach((to) => {
  if (to.meta.requireAdmin && !userStore.isAdmin) {
    return { path: '/' }   // 重定向到首页；本 spec 不新建 forbidden 视图
  }
})
```

**为什么不跳到 `forbidden` 路由**：项目当前无 ForbiddenView，新建专门视图属范围扩张（YAGNI）。非 admin 看不到量化菜单入口，进入 `/quant/*` 的唯一路径就是手敲 URL——这种情况直接回首页足以提示。未来如有更广的权限拒绝场景再统一引入 ForbiddenView。

**顶部菜单 / sidebar**：量化入口加 `v-if="userStore.isAdmin"`。

## 页面布局（QuantFactorsView.vue）

```text
┌─────────────────────────────────────────────────────────────────────┐
│  量化 · 因子清单                                                    │
│  16 个因子（v1）｜当前启用 16 / 16                          [刷新]   │
├─────────────────────────────────────────────────────────────────────┤
│  筛选：状态 [全部▾] 类别 [全部▾] 搜索 [_______]                     │
├─────────────────────────────────────────────────────────────────────┤
│ 启用 │ factor_id              │ 描述               │ 类别 │窗口│操作│
├──────┼────────────────────────┼────────────────────┼──────┼────┼────┤
│ [✓]  │ momentum_20d           │ 20 日动量          │price │ 35 │编辑│
│ [✓]  │ momentum_60d           │ 60 日动量          │price │ 75 │编辑│
│ [ ]  │ amihud_illiq_20d       │ Amihud 非流动性    │price │ 25 │编辑│
│ ...                                                                 │
└─────────────────────────────────────────────────────────────────────┘
                                                  (无分页，全部 16 条)
```

- 行内启停 switch 点击 → `n-popconfirm`：「确认 启用/禁用 `<id>`？该变更下一次端到端训练生效」→ 确认后才 PATCH
- 失败回滚 UI 状态 + `useMessage().error`
- 顶部统计动态计算：`X = items.filter(i => i.enabled).length`

## 编辑弹窗（FactorEditModal.vue）

复用 `@/components/common/AppModal.vue`（CLAUDE.md「Modal 统一」），`#actions` slot 放保存/取消按钮：

```text
┌─ 编辑因子：momentum_20d (v1) ──────────────────────────┐
│  描述         [20 日动量                            ]  │
│  公式 formula [close_adj(T)/close_adj(T-20)-1     ] R  │ ← 只读
│  数据源       [close_adj]                            R │ ← 只读
│  类别         (●) price ( ) industry ( ) fundamental   │
│               ( ) mixed                                │
│  PIT 窗口     [    35] 天                              │
│               ⚠ 改这个会让下一次端到端训练用新窗口算   │
│  PIT 锚点     (●) trade_date  ( ) ann_date             │
│  显示顺序     [   100]                                 │
│                              [取消]  [保存]            │
└────────────────────────────────────────────────────────┘
```

- `formula` / `data_source` 灰色背景 + 「仅供阅读，由代码维护」提示，不进表单提交
- `pit_window_days / category / pit_anchor` 变更时按钮旁显示「⚠ 该变更下一次端到端训练生效」
- 保存按钮在校验通过前 `disabled`：`pit_window_days` ∈ [1, 400]、`description` 1-500 字符
- 保存成功 → `useMessage().success` toast → 弹窗关闭 → 父表格用返回的 `item` **原地刷新该行**（不全表重拉）
- **筛选可见性兜底**：若改动后该行不再匹配当前筛选条件（例如把 enabled 由 true 改 false、但筛选框是「状态=已启用」），保存后该行视觉上消失。此时额外弹 `useMessage().info('已保存，因当前筛选条件已隐藏该行')`，避免用户误以为操作未生效
- 失败 → 弹窗保持打开 + 顶部 `n-alert` 显示错误

## 组件拆分（单文件 ≤ 500 行，CI 强制）

```text
apps/web/src/views/quant/QuantFactorsView.vue        ~200 行  页壳 + 数据加载 + 筛选
apps/web/src/components/quant/FactorTable.vue        ~150 行  表格 + 启停 switch + popconfirm
apps/web/src/components/quant/FactorEditModal.vue    ~180 行  编辑弹窗
```

`lint:quant-lines` 在 CI 强制 `apps/web/src/views/quant/**` 与 `apps/web/src/components/quant/**` 单文件 ≤ 500 行。

## API 客户端

`apps/web/src/api/modules/quant.ts` 追加：

```text
// 类型
interface FactorDefinition {
  factor_id: string
  factor_version: string
  description: string
  formula: string | null
  data_source: string[] | null
  category: 'price' | 'industry' | 'fundamental' | 'mixed'
  pit_window_days: number
  pit_anchor: 'trade_date' | 'ann_date'
  enabled: boolean
  display_order: number
  updated_at: string
  updated_by: string | null
}

interface UpdateFactorPatch {
  description?: string
  category?: FactorDefinition['category']
  pit_window_days?: number
  pit_anchor?: FactorDefinition['pit_anchor']
  enabled?: boolean
  display_order?: number
}

// 函数
quantApi.listFactors(query?: { enabled?: boolean; category?: string })
   → Promise<{ items: FactorDefinition[] }>

quantApi.listFactorCategories()
   → Promise<{ items: string[] }>

quantApi.updateFactor(id: string, version: string, patch: UpdateFactorPatch)
   → Promise<{ item: FactorDefinition }>
```

风格与既有 `getDailyTopK` / `getModelVersions` / `listRuns` 对齐。

## Store

`apps/web/src/stores/user.ts` 暴露：

```text
const isAdmin = computed(() => state.value.user?.is_admin === true)
```

`/api/auth/me` 拉用户信息时把 `is_admin` 写入 state（详见 [03-backend.md](./03-backend.md#apiauthme-扩展)）。

## keep-alive 与缓存（按 CLAUDE.md 规范）

- 因子清单数据**不依赖外部 store 变化**——只在挂载 / 手动刷新时拉一次
- 但用户可能从其他页面回来时 DB 已被另一个 admin 改过——建议放 `onActivated` 而非 `onMounted`，切回时重拉
- `computed` 用于过滤，避免 `ref` 不响应 store 的陷阱（CLAUDE.md 缓存陷阱条款）
