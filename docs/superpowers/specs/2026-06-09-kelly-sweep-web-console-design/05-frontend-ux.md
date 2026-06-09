# 05 · 前端 UX

← 返回 [index.md](./index.md)

## 页面位置与路由

放 `apps/web/src/views/quant/kelly-sweep/`（与 jobs 同域，受 `lint:quant-lines` ≤500 行约束）。路由 `/quant/kelly-sweep`。**单页操作台**：上半配置+发起+实时进度，下半结果面板；顶部「历史扫描」下拉（`GET /api/quant/kelly-sweep/history`）可加载任一历史 job 结果。

## 配置表单（全量 12 字段 + 出场族开关）

```text
┌─ 凯利网格搜索操作台  /quant/kelly-sweep   [历史扫描 ▾] ─────┐
│ ┌─ 入场 base 触发 ───────────────────────────────────────┐ │
│ │ [字段 kdj_j ▾] [算子 < ▾] [值 0.0]   ← 字段下拉来自     │ │
│ │                              /kelly-sweep/meta(白名单源) │ │
│ └────────────────────────────────────────────────────────┘ │
│ universe: (•)全市场 ( )指定列表[__________]                 │
│ 训练[2023-01-01~2024-12-31]  验证[2025-01-01~今]            │
│ ┌─ 网格 & 门槛 (全量专家档) ─────────────────────────────┐ │
│ │ max_entry_filters[1▾] min_samples[300] top_k[30]       │ │
│ │ RS基准:☑hs300 ☑zz500 ☐industry(未接通禁用) lookback[5] │ │
│ │ same_day_rule(•)sl_first( )tp_first max_window[20]      │ │
│ │ bootstrap_iters[1000]                                   │ │
│ └────────────────────────────────────────────────────────┘ │
│ ┌─ 出场族(勾选要扫的) ───────────────────────────────────┐ │
│ │ ☑fixed_n(5) ☑tp_sl(36) ☑trailing(6) ☑atr_stop(6)      │ │
│ └────────────────────────────────────────────────────────┘ │
│ 预计组合数: 16变体×53出场=848 ✓  (>5000 显示⚠警告)         │
│                                          [发起扫描]         │
├─ 运行中 (SSE, 复用 ProgressLine.vue) ──────────────────────┤
│ [████████████░░░░░] 62%  网格扫描 75/121 变体              │
└────────────────────────────────────────────────────────────┘
```

要点：
- **base 字段下拉来自 `/kelly-sweep/meta`**（白名单源 `enumerate.py:57`），不前端硬编码（见 [04](./04-nestjs-api.md#字段白名单派生接口避免前端硬编码漂移)）。
- `industry` RS 基准 disable 并标「未接通」（Python 会抛 NotImplementedError）。
- **组合数预估**：变体数（按 `max_entry_filters` 从 15 候选估算 `C(15,k)` 累加 + base）× 勾选出场数；>5000 显示 ⚠。这是用户对 ~13 分钟时长的唯一预期来源。
- 发起前查 running 的 kelly_sweep job（软护栏，见 [01](./01-architecture-dataflow.md#并发护栏)）。

## 结果面板（RS 分组 + 散点 + top-K 表 + 详情）

口径不可跨组比，**含 RS / 不含 RS 用 tab 严格分开**：

```text
┌─ 扫描结果 (2023~2026, 848组合) ─────────────────────────────┐
│ 摘要: 最优Kelly 0.383 (CI .343–.424, n=3004) | 基线 0.171  │
│ ┌─[ 含 RS (with_rs) ]─[ 不含 RS (no_rs) ]─┐  ← 口径分组    │
│ │ 帕累托前沿散点 (新建 ECharts scatter)     │              │
│ │  kelly_valid▲                             │              │
│ │    .4┤    ●━●  ← 前沿点高亮+连线           │              │
│ │    .3┤  ●  · ·                            │              │
│ │    .2┤ ·· ·· ·· ← 灰点=below_floor/无效    │              │
│ │      └─────────────▶ n_valid 信号数        │              │
│ ├───────────────────────────────────────────┤              │
│ │ top-K 排行 (NDataTable 可排序分页)         │              │
│ │ 变体|出场|n_valid|Kelly▼|CI|胜率|b         │              │
│ │ dev_ma30<-.12|fixed_n(1)|3004|.383|..      │ [详情]       │
│ └───────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────┘

点[详情] ▼
┌─ 行详情: dev_ma30<-0.12 + fixed_n(1) [with_rs] ─┐
│ 入场: base kdj_j<0 AND dev_ma30<-0.12           │
│ 出场: fixed_n(n=1)                              │
│ ┌─训练集──────┐ ┌─验证集──────────┐            │
│ │ n / Kelly   │ │ n=3004 Kelly=.383│            │
│ │ 胜率/b/PF   │ │ CI .343–.424     │            │
│ │             │ │ 胜率/b/PF        │            │
│ └─────────────┘ └──────────────────┘            │
└─────────────────────────────────────────────────┘
```

散点图要点：
- x=`n_valid`（信号数）、y=`kelly_valid`（凯利），ECharts `scatter` series。
- `is_frontier` 点高亮 + 连线（前沿），普通点常规色，`below_floor`/`kelly_valid=null` 灰点（无效，仅参考）。
- 项目无散点先例、无 ECharts 公共封装 → 新建 `KellyParetoScatter.vue`，参照 `RetHistogram.vue`（`components/strategy/RetHistogram.vue`）的 `onMounted` init / `window.resize` / `onUnmounted` dispose 模板。
- tooltip 显示变体+出场+各指标；点击点联动定位 top-K 表对应行（可选增强）。

## 组件拆分（全部 ≤500 行）与复用

```text
views/quant/kelly-sweep/
  KellySweepView.vue          编排:配置+进度+结果+历史下拉
  KellySweepConfigForm.vue    配置表单(12字段+出场族+组合数预估)
  KellySweepResultPanel.vue   结果面板(RS分组 tab 容器)
components/quant/kelly-sweep/
  KellyParetoScatter.vue      帕累托散点(新建, 参照 RetHistogram 模板)
  KellySweepTopkTable.vue     top-K 排行表(NDataTable 排序分页)
  KellySweepRowDetail.vue     详情弹窗内容
```

**复用件**（已核实路径）：
- `ProgressLine.vue`（`components/quant/ProgressLine.vue`）— SSE 进度，**零改动**，传 `:jobId` 即自动取 sse-token 建连。
- `AppModal.vue`（`components/common/AppModal.vue`）— 详情弹窗容器。
- API client `apps/web/src/api/client.ts`（fetch 封装，`API_BASE='/api'`）。

**base 触发选择器**：用轻量自建单条三元组（字段下拉来自 meta 接口 + 算子 + 常量值），**不复用 `ConditionRows.vue`**——后者是多条+cross 算子+field/value 双模式，与 base_trigger「单条/常量/仅 lt~neq」约束差异大，硬套反绕。

## API 封装与 store

- 新建 `apps/web/src/api/modules/quant/kellySweep.ts`（对象式导出 `kellySweepApi`），在 `api/index.ts` re-export。封装：`createSweepJob`（复用 `quantApi.createJob` 或薄包装）、`getMeta`、`getSummary`、`getScatter`、`getTopk`、`getRows`、`getRowDetail`、`getHistory`。
- 新建 Pinia store `apps/web/src/stores/kellySweep.ts`：管理当前配置、当前 jobId、结果数据、历史列表。进度走 `ProgressLine.vue` 的 SSE（不另起轮询）。
