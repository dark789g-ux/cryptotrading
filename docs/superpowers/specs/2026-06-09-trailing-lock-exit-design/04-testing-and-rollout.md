# 04 · 测试、迁移与验证

> 规则见 [01](./01-rule-semantics.md)，核接口见 [02](./02-shared-core-and-contracts.md)，集成见 [03](./03-module-integration.md)。

## 一、测试策略

### 1.1 对拍（跨语言一致性，第一优先级）

[02 §四](./02-shared-core-and-contracts.md#四对拍样例集) 的 S1–S12 既是 Python 核单测、又是 TS 版单测的**同一期望表**：

```text
同一组(输入 bars + signal_high + max_hold)
        │
        ├─▶ Python simulate_band_lock(...)  ──▶ 期望 BandLockOutcome
        └─▶ TS    decideBandLock(...)        ──▶ 期望 ExitDecision
两边对同一期望表断言 → 行为一致（含 hold_days / exit_index / 取整边界）
```

- Python：`apps/quant-pipeline/tests/unit/test_band_lock_exit.py`（新建），逐样例精确数值断言。
- TS：`apps/server/src/strategy-conditions/signal-stats/*.spec.ts`（沿现有纯函数单测位置）。
- `floor2` 取整边界（如 `floor2(10.4895)=10.48`、含进位）单列断言，防浮点末位漂移。

### 1.2 各模块单测

- signal-stats：`decideBandLock` 覆盖 S1–S12；`buildHoldingDays` 新字段填充；入场过滤复用回归（不破坏 fixed_n/strategy）。
- exit_rules：band_lock scheme 端到端（含 force_close 兜底、停牌、跌停顺延激活后口径）；
  **回归**：原有 5 种 first-match 规则与 `default_rules` 不受影响（band_lock 走独立 scheme 入口）。
- kelly_sweep：`simulate_band_lock_exit` 在构造 path 上的出场；grid 注册后 `_exit_id` 唯一、不与现有族碰撞。

### 1.3 真机 e2e（按各模块现有路径）

- signal-stats：前端新建一个 `trailing_lock` 信号测试 → 触发 run → 校验 trade 落库（exit_reason ∈ stop/ma5_exit/...、scheme）。
- exit_rules / kelly_sweep：经 `/quant/jobs` 跑一个小区间 job，确认 band_lock scheme 产出、无异常、限停板顺延真实触发。

## 二、迁移（DB）

- signal-stats：默认**无需 migration**（exit_reason/exit_mode 为 varchar；maxHold 复用现有列）。
  **仅当** `signal_test.exit_mode` 存在 CHECK 约束限定取值时，随附 `migrations/*.sql` + 同名 `.ps1`（docker exec）
  放开 `'trailing_lock'`（实现前 `\d signal_test` 核对）。
- exit_rules / kelly_sweep：band_lock 配置若落 `factors.strategy_definitions`，按现有该表写法新增一条策略定义（migration 或种子）。

## 三、验证标准（完成判据）

```text
[ ] S1–S12 对拍：Python 核与 TS 版输出逐项相等（含取整边界）
[ ] signal-stats: pnpm --filter @cryptotrading/server exec jest signal-stats 全绿
[ ] signal-stats: pnpm --filter @cryptotrading/web type-check + lint:quant-lines 绿
[ ] exit_rules / kelly_sweep: pytest 相关用例全绿，原有规则回归不破
[ ] vite build / server build 绿
[ ] 三模块真机各跑通一次 trailing_lock，限停板顺延与锁定路径被真实数据触发并核对
[ ] 改后端代码后重启后端进程再 e2e（dev 无 watch，见 CLAUDE.md）
```

**口径自检（落硬断言前必做）**：daily_quote/stk_limit 列名（本设计已亲验）、kelly_sweep 与 runner.py 行号（二手）、
exit_rules scheme 接入点——逐一 grep 实体 / 查真 DB 一条再写，不采信转述。

## 四、分批提交建议

> 互不相交文件域，便于并行 + 分层 commit。

| 批 | 范围 | 文件域 |
|---|---|---|
| A | Python 共享核 + 单测 | `strategy/band_lock_exit.py`、`tests/unit/test_band_lock_exit.py` |
| B | signal-stats 后端 | `signal-stats/*.ts`（simulator/db/纯函数/spec） |
| C | signal-stats 前端 | `web/.../SignalTestForm.vue`、`api/.../signalStats.ts` |
| D | exit_rules 接入 | `strategy_aware.py`/`labels/runner.py`/scheme 入口 + 数据层 join stk_limit |
| E | kelly_sweep 接入 | `kelly_sweep/{types,paths,exits,sweep}.py` |

- A 是 B/D/E 的前置（共享核先落、先对拍）；B↔C 串行（类型契约）；D、E 可与 B/C 并行（不同语言/目录）。
- 提交信息遵循 Conventional Commits；多子系统大改按用户偏好**分层 commit**（每子系统一个语义清晰 commit）。

## 五、范围边界（YAGNI）

- **不动**回测模块（crypto）。
- **不引入**未复权全链路计价（仅限停板判定用 raw，止损/比价仍走复权）。
- **不做**跌停部分成交、滑点、手续费建模（与三模块现有口径一致：毛收益）。
- band_lock **不塞进** `_RULE_BUILDERS` first-match 框架（它是整套有状态方案，独立 scheme 入口）。
