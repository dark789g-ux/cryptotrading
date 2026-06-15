# 两个收尾：拆 signal-stats.service 校验降行数 + regime 新规则默认 value:0 — 交接

> 自包含交接：可整段贴给全新会话直接做。**两个任务独立、可直接实现（无需 brainstorming）**：① 纯重构降行数、② 一行默认值改。文件域不交（后端 / 前端），可一并做也可分开。

---

## 任务 ①：拆 `signal-stats.service.ts` 校验层降到 ≤500 行（纯重构）

### 一句话目标
`apps/server/src/strategy-conditions/signal-stats/signal-stats.service.ts` 现 **813 行**，超项目 ≤500 行通则（`.claude/rules/code-organization.md`）。把校验层抽到独立模块，把主 service 降到 ≤500。**纯重构、零行为改动。**

### 现状摸底（file:line 为证，已核）
- 文件 813 行。校验私有方法集中在 :503–790：
  - `validateBacktestConfig`（:503，迷你回测加的，内部 :583 调 `validateRegimes`）
  - `validateBacktestRankSpec`（:586）/ `validateBacktestSizing`（:613）/ `validateBacktestCircuitBreaker`（:657）
  - `validateBandLockParams`（:736）/ `validatePhaseLockParams`（:766）（更早的出场模式校验）
- import：`validateRegimes` from `../portfolio-sim/portfolio-sim.regime-validator`（:42）。
- 调用点：`create()/update()` 链路里 `this.validateBacktestConfig(dto.backtestConfig)`（:495）等。
- 背景：该文件在 minibacktest 前已 548 行（本就超标），迷你回测 M1 加了 backtest 校验族（~180 行）、regime M2 加了一行 `validateRegimes` 调用。

### 已定方向（实现可微调）
- 把上述**校验私有方法族**（backtest 4 个 + bandLock/phaseLock 2 个，约 287 行）抽到独立模块，如 `signal-stats/signal-stats.validators.ts`（纯函数或静态类），service 内改为委托调用。
- **注意行数账**：只抽 backtest 4 个（~180 行）→ 813-180≈633，**仍超 500**；要降到 ≤500 需把 6 个校验族一并抽出（~287 行 → ~526），可能还要再带一两个相邻 helper（如 backtest config 组装、出场参数解析）。**实现者按实际行数决定抽多少**，目标是主 service ≤500。
- 抽出的校验**继续调用** `validateRegimes`（portfolio-sim.regime-validator）——别把它一起搬走，那是 portfolio-sim 域的共享纯函数。
- 校验语义参照 portfolio-sim 的 `create-portfolio-sim.dto.ts`（同构）。

### 硬约束
- **零行为改动**：现有单测必须继续全绿（`signal-stats.backtest-config.spec.ts` / `signal-stats.service.spec.ts` 等），必要时把测试指向新模块。
- 抛错风格不变（中文 `BadRequestException`）。源文件 UTF-8。
- 该文件在 `views/strategy` 后端域，**不在** `lint:quant-lines`（仅 `apps/web` quant Vue）强制范围，但 ≤500 通则仍适用、本任务就是为它。
- 后端改 `apps/server` 须重启进程才端到端生效（`nest start` 无 watch），但本任务只到单测层。

### 验证
- `pnpm --filter @cryptotrading/server build` 通过。
- `pnpm --filter @cryptotrading/server exec jest signal-stats` 全绿（429 测试基线）。
- 复查 `wc -l signal-stats.service.ts` ≤ 500。

---

## 任务 ②：regime 新规则默认条件给 `value: 0`（一行改）

### 一句话目标
`RegimeRulesEditor` 点「+ 规则」生成的默认条件是 `oamv_macd > undefined`，用户不填直接提交会吃后端 400（`value 须为有限数`）。给默认值 `0`，变成 `oamv_macd > 0`（正是 canonical Q1 条件），体验更顺。

### 现状摸底（file:line 为证，已核）
`apps/web/src/components/strategy/RegimeRulesEditor.vue:87-95` `freshRule()`：
```js
function freshRule(): RegimeRule {
  return {
    conditions: [
      { field: 'oamv_macd', operator: 'gt', value: undefined, compareField: undefined, compareMode: 'value' },
    ],
    maxPositions: 2,
    positionRatio: 0.2,
  }
}
```
改 `value: undefined` → `value: 0`（其余不动）。

### 硬约束 / 注意
- 测试 `RegimeRulesEditor.spec.ts` **无任何断言 `value === undefined`**（只断 `conditions[0].field` 匹配 `^oamv_`），故零破坏；若你顺手加默认值相关断言，自洽即可。
- `compareMode: 'value'` 是前端 `StrategyConditionItem` 合法字段、后端忽略，**保留别删**。
- 改 `.vue` 合并前跑 `vite build`（type-check 查不出 SFC 编译错）。

### 验证
- `pnpm --filter @cryptotrading/web type-check` + `pnpm --filter @cryptotrading/web test`（RegimeRulesEditor 9 例基线）+ `pnpm --filter @cryptotrading/web build`。

---

## 前序进度 / 待续
- 2026-06-15：本交接由「signal_test 迷你回测+ml.jobs草稿态」(memory `project_signaltest_minibacktest`) 与「regime 条件调仓」(memory `project_regime_position_sizing`) 两功能收尾派生，两者均已合入本地 main（未推 origin）。任务①来自迷你回测最终审查遗留，任务②来自 regime 最终审查 Minor。
- **下一步**：新会话直接实现两个任务（纯重构 + 一行默认值），跑门禁，按 `finishing-a-development-branch` 收尾。无需 brainstorming。
