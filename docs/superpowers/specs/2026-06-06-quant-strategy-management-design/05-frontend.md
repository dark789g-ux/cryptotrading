# 05 · 前端

← 返回 [index](./index.md) ｜ 上一篇 [04 NestJS](./04-backend-nestjs.md)

镜像现有 `views/quant/QuantLabelsView.vue`（217 行）+ `components/quant/label-modal/`
（LabelEditModal 284 / BaseTypeFields 119 / ClassifyFields 168）。
**硬约束**：Vue 单文件 ≤500 行，`lint:quant-lines` 在 CI 强制 → 按职责拆组件。

## 1. 页面与组件结构

```text
views/quant/QuantStrategiesView.vue           列表容器（仿 QuantLabelsView）
  ├─ 页头: 刷新 + "新建策略"
  ├─ 筛选: <n-select> 状态(all/启用/禁用)
  ├─ components/quant/StrategyTable.vue        表格 + @edit 事件
  └─ components/quant/strategy-modal/
       StrategyEditModal.vue                   弹框（仿 LabelEditModal）
         ├─ 基本信息: strategy_id / strategy_version / name / description
         ├─ ExitRulesEditor.vue                ★ 动态规则列表（核心新组件）
         │    └─ ExitRuleRow.vue               单条规则: type 选择 + 该 type 的 params 框
         └─ 状态段(仅编辑): enabled / display_order
```

## 2. ExitRulesEditor 交互（核心）

```text
┌─ 出场规则（按顺序判定，命中即出场） ──────────────────────┐
│  ① [stop_loss     ▼]  pct    [0.08]            [↑][↓][✕] │
│  ② [ma_break      ▼]  period [5   ]            [↑][↓][✕] │
│  ③ [max_hold      ▼]  days   [20  ]            [↑][↓][✕] │
│  ④ [take_profit   ▼]  pct    [0.15]            [↑][↓][✕] │
│                                                           │
│  [ + 添加规则 ]      ⚠ 必须含一条 max_hold               │
└───────────────────────────────────────────────────────────┘
```

- 规则 type 下拉 + 参数框由 `GET /quant/strategies/exit-rule-types` 返回的元信息**动态渲染**
  （param 名 / 类型 / 范围 / 默认值都来自后端，前端不硬编码范围——后端单一真相源）。
- 上移/下移调顺序（first-match 优先级）；✕ 删除。
- 前端即时校验：非空 + 恰一条 max_hold + params 落范围；不满足时禁用「保存」并提示。
- 同一 type 至多一条（添加时该 type 从可选列表移除，与后端约束一致）。

## 3. 标签弹框改造（BaseTypeFields.vue）

现状 `base_type=strategy_aware` 时渲染 `max_hold_days` 数字框（`BaseTypeFields.vue:33-49`）。
**改为策略选择器**：

```text
base_type=strategy_aware 时:
  ┌─────────────────────────────────────────────┐
  │ 引用策略 *  [ 默认出场策略 (default_exit@v1) ▼] │
  │             下拉 = GET /quant/strategies?enabled=true │
  │             选中后 base_params={strategy_id, strategy_version} │
  └─────────────────────────────────────────────┘
```

- 删除 `max_hold_days` 输入 + `onBaseTypeChange` 里 `{max_hold_days:20}` 重置逻辑
  （`BaseTypeFields.vue:90`）；改为切到 strategy_aware 时 `base_params` 置空待选。
- 下拉选项 label 显示 `name (id@version)`，value 为 `{strategy_id, strategy_version}`。
- fwd_ret 分支不动。

## 4. api service（api/modules/quant.ts）

新增（镜像 listLabels 等）：

| 方法 | HTTP | 路径 |
|------|------|------|
| `quantApi.listStrategies(query?)` | GET | `/api/quant/strategies` |
| `quantApi.getStrategy(id, version)` | GET | `/api/quant/strategies/:id/:version` |
| `quantApi.createStrategy(body)` | POST | `/api/quant/strategies` |
| `quantApi.updateStrategy(id, version, body)` | PATCH | `/api/quant/strategies/:id/:version` |
| `quantApi.listExitRuleTypes()` | GET | `/api/quant/strategies/exit-rule-types` |

## 5. 路由与菜单

- 路由（`router/index.ts`）：`/quant/strategies`，name `quant-strategies`，
  `meta.requireAdmin: true`（守卫自动拦非 admin，无需额外处理）。
- Sidebar（`components/layout/Sidebar.vue`）：量化父菜单在「标签库」后追加
  `{ label: '策略管理', key: 'quant-strategies' }`，并在 `QUANT_CHILD_KEYS` 数组同步加该 key
  （`:133-139`）。

## 6. 行数与拆分自检

| 文件 | 参照行数 | 预算 |
|------|---------|------|
| QuantStrategiesView.vue | QuantLabelsView 217 | < 250 |
| StrategyEditModal.vue | LabelEditModal 284 | < 300 |
| ExitRulesEditor.vue | — | < 250（拆 ExitRuleRow 后） |
| ExitRuleRow.vue | — | < 150 |
| BaseTypeFields.vue（改） | 现 119 | < 200 |

每个文件提交前跑 `pnpm --filter @cryptotrading/web lint:quant-lines`。

## 7. 验证注意

- 前端类型检查 `pnpm --filter @cryptotrading/web type-check`。
- ⚠ [[project_active_mv_indicator]] 教训：`vue-tsc` 查不出某些 SFC 编译错 →
  关键交互（ExitRulesEditor 增删、策略选择器联动 base_params）须真机点测（见
  [06](./06-testing-and-tasks.md#4-端到端验证验收)）。
