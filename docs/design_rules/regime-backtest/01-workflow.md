📍 [手册首页](./README.md) | 第 1 章 接口与工作流 | [第 2 章 字段白名单](./02-field-whitelist.md) | [第 3 章 引擎内部机制](./03-engine-internals.md)

# 第 1 章 接口与工作流

> Regime 回测手册 · 接口层

`POST /api/backtest/ashare` 接口的 Agent 工作流规范。本模块的定位是 **Agent 基于用户需求生成本文所述 config → 运行回测 → 总结结果**。

---

## 1. 模块定位与 Agent 职责

**规则**:本接口是 **A 股日线**唯一可用的回测通路。Agent 收到「A 股回测」类需求时,走本接口;不要走 `POST /api/backtest/start`(那是主回测引擎,读 `klines` 表,只有加密币数据,跑不了 A 股)。

**数据通路**:本接口读 `raw.daily_quote` + `raw.daily_indicator` + `raw.daily_basic` + `stock_amv_daily` + `signal_rolling_indicator` + `raw.stk_limit` + `raw.trade_cal` 等 A 股专用表,**不读 `klines`**。

**config 来源 — 红线**:

> config **必须从用户的策略需求生成**,不从数据库历史 config 转换、复制或"还原"。

**反例 / 教训**:库里 `regime_strategy_config` 表存有历史 config(如 M2-M4 研究产出),但它们:
1. 可能是**旧 schema 格式**(顶层 `Q1/Q2/Q3/Q4`),已被当前 `validateRegimeConfig` 拒绝(当前要求 `{quadrants:[...]}`);
2. 与当前用户的策略需求**无关**——它们是别人过去的研究意图。

Agent 看到「A 股回测」需求时,**禁止**去做「找一条历史 config 来用」或「把旧 config 转成新格式」——这是把数据残骸当需求来源,本末倒置。正确做法是:理解用户的策略意图,按本文 §5-§6 的字段规则**新构造** config。

---

## 2. 完整工作流

```
用户需求(自然语言策略描述)
    │
    ▼
Agent 构造 config(按 §5 字段规则 + §6 白名单 + 策略语义自行组合)
    │
    ▼
① POST /api/backtest/ashare          ← 创建 run,返回 runId
② POST /api/backtest/ashare/:id/run  ← 触发异步执行
③ GET  /api/backtest/ashare/:id/progress ← 轮询(15s 间隔)直至 status=completed|failed
④ GET  /api/backtest/ashare/:id      ← 取汇总指标
   GET  /api/backtest/ashare/:id/daily ← 取净值曲线
   (DB 直查 regime_backtest_trade WHERE status='taken') ← 取成交明细
    │
    ▼
Agent 总结结果(收益率/回撤/Sharpe/典型成交),回呈用户
```

**鉴权**:写操作(POST/PATCH/DELETE)需 **Admin 角色**;读操作(GET)无需 Admin 但仍需登录态(全局 AuthGuard)。Agent 用 API Key 走 `Authorization: Bearer ct_live_xxx`,详见 [api-key-auth-design.md](../api-key-auth-design.md)。API Key 绑定用户的 role 必须是 admin 才能触发回测。

**curl 示例**:

```bash
# ① 创建回测(Admin)
curl -X POST http://localhost:3000/api/backtest/ashare \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "<回测名>",
    "config": { "quadrants": [ ... ] },
    "capital": {
      "initialCapital": 1000000,
      "cost": { "commissionPerSide": 0.00025, "transferPerSide": 0.00001,
                "stampSellBefore20230828": 0.001, "stampSellFrom20230828": 0.0005,
                "slippagePerSide": 0.0005 }
    },
    "dateStart": "20250101",
    "dateEnd": "20260716"
  }'
# 响应 201: { "id": "<runId>", "status": "pending", ... }

# ② 触发执行(Admin)
curl -X POST http://localhost:3000/api/backtest/ashare/<runId>/run \
  -H "Authorization: Bearer <your-api-key>"
# 响应 201: { "runId": "<runId>" }

# ③ 轮询进度(15s 间隔)
curl -H "Authorization: Bearer <your-api-key>" \
  http://localhost:3000/api/backtest/ashare/<runId>/progress
# 响应: { "status": "running|completed|failed", "phase": "loading|writing", "progressDone": N, "progressTotal": M, "errorMessage": null }

# ④ 取汇总指标 + 净值曲线
curl -H "Authorization: Bearer <your-api-key>" \
  http://localhost:3000/api/backtest/ashare/<runId>
# 响应含: finalNav, totalRet, annualRet, maxDrawdown, sharpe, calmar, nTaken, nSkipped, totalCosts
```

**关键坑**:

1. **日期格式是 `YYYYMMDD`(如 `20250101`),不是 `YYYY-MM-DD`**——与主回测引擎不同。校验正则 `/^\d{8}$/`,传错直接 400。
2. **`dateStart` 必须 < `dateEnd`**(字符串比较)。
3. **并发与重跑约束**:`running` 状态的 run 不能再触发(409 Conflict);`completed` 的 run 不能重跑(400,只能新建或 PATCH 一个 `pending`/`failed` 的)。
4. **执行耗时**:全市场 run(~5000 只)约 5-15 分钟,loading 阶段(信号枚举)占大头。轮询间隔建议 15s,设足够长的 timeout。

---

## 3. HTTP 接口全表

**路由前缀**:`/api/backtest/ashare`(Controller: `regime-backtest-ashare.controller.ts`)

| 方法 | 路径 | Admin | 参数 | 语义 |
|---|---|---|---|---|
| POST | `/` | ✅ | Body: CreateRegimeBacktestDto | 创建回测任务 |
| GET | `/` | ❌ | `page`(默认1), `pageSize`(默认20), `status`, `keyword` | 分页列表 |
| POST | `/:id/run` | ✅ | Param: id | 触发异步执行 |
| GET | `/:id/progress` | ❌ | Param: id | 轮询进度 |
| GET | `/:id` | ❌ | Param: id | 详情(含汇总指标) |
| GET | `/:id/daily` | ❌ | Param: id | 每日净值曲线 |
| GET | `/:id/trades` | ❌ | Param: id | ⚠️ **缺陷,见下,勿用** |
| GET | `/:id/daily-log` | ❌ | Param: id | 每日审计日志 |
| GET | `/:id/positions` | ❌ | `page`, `pageSize`(默认50), `sortBy`, `sortOrder`, `tsCode` | 持仓明细(分页) |
| GET | `/:id/symbol-stats` | ❌ | `page`, `pageSize`, `sortBy`, `sortOrder`, `tsCode` | 标的统计(分页) |
| GET | `/:id/kline-chart` | ❌ | `tsCode`, `signalDate`, `before`(默认100), `after`(默认30) | K线图+交易标注 |
| PATCH | `/:id` | ✅ | Body: UpdateRegimeBacktestDto | 更新(仅 pending/failed) |
| DELETE | `/:id` | ✅ | Param: id | 删除 |

> 旧别名路由 `POST /api/regime-engine/backtests`(Legacy alias)功能等同,新代码建议用主路由。

**⚠️ 已知缺陷 — `GET /:id/trades`**:

`listTrades`(`regime-backtest.service.ts:264`)**无分页、无 status 过滤**,直接 `getMany()` 全量返回。全市场 run 会产生**百万级 trade 行**(每只票每个不命中信号都记一条 skipped),全量加载导致 500 Internal Server Error。

**Agent 取成交明细必须用 DB 直查**(带 `status='taken'` 过滤):

```bash
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "
  SELECT ts_code, signal_date, buy_date, exit_date, regime, exit_mode,
         status, ROUND(realized_ret_net::numeric, 4) AS ret_net,
         ROUND(costs_paid::numeric, 2) AS costs, rank
  FROM regime_backtest_trade
  WHERE run_id='<runId>' AND status='taken'
  ORDER BY signal_date;"
```

### 3.1 字段类型契约（numeric → number）

本接口（`GET /api/backtest/ashare/:id` 等 regime-backtest 系列接口）返回的所有 numeric 类型字段（`finalNav`, `totalRet`, `annualRet`, `maxDrawdown`, `sharpe`, `calmar`, `dailyWinRate`, `dailyKelly`, `totalCosts`, `nav`, `cash`, `dailyRet`, `exposure`, `ret`, `alloc`, `costsPaid`, `realizedRetNet`, `rankValue` 等）在 HTTP 响应中均为 **JSON number**，而非字符串。

**实现机制**：regime-backtest 的 4 张表（`regime_backtest_run` / `regime_backtest_daily` / `regime_backtest_trade` / `regime_backtest_daily_log`）的 entity 上挂了 `NumericTransformer`，把 PostgreSQL numeric 列经 node-postgres 默认返回的 string 转回 number。

**历史背景**：PostgreSQL numeric 列默认经 node-postgres 返回 string（防精度丢失）。本仓库历史代码用 `String()/Number()` 在 runner/service 层手动转换，现已通过 transformer 统一在 entity 层处理。

**注意区分**：其他模块（A 股行情、money-flow、crypto K 线等）的 numeric 字段**仍可能返回 string**，前端消费方需自行用 `Number()` 或 `@/utils/format` 的 `toNum/fmtPct/fmtNum` 兜底。

---

## 4. body 契约(CreateRegimeBacktestDto)

**文件**:`backtest/dto/create-regime-backtest.dto.ts`

| 字段 | 必填 | 类型 | 语义 |
|---|---|---|---|
| `name` | ✅ | string(≤200) | 回测名 |
| `note` | ❌ | string | 备注 |
| `config` | ✅ | RegimeConfigMap | 策略规则(见 §5) |
| `regimeConfigId` | ❌ | string | 仅溯源,不用于加载规则 |
| `capital` | ✅ | object | 资金与成本(见下) |
| `dateStart` | ✅ | YYYYMMDD | 起始日 |
| `dateEnd` | ✅ | YYYYMMDD | 结束日 |

### capital 结构

| 字段 | 必填 | 语义 |
|---|---|---|
| `initialCapital` | ✅ | 初始资金,>0 |
| `cost` | ✅ | 费率对象(见下,5 键) |
| `sizing` | ❌ | 仓位模式:`{mode: 'fixed'\|'signal_weighted'\|'source_kelly'}` |
| `kelly` | ❌ | Kelly 配置,启用要求 `sizing.mode='source_kelly'` |
| `circuitBreaker` | ❌ | 熔断配置(仅校验 `enableCooldown`/`enableDrawdownHalt` 两布尔键) |
| `anchorMode` | ❌ | 锚定模式 |
| `requireAllPositionsProfitable` | ❌ | 仅全部持仓盈利才开新仓 |
| `positionRatio` | — | **@deprecated**,传了被忽略并 warn |
| `maxPositions` | — | **@deprecated**,传了被忽略并 warn |

### capital.cost 五键(PortfolioSimCostRates)

| 键 | 现实值 | 语义 |
|---|---|---|
| `commissionPerSide` | `0.00025` | 佣金单边(万2.5) |
| `transferPerSide` | `0.00001` | 过户费单边 |
| `stampSellBefore20230828` | `0.001` | 印花税(2023-08-28 前) |
| `stampSellFrom20230828` | `0.0005` | 印花税(2023-08-28 后减半) |
| `slippagePerSide` | `0` / `0.0005` / `0.001` | 滑点(乐观/现实/保守三档) |

**反例**:不要用 `buy`/`sell` 这类旧键名——校验只检查 `cost` 是 object,但引擎按上述 5 键消费,传错键名会得到全 0 费率(回测失真)。

### kelly 启用条件

`kelly.enabled=true` 时,**必须**同时设 `sizing.mode='source_kelly'`,否则 400。其余 kelly 子字段:`simTrades`(0-500)、`windowTrades`(1-500)、`stepTrades`(1-500)、`kellyFraction`((0,1])、`kellyMaxMult`(>0)、`enableProbe`(boolean)。

---

## 5. config 字段全表(Agent 构造 config 的核心依据)

**文件**:`entities/strategy/regime-strategy-config.entity.ts` + `regime-engine.validation.ts`

### 5.1 顶层(RegimeConfigMap)

| 键 | 必填 | 语义 |
|---|---|---|
| `quadrants` | ✅ | 有序象限数组(顺序=匹配优先级,非空) |
| `marketIndex` | ❌ | **@deprecated**,旧版顶层大盘指数,已下放到各 quadrant 的 match.target |
| `universe` | ❌ | 标的池,缺省=全市场 |

`universe` 三种 mode:
- `{mode:'all'}` 或缺省 → 全市场
- `{mode:'symbols', symbols:['000001.SZ', ...]}` → 显式标的
- `{mode:'watchlist', watchlistId:'<id>'}` → 自选股

**顶层只允许这 3 个键**,出现其他键报「config 含未知键(仅允许 quadrants|marketIndex|universe)」。

### 5.2 QuadrantEntry 字段

| 字段 | trade | flat | 类型 / 约束 |
|---|---|---|---|
| `key` | ✅ | ✅ | string,正则 `^[a-zA-Z0-9_-]+$`,配置内唯一 |
| `label` | ✅ | ✅ | string,非空 |
| `match` | ✅(多象限必填) | ✅(同) | RegimeBucketCondition[],单象限可空(通配) |
| `action` | ✅ | ✅ | `'trade'` 或 `'flat'` |
| `entryConditions` | ✅非空 | **必须 null** | StrategyConditionItem[],field 在白名单(§6) |
| `exitMode` | ✅ | **必须 null** | `'fixed_n'\|'strategy'\|'trailing_lock'` |
| `exitParams` | ✅ | **必须 null** | object,结构随 exitMode(见 5.3) |
| `positionRatio` | ✅ (0,1] | 可选 | 仓位比例 |
| `maxPositions` | ✅ 正整数 | 可选 | 最大持仓数 |
| `rankField` | ✅ | 不校验 | 白名单(§6),含 `'none'` |
| `rankDir` | ✅(rankField≠none) | 不校验 | `'asc'\|'desc'` |
| `requireAllPositionsProfitable` | ❌ | ❌ | boolean,缺省 false |
| `matchLogic` | ❌ | ❌ | `'and'`(默认)或 `'or'`;控制 `match` 数组内顶层叶子条件的逻辑连接(嵌套 MatchGroup 内部由自身的 `logic` 控制,不受此字段影响) |
| `evidence` | ❌ | ❌ | 研究证据,任意 object |

**关键约束**:
- **`positionRatio * maxPositions ≤ 1`**(trade 象限),否则报「不能大于 1」。
- **单象限通配**:当 `quadrants.length === 1` 时,该象限 `match:[]`(空数组)合法,语义为「任何市场环境都命中此象限」。
- **多象限时每个 match 必须非空**,否则报「必须为非空数组」。

### 5.3 exitMode 三模式的 exitParams

| exitMode | exitParams 必填字段 |
|---|---|
| `fixed_n` | `N`: >0 的数字(固定持有 N 个交易日) |
| `strategy` | `exitConditions`: 非空数组(条件格式同 entryConditions);`maxHold`: >0 的数字(最大持有日)。**注意:exitConditions 当前不支持 compareMode='field' 的现算字段条件**(ExitSignalLoader 不注入 siblingResults,见源码 exit-signal.loader.ts Phase 2 注释)。 |
| `trailing_lock` | 全可选:`maxHold`(>0或null)、`stopRatio`((0,1])、`floorRatio`((0,1])、`floorEnabled`(boolean)、`ma5RequireDown`(boolean) |

### 5.4 match 条件(RegimeBucketCondition)结构

| 字段 | 必填 | 语义 |
|---|---|---|
| `type` | ✅ | `'index'`(大盘指数级)或 `'stock'`(个股级) |
| `target` | ✅ | 非空字符串(index 时为指数代码如 `000001.SH`;stock 时为个股 ts_code) |
| `field` | ✅ | 字段名,index 走 `INDEX_FIELD_WHITELIST`,stock 走 `REGIME_BUCKET_STOCK_FIELD_WHITELIST`(§6) |
| `operator` | ✅ | `gt\|gte\|lt\|lte\|eq\|neq\|cross_above\|cross_below` |
| `value` | compareMode=value 时 ✅ | 数字常量 |
| `compareField` | compareMode=field 时 ✅ | 同白名单的另一字段名 |
| `compareMode` | ❌ | `'value'`(默认)或 `'field'` |
| `matchLogic` | ❌ | `'and'`(默认,全部满足)或 `'or'`(任一满足即命中本象限);放在 QuadrantEntry 上,非 RegimeBucketCondition 内 |

`compareMode=value`:把 `field` 的值与数字常量 `value` 比较。
`compareMode=field`:把 `field` 的值与同 target 的另一字段 `compareField` 的值比较(如 `close` vs `ma60`)。

#### 5.4.1 嵌套 AND/OR（MatchGroup）

`match` 数组的每个元素既可以是叶子条件(`RegimeBucketCondition`),也可以是分组(`MatchGroup`),支持嵌套 AND/OR 逻辑。

**MatchGroup 结构**:

| 字段 | 必填 | 语义 |
|---|---|---|
| `logic` | ✅ | `'and'` 或 `'or'` |
| `items` | ✅ | 非空数组,每项为 `RegimeBucketCondition` 或嵌套 `MatchGroup` |

**向后兼容**:扁平条件数组(无 MatchGroup)仍完全有效,`matchLogic` 控制顶层叶子之间的连接。

**嵌套深度限制**:最多 5 层(校验层 `validateMatchGroup` 递归强制,超出报错;建议不超过 3-4 层)。

**matchLogic 与 MatchGroup 共存规则**:顶层 `match` 数组内可混合叶子条件和 MatchGroup。此时 `matchLogic` 控制这些**顶层元素**之间的连接逻辑,与 MatchGroup 内部的 `logic` 独立。建议要么全叶子+`matchLogic`,要么单一顶层 MatchGroup 包裹全部逻辑,避免混合时语义混乱。

**关键实现细节**:`MarketSnapshotLoader.extractTargets` 使用 `collectMatchTargets()` **递归遍历**整个 match 树(包括 MatchGroup 内部的叶子条件),确保所有 target 的快照数据都被加载。如果遗漏某个 target 的加载,求值时会找不到数据,fail-closed 导致条件误判为 false。

**示例:震荡象限 `(MACD<0 ∧ DIF>0) ∨ (MACD>0 ∧ DIF<0)`**:

```json
"match": [
  {
    "logic": "or",
    "items": [
      {
        "logic": "and",
        "items": [
          { "type": "index", "target": "000985.CSI", "field": "macd", "operator": "lt", "value": 0 },
          { "type": "index", "target": "000985.CSI", "field": "dif", "operator": "gt", "value": 0 }
        ]
      },
      {
        "logic": "and",
        "items": [
          { "type": "index", "target": "000985.CSI", "field": "macd", "operator": "gt", "value": 0 },
          { "type": "index", "target": "000985.CSI", "field": "dif", "operator": "lt", "value": 0 }
        ]
      }
    ]
  }
]
```

### 5.5 最简可用 config 骨架(Agent 起点)

单象限 wildcard,任何市场环境都交易。来自测试 fixture,已验证可通过校验:

```json
{
  "quadrants": [
    {
      "key": "solo",
      "label": "唯一象限",
      "action": "trade",
      "match": [],
      "entryConditions": [ { "field": "brick", "operator": "gt", "value": 0 } ],
      "exitMode": "fixed_n",
      "exitParams": { "N": 5 },
      "positionRatio": 0.5,
      "maxPositions": 2,
      "rankField": "turnover_rate",
      "rankDir": "desc"
    }
  ]
}
```

Agent 应在此骨架基础上,根据用户策略需求替换 `entryConditions`/`exitMode`/`match` 等字段。字段值的选择依据见 [第 2 章 字段白名单](./02-field-whitelist.md)。

---

## 6. 字段白名单(略,见独立文档)

完整的字段白名单(entryConditions / rankField / match index / match stock / operator / 大盘指数代码)因篇幅较大,独立成文:

👉 **[第 2 章 字段白名单](./02-field-whitelist.md)**

Agent 构造 entryConditions / exitConditions / match 条件前,务必先查该文档确认字段可用。

### 6.1 现算字段(derived field)

除预算字段外,`entryConditions` / `exitConditions` 还支持**现算字段**:

- **MA 任意周期**: `ma10` / `ma15` / `ma20` 等(正则 `ma{N}`,其中 `ma5/30/60/120/240` 走预算列,其余走内存现算)
- **KDJ 自定义参数**: `kdj_j` / `kdj_k` / `kdj_d` 带 `kdjParams: {n, m1, m2}` 时走现算(不带则走预算列 9/3/3)

这些字段通过校验层 `isDerivedField()` 旁路判定,无需手动加白名单。`rankField` 也支持现算字段(如 `ma20` 做排序因子)。

**两阶段求值**:含现算字段时,引擎先执行 Phase 1 SQL 查询(用预算字段筛选候选集),再执行 Phase 2 内存重算(逐候选计算现算字段值并过滤)。两阶段取交集,最终得到满足全部条件的信号列表。

**性能提示**:全市场回测(~5000 只)时,每个交易日 × 每个现算字段都需一次 DB 查询读取 warmup 序列(如 250 根 qfq_close),累计开销显著。建议 config 中至少配置一个 SQL 预算字段条件做 Phase 1 粗筛,缩小 Phase 2 候选集范围。

设计详见 [第 3 章 引擎内部机制](./03-engine-internals.md)。

---

## 7. Agent 检查清单(调用前逐条过)

- [ ] config 是否**从用户需求生成**(非从 `regime_strategy_config` 表历史数据复制/转换)
- [ ] `dateStart`/`dateEnd` 是否 `YYYYMMDD` 格式(8 位纯数字)且 `start < end`
- [ ] 日期范围内 A 股数据是否存在(查 `raw.daily_quote` 的 `MIN/MAX(trade_date)`)
- [ ] 每个 trade 象限是否填齐:`positionRatio` / `maxPositions` / `rankField` / `rankDir` / `entryConditions` / `exitMode` / `exitParams`
- [ ] `positionRatio * maxPositions ≤ 1`
- [ ] 每个 flat 象限的 `entryConditions`/`exitMode`/`exitParams` 是否为 `null`
- [ ] `entryConditions` / `exitConditions` 的每个 `field` 是否在白名单
- [ ] `rankField` 是否在白名单(含 `'none'`)
- [ ] 多象限时每个 `match` 是否非空;单象限 `match` 可空
- [ ] `capital.cost` 是否用 5 键(`commissionPerSide` 等),非 `buy`/`sell` 旧键
- [ ] 若用 `kelly.enabled=true`,是否同时设 `sizing.mode='source_kelly'`
- [ ] 查成交明细是否用 **DB 直查**(`WHERE status='taken'`),**避坑** `GET /:id/trades` 接口
- [ ] 若 `match` 含 MatchGroup 嵌套,嵌套深度是否 ≤ 5
- [ ] 若 `entryConditions` 含现算字段(`ma{N}` 非 5/30/60/120/240 周期,或 `kdj_*` 带 `kdjParams`),是否了解全市场回测时的性能影响(见 §6.1 性能提示)
- [ ] 大盘指数 `ts_code` 后缀是否正确(`.SH` 上交所 / `.CSI` 中证公司 / `.SZ` 深交所,见白名单文档 §3.3)
- [ ] 若 Agent 自行解析本接口返回值做数值计算（而非直接转交前端展示），确认字段为 number 类型（regime-backtest 系列已统一为 number，其他模块仍可能为 string）

---

## 8. 接口能力边界与扩展原则

**规则**:当 Agent 发现用户需求**无法用当前 config 字段表达**时,不要硬塞进现有字段、不要用近似字段凑、更不要悄悄改用户需求去迁就接口。按「识别 → 评估 → 扩展」三步处理。

### ① 识别

Agent 应主动识别"接口无法满足"的信号,典型如:
- 用户要**止损止盈**(当前只有 fixed_n/strategy/trailing_lock 三种出场,无显式止损价);
- 用户要**分钟级/周线级**回测(当前只支持日线);
- 用户要**按行业/板块分桶**(当前 match 只支持 index/stock 两级,无行业聚合);
- 用户要**按象限独立 kelly**(当前 kelly 是 capital 全局配置,非按象限);
- 用户要的某个**技术指标**不在 §6 白名单;
- 用户要嵌套 AND/OR 组合条件(如 `(A∧B)∨(C∧D)`):**已支持**(MatchGroup 嵌套结构,见 §5.4.1);若用户需求可通过单层 `matchLogic` 表达,则不必使用 MatchGroup。

### ② 评估

判断缺失属于哪一层,决定扩展成本:

| 层级 | 表现 | 扩展成本 |
|---|---|---|
| **(a) 数据层** | 某字段/计算在 DB 里根本不存在(如要 VIX,A 股没这数据) | 高(需先补数据源) |
| **(b) config 层** | 字段在 DB 里有,但 `validateRegimeConfig` 白名单没放开 | 低(放开白名单即可,改 `regime-engine.validation.ts` + 对应 `*_COL_MAP`) |
| **(c) 引擎层** | 字段和白名单都不支持,需要新的回测逻辑 | 中-高(改 engine/loader,可能加新 exitMode/sizing 模式) |

### ③ 扩展路径

**停下,向用户说明**:
1. 当前接口**无法满足**的具体能力 X;
2. 原因(属于 a/b/c 哪层,缺什么);
3. 建议的扩展方案(改哪个文件、加什么字段/逻辑、预估工作量);
4. 征得用户同意后,走 Plan Mode 派子 Agent 实现。

**禁止**:
- 用语义不匹配的字段硬凑(如把"换手率"当"波动率"用);
- 不告知用户就改需求(如用户要止损,Agent 偷偷改成"持有 5 天"跑出来);
- 绕过校验(如直接写库不走 `validateRegimeConfig`)。

### 现成案例:`GET /:id/trades` 500

`listTrades` 无分页导致全市场 run 必 500。这是**引擎层缺陷**(代码:`regime-backtest.service.ts:264` 的 `getMany()` 全量返回)。
- **临时绕过**:Agent 用 DB 直查带 `status='taken'`(见 §3);
- **根本修复**:给 `listTrades` 加分页 + 默认 `status` 过滤(改 controller + service)。
- Agent 发现此问题时,应按本节流程向用户报告,而非假装 trades 接口正常。

---

## 9. 文档维护约定

- 字段白名单是**易腐坏点**:每当 `strategy-conditions.types.ts` 的 `*_COL_MAP` 或 `rank-select.ts` 的 `RANK_FIELDS` 变更,必须同步更新 [第 2 章 字段白名单](./02-field-whitelist.md)。
- 校验规则变更(`regime-engine.validation.ts`)时,同步更新本文 §5。
- 新增 exitMode / sizing 模式时,更新 §5.3 和 §4。
