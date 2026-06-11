# 05 · 验证、任务切分与风险

## 测试金字塔

### 引擎核单测（portfolio-sim.engine.spec.ts + portfolio-sim.cost.spec.ts，纯函数）

1. 同日超额：候选 > 空槽 → 按 rank 排序取前 K，平局 ts_code 升序；rank 缺失排队尾。
2. already_held：同策略在持同票的新信号 skip（reason 正确）；出场当日新信号可再进
   （先出场后开仓顺序的直接推论，显式断言）。
3. exposureCap 撞线：敞口恰好等于上限时下一笔 skip（边界含等号语义固定并断言）。
4. cash_short：现金不足整笔跳过、不部分成交。
5. 停牌沿价：盯市窗口中间缺行情日 NAV 路径正确。
6. **印花税时变边界**：2023-08-25 卖出按 0.1%、2023-08-28 卖出按 0.05%。
7. 零命中日 / 跨年窗口 / 单笔 trade 的最小用例。
8. **出场收口精确性**：任意盯市路径下 realized 毛收益恒等于 `1+ret`（构造性断言）。
9. **成本单调性**：同输入三档成本，净值逐档单调下降；零成本时逐笔 net=ret。
10. **约束单调性**：maxPositions 5→3→1，taken 数单调不增，且每个被弃信号的 rank
    不优于同日任何成交信号。
11. 汇总指标：手算小样本的 max_drawdown / annual_ret / sharpe / 日 kelly 对数。

### 锚点 e2e（真 DB，硬门禁）

锚点模式跑 `52d2a2c8-1d36-4a0a-a4f6-5ef6e7137971` → `anchor_check.pass === true`：
复放 rets 喂 `calcSignalStats`，kellyF/winRate/sampleCount 与官方 `signal_test_run`
存储值逐位一致（numeric 存储精度内）。Q1 run `800c3732` 同样跑一遍。

### 回归与门禁

- 本模块只新增文件（除 app.module 实体注册），signal-stats / strategy-conditions
  既有 430+ 测试必须全绿：`pnpm --filter @cryptotrading/server exec jest`。
- 后端 build；前端 `type-check` + `vite build` + `lint:quant-lines`。

### 真机 e2e 清单（操作台全流程）

1. 新建模拟（官方双源+现实档）→ 列表出现 → 触发 → 三阶段进度推进 → success。
2. 锚点模式 run → 详情页徽章绿✓、数字对照正确。
3. 详情页：指标卡、净值曲线、弃单分布、明细表筛选/分页。
4. running 中刷新页面 → 轮询恢复、进度继续。
5. running 中再触发 → 409 中文提示；running 中删除 → 拒绝。
6. 重跑同一 run → 旧 daily/fills 被清、结果更新（幂等）。

## 终态交付物

1. 代码 + 测试 + migration（已应用）+ 操作台。
2. **组合口径报告**：Q3-winner 单独、Q1-winner 单独、Q3+Q1 联合（共享资金池），
   各 × 三档成本 = 9 个 run 的净值/回撤/税后日 kelly 汇总，写入
   `doc/研究/0amv-regime-strategy/results.md` 新增"组合口径"节（数字带 run id 可复算），
   并对照 config v1 的 kellyFraction 给出影子期复核基线。
3. 影子期复算路径文档（见下节）。

## 影子期复算路径（本期文档化，工具化二期）

影子期 picks（`regime_daily_pick`）只有信号日快照、无前向收益。8 周后复核步骤：

1. 对影子期窗口的每个 trade 日 pick，按 config v1 的出场规则用 signal-stats
   **建方案+触发 run**（买入条件可用 ts_code IN 列表近似或复用原条件+日期窗），
   得到逐笔 trades。
2. 以该 run 为源建 portfolio-sim run（现实档成本、影子期实际仓位参数）→ 组合日收益
   口径指标。
3. 与本期报告的基线对照，决定 config v1 保留/降级（降级=建 config v2 激活）。

## SDD 任务切分（文件域互不相交）

| 批次 | 任务 | 文件域 |
|---|---|---|
| W1-a | migration + 三实体 + app.module 注册 | `migrations/20260611_*`、`entities/strategy/portfolio-sim-*`、`app.module.ts` |
| W1-b | 引擎核 + 成本模型 + types + 单测 | `strategy-conditions/portfolio-sim/{engine,cost,types}*` |
| W2 | loader + runner + service + controller + module + dto + service 层测试 | `strategy-conditions/portfolio-sim/` 其余文件 |
| W3 | 前端（api/视图/组件/路由/Sidebar） | `apps/web/src/` 对应文件 |
| W4（主会话） | 重启 server → 锚点 e2e → 真机 e2e → 9 run 报告 → results.md 增补 | 文档与运行 |

W1-a 与 W1-b 并行（文件不相交）；W2 依赖 W1 两者；W3 依赖 W2 的 API 契约（按 03 文档
可先行写接口层，联调等 W2）。并行 implementer 不提交，控制者批次末按域分层 commit
（用户偏好分层 commit）。**子代理派发 model 一律 opus（用户 2026-06-11 指示，禁 fable）；
禁 worktree 隔离（仓规）。**

## 风险表

| 风险 | 影响 | 缓解 |
|---|---|---|
| qfq 路径与 run 时点除权差异 | 回撤形状轻微失真 | 出场收口保证收益精确；边界声明已写 01 |
| trade_cal 滞后于 trades | 窗口尾部缺交易日 | 用 trades 日期并集补齐 + warn（02） |
| 弃单表体量（67k/run）累积 | 库膨胀 | DELETE 级联；报告期 9 run ≈ 60 万行，可控 |
| numeric→string 水合 | 指标计算静默串接 | loader 边界统一 parseFloat + 单测覆盖 |
| rank JOIN 部分缺失 | 排序降级 | 不淘汰、队尾+NULL 标记；锚点模式不受影响 |
| runner 完成未推终态进度 | 前端卡 99%（kelly_sweep 旧坑） | 完成路径显式推满 + e2e 第 1 条覆盖 |
| 重跑半途失败留脏数据 | 详情页数据不一致 | 触发起点事务内清旧 daily/fills（03） |
