# 02 · 计算层与 DB 模型

> 前置：[01-decisions.md](./01-decisions.md)。本篇定义 ROC 的计算公式、接入既有指标管线、DB 迁移与回填。

## 2.1 计算公式

ROC（Rate of Change）：

```
ROC(N)[i] = (close[i] - close[i-N]) / close[i-N] * 100
```

- `i` 为 K 线序列下标（按交易日升序），`close[i-N]` 为 N 个交易日前的收盘价。
- **数据不足**（`i < N`，序列开头不足 N+1 根）：返回 `null`（与 `MA240` 等严格 SMA 的「不足周期返 null」口径一致，见 `indicators.ts:159-163` `calcStrictSma`）。
- **除零防御**：`close[i-N] = 0` 时返回 `null`（理论极罕见，但与 fail-closed 原则一致）。
- 三档固定 N ∈ {10, 20, 60}，产出 `roc10` / `roc20` / `roc60`。

## 2.2 接入批算：`calcIndicators`

文件 `apps/server/src/indicators/indicators.ts`。

### 2.2a 接口扩展

`KlineRowWithIndicators`（:20-40）新增三个字段：

```ts
export interface KlineRowWithIndicators extends KlineRow {
  // ... 现有 DIF/DEA/MACD/KDJ/BBI/MA/ATR ...
  roc10: number | null;
  roc20: number | null;
  roc60: number | null;
}
```

### 2.2b 计算逻辑

`calcIndicators`（:117）内部，`closes` 数组已存在（:118）。在产出 map（:185-206）之前，加 ROC 计算：

```ts
// ROC：N 个交易日前的收盘价。i < N 时返回 null（不足周期）。
const rocN = (n: number): (number | null)[] =>
  closes.map((_, i) => {
    if (i < n) return null;
    const prev = closes[i - n];
    if (!prev) return null; // prev=0（除零）或 NaN（脏数据）→ null（fail-closed）
    return roundSig((closes[i] - prev) / prev * 100, 6);
  });
const roc10 = rocN(10);
const roc20 = rocN(20);
const roc60 = rocN(60);
```

产出 map（:185）的返回对象新增：

```ts
    roc10: roc10[i],
    roc20: roc20[i],
    roc60: roc60[i],
```

> `roundSig(x, 6)` 复用文件已有的有效数字四舍五入（与 `dif/dea/macd` 同 helper）。6 位有效数字：ROC 通常 [-100, 数百]%，6 位对百分比量纲绰绰有余，且前端 `decimals: 2` 会二次截断，DB 精度不影响展示。
>
> **prev=0/NaN 返 null 的口径**：与项目既有 `stop_loss_pct`（`closes[i] ? ... : 0.0`，:180）的「0 时返 0」不同——ROC 选 fail-closed（返 null），因为 `close=0` 是脏数据/停牌异常，ROC 此时应缺省（显示 `-`）而非给出误导性的 0% 动量。

## 2.3 接入流式：`calcIndicatorsStreaming`

文件 `apps/server/src/indicators/indicators-stream.ts`。流式增量计算，用于 A 股脏数据增量重算 + worker 线程池。

### 2.3a 关键前提：state.closes 窗口够用

`IndicatorCalcState.closes` 保留最近 239 个收盘价（:150 `closesForCalc.slice(-239)`，为 MA240 服务）。ROC60 取 60 根前，**239 > 60，够用，无需扩容 state**。

> 但注意：流式 state 里 `closes` 是 `appendWindow(prev?.closes ?? [], close, 240)` 的结果，长度递增到 240 后稳定。算 ROC60 时取 `closes[closes.length - 1 - 60]`——当 `index < 60`（即 `count < 61`）时 state 里不足 61 根，返 null。

### 2.3b 计算逻辑

`IndicatorStreamCalculator.next`（:79）内部，`closesForCalc` 已存在（:104）。在产出 `row`（:165）之前，加 ROC：

```ts
// ROC：取 closesForCalc 里 N 根前的收盘价。长度不足 N+1 返 null。
const calcRoc = (n: number): number | null => {
  if (closesForCalc.length < n + 1) return null;
  const prev = closesForCalc[closesForCalc.length - 1 - n];
  if (!prev) return null;
  return roundSig((close - prev) / prev * 100, 6);
};
```

产出 `row`（:165-186）新增：

```ts
        roc10: calcRoc(10),
        roc20: calcRoc(20),
        roc60: calcRoc(60),
```

> 注意：`KlineRowWithIndicatorState.row` 类型即 `KlineRowWithIndicators`，2.2a 加了字段后这里 TS 会要求补齐。

## 2.4 DB 迁移：daily_indicator + klines 各加 3 列

### 2.4a 迁移文件

按项目惯例（`apps/server/src/migration/*.sql` + 同名 `.ps1`），新建：

`apps/server/src/migration/2026MMDD-add-roc-indicators.sql`：

```sql
-- A 股：raw.daily_indicator
ALTER TABLE raw.daily_indicator
  ADD COLUMN IF NOT EXISTS roc10 double precision,
  ADD COLUMN IF NOT EXISTS roc20 double precision,
  ADD COLUMN IF NOT EXISTS roc60 double precision;

-- 加密：klines
ALTER TABLE klines
  ADD COLUMN IF NOT EXISTS roc10 double precision,
  ADD COLUMN IF NOT EXISTS roc20 double precision,
  ADD COLUMN IF NOT EXISTS roc60 double precision;
```

同名 `.ps1`（用 `$PSScriptRoot` 引同目录 SQL，内置 `docker exec`），仿现有迁移脚本。

### 2.4b 实体扩展

`apps/server/src/entities/raw/daily-indicator.entity.ts`，仿现有 `ma240`（:50-51）加：

```ts
@Column({ type: 'double precision', nullable: true })
roc10: number;

@Column({ type: 'double precision', nullable: true })
roc20: number;

@Column({ type: 'double precision', nullable: true })
roc60: number;
```

`apps/server/src/entities/symbol/kline.entity.ts`，仿现有 `ma240`（:85-86）加同样的三个 `@Column`。

## 2.5 写入映射：A 股 + 加密

计算结果到实体的映射，两处各加 3 行。

### 2.5a A 股

`a-shares-indicator.service.ts` 的 `createIndicatorEntity`（:218-250），在 `riskRewardRatio` 之后加：

```ts
      roc10: row.roc10,
      roc20: row.roc20,
      roc60: row.roc60,
```

> `calcIndicatorsStreaming`（流式）和 `calcIndicators`（批算）两条路径的产物都经过 `createIndicatorEntity`，故映射只改这一处。但批算路径 `recalculateIndicatorsForSymbol`（:147）也调 `createIndicatorEntity`，自动覆盖。

### 2.5b 加密

`sync/sync.service.ts` 的 entity 映射（:271-304），在 `riskRewardRatio` 之后加：

```ts
      roc10: r.roc10,
      roc20: r.roc20,
      roc60: r.roc60,
```

## 2.6 回填

ROC 随指标管线一起算，回填复用现有机制，无需新脚本：

### 2.6a A 股全量回填

复用 `recalculateIndicatorsForSymbols`（`a-shares-indicator.service.ts:40`）或现有回填脚本 `migration/a-share-indicators-backfill.ts`。calcIndicators 加了 ROC 后，重算即写入 roc10/20/60。

**全量回填命令**（所有 list_status='L' 的 A 股）：通过 migration 脚本或 service 方法触发，按 ts_code 逐个重算全历史。5536 标的，耗时参考现有指标回填（分钟级）。

### 2.6b 加密回填

加密 klines 的指标在每次 sync 时现算现写（`sync.service.ts:268`），无需独立回填——下次全量同步即补齐 roc10/20/60。若要立即补齐，重新触发各 symbol 的全量同步。

### 2.6c 数据不足的处理

- 新股/新币上市不足 N 天：`calcIndicators` 返 null，落库为 NULL。
- 消费方（筛选 SQL、表格 SELECT）遇 NULL：比较/排序走 `NULLS LAST`（A 股 `appendAShareSort` :251、crypto `symbols.service.ts:175` 均已用 `NULLS LAST`）。
