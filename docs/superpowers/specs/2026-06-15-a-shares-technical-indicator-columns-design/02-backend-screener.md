# 02 · 后端 A股 screener 改动

← 返回 [index.md](./index.md)

目标文件：`apps/server/src/market-data/a-shares/data-access/a-shares-query.sql.ts`（核心）、`apps/web/src/api/modules/market/aShares.ts`（`AShareRow` 类型）。

`raw.daily_indicator i` 已在 `buildASharesBaseQuery` 内 JOIN（`:144`），所以 Tier-1 列**只缺 SELECT**；个股 AMV 需**新增一个 LEFT JOIN**。

## 1. SELECT 补列（buildASharesBaseQuery `:115-139`）

在现有 `q.trade_date AS "tradeDate"` 之后、`tags` 之前，插入指标列（DB 列名 → camelCase 别名，与自选股 canonical key 一致）：

```text
-- 均线
i.ma5 AS "ma5", i.ma30 AS "ma30", i.ma60 AS "ma60", i.ma120 AS "ma120", i.ma240 AS "ma240", i.bbi AS "bbi",
-- KDJ / MACD
i.kdj_j AS "kdjJ", i.kdj_k AS "kdjK", i.kdj_d AS "kdjD", i.dif AS "dif", i.dea AS "dea", i.macd AS "macd",
-- 风控 / 波动
i.atr_14 AS "atr14", i.loss_atr_14 AS "lossAtr14", i.low_9 AS "low9", i.high_9 AS "high9",
i.risk_reward_ratio AS "riskRewardRatio", i.stop_loss_pct AS "stopLossPct",
-- 行情(量)
i.quote_volume_10 AS "quoteVolume10",
-- 砖块图
i.brick AS "brick", i.brick_delta AS "brickDelta", i.brick_xg AS "brickXg",
-- 个股 AMV（来自新增 JOIN sa）
sa.amv_dif AS "amvDif", sa.amv_dea AS "amvDea", sa.amv_macd AS "amvMacd"
```

> 列别名必须与前端 `AShareRow` 字段名、共享目录 descriptor 的 `key` **三处字面一致**（canonical key）。这是去重抽象成立的前提，见 [04 硬约束](./04-consumers-ashares-watchlist.md#canonical-key-对齐硬约束)。

## 2. 新增个股 AMV JOIN（buildASharesBaseQuery `:144` 后追加一行）

```sql
LEFT JOIN stock_amv_daily sa ON sa.ts_code = s.ts_code AND sa.trade_date = l.trade_date
```

- 与 `i` 的 JOIN 同构：按 `l.trade_date`（每股最新行情日）对齐。
- `stock_amv_daily` 唯一键 `(ts_code, trade_date)` → LEFT JOIN **至多一行，不放大 COUNT**（与 `i`/`m` 同理）。
- **实现时验证**：`stock-amv-daily.entity.ts` 的 `@Entity` 表名与 schema（裸名 `stock_amv_daily` 可达，疑似 public，无 `raw.` 前缀；与 `raw.daily_indicator` 不同 schema，勿照搬前缀）。
- 缺该股当日 AMV 时 LEFT JOIN → NULL，前端渲染 `-`，可接受（实测满覆盖，仅极少次新股缺）。

## 3. 排序映射 RAW_SORT_COL_MAP

现有映射（`:50-67`）不含任何指标列。为支持表头点击远程排序，补入（前端列 key → SQL 表达式）：

```text
ma5:'i.ma5', ma30:'i.ma30', ma60:'i.ma60', ma120:'i.ma120', ma240:'i.ma240', bbi:'i.bbi',
kdjJ:'i.kdj_j', kdjK:'i.kdj_k', kdjD:'i.kdj_d', dif:'i.dif', dea:'i.dea', macd:'i.macd',
atr14:'i.atr_14', lossAtr14:'i.loss_atr_14', low9:'i.low_9', high9:'i.high_9',
riskRewardRatio:'i.risk_reward_ratio', stopLossPct:'i.stop_loss_pct', quoteVolume10:'i.quote_volume_10',
brick:'i.brick', brickDelta:'i.brick_delta', brickXg:'i.brick_xg',
amvDif:'sa.amv_dif', amvDea:'sa.amv_dea', amvMacd:'sa.amv_macd',
```

- `QFQ_SORT_COL_MAP`（`:69-74`）以 `...RAW_SORT_COL_MAP` 展开，**自动继承**新映射，无需重复。
- `appendASharesSort`（`:204-219`）逻辑不变：`ORDER BY <col> <dir> NULLS LAST`。NULLS LAST 保证缺指标的股恒置末尾。
- 排序字段名（前端 column key）= 上表左键 = SELECT 别名，三者一致才能"点表头→remote 排序"闭环。

## 4. 前端类型 AShareRow（`aShares.ts:18-37` 扩字段）

数值字段全为 `string | null`（PG NUMERIC/double 经 JSON 返回为 string）；**`brickXg` 例外为 `boolean | null`**（DB 列 `brick_xg` 是 `boolean`，node-postgres 直接解析为 JS `boolean`，不是数字串——见下方 ⚠）：

```ts
ma5: string | null; ma30: string | null; ma60: string | null; ma120: string | null; ma240: string | null
bbi: string | null
kdjJ: string | null; kdjK: string | null; kdjD: string | null
dif: string | null; dea: string | null; macd: string | null
atr14: string | null; lossAtr14: string | null; low9: string | null; high9: string | null
riskRewardRatio: string | null; stopLossPct: string | null
quoteVolume10: string | null
brick: string | null; brickDelta: string | null; brickXg: boolean | null   // ⚠ boolean，非 string
amvDif: string | null; amvDea: string | null; amvMacd: string | null
```

> ⚠ **`brick_xg` 是布尔信号**（`daily-indicator.entity.ts` `@Column({ name:'brick_xg', type:'boolean' })`；`fieldDescriptions.ts` 已有条目"砖形图选股信号（布尔）"）。`SELECT i.brick_xg AS "brickXg"` 返回 JS `true/false`。后果：① `AShareRow.brickXg` 为 `boolean | null`；② `a-shares.service.ts` 的查询结果泛型 `Record<string, string | null>` 不容纳 boolean——实现时放宽该泛型或容忍该列；③ 渲染按**信号**（tag 真/假 或 ✓/✗）而非数值，见 [03 §1.1 kind=signal](./03-shared-catalogue-grouping.md#13-渲染器契约)。
> 其余数值列的共享渲染器接受 `string | null | number | undefined`（`Number(value)` 归一），见 [03 渲染器契约](./03-shared-catalogue-grouping.md#13-渲染器契约)。

## 5. 服务层与分页（实现时核对，无预期改动）

- `a-shares.service.ts:query`（`:109-131`）只跑 `buildASharesBaseQuery` + `appendASharesSort` + 分页包装。**实现时确认**：
  - COUNT 查询若基于同一 base，LEFT JOIN 唯一键不放大行数 → COUNT 安全。
  - 服务层未对 SELECT 字段做白名单/逐字段映射（裸 `dataSource.query()` 直返行对象）→ 新别名自动透出。
- **无 DB 迁移**（列已存在）。改 SQL 后**必须重启后端**。

## 6. 不做（边界重申）

- 不动 `RAW_CONDITION_COL_MAP`（筛选条件本期不扩；i.* 指标本就有映射，AMV 不加）。
- 不动 `priceMode`/qfq 逻辑（指标列与复权口径无关，直接取 raw 指标值）。
- 不引入 `technicalindicators` npm 包（既有为 `indicators.ts` 手写纯函数，该包是僵尸依赖）。
