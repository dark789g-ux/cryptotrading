# 前端 UI

## 文件布局

```text
apps/web/src/components/symbols/a-shares-index/
├─ ASharesIndexPanel.vue              # 改：第三 tab + #suffix 按钮
├─ ASharesIndexCustomPanel.vue        # 新：我的指数行情表
├─ CreateCustomIndexModal.vue         # 新：5 步向导
├─ create-custom-index/
│   ├─ StepBasicInfo.vue
│   ├─ StepMembers.vue
│   ├─ StepWeights.vue
│   ├─ StepIndexSpec.vue
│   ├─ StepPreview.vue
│   └─ useCreateCustomIndexWizard.ts  # 步骤状态 + 校验
├─ customIndexColumns.ts
├─ useCustomIndexQuery.ts
└─ ASharesIndexKlineModal.vue         # 改：category=custom 分支

apps/web/src/api/modules/market/customIndex.ts
packages/shared-types/src/custom-index.ts   # 可选，或放 web types
```

---

## ASharesIndexPanel 改造

```text
┌─ n-tabs (#suffix) ──────────────────────────────────────┐
│  同花顺指数 │ 申万指数 │ 我的指数     [创建指数]        │
├─────────────────────────────────────────────────────────┤
│  subTab=ths  → ASharesIndexThsPanel                     │
│  subTab=sw   → ASharesIndexSwPanel                      │
│  subTab=custom → ASharesIndexCustomPanel                │
└─────────────────────────────────────────────────────────┘
```

- `subTab` 类型扩展：`'ths' | 'sw' | 'custom'`
- `#suffix`：`n-button`「创建指数」→ `showCreateModal = true`；若当前非 custom tab，先 `subTab = 'custom'`
- 编辑：`ASharesIndexCustomPanel` 行操作 → 同一 Modal `mode='edit'`

参考 `WatchlistsView.vue` `#suffix` 与 `ASharesIndexPanel.vue` 现有 lazy tab。

---

## CreateCustomIndexModal

容器：`AppModal`，宽度 `min(720px, 94vw)`，`:mask-closable="false"`（防误关）。

### 步骤条

Modal 顶部 `n-steps`（`current=step`，仅展示不可点跳步）。

### Step 1 — 基本信息（StepBasicInfo）

| 字段 | 组件 | 校验 |
|------|------|------|
| 名称 | `n-input` | 必填，1–100 字（与 DB `name` 上限一致） |
| 描述 | `n-input type=textarea` | 可选 |

说明卡片：自定义指数 = 成分 + 权重 + 基期 → 系统合成历史序列。

### Step 2 — 成分选取（StepMembers）

```text
┌─ 添加方式 ─────────────────────────────────────────────┐
│ [搜索股票...]  [从指数导入 ▼]  [从自选导入 ▼]            │
├─ 已选成分 (N) ─────────────────────────────────────────┤
│  ts_code │ 名称 │ 操作(移除)                            │
│  ...                                                    │
└─────────────────────────────────────────────────────────┘
```

- **搜索**：复用 A 股标的搜索 API（与 watchlist 添加类似）
- **从指数导入**：`n-select` 选 ths/sw 指数 → `GET /api/index-catalog/:tsCode/members`
- **从自选导入**：选 watchlist → 现有 watchlist members API
- 校验：2 ≤ N ≤ 500

### Step 3 — 权重方案（StepWeights）

```text
○ 等权    ○ 流通市值加权    ○ 自定义权重

[自定义时]
┌ ts_code │ 名称 │ 权重(%) │ ─┐
│ 600519  │ 茅台 │  [50]   │   │ 合计须 = 100%
└───────────────────────────────┘

┌─ 权重预览（横向 bar）──────────┐
└───────────────────────────────┘
```

切换方案时实时重算预览；`float_mv` / `custom` 调 **`POST /api/custom-indices/preview-weights`**（V1 必需）。

### Step 4 — 基期与口径（StepIndexSpec）

| 字段 | 说明 |
|------|------|
| 基期日期 | `n-date-picker`，转 YYYYMMDD；须为交易日 |
| 基点 | 默认 1000 |
| 指数类型 | `n-radio-group`：价格指数 / 全收益指数 |
| 调仓生效日 | 创建时默认 = 基期；编辑时可改 |

说明卡片：口径差异、除权除息处理、版本链概念（编辑会产生新版本）。

### Step 5 — 预览确认（StepPreview）

摘要只读列表 + 预估回算区间 + 实际起始日 warning。

Footer actions：

```text
[取消]  [上一步]  [创建并开始计算]   # create mode
[取消]  [上一步]  [保存并重算]       # edit mode
```

创建成功：关 Modal → CustomPanel `reload()` → 若 `status=computing` 订阅 SSE 更新行内进度。

---

## ASharesIndexCustomPanel

结构照抄 `ASharesIndexThsPanel.vue`：

- `useCustomIndexQuery` → `GET /api/custom-indices/latest`
- `customIndexColumns.ts`：名称、close、pctChange、count、indexType、status、操作
- **status 列**：`computing` 时 `n-progress`；`failed` 显示 tooltip + 「重试」
- 行点击（ready）→ K 线 Modal
- 「成分股」列 → `emit('jump-to-members')`（复用父级跳转股票 tab）
- 列偏好 `tableId: 'aSharesIndexCustom'`

---

## ASharesIndexKlineModal 扩展

`IndexLatestRow.category` 扩展 `'custom'`。

```text
category === 'custom'
  ├─ kline: customIndexApi.getKline(id, range)
  ├─ AMV:   customIndexApi.getAmv(id, range)
  └─ 副图:  ['VOL','KDJ','MACD','0AMV','0AMV_MACD']  （与同花顺行业一致）
```

`row.id` 用于 API 路径；`row.tsCode` 用于标题。

---

## 计算进度 UX

```text
computing 状态下：
  列表行内 progress bar
  可选：Modal 关闭后 toast「指数计算中，完成后可查看 K 线」
  SSE 终态 → 自动 refresh 该行
```

失败：`n-alert type=error` 展示 `last_error` 摘要 + 「重试」按钮。

---

## 成分股跳转

`jump-to-members` payload 扩展：

```typescript
{ tsCode: string; name: string; category: 'custom'; customIndexId: string }
```

`ASharesPanel.applyIndexFilter` 扩展：对 custom 指数调 `GET /api/custom-indices/:id/members` 得到 con_code 列表 → 应用股票筛选。
