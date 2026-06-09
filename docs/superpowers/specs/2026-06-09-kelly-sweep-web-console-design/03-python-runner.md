# 03 · Python 侧改动（runner + 进度钩子 + CLI）

← 返回 [index.md](./index.md)

核心原则：**不动计算逻辑**，只加进度钩子和一个 runner 入口。所有改动对现有 CLI/测试路径默认无影响（`on_progress` 默认 `None`）。

## `_runner_kelly_sweep(job)` 入口

新增到 `apps/quant-pipeline/.../worker/dispatcher.py`，并注册进 `_ROUTES`（`dispatcher.py:358-377` 加 `"kelly_sweep": _runner_kelly_sweep`）。它复刻 CLI 的 `_run_sweep_pipeline`（`cli.py:289-392`）调用链，差别只在：从 `job.params` 读配置、传 `on_progress`、跑完写库（而非写 CSV/MD）。

```text
_runner_kelly_sweep(job):
  cfg = SweepConfig(**parse_params(job.params))          # 12 字段
  families = job.params["exit_families"]
  exit_grid = build_exit_grid(families)                  # 见下, runner/CLI 共用
  prog = make_progress_bridge(job.id)                    # 桥接 update_progress

  signals = enumerate_signals(cfg, on_progress=prog.stage("enumerate", 0, 15))
  paths   = load_forward_paths(signals, cfg.max_window,
                               date_end=cfg.valid_range[1],
                               on_progress=prog.stage("paths", 15, 35))
  xs_df, hist = load_feature_inputs(signals, on_progress=prog.stage("features", 35, 50))
  idx_df  = load_index_daily(bench_codes, (cfg.train_range[0], cfg.valid_range[1]),
                             on_progress=prog.stage("index", 50, 55))
  rows    = run_sweep(cfg, signals, paths, xs_df, hist, idx_df,
                      exit_grid=exit_grid,
                      on_progress=prog.stage("sweep", 55, 90))   # 按变体细推
  pareto  = compute_pareto_frontier(rows)
  topk    = rank_top_k(rows, cfg, paths, on_progress=prog.stage("ci", 90, 100))
  persist_results(job.id, rows, pareto, topk)            # 写 research.kelly_sweep_results
  return summary_payload(rows, pareto, topk)             # → ml.jobs.result_payload
```

## on_progress 钩子插点

给下列函数各加形参 `on_progress: Optional[Callable[[int, int], None]] = None`（`(done, total)`）。**默认 None → 现有 CLI/单测调用零改动**。约 6 处函数签名 + 内部循环插点：

| 函数 | 文件 | 插点 |
|---|---|---|
| `enumerate_signals` | `enumerate.py` | 各过滤阶段后 emit 一次（粗粒度即可） |
| `load_forward_paths` | `paths.py`（def @88，插点参考 :133） | 按已加载信号数 emit |
| `load_feature_inputs` | `paths.py` | 截面计算前后 emit |
| `load_index_daily` | `paths.py` | 加载完 emit |
| `run_sweep` | `sweep.py:661` 外层 `for variant` | **每完成一个变体 emit `(i+1, n_variants)`** ← 关键长段 |
| `rank_top_k` | `report.py:126` bootstrap CI 循环 | 每算完一行 CI emit |

`make_progress_bridge(job_id)` 提供 `.stage(name, lo, hi)`，把子函数的 `(done,total)` 缩放到 `[lo,hi]` 全局百分比，再调 `update_progress(job_id, pct, stage=f"{中文阶段} {done}/{total}")`。可借鉴现有 `make_scaled_callback`（`worker/progress.py:34-66`）的缩放思路。

> **为何侵入式加参数而非包装**：网格扫描 6 分钟长段必须按变体细推，否则进度卡死；纯计算函数内部无外部观测点，只能在循环里插回调。`Optional` 默认 None 把侵入降到最低——CLI、单测、`--self-check` 路径完全不传，行为逐字不变。

## families→exit_grid 构造函数（防口径漂移）

新增 `build_exit_grid(families: list[str]) -> list[dict]`，从 `DEFAULT_EXIT_GRID`（`sweep.py:90-106`）按 `type` 字段过滤出勾选族的子集。**runner 和 CLI 共用同一个函数**——这是「Web 与 CLI 同参数结果一致」的关键保证：

```text
build_exit_grid(["fixed_n", "tp_sl"]):
  return [cfg for cfg in DEFAULT_EXIT_GRID if cfg["type"] in {"fixed_n","tp_sl"}]
  # 空 families 或全选 → 等价 DEFAULT_EXIT_GRID(53 个)
```

边界：families 为空 → 报错（至少选一族）；含未知 type → 报错（fail-fast，禁默默忽略）。

## CLI 加 `--exit-families`

`cli.py` argparse 加 `--exit-families`（逗号分隔，默认全选=四族）。`_run_sweep_pipeline` 用同一个 `build_exit_grid` 构造 `exit_grid` 传给 `run_sweep`。这样同一组配置：

```
python -m quant_pipeline.research.kelly_sweep.cli \
  --base-field kdj_j --base-op lt --base-value 0 \
  --exit-families fixed_n,tp_sl --max-entry-filters 1 ... --output-dir <dir>
```

与 Web 端传 `exit_families:["fixed_n","tp_sl"]` 产出的 `ResultRow` 必须逐行一致（交叉验证见 [06](./06-testing-verification.md#交叉验证验证标准硬要求)）。

## 写库 `persist_results`

新增模块（如 `kelly_sweep/persist.py` 或 worker 侧）把 `rows` + `pareto`（标 is_frontier）+ `topk`（标 is_topk）合并后**批量** INSERT 到 `research.kelly_sweep_results`：

- 用 SQLAlchemy `text()` 批量插入（与 worker 既有裸 SQL 风格一致，`db/schemas.py` 不映射 ORM 实体）。
- `variant_filters`/`exit_cfg` → `json.dumps`（确保 `ensure_ascii=False`、UTF-8）。
- is_frontier/is_topk 由 runner 在内存中用 `compute_pareto_frontier`/`rank_top_k` 的结果集标注后写入（同一 job 一次性写全表，幂等性靠「写前按 job_id 删旧行」或「job 仅跑一次」保证；推荐写前 `DELETE WHERE job_id=?` 防重试残留）。

## 不破坏既有自校验

`--self-check`（`cli.py`）复现锚点 Kelly 0.1755≈0.171 的逻辑不得受影响：`on_progress` 默认 None、`build_exit_grid` 全选时等价 `DEFAULT_EXIT_GRID`，self-check 路径行为与改动前逐字一致。测试见 [06](./06-testing-verification.md)。
