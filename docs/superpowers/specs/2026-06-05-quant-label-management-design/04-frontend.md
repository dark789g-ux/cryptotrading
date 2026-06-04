# 04 · 前端 Vue

← 回到 [index.md](./index.md)

沿用现有因子注册表（`QuantFactorsView`/`FactorTable`/`FactorEditModal`）的成熟模式。

## 标签库管理页

```text
┌─ 标签库 (Quant Labels)  /quant/labels ──────────────────┐
│ [基础类型▼] [状态▼]                          [+ 新建标签]│
├──────────────────────────────────────────────────────────┤
│ 名称                基础           分类         版本 状态  │
│ 次日涨跌·横盘±0.5%   fwd_ret h1     band 0.5%    v1   ✓  ⋯│
│ 5日收益·三分位       fwd_ret h5     tercile      v1   ✓  ⋯│
│ 固定策略收益         strategy_aware —(连续/回归) v1   ✓  ⋯│
└──────────────────────────────────────────────────────────┘
   ⋯ = 改元数据 / 新建版本 / 启用·禁用
```

## 标签编辑 Modal（AppModal，按钮走 #actions slot）

```text
┌─ 新建标签 ─────────────────────────────────┐
│ 名称   [次日涨跌·横盘±0.5%            ]      │
│ 描述   [...                          ]      │
│ ┌─ 基础层 ───────────────────────────┐     │
│ │ 基础类型 [fwd_ret ▼]                │     │ ← base_type 变→字段动态切换
│ │ horizon  [1]  (1=次日, 5=5日…)      │     │   (BaseTypeFields.vue)
│ └────────────────────────────────────┘     │
│ ┌─ 分类层（可选）────────────────────┐     │
│ │ 分类方式 [band ▼] (留空=连续/回归)  │     │ ← classify_mode 变→字段动态切换
│ │ 横盘阈值 ε [0.5] %                  │     │   (ClassifyFields.vue)
│ └────────────────────────────────────┘     │
│                       #actions: [取消][保存]│
└─────────────────────────────────────────────┘
```

`base_type=strategy_aware` 时基础层字段切换为 `max_hold_days`；`classify_mode=tercile`
时分类层无额外字段；`custom` 时显示分位/阈值边界输入。

## 训练入口改造（TrainE2EFields + buildParams.ts）

```text
【改造前】
  标签方案 [dir3_band ▼]  ← 4 个硬编码 scheme
  └折叠: dir3_band_eps[ ] fwd_horizon_days[ ] max_hold_days[ ]  ← scheme 专属参数
  buildParams.ts: 按 label_scheme 分支打 dir3_band_eps 等进 params

【改造后】
  命名标签 [次日涨跌·横盘±0.5% (v1) ▼]  ← 从标签库选；摘要显示 "fwd_ret h1 | band 0.5%"
  └折叠: 移除上面 3 个 scheme 专属参数（已进标签定义）
         保留 neutralize_cols / robust_z / factor_clip_sigma / label_winsorize
  buildParams.ts: 改为打 labelRef:{label_id, label_version} 进 body
```

命名标签下拉数据来自 `GET /quant/labels?enabled=true`，用 `computed` 派生（响应接口刷新）。
下拉项展示 `name` + 基础/分类摘要。

## 前端文件域

```text
新 apps/web/src/views/quant/QuantLabelsView.vue                      (页面骨架)
新 apps/web/src/components/quant/LabelTable.vue                      (表格，仿 FactorTable)
新 apps/web/src/components/quant/LabelEditModal.vue                  (AppModal)
新 apps/web/src/components/quant/label-modal/BaseTypeFields.vue      (基础层动态字段)
新 apps/web/src/components/quant/label-modal/ClassifyFields.vue      (分类层动态字段)
改 apps/web/src/components/quant/train-modal/TrainE2EFields.vue      (label_scheme→命名标签下拉)
改 apps/web/src/components/quant/train-modal/FeatureLabelFields.vue  (移除 scheme 专属参数)
改 apps/web/src/components/quant/train-modal/buildParams.ts          (打 labelRef)
改 apps/web/src/api/modules/quant.ts                                 (+ labels API + createJob labelRef)
改 apps/web/src/router（quant 路由）                                  (+ /quant/labels)
改 导航菜单                                                          (+ 标签库入口)
新 apps/web/src/components/quant/__tests__/QuantLabels.spec.ts
```

`/quant/*` 路由树已是 admin-only（见 factor-registry spec），新页面自动继承守卫。

## 前端硬约束（项目踩过的坑，必写进任务）

- **合并前必跑 `pnpm --filter @cryptotrading/web build`（vite），不能只信 type-check**：
  `defineProps`/`withDefaults` 默认值引用局部变量、SFC 模板编译错，`vue-tsc --noEmit`
  查不出，只有 vite build / 真机才暴露；动到懒加载路由的页面要真机点开确认不白屏
- 所有新 `.vue` ≤ 500 行（CI `lint:quant-lines` 强制 `views/quant/**` 与 `components/quant/**`）
- Modal 统一 `AppModal`、按钮走 `#actions`；子组件内禁自带"保存/取消"按钮
- `n-select` 自定义 option `extends SelectOption`（`import type { SelectOption } from 'naive-ui'`）
- `withDefaults` 默认值用内联字面量，禁引用 `<script setup>` 局部变量
- 数据加载注意 keep-alive：放 `onActivated` 而非仅 `onMounted`；`watch` 依赖初始值加 `{ immediate: true }`
- 阈值/分类配置 UI 遵循"比较目标同时支持字段引用与常量"等条件构建器规范（按需）
