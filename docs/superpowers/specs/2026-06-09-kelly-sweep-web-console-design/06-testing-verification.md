# 06 · 测试与验证

← 返回 [index.md](./index.md)

## 测试矩阵

| 层 | 测试 | 要点 |
|---|---|---|
| Python | `build_exit_grid` 单测 | 子集过滤正确；空 families 报错；未知 type 报错（fail-fast） |
| Python | `on_progress` 回调单测 | 各函数传 callback 时被按 `(done,total)` 调用；不传（None）时行为与改前逐字一致 |
| Python | `_runner_kelly_sweep` 单测 | 从 params 正确构造 SweepConfig；调用链顺序对；写库字段映射对（可对小型 fixture DB 或 mock） |
| Python | `persist_results` 单测 | is_frontier/is_topk 标注正确；jsonb 序列化 UTF-8（`ensure_ascii=False`）；写前删旧行幂等 |
| Python | **`--self-check` 锚点复现** | Kelly 0.1755≈0.171 不被改动破坏（回归护栏） |
| NestJS | DTO 校验单测 | 12 字段 + exit_families 边界；`industry` 拒绝；`base_trigger.field` 非白名单拒绝；日期顺序约束 |
| NestJS | 查询 service 单测 | 分页/排序/RS 分组取数；sort 列白名单防注入；group 必填 |
| 前端 | `type-check` | `pnpm --filter @cryptotrading/web type-check` 全绿 |
| 前端 | 组件单测（vitest） | 组合数预估计算；散点 option 生成；表格排序 |
| 前端 | `lint:quant-lines` | 所有新 Vue 文件 ≤500 行 |
| DB | migration 幂等 | `IF NOT EXISTS`/`DROP IF EXISTS`；重复执行不报错；CHECK 是旧约束真超集 |

## 交叉验证（验证标准硬要求）

「Web 层不得引入口径漂移」——沿用 harness 自校验哲学。**同一组配置**，Web 跑出的结果应与直接跑 CLI 同参数产出的 `top_k_ranking.csv` 一致：

```text
1. 选一组配置(如 base kdj_j<0, max_entry_filters=1, exit_families=fixed_n,tp_sl,
   train 2023~2024, valid 2025~今)
2. CLI:  python -m quant_pipeline.research.kelly_sweep.cli \
           --base-field kdj_j --base-op lt --base-value 0 \
           --exit-families fixed_n,tp_sl --max-entry-filters 1 \
           --train-start 20230101 ... --output-dir <dir>
         → 得 top_k_ranking.csv
3. Web:  同参数发起 kelly_sweep job → 等完成 → 查 research.kelly_sweep_results
         WHERE job_id=? AND is_topk ORDER BY kelly_valid DESC
4. 比对: 两侧 top-K 的 (variant_id, exit_id, kelly_valid, n_valid) 逐行一致
         (浮点按容差比, 沿用 harness 锚点 0.1755≈0.171 的容差哲学)
```

零漂移的结构性保证：runner 复刻 CLI 的 `_run_sweep_pipeline` 调用链 + **runner/CLI 共用 `build_exit_grid`**（见 [03](./03-python-runner.md#familiesexit_grid-构造函数防口径漂移)）。

## 端到端真机验证

1. 启动 DB + server + web + Python worker（`pnpm dev` + worker 进程）。
2. 改 `apps/server` 后**重启后端**（无 watch，否则新路由 404）。
3. Web 配置一组参数 → 发起 → 观察进度条实时推进（含「网格扫描 N/M 变体」细推）。
4. 完成后看到帕累托前沿散点 + top-K 排行 + 逐行详情，含/不含 RS 两组分开。
5. 异常路径：故意传非法配置（如 industry 基准、空 exit_families）→ 看到清晰报错而非静默/500。

## 白名单一致性检查项

base 字段白名单跨语言有一份「人工对齐」的重复（Python `enumerate.py:57` ↔ NestJS meta 常量，见 [04](./04-nestjs-api.md#字段白名单派生接口避免前端硬编码漂移)）。加一条 CI 或评审检查：两处成员集合一致；改 Python 白名单时必须同步 NestJS。

## 风险与护栏小结

| 风险 | 护栏 |
|---|---|
| 新增 run_type 漏更新 CHECK 约束 → HTTP 500 | [02](./02-data-model.md#动作-1ml_jobs_run_type_check-加入-kelly_sweep) 明确列为必做项；端到端验证发起一次即暴露 |
| TypeORM 实体漏根注册 → EntityMetadataNotFound 500 | [04](./04-nestjs-api.md#typeorm-entity-双注册) 强调双注册 |
| alembic 版本脱节 → 重跑撞「已存在」 | 补 migration 先 `stamp` 对齐再 `upgrade`；DDL 全 IF NOT EXISTS |
| 进度卡在 55% 6 分钟 | 网格段按变体细推 |
| Web/CLI 口径漂移 | 共用 `build_exit_grid` + 复刻调用链 + 交叉验证 |
| 同时多扫吃满 CPU | worker 单进程串行天然限一个 + 前端软提示 |
| 组合数爆炸（max_entry_filters=2） | 前端组合数预估 + >5000 ⚠ |
| 中文/编码 | 源文件 UTF-8；jsonb `ensure_ascii=False`；对象键名英文 |

## SDD 切批次建议（按不相交文件域，禁 worktree）

| 批次 | 文件域 | 依赖 |
|---|---|---|
| B1 DB/migration | alembic revision + `.sql`/`.ps1` | 无（先行） |
| B2 Python runner | `kelly_sweep/*`（on_progress、build_exit_grid、persist）、`worker/dispatcher.py`、`cli.py` | B1 表就绪 |
| B3 NestJS | entity + dto + controller/service + module 注册 | B1 表就绪 |
| B4 前端 | `views/quant/kelly-sweep/*`、`components/quant/kelly-sweep/*`、api、store | B3 接口契约 |
| B5 测试+交叉验证+真机 | 各层测试 + CLI↔Web 比对 | B1–B4 |

B2/B3 可并行（不相交文件域）；B4 依赖 B3 的接口契约（契约已在 [04](./04-nestjs-api.md) 固定，可契约先行并行）。
