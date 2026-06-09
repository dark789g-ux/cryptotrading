# 凯利网格搜索 Web 操作台 —— 设计 spec（入口）

> 给已落地的 Python「凯利上界研究 harness」配一套 Web 操作台：前端配置网格搜索参数 → 一键发起 → SSE 实时进度 → 浏览结果（信号数↔凯利 帕累托前沿散点 + top-K 排行表 + 逐行详情）。**不在 TS 重写扫描引擎——复用现成 Python harness。**

## 背景与目标

A 股「买入条件触发后」的前向收益研究工具：在「入场条件变体 × 出场参数」网格上批量算凯利公式 `f*=p-(1-p)/b`，找「信号更少但凯利更高」的方案（纯研究口径，不扣费、探索上界）。

Python harness（Phase1）已合入 main：模块在 `apps/quant-pipeline/src/quant_pipeline/research/kelly_sweep/`，CLI 跑一轮全市场约 13 分钟。首轮扫描已跑出有意义结果（最优验证集 Kelly 0.383，远超基线 0.171）。本 spec 只负责**前端操作台**这一条路线——让用户在 Web 反复探索，不重写引擎。

**本次范围**：配置 → 跑 → 看结果。**不含**「把赢家方案一键 promote 成 signal_test / 实盘候选」（属 Phase2）。

## 五个已敲定的决策（brainstorming 拍板）

1. **执行架构**：复用现有 `ml.jobs` worker + SSE 机制，新增一个 `kelly_sweep` run_type。不另造任务系统，不用 NestJS spawn 子进程。
2. **结果存储**：新建专用 DB 表 `research.kelly_sweep_results` 存全量 `ResultRow`（前端可分页/排序/逐行详情）。
3. **范围边界**：只做「配置→跑→看结果」，promote 留 Phase2。
4. **配置档位**：全量专家档——`SweepConfig` 12 个字段全部前端可调。
5. **出场网格**：暴露出场族开关（fixed_n / tp_sl / trailing / atr_stop 勾选），CLI 同步加 `--exit-families` 保证交叉验证。

## 子文档清单与阅读顺序

按下列顺序阅读（每份 < 300 行，可独立审阅）：

1. [01-architecture-dataflow.md](./01-architecture-dataflow.md) — 整体数据流、job 生命周期、复用的异步+SSE 机制、进度粒度、并发护栏。
2. [02-data-model.md](./02-data-model.md) — `research.kelly_sweep_results` 表 DDL、`ResultRow`→表字段映射、`ml.jobs` params/result_payload 约定、migration（CHECK 约束 + 建表）。
3. [03-python-runner.md](./03-python-runner.md) — `_runner_kelly_sweep` 调用链、`on_progress` 进度钩子插点、`families→exit_grid` 构造函数、CLI `--exit-families`、写库。
4. [04-nestjs-api.md](./04-nestjs-api.md) — run_type 6 处接入点、结果查询接口契约、DTO 校验、TypeORM entity 双注册、字段白名单派生接口。
5. [05-frontend-ux.md](./05-frontend-ux.md) — 页面位置/路由、配置表单与结果页 wireframe、组件拆分（≤500 行）、复用件、store。
6. [06-testing-verification.md](./06-testing-verification.md) — 测试矩阵、CLI↔Web 交叉验证、验证标准、风险与护栏。

## 跨文档引用约定

统一用**相对路径 + 锚点**：例 `[结果表](./02-data-model.md#结果表-ddl)`、`[进度粒度](./01-architecture-dataflow.md#进度粒度)`。代码位置统一 `相对仓库根路径:行号`（如 `apps/quant-pipeline/.../enumerate.py:57`）。

## 硬约束（贯穿所有子文档，必须遵守）

- Windows + PowerShell（禁 `&&`，用 `;`）；**所有源文件 UTF-8**，文件 I/O 显式 `encoding='utf-8'`，对象键名用英文。
- 后端 `dev` 无 watch：改 `apps/server` 后**必须重启**后端进程，否则新路由 404。
- DB schema 调整须随附 `docker exec` 可执行脚本；Python 侧迁移用 alembic（历史有版本脱节坑，补 migration 先 `stamp` 对齐再 `upgrade`）。
- TypeORM 新增实体须**同时**加 module `forFeature` + `app.module` 根 entities 数组（漏后者编译绿但运行时 `EntityMetadataNotFound` 500）。
- `apps/web/src/views/quant/**` 与 `components/quant/**` 单 Vue 文件 ≤500 行（CI `lint:quant-lines` 强制）。
- **进硬断言/硬编码/migration/SQL join 键的事实必须落源头核对**（实体定义、官方文档、真 DB 一条样本），禁二手转述。本 spec 内已核对的事实均标了 `file:line` 出处。
- SDD 派发子代理**禁用 git worktree 隔离**（Windows node_modules 锁），靠按不相交文件域切批次避免冲突。

## 已核对的关键源头事实（写进硬断言/DDL 的依据）

| 事实 | 出处（已亲查） |
|---|---|
| base 触发字段白名单 = `_ALLOWED_INDICATOR_FIELDS`（kdj_j/macd*/rsi*/cci/dmi*/boll*…，防 SQL 注入） | `apps/quant-pipeline/.../kelly_sweep/enumerate.py:57` |
| `ResultRow` 20 字段（落库 schema 依据；其中 `valid_keys` 不入表，见 02） | `apps/quant-pipeline/.../kelly_sweep/sweep.py:135-212` |
| 默认网格：入场候选 15 个 + 出场 53 个（fixed_n5/tp_sl36/trailing6/atr6） | `apps/quant-pipeline/.../kelly_sweep/sweep.py:62-106` |
| pipeline 调用链 `enumerate→paths→features→index→run_sweep→pareto→rank_top_k` | `apps/quant-pipeline/.../kelly_sweep/cli.py:289-392` |
| 进度回写 `update_progress(job_id, progress, stage)` → pg_notify | `apps/quant-pipeline/.../worker/progress.py:134-164` |
| 新增 run_type 漏同步 `ml_jobs_run_type_check` → INSERT 撞约束 HTTP 500（prepare/train_e2e 踩坑） | `apps/quant-pipeline/.../migrations/versions/20260606_0004_add_prepare_run_type.py` |
