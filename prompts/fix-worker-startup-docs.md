# 修 quant Python worker 启动文档（当前命令失效）

> 本文自包含，可整段贴给全新会话接手。

## 一句话目标
让"启动 quant Python worker"的文档命令真实可用——当前文档命令直接报错。

## 现状摸底（file:line 为证，已核实）
- `apps/server/src/modules/quant/realtime/README.md:76` 写：
  `cd apps/quant-pipeline ; uv run python -m quant_pipeline.worker`
  —— **失效**：`quant_pipeline.worker` 是包、无 `__main__.py`，运行报 `'quant_pipeline.worker' is a package and cannot be directly executed`。
- 真实入口：`quant_pipeline.worker.loop:run_worker_loop`（`apps/quant-pipeline/src/quant_pipeline/worker/loop.py:35`，`def run_worker_loop() -> None`，内部 poll → dispatch 循环）。
- `apps/quant-pipeline/pyproject.toml` `[project.scripts]`（:43-45）只有 `quant = "quant_pipeline.cli:app"` 与 `lint-no-silent-degradation`，**无 worker 入口脚本**。
- 2026-06-13 实测可用的临时启动方式（从 `apps/quant-pipeline`）：
  `.venv/Scripts/python.exe -c "from quant_pipeline.worker.loop import run_worker_loop; run_worker_loop()"`

## 已定方向（A/B 可都做）
- **A**：新增 `apps/quant-pipeline/src/quant_pipeline/worker/__main__.py`，内容调用 `run_worker_loop()`，让 `python -m quant_pipeline.worker` 文档命令直接可用。
- **B**：在 pyproject `[project.scripts]` 加 `quant-worker = "quant_pipeline.worker.loop:run_worker_loop"`，文档改用 `uv run quant-worker`。
- 然后修 `realtime/README.md:76` 的命令，并 grep 全仓其它引用旧命令处（`-m quant_pipeline.worker`）一并更新。
- 建议 A+B 都做（最稳，两种调用方式都能用）。

### 开放问题
- 团队习惯用 `uv run` 还是直接 venv python？据此定文档主推命令。

## 硬约束 / 项目规范
- 不改 worker 逻辑，只补入口 + 文档；源文件 UTF-8。
- 加 `__main__.py` 须确认能正确加载根 `.env`（worker 依赖 DB 配置；项目约定 Python 子项目从仓库根加载 .env）。

## 验证标准
按更新后的文档命令能起 worker、轮询到 pending job 并处理（DB `ml.jobs` 的 pending job 被置 running）；README 命令复制即用、不报错。

## 前序进度 / 待续
全新任务，未动手。2026-06-13 phase_lock e2e 起 worker 时撞到旧命令失效，靠 `-c` 临时绕过。相关：`fix-kelly-sweep-cancel-granularity.md`、`add-orphaned-running-job-reclaim.md`。
