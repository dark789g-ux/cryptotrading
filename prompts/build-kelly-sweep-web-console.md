# 交接：为 kelly-sweep 研究 harness 建前端「网格搜索操作台」

> 本文自包含，可整段贴给全新会话/agent 直接接手，不依赖上一会话上下文。
> **第一步请触发 `brainstorming` skill**（这是新特性，需先设计、获批后再实现）。

## 一句话目标

给已落地的 Python「凯利上界研究 harness」配一套 **Web 操作台**：用户在前端配置网格搜索参数 → 一键发起 → 看实时进度（SSE）→ 浏览结果（信号数↔凯利 帕累托前沿图 + top-K 排行表 + 逐项详情）。**不要用 TS 重写扫描引擎——复用现成的 Python harness。**

## 背景：harness 是什么、已有什么成果

A 股「买入条件触发后」的前向收益研究工具：在「入场条件变体 × 出场参数(止盈止损/移动止损/ATR/固定持有)」网格上批量算凯利公式 `f*=p-(1-p)/b`，找「信号更少但凯利更高」的方案。纯研究口径（不扣费、探索上界）。已用 SDD 完成 Phase1（Python，**已合入 main**），并用集成自校验复现 NestJS 锚点验证过正确性。

**首轮真实扫描已跑出有意义结果**（CLI，全市场 2023–2026，848 组合）：最优 `收盘价低于30日均线12%(dev_ma30<-0.12) + 持1日(fixed_n(1))` 验证集 Kelly **0.383**（CI 0.343–0.424，信号 3004 条），远超基线 0.171。这套工具值得配 Web 操作台让用户反复探索。

## 现状摸底（路径为证；新会话请用 brainstorming 的 Explore 子代理逐一核实）

### 已有的 Python 引擎（复用对象，**勿重写**）
- 模块目录：`apps/quant-pipeline/src/quant_pipeline/research/kelly_sweep/`
  - `config.py`（`SweepConfig` pydantic，全部可调参数）、`types.py`（契约：ForwardPath/TradeResult/MetricResult/ResultRow）
  - `enumerate.py`/`paths.py`（DB 读取：信号枚举 + 前向路径 + 特征输入 + 指数日线）
  - `entry_features.py`/`exits.py`/`metrics.py`（纯计算）、`sweep.py`（`run_sweep(...)→list[ResultRow]`）
  - `report.py`（`compute_pareto_frontier(rows)`、`rank_top_k(rows,config,paths)`、`render_report(...)`）
  - `cli.py`（命令行入口，**主流程 `_run_sweep_pipeline` 是 Web 后端要复刻的调用序列**）
- **CLI 用法**（操作台后端可直接调内部函数，或子进程调 CLI）：
  `python -m quant_pipeline.research.kelly_sweep.cli --base-field kdj_j --base-op lt --base-value -10 --train-start ... --valid-start ... --max-entry-filters 1 --min-samples 300 --rs-benchmark hs300 --output-dir <dir>`
  产出 3 个文件到 output-dir：`top_k_ranking.csv` / `pareto_frontier.csv` / `kelly_sweep_report.md`。
- **运行时长**：全市场全区间一轮 ~13 分钟（枚举+路径加载~4min、特征~2min、网格扫描~6min、CI~2min）。**必须异步 + 进度反馈，不能同步阻塞 HTTP。**
- 设计 spec（背景/口径/护栏全在这）：`docs/superpowers/specs/2026-06-09-signal-kelly-research-harness-design/`（index 入口 + 01~06）。

### 可复用的既有"异步 job + SSE 进度"机制（强烈建议照搬，别另造）
- 项目已有量化训练 jobs 的异步执行 + SSE 进度推送（CLAUDE.md：`modules/quant` 含 `ml.jobs` SSE）。新会话务必先读懂它再设计：
  - Python 侧 worker poller：`apps/quant-pipeline/src/quant_pipeline/worker/poller.py`（轮询 jobs 表、跑 Python 活、回写进度）。
  - 前端 SSE 接法（**EventSource 不带 Authorization header**）：先 `POST /api/quant/jobs/:id/sse-token` 取短期 token，再用 query 参数建连——详见 `apps/web/src/views/quant/README.md`。
  - 前端量化视图：`apps/web/src/views/quant/`。
- **大概率正确的架构**：网格搜索做成一种新的 job 类型，NestJS 接收配置→入 jobs 表→Python worker 取走→调 `run_sweep` 流程→回写阶段进度→SSE 推前端；结果落 DB 表供前端查询/分页。
### 既有相关 UI/后端（可借鉴组件与模式）
- 单方案信号统计 UI：`apps/web/src/views/strategy/SignalStatsView.vue`（方案表/详情弹窗/收益率直方图——ECharts 用法可借鉴）。
- 后端：`apps/server/src/strategy-conditions/signal-stats/`（注意：这是**单方案**跑，与网格扫描不同；但出场字段、条件编辑器组件可复用）。

## 已定方向（会话中与用户敲定，新会话默认遵循）
1. **复用 Python harness 作扫描引擎**，前端/NestJS 只做触发 + 进度 + 结果展示，**不在 TS 重实现扫描逻辑**。
2. **异步执行 + SSE 进度**，照搬既有 quant jobs 机制（不另造一套任务系统）。
3. 用户偏好：复杂改动**分层 commit**；术语用大白话；不要假设、暴露权衡。

## 待 brainstorming 敲定的开放问题
1. **执行架构**：复用 quant jobs worker（推荐）还是 NestJS 直接 spawn Python 子进程？job 表用现有的还是新建 kelly_sweep_jobs？
2. **结果存储**：扫描产出（ResultRow 全表 + 前沿 + top-K）落 DB 表（前端可分页/排序）还是只存 CSV/MD 文件由后端读？落 DB 则需 schema（Python 侧 alembic 还是 NestJS migration？）。
3. **进度粒度**：枚举/路径/特征/网格/CI 五阶段够不够？网格是长段，要不要按"已扫 N/总组合"细推？harness 当前是 logging，要接进度需小改（emit 到 job 进度通道）。
4. **前端 UX**：配置表单要暴露哪些参数（base 触发、区间、max_entry_filters、min_samples、rs 基准、same_day_rule、出场网格开关？）；结果页：帕累托前沿散点（ECharts）+ top-K 可排序表 + 逐行详情（变体×出场+指标+CI）；含 RS / 不含 RS 两组分开展示（口径不可跨组比）。
5. **并发/成本护栏**：一轮 ~13min 且吃 CPU——限制同时只跑一个？排队？防滥用。
6. **范围边界**：只做"配置→跑→看结果"，还是也做"把某个赢家方案一键 promote 成 signal_test 方案/落地实盘候选"（后者属 Phase2 范畴，可不纳入本次）。

## 硬约束 / 项目规范（必须遵守）
- Windows + PowerShell（禁 `&&`，用 `;` 或多行）；终端 GBK 但**所有源文件 UTF-8**，文件 I/O 显式 `encoding='utf-8'`，HTML `<meta charset="UTF-8">`，对象键名用英文。
- 后端 `dev` 是 `nest start`（**无 watch**）：改 `apps/server` 代码后**必须重启后端进程**，否则新路由 404。前端 vite 有 HMR。
- DB schema 调整须随附 `docker exec` 可执行脚本（`apps/server/migrations/*.sql` + 配套 `.ps1`）；Python 侧迁移用 alembic（注意历史上有 alembic 版本脱节坑，补 migration 先 stamp 对齐）。
- TypeORM 新增实体须**同时**加 module `forFeature` + `app.module` 根 entities 数组（漏后者编译绿但运行时 `EntityMetadataNotFound` 500）。
- `apps/web/src/views/quant/**` 与 `components/quant/**` 单 Vue 文件 ≤500 行（CI `lint:quant-lines` 强制）。
- 接口/字段口径以官方/源头为准，进硬断言前落源头核对，禁二手转述。
- 派发 SDD 子代理时**禁用 git worktree 隔离**（Windows node_modules 锁），靠按不相交文件域切批次避免冲突。

## 验证标准
- 端到端真机：在 Web 配置一组参数 → 发起 → 看到实时进度推进 → 拿到帕累托前沿 + top-K。
- **正确性交叉验证**：同一组配置，Web 跑出的结果应与直接跑 CLI（`python -m ...kelly_sweep.cli` 同参数）产出的 `top_k_ranking.csv` 一致（沿用 harness「自校验」哲学——Web 层不得引入口径漂移）。
- 后端单测 / 前端 type-check + 单测 / `lint:quant-lines` 全绿；DB migration 可执行且幂等。

## 前序进度 / 上下文指针
- harness Phase1 已合 main；记忆见 `~/.claude/.../memory/project_kelly_sweep_harness.md`（含口径、backlog、首轮扫描结论）。
- 报告样例产物在 `apps/quant-pipeline/kelly_sweep_output/full`（已 gitignore，可跑 CLI 重生成参考其结构）。
- 本任务是会话中讨论的"前端操作台"路线（当时列了 4 条路：扣费压测 / 更深网格 / Phase2 落地赢家 / 前端操作台——本交接只负责**最后一条**）。
- **生命周期**：完成后把本文件移入 `prompts/archive/` 或删除，别留主目录冒充待办。
