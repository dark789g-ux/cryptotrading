# 策略条件新增 AMV-MACD 字段 — 设计文档

- 日期：2026-06-03
- 主题：在策略条件构建器中新增「个股 AMV-MACD」与「个股所在行业 AMV-MACD」共 6 个可筛选字段
- 状态：已与用户确认设计，待实现

## 1. 背景与目标

策略条件扫描（`apps/server/src/strategy-conditions/`）允许用户用「指标 + 操作符 + 比较目标」组合筛选全量上市 A 股。
当前可选指标在前端 `StrategyConditionBuilder.vue` 的 `aShareFields` 中定义，后端经
`ASHARE_FIELD_COL_MAP` 翻译为 `表别名.列名` 拼进扫描 SQL。

本次目标：新增 6 个 A 股专用字段（AMV-MACD 的 DIF / DEA / 柱），分两类：

1. **个股** 自身的 AMV-MACD
2. **个股所在行业**（同花顺 type='I' 行业指数）的 AMV-MACD

> AMV 三张表仅含 A 股数据，因此这 6 个字段 **只加进 `aShareFields`，不加进 `cryptoFields`**。

## 2. 已落源头验证的事实

下列列名 / 表名均已亲自核对实体定义，不得改动：

| 实体 / 文件 | 表名 | 关键列（DB 列名） |
|---|---|---|
| `entities/active-mv/stock-amv-daily.entity.ts` | `stock_amv_daily` | `ts_code` / `trade_date`(varchar 8) / `amv_dif` / `amv_dea` / `amv_macd` |
| `entities/active-mv/industry-amv-daily.entity.ts` | `industry_amv_daily` | `ts_code`(行业指数 `.TI`) / `trade_date`(varchar 8) / `amv_dif` / `amv_dea` / `amv_macd` |
| `entities/money-flow/ths-member-stock.entity.ts` | `ths_member_stocks` | `con_code`(成分股) / `ts_code`(指数) |

- `amv_macd` 列注释明确为 MACD **柱** = 2×(DIF-DEA)，对应需求里的 "AMV-MACD-MACD"。
- `industry_amv_daily` 表**只存** type='I' 行业指数；概念（type='N'）在另一张 `concept_amv_daily`，本次不涉及。
- 个股 / 行业 AMV 的 DIF/DEA/柱 在同步时已算好落库（`stock-amv.service.ts` / `industry-amv.service.ts` 调 `calcMacd`），**查库即可，无需现算**。

## 3. 字段定义

均追加到 `aShareFields`，`supportsCross: false`（用户确认不需要上穿/下穿）。

| 前端 label | value(key) | 翻译目标列 | 类别 |
|---|---|---|---|
| AMV-MACD-DIF | `amv_dif` | `sa.amv_dif` | 个股（普通 JOIN） |
| AMV-MACD-DEA | `amv_dea` | `sa.amv_dea` | 个股 |
| AMV-MACD-MACD | `amv_macd` | `sa.amv_macd` | 个股 |
| 行业AMV-MACD-DIF | `ind_amv_dif` | `ia.amv_dif` | 行业（EXISTS） |
| 行业AMV-MACD-DEA | `ind_amv_dea` | `ia.amv_dea` | 行业 |
| 行业AMV-MACD-MACD | `ind_amv_macd` | `ia.amv_macd` | 行业 |

`sa` = `stock_amv_daily` 别名；`ia` = `industry_amv_daily` 别名。

## 4. 架构：两类字段两种复杂度

```text
个股 AMV (3 个)  ──► 普通列：加 FIELD_COL_MAP 条目 + 多一个 LEFT JOIN
                     完全套用现有 "col 操作符 值/字段" 模型

行业 AMV (3 个)  ──► EXISTS 子查询：一股对多行业，"任一行业达标即命中"
                     无法用普通 JOIN（会一股变多行），需 query-builder 新分支
```

### 4.1 个股 AMV — 普通 JOIN

只需：
1. `ASHARE_FIELD_COL_MAP` 增 3 条：`amv_dif → 'sa.amv_dif'`、`amv_dea → 'sa.amv_dea'`、`amv_macd → 'sa.amv_macd'`。
2. runner 的 A 股扫描 SQL 增一行 LEFT JOIN（见 §5）。

之后现有逻辑天然支持：与常量值比较、与任意字段比较（含 `AMV-DIF > AMV-DEA`）。
cross 分支因 `sa.*` 不以 `i.` 开头会被自动 warn+skip，符合预期。

### 4.2 行业 AMV — EXISTS 子查询

「任一所属行业达标即命中」的语义用 `EXISTS` 表达。以 `行业AMV-DIF 大于 0` 为例：

```text
EXISTS (
  SELECT 1
  FROM ths_member_stocks mem
  JOIN industry_amv_daily ia
       ON ia.ts_code   = mem.ts_code
      AND ia.trade_date = i.trade_date      -- 对齐基准日
  WHERE mem.con_code = i.ts_code            -- 当前个股
    AND ia.amv_dif > $n                      -- 任一行业满足即真
)
```

- 不需再 JOIN `ths_index_catalog` 过滤 type='I'：`industry_amv_daily` 本就只含行业指数，概念指数 JOIN 不上自然排除。
- `i.ts_code` / `i.trade_date` 来自外层 `daily_indicator` 别名（已与 `s` 同 ts_code、同基准日）。

## 5. 扫描 SQL 整体形态（A 股，runner）

```text
SELECT s.ts_code as "tsCode", s.name
FROM a_share_symbols s
JOIN raw.daily_indicator i
  ON i.ts_code = s.ts_code
 AND i.trade_date = (SELECT MAX(trade_date) FROM raw.daily_indicator)   -- 基准日
LEFT JOIN raw.daily_quote q  ON q.ts_code=s.ts_code AND q.trade_date=i.trade_date
LEFT JOIN raw.daily_basic m  ON m.ts_code=s.ts_code AND m.trade_date=i.trade_date
LEFT JOIN stock_amv_daily sa ON sa.ts_code=s.ts_code AND sa.trade_date=i.trade_date  -- ★新增
WHERE s.list_status = 'L'
  AND <where.sql>     -- 个股 AMV → sa.* 列比较；行业 AMV → EXISTS 子查询
ORDER BY s.ts_code
LIMIT $.. OFFSET $..
```

`stock_amv_daily` 按 `(ts_code, trade_date)` 唯一索引，LEFT JOIN 始终添加（即使未用 AMV 字段），代价可忽略。
crypto 分支不变。

## 6. query-builder 改动契约

`build()` 新增可选 `industryCfg`，仅 A 股传入：

```text
industryCfg = {
  fieldMap:   { ind_amv_dif:'ia.amv_dif', ind_amv_dea:'ia.amv_dea', ind_amv_macd:'ia.amv_macd' },
  memberTable:'ths_member_stocks', memberAlias:'mem',
  memberConKey:'con_code', memberIndexKey:'ts_code',
  amvTable:'industry_amv_daily', amvAlias:'ia',
  amvIndexKey:'ts_code', amvDateKey:'trade_date',
  outerCodeRef:'i.ts_code', outerDateRef:'i.trade_date',
}
```

循环内、在现有 `fieldMap[field]` 查找**之前**先判断行业字段：

```text
若 field ∈ industryCfg.fieldMap：
  · operator 是 cross_*            → warn + skip（不支持上穿；warn 文案可复用现有通用提示）
  · compareField 也是行业字段       → EXISTS(... ia.<col> <op> ia.<col2> ...)
  · compareField 是非行业字段       → warn + skip（不支持跨表混比）
  · 无 compareField（比常量值）     → 校验 value 有限数字，EXISTS(... ia.<col> <op> $n ...)
  生成完整 EXISTS 片段后 continue
否则走现有逻辑（个股 AMV 走普通列分支）
```

参数绑定复用现有 `params` / `ph()` 机制；未知操作符沿用现有 warn+skip。
crypto 不传 `industryCfg`，行业字段对 crypto 即「未知字段」→ warn+skip（AMV 本就只 A 股）。

## 7. 前端改动

`apps/web/src/components/strategy-conditions/StrategyConditionBuilder.vue`
`aShareFields` 数组末尾追加 6 条（接在估值字段之后）：

```text
{ label:'AMV-MACD-DIF',  value:'amv_dif',  supportsCross:false },
{ label:'AMV-MACD-DEA',  value:'amv_dea',  supportsCross:false },
{ label:'AMV-MACD-MACD', value:'amv_macd', supportsCross:false },
{ label:'行业AMV-MACD-DIF',  value:'ind_amv_dif',  supportsCross:false },
{ label:'行业AMV-MACD-DEA',  value:'ind_amv_dea',  supportsCross:false },
{ label:'行业AMV-MACD-MACD', value:'ind_amv_macd', supportsCross:false },
```

`supportsCross` 缺省即 falsy，但显式写出更清楚；`getOperatorOptions` 会自动禁用上穿/下穿选项。

## 8. 已确认的两个权衡

1. **日期对齐**：AMV 数据对齐到基准日 `i.trade_date`（= `daily_indicator` 全表最新日）。
   若当天 AMV 尚未同步 → 该 AMV 条件查不到数据 → **静默不命中**（不报错）。用户已接受此默认（同日对齐口径最严谨）。
2. **行业字段比较约束**：行业 AMV 字段只能与 **常量值** 或 **另一个行业 AMV 字段** 比较；
   与个股字段混比由后端 warn+skip。前端下拉仍会列出全部字段（不额外做 disabled），约束靠后端兜底。

## 9. 边界 / 注意事项

- `matchedConditions` 命中描述沿用现有逻辑，展示原始 key（如 `amv_dif` / `ind_amv_dif gt 0`），不额外美化（YAGNI）。
- 一只股票挂多个行业指数时，EXISTS 命中即可，天然满足「任一行业达标」。
- AMV 列允许 NULL（停牌/缺数），NULL 参与比较结果为 false → 不命中，符合预期。
- 无 schema 变更、无 migration、无新实体注册（三张表实体已存在并注册）。

## 10. 验证清单

- 后端单测：`pnpm --filter @cryptotrading/server exec jest strategy-conditions`
  - 个股 AMV：value 比较、字段对字段比较生成的 SQL 正确；显式加一例 `amv_dif > amv_dea`（同表非 `i.` 前缀的字段对字段）应生成 `sa.amv_dif > sa.amv_dea`。
  - 行业 AMV：value 比较、行业对行业比较生成 EXISTS；cross / 混比走 warn+skip。
- 后端改动后 **必须重启 `nest start`**（无 watch）再端到端验证。
- 前端：`pnpm --filter @cryptotrading/web type-check` + **`build`(vite)**，并真机打开策略条件页确认 6 个新字段可选、可保存、可运行命中。
- 真机：建一个含个股 + 行业 AMV 条件的条件组，运行后核对命中数与 DB 直查一致（抽样 `docker exec ... psql`）。

## 11. 任务切分（供并行实现，文件域互不重叠）

- **任务 A（后端映射 + EXISTS）**：`strategy-conditions.types.ts` + `strategy-conditions.query-builder.ts`
- **任务 B（后端 SQL JOIN）**：`strategy-conditions.runner.ts`（加 `LEFT JOIN stock_amv_daily sa`）
- **任务 C（前端字段）**：`StrategyConditionBuilder.vue`（`aShareFields` 追加 6 条）

> 任务 A 与 B 同属后端但文件不同；A 定义 `industryCfg` 并在 `buildAShareQuery` 传入，B 只动 runner SQL。
> 建议 A、B 由同一 agent 顺序完成（契约耦合在 `buildAShareQuery` 调用处），C 独立并行。
