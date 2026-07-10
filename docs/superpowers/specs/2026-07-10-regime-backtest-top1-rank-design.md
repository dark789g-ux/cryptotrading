# Regime 回测：同日排序 Top1 选股 + 全量候选审计

## 1. 背景与目标

### 问题

同日多个标的命中 `entryConditions` 时，引擎按 `ts_code` 字母序逐笔开仓；`maxPositions=1` 时等价于「代码最小者入选」，非业务择优。

### 目标

1. 筛选后按象限配置的排序键排序，**同日硬 Top1** 进入开仓路径。  
2. **跨日**仍受象限 `maxPositions` 约束，可累加持仓。  
3. 回测详情可审计：每个信号日的**全量候选**（rank、排序值、是否入选）。  
4. Live `runDaily` / `regime_daily_pick` **一期不改**（未产品化）。

### 产品定案

| 项 | 定案 |
|----|------|
| 同日 | 排序后只开 1 只（硬 Top1） |
| 跨日 | `maxPositions` 照旧，可累加 |
| 排序字段 | 精选短名单 + `none`；可配升/降 |
| 配置挂载 | 每个 `trade` 象限各自一份 |
| 执行路径 | 枚举层截断：仅 Top1 进 WindowBuilder/引擎 |
| 审计 | `rank>1` 合成 `not_top1` 行落 trade 表；不跑出场模拟 |
| Live 日选 | 一期不改 |
| 递补 | 不递补（Top1 被拒不改开 rank=2） |

### 非目标（一期）

- 多因子加权打分  
- 同日 TopN（N>1）开仓  
- Live 日选对齐  
- `GET .../trades` 按日分页  
- 改现金切分 / `trailing_lock` 语义  
- 旧配置自动补默认 `rankField`（缺则 400）  
- 拆分 `nSkipped` 为 `nNotTop1` / `nEngineSkipped`（一期承认 `nSkipped` 含审计行）

---

## 2. 排序规则 {#ranking}

### 2.1 象限字段（仅 `action=trade`）

```text
rankField: RankField   // trade 必填
rankDir:   'asc' | 'desc'  // rankField ≠ 'none' 时必填；none 时忽略/清空
```

| rankField | 默认方向 | UI 标签 | 数据日 |
|-----------|----------|---------|--------|
| `turnover_rate` | desc | 换手率（新建默认） | signalDate=T |
| `pct_chg` | desc | 涨跌幅 | T |
| `amount` | desc | 成交额 | T |
| `pos_120` | asc | 120 日位置 | T |
| `circ_mv` | asc | 流通市值 | T |
| `amv_macd` | desc | 个股 AMV-MACD | T |
| `none` | — | 不排序 | —（按 `ts_code` 升序） |

列映射复用 `ASHARE_FIELD_COL_MAP`（与入场条件同源 JOIN）。

**取数定案（A）**：扩展 `buildEnumerateQuery`（或枚举专用查询）在命中 SQL 中 `SELECT ts_code, <rankExpr> AS "rankValue"`，一次查出排序值。`rankField=none` 时不选表达式，`rankValue=null`。

### 2.2 比较语义

```text
1. 取候选在 T(=signalDate) 的 rankValue
2. null / NaN → 缺失，排在有值之后（升/降皆殿后）
3. 有值按 rankDir 比较
4. 平局 → ts_code 升序
5. 编号 rank=1..N；仅 rank=1 入选进引擎
```

**禁止**用 buyDate=T+1 字段排序（lookahead）。

### 2.3 校验

- `trade`：`rankField` ∈ 短名单；`≠ none` 时 `rankDir` ∈ `{asc,desc}`。  
- `flat`：运行忽略 `rankField`/`rankDir`；保存时**原样保留**（不强制剥离、不强制校验）。  
- 任何缺 `rankField` 的 trade 象限（含旧快照复制、API 直调）：**400 / 校验失败**。  
- 仅新建 UI 默认填 `turnover_rate` + `desc`。

---

## 3. 数据流与落库契约 {#data-flow}

### 3.1 唯一契约（禁止双写 rank=1）

```text
enumerate + SELECT rankValue
        │
        ▼
   sort → rankedCandidates[]   (全量，含 rank/rankField/rankValue)
        │
        ├── rank==1 且存在 T+1 buyDate ──► WindowBuilder ──► 引擎
        │                                      │
        │                                      ▼
        │                              engineTrades（0或1条/日）
        │                                      │
        ├── rank>=2 且该日有 T+1 ─────► auditSkipped[]（not_top1 行）
        │
        ▼
runner.mergeAndPersist:
  1. 对 engineTrades 按 (signalDate, tsCode) 覆写 rank/rankField/rankValue
  2. 追加 auditSkipped（禁止再插入 rank=1）
  3. 批量写入 regime_backtest_trade
  4. summary.nSkipped = 引擎 skip 数 + auditSkipped.length
     summary.nTaken   = 引擎 taken 数
```

引擎**不感知** rank；enrichment 仅在 persist 前由 runner 完成。

无 T+1（`buyDate` 越界）时：该信号日**整组不产出**（与现 `SignalEnumerator` 一致）——既无引擎信号，也无审计行。

### 3.2 递补

一期：**不递补**。

### 3.3 `nSkipped` 语义

`nSkipped` **含** `not_top1` 审计行，故候选多时该指标会显著大于「引擎门禁跳过数」。一期不拆分；详情以 trade 表为准。

---

## 4. 落库与 API {#persistence}

### 4.1 新增列

| 列 | 类型 | 说明 |
|----|------|------|
| `rank` | `int` nullable | 1-based；新 run 必有 |
| `rank_field` | `varchar(32)` nullable | 含 `none` |
| `rank_value` | `numeric` nullable | `none`/缺失为 null |

迁移：`apps/server/src/migration/20260710_regime_backtest_trade_rank.sql` + `.ps1`。  
索引：`(run_id, signal_date, rank)`。

### 4.2 `not_top1` 行模板（满足实体 NOT NULL）

实体非空列必须赋值：

| 字段 | 值 |
|------|-----|
| `signalDate` | T |
| `buyDate` | 日历 T+1（与枚举一致） |
| `tsCode` | 候选代码 |
| `regime` | 当日象限 key |
| `exitMode` | 象限 `exitMode ?? ''` |
| `status` | `skipped` |
| `skipReason` | `not_top1` |
| `rank` / `rankField` | 必填 |
| `rankValue` | 有值则填；`none`/缺失则 null |
| `exitDate` / `ret` / `alloc` / `costsPaid` / `realizedRetNet` / `exitReason` | null |

`SkipReason` 联合类型新增 `'not_top1'`。

Top1：仅来自 `engineTrades`；runner 覆写 rank 三列；**禁止** audit 再写一条 rank=1。

### 4.3 API

- `GET .../trades` 增加 `rank` / `rankField` / `rankValue`。  
- **默认排序**：`ORDER BY signal_date ASC, rank ASC NULLS LAST`。  
- 创建/运行无新顶层字段；配置在 `quadrants[]`。  
- 一期全量返回。

---

## 5. UI {#ui}

### 5.1 配置编辑

```text
┌─ Qx trade ──────────────────────────────────────┐
│ 仓位比例 [    ]   最大持仓 [    ]                 │
│ 选股排序 [换手率 ▾]  方向 [降序 ▾]                │
│ 入场条件 …                                       │
└─────────────────────────────────────────────────┘
```

切换 `rankField` → 填默认方向；`none` 隐藏方向。  
`RegimeBacktestConfigSummary` 展示排序摘要。

### 5.2 详情交易表

```text
┌─ 交易明细 ──────────────────────────────────────┐
│ 筛选 [全部|仅入选|仅成交]   信号日搜索             │
│                                                  │
│ ▼ 20260115  Q1  候选 87  入选 000001.SZ (#1)     │
│   #  代码         排序值     状态     原因         │
│   1  000001.SZ    12.35      taken    —          │
│   2  000002.SZ    11.10      skipped  未入选      │
│ ▶ 20260116  …                                    │
└──────────────────────────────────────────────────┘
```

筛选语义：

| 选项 | 条件 |
|------|------|
| 全部 | 无过滤 |
| 仅入选 | `rank === 1`（含引擎常规 skip） |
| 仅成交 | `status === 'taken'` |

- 按 `signalDate` 分组折叠；组头：候选数 + 入选代码（`rank===1` 的 tsCode）。  
- `SKIP_REASON_LABELS.not_top1 = '未入选'`（`RegimeBacktestTradesTable.vue`）。  
- **排序值展示**：一期统一显示原始数值（不强制 `%`）；列标题用字段中文名（如「换手率」）。

---

## 6. 实现落点

| 区域 | 路径 |
|------|------|
| 象限类型 | `regime-strategy-config.entity.ts` `QuadrantEntry` |
| 引擎 trade 类型 | `regime-backtest.types.ts` `RegimeBacktestTrade` |
| 前端类型 | `apps/web/.../regimeEngine.ts` |
| 校验 | `regime-engine.validation.ts` |
| 枚举+排序值 | `strategy-conditions.enumerator.ts` + `signal-enumerator.ts`（或 `rank-selector.ts`） |
| 合并落库 | `regime-backtest.runner.ts`（enrich + merge audit） |
| SkipReason | `core/types.ts` |
| 实体/迁移 | `regime-backtest-trade.entity.ts` + migration |
| UI 配置 | `RegimeConfigEditor.vue` + helpers |
| UI 详情 | `RegimeBacktestTradesTable.vue`（labels + 分组） |
| 单测 | 排序/平局/空值/not_top1 模板/不递补/merge 不双写/校验 |

---

## 7. 验收

- [ ] `trade` 缺 `rankField` → 校验/创建失败  
- [ ] 同日 3 候选，`turnover_rate` desc → 仅最高换手进引擎；2 条 `not_top1` 无 `alloc`  
- [ ] 平局 → 较小 `ts_code` 为 rank=1  
- [ ] 空值殿后  
- [ ] `none` → 最小 `ts_code` 入选，`rank_value` null  
- [ ] Top1 `already_held` → 无 taken，不递补；仍有 rank=1 的 skipped 行 + 其余 not_top1  
- [ ] persist 后同日恰好一条 `rank=1`  
- [ ] `maxPositions=2`：两日各 Top1 可同时持仓  
- [ ] `nSkipped` 含 not_top1  
- [ ] 详情分组可见全量候选；筛选「仅入选/仅成交」语义正确  
- [ ] trades API 按 `signal_date, rank` 排序  
- [ ] 迁移可执行；旧 run 新列为 null  

---

## 8. 与既有设计关系

叠加于 [regime-backtest-inline-config-design](./2026-07-10-regime-backtest-inline-config-design/index.md)，**不修改**现金切分公式。

## 9. 实现计划

[docs/superpowers/plans/2026-07-10-regime-backtest-top1-rank.md](../plans/2026-07-10-regime-backtest-top1-rank.md)
