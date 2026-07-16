# 回测接口 params 覆盖设计规范

`POST /api/backtest/start/:strategyId` 接口扩展：支持 `overrides?: Partial<BacktestConfig>` 临时覆盖回测参数，无需先改策略。三层合并优先级：`DEFAULT_CONFIG < strategy.params < body.overrides`。

---

## 1. 设计目标与定位

**规则**：`POST /api/backtest/start/:strategyId` 新增可选 `overrides` 字段，允许 Agent 在回测时临时覆盖参数，**不持久化到策略本身**。覆盖结果落库到 `backtest_runs.config_snapshot`（JSONB），仅影响本次 run。

**解决的问题**：Agent 调回测时无法动态改参，只能先 `PUT /strategies/:id` 改 params 再触发，工作流冗长且污染策略配置。典型场景——参数扫描（遍历 `stopLossFactor` 从 0.8 到 1.5）、A/B 对比（同策略不同 `entrySortMode`）、临时试参（调 `maxPositions` 看容量上限）——都只是「跑一次看结果」，不应修改策略。

**边界**：`overrides` 是**不持久化的临时覆盖**，与 `PUT /strategies/:id` 的持久化修改有明确分工：

| 操作 | 持久性 | 影响范围 | 入口 |
|---|---|---|---|
| `PUT /strategies/:id`（改 params） | 永久，策略配置变更 | 后续所有 run | 前端 UI |
| `body.overrides`（临时覆盖） | 单次 run，不修改策略 | 仅本次 run | Agent / 脚本 |

**反例 / 教训**：若 Agent 用 `PUT /strategies/:id` 改参跑参数扫描，每轮改写都会覆盖上一轮的 params，无法并行、无法回溯。参数扫描 10 组配置 → 策略 params 被覆写 10 次，最终策略残留最后一组参数，可能不是最优值。`overrides` 把「试参」与「持久化」解耦，Agent 随意折腾不影响策略。

---

## 2. body 契约

**规则**：请求 body 定义如下，`symbols` 仍放顶层保持向后兼容，`overrides` 是新增可选字段。

```typescript
{
  symbols?: string[];              // 交易对列表，空数组 = 用策略默认 symbols
  overrides?: Partial<BacktestConfig>;  // 新增：临时覆盖回测参数
}
```

`BacktestConfig` 字段全集定义在 `apps/server/src/backtest/engine/models.ts` 的 `BacktestConfig` interface（约 70 个字段，含入场信号、止损策略、出场管理、风控参数、凯利公式等）。

**curl 示例**：

```bash
# Agent 触发回测，临时覆盖 maxPositions 和 stopLossFactor
curl -X POST http://localhost:3000/api/backtest/start/<strategy-id> \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "symbols": [],
    "overrides": {
      "maxPositions": 5,
      "stopLossFactor": 1.5,
      "enableBreakevenStop": true
    }
  }'
```

> 鉴权方式见 [api-key-auth-design.md](./api-key-auth-design.md)，Agent 需携带 `Authorization: Bearer ct_live_xxx` header。

---

## 3. 三层合并优先级规则

**规则**：回测 config 通过三层浅合并生成，优先级从低到高：

```
DEFAULT_CONFIG  <  strategy.params  <  body.overrides
```

合并逻辑在 `apps/server/src/backtest/backtest-execution.pipeline.ts:41`：

```typescript
const params = (strategy.params ?? {}) as Partial<BacktestConfig>;
const config: BacktestConfig = { ...DEFAULT_CONFIG, ...params, ...overrides };
validateConfig(config);
```

JavaScript spread 是**浅合并**（shallow merge），同名标量字段直接覆盖，同名数组 / 嵌套对象是**整体替换**，不是深合并。

**反例 / 教训**：浅合并对数组字段是整体替换。假设策略 params 里配置了 `maConditions: [{ left: 'close', op: '>', right: 'ma60' }, { left: 'ma5', op: '>', right: 'ma30' }]`（2 个条件），Agent 想只改第一项，传：

```json
{
  "overrides": {
    "maConditions": [{ "left": "close", "op": ">=", "right": "ma60" }]
  }
}
```

合并后 `maConditions` 只剩 1 项（Agent 传的），原第 2 项被整体替换丢失。**教训**：Agent 改数组字段必须传**完整数组**，不能只传想改的那一项。

**适用此规则的数组字段清单**（必须传完整数组）：

| 字段 | 类型 | DEFAULT 默认值 |
|---|---|---|
| `maPeriods` | `number[]` | `[30, 60, 120, 240]` |
| `maConditions` | `MaCondition[]` | `[]` |
| `entrySortFactors` | `SortFactor[]` | 5 个因子（仅 risk_reward 启用） |
| `takeProfitTargets` | `TakeProfitTarget[]` | `[]` |

**反例 / 教训**：同理，`entrySortFactors` 是含嵌套对象（`params?: Record<string, unknown>`）的数组。Agent 若只想改 momentum 因子的 weight，必须传完整的 5 个因子数组，不能只传 momentum 那一项。传少了 → 该字段缺失 → `validateConfig` 抛「`entrySortFactors 至少需要一个启用的因子`」。

---

## 4. configSnapshot 快照规则

**规则**：三层合并后的完整 config 自动落库到 `backtest_runs.config_snapshot`（JSONB 列），无需额外改动。该快照是本次 run 的**唯一真实生效参数来源**。

**禁**用策略当前 params 复现历史 run：策略 params 可能已被 `PUT /strategies/:id` 修改，与历史 run 时的参数不同。要复现某次 run 的参数，**必须**用 `runId` 查 `configSnapshot`。

**Agent 复现工作流**：

```
1. POST /api/backtest/start/:strategyId  ← 带 overrides，返回 ok
2. GET  /api/backtest/progress/:strategyId ← 轮询，done 后拿 runId
3. GET  /api/backtest/run/:runId          ← 读 configSnapshot，拿到本次生效的完整 config
```

**反例 / 教训**：若 Agent 靠「记下 overrides + 读策略当前 params」反推 run 的 config，一旦策略在两次 run 之间被修改（手动或另一个 Agent），反推结果就错了。`configSnapshot` 的存在正是为了消除这种时序耦合——每次 run 独立快照，runId 是唯一可靠的溯源键。

---

## 5. validateConfig 加固规则

**规则**：`validateConfig`（`apps/server/src/backtest/engine/models.ts:274`）新增高危字段**上界校验**与**日期格式校验**。加固上界取 `DEFAULT_CONFIG` 对应默认值的 2-25 倍，以「不误伤既有合法配置」为红线。

**加固字段上界**：

| 字段 | DEFAULT 默认值 | 加固上界 | 倍数 | 校验逻辑 |
|---|---|---|---|---|
| `maxBacktestBars` | 10,000 | 100,000 | 10x | `>= 0 && <= 100000` |
| `warmupBars` | 240 | 10,000 | ~42x | `>= 0 && <= 10000` |
| `lookbackBuffer` | 0 | 10,000 | — | `>= 0 && <= 10000` |
| `maxPositions` | 2 | 50 | 25x | `正整数 && <= 50` |

**dateStart / dateEnd 规则**：

- 非空时必须匹配 `^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$`，接受以下格式：
  - `YYYY-MM-DD`（如 `2024-01-01`）
  - `YYYY-MM-DD HH:MM:SS` 或 `YYYY-MM-DDTHH:MM:SS`（如 `2024-01-01 09:30:00`），空格或 `T` 分隔，时分秒部分可选
- 若 `dateStart` 和 `dateEnd` 均非空，则 `dateStart <= dateEnd`（字符串比较即可，ISO 格式天然有序）
- **禁**加年份下限（如 `>= 2000`）：用户跑历史数据可能需要 2010 年前甚至更早的行情，加年份下限会误伤合法场景

**反例 / 教训**：Agent 传 `maxBacktestBars: 1000000`（100 万根 K 线），`validateConfig` 直接 throw → 回测立即失败返回错误。这是**预期行为**，不是 bug。上界存在的意义是防止 Agent 误传超大值导致 OOM 或跑几小时。Agent 若确实需要更大范围，应调小 timeframe（如从 1h 改为 1d）而非突破上界。

**反例 / 教训**：若 `dateStart` 校验加了 `年份 >= 2000` 的下限，用户回测 A 股 1990 年代数据时会被拦截。日期校验只管格式和逻辑顺序（start <= end），不管年份范围——数据是否存在是 dataService 层的事，不是 validateConfig 的职责。

**反例 / 教训**：正则若只接受 `YYYY-MM-DD`，既有策略配置中 `dateStart: "2024-01-01 09:30:00"`（带时分秒）会被 `validateConfig` 拒绝，导致 Agent 回测报错。放宽正则的原因是 engine 用 `new Date()` 解析（`data.service.ts:57`），JS Date 构造函数能正确解析 `YYYY-MM-DD` 和 `YYYY-MM-DD HH:MM:SS` 两种格式，过严的正则会误伤合法配置。

---

## 6. 前端零改动契约

**规则**：body 多出的 `overrides` 字段被 NestJS 静默忽略（项目无全局 `ValidationPipe`、无 `forbidNonWhitelisted`），前端无需任何改动即可继续正常触发回测。

**禁**在前端 `StartBacktest` 调用里塞 `overrides`：`overrides` 是 Agent 专用通道，UI 走「编辑策略 → PUT /strategies/:id」改 params。前端和 Agent 的改参路径完全隔离：

| 角色 | 改参方式 | 持久性 |
|---|---|---|
| 前端 UI | 编辑策略 → `PUT /strategies/:id` | 永久 |
| Agent / 脚本 | `POST body.overrides` | 单次 run |

前端触发回测仍只传 `{ symbols }`，行为不变。`overrides` 字段对前端完全透明——JS 对象多传一个 undefined 字段不会产生副作用。

**反例 / 教训**：若在前端也暴露 `overrides`，用户可能困惑「为什么我在覆盖里改了参数但刷新策略页还是旧值」。`overrides` 的语义是「临时、不持久化」，与 UI 的心智模型（改了就保存）冲突。保持 Agent 专用是设计边界清晰的体现。

---

## 7. Agent 接入示例

> 鉴权前置依赖见 [api-key-auth-design.md](./api-key-auth-design.md)。以下示例均假设已创建 API Key 并携带 `Authorization: Bearer <your-api-key>`。

**完整工作流（三步）**：

```bash
# ① 触发回测（带 overrides，异步立即返回）
curl -X POST http://localhost:3000/api/backtest/start/<strategy-id> \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "symbols": [],
    "overrides": {
      "maxPositions": 10,
      "maxBacktestBars": 50000,
      "dateStart": "2024-01-01",
      "dateEnd": "2025-06-30",
      "stopLossFactor": 1.3
    }
  }'
# 响应: { "ok": true }

# ② 轮询进度（30 秒内自动清理，拿到 runId 立即存）
curl -H "Authorization: Bearer <your-api-key>" \
  http://localhost:3000/api/backtest/progress/<strategy-id>
# 响应: { "status": "done", "runId": "abc-123", ... }

# ③ 取 run 详情（含 configSnapshot，可复现本次参数）
curl -H "Authorization: Bearer <your-api-key>" \
  http://localhost:3000/api/backtest/run/abc-123
# 响应: { ..., "configSnapshot": { "maxPositions": 10, "stopLossFactor": 1.3, ... } }
```

**注意事项**（复自 api-key-auth-design.md §4）：
1. 进度数据 `done` / `error` 后 30 秒自动清理——拿到 `runId` 立即存。
2. 同一用户同一策略并发阻塞——返回 `{ ok: false, message: '该策略的回测任务已在运行中' }`，Agent 要轮询等当前一次跑完再启下一次。

---

## 8. 检查清单（扩展回测接口时逐条过）

- [ ] `overrides` 是否走三层合并（`DEFAULT_CONFIG < strategy.params < overrides`），而非只合并两层
- [ ] 数组 / 嵌套字段（`maConditions` / `entrySortFactors` / `takeProfitTargets` / `maPeriods`）是否传完整数组（浅合并整体替换语义）
- [ ] 合并后是否过 `validateConfig`（加固后的上界 + 日期格式）
- [ ] `configSnapshot` 是否落库完整生效参数（三层合并后的最终结果）
- [ ] 前端调用是否未塞 `overrides`（`overrides` 是 Agent 专用通道）
- [ ] `dateStart` / `dateEnd` 校验是否未加年份下限（用户可能跑 2010 年前数据）
- [ ] 上界是否取 `DEFAULT_CONFIG` 的合理倍数（不误伤既有合法配置）
- [ ] Agent 是否通过 `runId` 查 `configSnapshot` 复现参数，而非依赖策略当前 params
- [ ] curl 示例是否使用占位符 `<your-api-key>` / `<strategy-id>`，不泄露真实凭证
