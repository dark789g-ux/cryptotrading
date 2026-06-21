# 05 · 任务拆分与验收

> 前置：[01](./01-decisions.md) [02](./02-calc-and-db.md) [03](./03-screener-refactor.md) [04](./04-table-columns.md)。

## 5.1 实施批次（依赖序）

```text
批次1（落库基础，串行内聚）
  ├─ calcIndicators + calcIndicatorsStreaming 加 ROC（02）
  ├─ 实体 + DB 迁移（02）
  └─ 写入映射 A股 + 加密（02）
  → 产出：roc10/20/60 能随同步流程计算并落库

批次2（回填，依赖批次1）
  └─ A 股全量回填 roc10/20/60（02）
  → 产出：历史数据补齐

批次3（筛选改造 + 表格列，可并行，依赖批次1/2）
  ├─ 筛选改造：删方案A现算→读列（03）
  └─ 表格列：主SQL+排序+前端列（04）
  → 产出：筛选条件和表格列都用上 ROC
```

批次 3 内筛选改造（03）与表格列（04）文件域不相交（strategy-conditions vs market-data/catalog + web columns），可并行。

## 5.2 改动文件总清单

**计算层与 DB（02）**
- `indicators/indicators.ts` — calcIndicators + 接口
- `indicators/indicators-stream.ts` — calcIndicatorsStreaming
- `entities/raw/daily-indicator.entity.ts` — 3 列
- `entities/symbol/kline.entity.ts` — 3 列
- `market-data/a-shares/services/a-shares-indicator.service.ts` — createIndicatorEntity 映射
- `market-data/sync/sync.service.ts` — entity 映射
- `migration/2026MMDD-add-roc-indicators.sql` + `.ps1`（新）

**筛选改造（03）**
- `strategy-conditions/strategy-conditions.query-builder.ts` — 删现算分支
- `strategy-conditions/strategy-conditions.types.ts` — 加列映射
- `entities/strategy/strategy-condition.entity.ts` — 删 rocParams
- `strategy-conditions/dto/create-strategy-condition.dto.ts` — 删 rocParams
- `strategy-conditions/strategy-conditions.query-builder.roc.spec.ts` — 重写
- `web/.../conditionFieldMeta.ts` — roc→roc10/20/60
- `web/.../ConditionRows.vue` — 删参数框
- `web/api/.../strategyConditions.ts` — 删 rocParams

**表格列 + 表格筛选（04）**
- `market-data/a-shares/data-access/a-shares-query.sql.ts` — SELECT + 排序映射 + RAW_CONDITION_COL_MAP（表格筛选）
- `catalog/symbols/symbols.service.ts` — SELECT + 排序映射 + KLINE_INDICATOR_COLUMNS（表格筛选）
- `web/api/.../aShares.ts` — AShareRow 加字段
- `web/api/.../SymbolRow` — 加字段
- `web/.../indicatorColumnDefs.ts` — 3 个 descriptor
- `web/.../cryptoColumns.ts` — 3 条硬编码列
- `web/.../columnGroupMeta.ts` — 分组
- `web/.../fieldDescriptions.ts` — 说明

## 5.3 验收标准

### 计算正确性（02）
- [ ] `calcIndicators` 对已知序列算出的 roc10/20/60 与手算一致（单测）
- [ ] 流式 `calcIndicatorsStreaming` 与批算 `calcIndicators` 在同一序列上结果一致（对拍单测，仿 `kdj-params.spec.ts:84`）
- [ ] 数据不足（序列 < N+1 根）返回 null

### DB 与写入（02）
- [ ] 迁移 SQL 执行成功，daily_indicator + klines 各加 3 列
- [ ] A 股全量回填后，roc10/20/60 有值（抽查几个老股）
- [ ] 新股上市 <60 天，roc60 为 NULL

### 筛选（03）
- [ ] `roc20 gt 5` 条件 → SQL 含 `i.roc20 > $1`，params=[5]
- [ ] crypto `roc10 lt 0` → `k.roc10 < $1`
- [ ] cross_above（穿越 0 轴）可用：`roc20 cross_above 0`
- [ ] query-builder 全套单测通过（含重写的 ROC 测试）
- [ ] 前端选「动量20日」→ 条件 field=roc20，无参数框

### 表格（04）
- [ ] A 股表格：勾选 ROC20 列 → 显示数值，按列头排序生效（服务端）
- [ ] 加密表格：同上
- [ ] 排序性能：按 ROC 排序响应 <500ms（读预存列，非现算）
- [ ] 新股 ROC 列显示 `-`（null 处理）
- [ ] 表格筛选：A 股表格高级筛选选 ROC20 > 5 生效（走 RAW_CONDITION_COL_MAP，非静默跳过）
- [ ] 表格筛选：加密表格同上（走 KLINE_INDICATOR_COLUMNS）

### 同源一致性
- [ ] 同一标的同一天：筛选条件 `roc20 gt 5` 命中 ⟺ 表格 ROC20 列 > 5（同源读同一列）

### 回归
- [ ] 现有 KDJ/MACD/MA 指标计算不受影响（calcIndicators 单测全绿）
- [ ] 现有筛选条件功能不回归
- [ ] 表格现有列显示/排序不回归

## 5.4 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| calcIndicators 改动影响现有指标数学 | 中 | ROC 是独立计算（只读 closes，不改现有数组），加单测对拍批算 vs 流式 |
| 流式 state.closes 窗口边界 | 低 | 已确认 239 > 60；单测覆盖 index<60 返 null |
| 全量回填耗时 | 低 | 复用现有回填机制，分钟级；可后台跑 |
| 已入库的方案 A ROC 条件 | 低 | 方案 A 刚提交、预计无线上存量；实现时确认，若有则回填改写 field:'roc'→'roc10' |
| crypto 列硬编码 % 后缀与 formatFixed | 低 | 注意 formatFixed 返回 toFixed，需拼 % 或用 suffix 模式 |
| DB 迁移幂等 | 低 | `ADD COLUMN IF NOT EXISTS` |

## 5.5 开放问题（实现时确认）

1. **列分组归属**：roc10/20/60 放「均线」组还是新建「动量」组？（04.3c）
2. **迁移文件名日期戳**：02.4a 的 `2026MMDD-add-roc-indicators.sql` 是占位，实现时定一个真实日期戳（参考现有迁移脚本命名，如 `20260620150000`）。
3. **commit 788faf5 的 git 处理**：已提交的方案 A 代码不是 revert（会丢 spec 历史），而是在新 commit 里改造替换。

> 注：旧方案 A 单文件 spec（`2026-06-20-momentum-roc-strategy-conditions-design.md`，commit 788faf5 的 352 行）已被本目录取代并从工作树删除，git 历史保留，无需额外处理。
