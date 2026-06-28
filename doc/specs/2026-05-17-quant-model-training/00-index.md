# 量化模型训练模块 设计 · 总览

- 日期：2026-05-17
- 状态：草稿，待审阅（已通过一次独立 SubAgent 审阅，P0/P1 全部修订）
- 拆分说明：本目录是 `doc/specs/2026-05-17-quant-model-training-design.md` 的拆分形态，每个子文档 ≤ 300 行，便于 parallel-agents 各取一段独立推进
- 涉及模块：新增 `apps/quant-pipeline/`（Python · uv 管理）、`apps/server/src/modules/quant/`、`apps/web/src/views/quant/`、PostgreSQL 新增 `raw / factors / ml` 三 schema

## 1 背景与目标

`doc/量化/` 下 10 篇文档已完整给出 A 股截面选股的方法论：标签设计（strategy-aware）、因子库分层（量价 + 行业派生 + 财务）、模型选型（LightGBM + LambdaRank）、评估方法（Purged Walk-Forward + 三组对照 + 扣成本年化）、部署监控（IC 漂移 + 特征 PSI）。但项目代码侧没有任何对应实现：

- 已有 A 股数据层（`a_share_daily_quote / a_share_daily_metric / a_share_adj_factor / a_share_daily_indicator`，由 NestJS+TypeORM 管理、TuShare 同步在跑），位于 `public` schema
- 已有加密择时 Python 子项目 `timing/`，方向不同，**不可复用**
- 已有 `BacktestRunner` 仅服务加密货币，与本 spec 的 "Purged Walk-Forward 离线评估" 是两件事
- 零量化训练相关代码、零 Python ML 工具链

本 spec 把上述方法论一次性映射为一份 90 天 Roadmap，切成 **M0 → M4** 5 个里程碑，每个里程碑独立可验收、可演示。

**非目标**：
- 本 spec 不设计 "A 股 daily 频回测引擎"（独立 spec 处理）
- 本 spec 不把模型评分接入实盘下单
- 本 spec 不涉及加密货币侧的任何改动

## 2 决策摘要（用户已确认）

| 决策项 | 决策 |
|---|---|
| Spec 范围 | 完整 90 天 Roadmap，一次写完 |
| 代码布局 | 同仓 · `apps/quant-pipeline/` · Python |
| Python 环境 | uv（pyproject.toml + uv.lock） |
| 与现有 A 股表的关系 | 迁移进 `raw` schema（去 `a_share_` 前缀）+ NestJS entity 同步改 |
| 运行位置与触发 | 本地 Windows + CLI 手动 + Windows 任务计划 |
| 前端可见性 | 读展示（评分看板）+ 训练 run 管理 UI（含 SHAP / 触发） |
| NestJS ↔ Python 通信 | PG 作业队列表 `ml.jobs`，NestJS 插行、Python worker 轮询 |
| 阶段切分形态 | 5 个里程碑 M0 → M4 |
| Roadmap 内是否含监控 | 是，M4 含 IC 漂移 + 特征 PSI 监控 |
| e2e UI 测试形态 | 手测打卡（不引 Playwright） |
| 训练 / 推理设备 | 本机 CPU，不预设云方案；M4 复盘时判断是否需扩容 |
| 因子库初始规模 | M1 约 30 维（量价 20 + 行业派生 10） |

## 3 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  cryptotrading/ (monorepo)                                  │
│                                                             │
│  apps/server (NestJS)                                       │
│    ├ a-share 现有同步：entity 切到 raw.*                    │
│    ├ 新增 modules/quant/：                                  │
│    │   · jobs controller (POST/GET /quant/jobs/*)           │
│    │   · scores / runs / quality 只读 controller            │
│    │   · SSE 进度推送（PG LISTEN/NOTIFY 桥接）              │
│    └ 写 ml.jobs(pending) 行作为唯一触发手段                 │
│                                                             │
│  apps/web (Vue)                                             │
│    └ 新增 views/quant/：                                    │
│        · /quant            Overview (Top-K + 模型版本)      │
│        · /quant/scores     按日 ranked 列表                 │
│        · /quant/runs       训练 run 列表                    │
│        · /quant/runs/:id   超参 / fold / SHAP / 下载        │
│        · /quant/jobs       作业队列                         │
│        · QuantTrainTriggerModal (复用 AppModal)             │
│                                                             │
│  apps/quant-pipeline/ (Python · uv 管理) ※本仓新建          │
│    ├ pyproject.toml + uv.lock                               │
│    ├ src/quant_pipeline/                                    │
│    │   ├ cli.py             typer 主入口                    │
│    │   ├ sync/        TuShare → raw.*                       │
│    │   ├ quality/     PIT 审计 + 8 项数据质量门禁           │
│    │   ├ factors/     raw → factors.daily_factors           │
│    │   ├ labels/      strategy-aware → factors.labels       │
│    │   ├ features/    因子 + 标签 → 训练矩阵                │
│    │   ├ strategy/    exit_rules.py (训练/回测共用)         │
│    │   ├ training/    LightGBM LambdaRank + Walk-Forward    │
│    │   ├ evaluation/  NDCG / IC / Portfolio / SHAP / A-B    │
│    │   ├ inference/   写 ml.scores_daily                    │
│    │   └ worker/      轮询 ml.jobs                          │
│    ├ tests/{unit,integration,contract}                      │
│    └ artifacts/{model_run_id}/  本地 model.txt / report.md  │
│                                                             │
│  PG (single instance · 4 schemas)                           │
│    ├ public.*      NestJS 现有非 A 股业务                   │
│    ├ raw.*         A 股原始 (从 public.a_share_* 迁移)      │
│    ├ factors.*     因子 / 标签 / 特征 (按 factor_version)   │
│    └ ml.*          jobs / model_runs / scores_daily /       │
│                    quality_reports                          │
└─────────────────────────────────────────────────────────────┘
```

**通信契约（关键）**：NestJS 与 Python **不通过 HTTP 互调**，全部通过 PG 通信：
- NestJS 写 `ml.jobs(status='pending')` → Python worker `SELECT FOR UPDATE SKIP LOCKED` 取行执行
- Python 写 `ml.scores_daily` / `ml.model_runs` / `ml.quality_reports` → NestJS 读
- Python 进度推送通过 `NOTIFY ml_job_progress, '<json>'` → NestJS SSE 转发到前端

**重启 / 崩溃行为定义**：
- **Worker 崩溃保护**：Python worker 每 30 秒回写 `ml.jobs.heartbeat_at`。NestJS 侧（或 Python 自带）一个 reaper 每 60 秒扫 `status='running' AND heartbeat_at < now() - interval '3 min'` 的行，把它们 `status` 重置为 `pending` 并 `attempts += 1`；超过 `max_attempts` 则 `status='failed'` + `error_text='heartbeat_timeout'`
- **SSE 重连回补**：NestJS SSE endpoint 在建立连接时**先 SELECT 一次** `ml.jobs.progress` 当前值推给客户端（避免 LISTEN 之前的进度被错过）；之后 LISTEN 增量
- **NOTIFY payload schema**：固定 `{"job_id":"<uuid>","progress":<int 0..100>,"stage":"<str>"}`，**总长 ≤ 1KB**（远低于 PG 8KB 上限），不允许携带日志正文、错误堆栈或 SHAP 数组
- **NestJS SSE 桥接进程**必须维持一条**独立、长生命周期**的 PG 连接专门 `LISTEN`，不与请求池复用；断线重连后立即重新 `LISTEN`

## 4 文档地图

| 文档 | 内容 | 主要消费者 |
|---|---|---|
| [01-pg-schema.md](01-pg-schema.md) | PG 4 个 schema 总览、迁移与回滚序列、sync 所有权（**表 DDL 见 [doc/db/index.md](../../db/index.md)**） | M0 / M1 / M2 全部 |
| [02-quant-pipeline.md](02-quant-pipeline.md) | Python `apps/quant-pipeline/` 模块拆分、CLI 表面、worker/runner 进度约定 | M1 / M2 / M3 / M4 |
| [03-nestjs-vue.md](03-nestjs-vue.md) | NestJS `modules/quant/` + Vue `views/quant/` 改动表面、SSE 鉴权 | M2（jobs controller） / M3（读 controller + UI v1） / M4（UI v2） |
| [04-error-quality-testing.md](04-error-quality-testing.md) | 错误处理总则、数据质量门禁、测试策略、Vue 行数 CI | 全部 |
| [05-risks.md](05-risks.md) | 风险与开放议题（含 reaper / Optuna RDB 等设计权衡） | 全部 |
| [m0-data-migration.md](m0-data-migration.md) | M0 里程碑：数据迁移与 schema 底座（1-1.5 周） | M0 实施 agent |
| [m1-factor-library.md](m1-factor-library.md) | M1 里程碑：因子库 v1 + PIT 检测（2 周） | M1 实施 agent |
| [m2-training-mvp.md](m2-training-mvp.md) | M2 里程碑：标签 + 训练 MVP 通路 + ml.jobs 骨架（3 周，可延 1 周） | M2 实施 agent |
| [m3-walkforward-frontend-v1.md](m3-walkforward-frontend-v1.md) | M3 里程碑：Walk-Forward + 三组对照 + 前端评分看板（3-3.5 周） | M3 实施 agent |
| [m4-monitoring-frontend-v2.md](m4-monitoring-frontend-v2.md) | M4 里程碑：训练 run UI + SHAP + Optuna + 监控（3 周） + raw 表可用时点附录 | M4 实施 agent |

**Parallel-agents 使用建议**：每个 milestone 实施 agent 至少应将本 index + 该里程碑文档 + 01/02/03 三份跨切文档加入上下文；M2 起还应加上 04（质量门禁规范）；M4 应加上 05（reaper / Optuna RDB 等风险设计权衡）。

## 5 参考文档索引

- `doc/量化/00-index.md` 全局索引
- `doc/量化/01-训练体系蓝图.md` 6 阶段框架
- `doc/量化/02-数据分层与PG-schema.md` raw/factors/ml 三层 schema 设计 ← 01-pg-schema.md 来源
- `doc/量化/03-PIT与数据质量.md` 三铁律 + 三幽灵 Bug ← 04 来源
- `doc/量化/04-标签设计.md` strategy-aware labeling ← M2 来源
- `doc/量化/05-LightGBM训练体系.md` 标准配置 + Walk-Forward + Optuna ← M2/M3/M4 来源
- `doc/量化/06-TuShare接口清单.md` P0/P1/P2 接口与积分门槛
- `doc/量化/07-行业板块因子.md` 行业派生因子 + 中性化 ← M1 来源
- `doc/量化/08-反模式集合.md` 6 层禁忌清单 ← 04 红线来源
- `doc/量化/09-Roadmap-经验-项目结构.md` 90 天路线图与代码结构建议 ← 本 spec 整体来源
- `CLAUDE.md` 项目硬约束（编码 / NestJS 规范 / Vue 规范 / 时间规范 / 第三方 API 规范）← 01/03/04 合规来源
