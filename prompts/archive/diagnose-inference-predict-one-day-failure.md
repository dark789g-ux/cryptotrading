# 排查 test_predict_one_day_loads_meta_and_scores 失败根因

## 任务

`apps/quant-pipeline` 有一个**长期失败（pre-existing）**的单测，请查清根因并修复。先调查、后动手——遇到 bug 先用 `systematic-debugging` skill，别直接猜着改。

## 失败现象（精确）

- 测试：`apps/quant-pipeline/tests/unit/test_inference_score_writer.py::test_predict_one_day_loads_meta_and_scores`（文件第 298 行）
- 报错：`AttributeError: 'NoneType' object has no attribute 'execute'`
- 位置：`apps/quant-pipeline/src/quant_pipeline/inference/runner.py:141`
  ```python
  def _load_all_ts_codes(session: Session, trade_date: str) -> list[str]:
      sql = text("SELECT ts_code FROM raw.daily_quote WHERE trade_date = :td ORDER BY ts_code")
      rows = session.execute(sql, {"td": trade_date}).scalars().all()   # ← session 为 None
  ```

## 复现

```powershell
Push-Location apps\quant-pipeline
uv run pytest "tests/unit/test_inference_score_writer.py::test_predict_one_day_loads_meta_and_scores" -q --tb=long
Pop-Location
```

## 已确认的边界（来自先前会话）

- 该失败与近期 `close_adj 改纯后复权`（commit `83aeda0`）**无关**——已用 `git stash` 把那次改动撤掉后在 baseline 复现，同样在 `runner.py:141` 失败。即它是**早就存在**的，不是新引入。
- `tests/unit` 全量当前 = 773 passed, 1 failed（就是这一个）。修好后应为 774 passed。

## 初步观察（线索，请自行验证、勿当定论）

测试 `test_predict_one_day_loads_meta_and_scores`（第 298-355 行）这样构造：
- 用 `session=None` 调 `predict_one_day("x", "20260517", session=None)`（第 351 行）。
- monkeypatch 了 `_load_model_run`、`_resolve_artifact_local_path`、`_load_daily_feature_section` 三个函数。
- **没有** monkeypatch `_load_all_ts_codes`。

而 `predict_one_day`（`runner.py:145`）的执行路径里调用了 `_load_all_ts_codes(session, trade_date)`，该函数用真 `session.execute` 查 `raw.daily_quote` → `session=None` 直接炸。

一个值得追的点：`_load_daily_feature_section`（已被 patch）返回的 df **已经带 5 行 ts_code**（`S0..S4`），而 `_load_all_ts_codes` 又**单独**去查 `raw.daily_quote` 取全部 ts_code。为什么 `predict_one_day` 既要特征 df、又要单独查一次当日全部 ts_code？（可能用于"特征缺失的票补齐/行数对齐/截面校验"——请读 `predict_one_day` 全文确认它拿 `_load_all_ts_codes` 的结果做什么。）这决定了正确修法。

## 请查清

1. 用 `git log -p` / `git blame apps/quant-pipeline/src/quant_pipeline/inference/runner.py` 找出 `_load_all_ts_codes` 调用是**哪次 commit 引入**到 `predict_one_day` 路径的，以及为何该测试当时没同步更新（测试早于该调用？改 `predict_one_day` 时漏改测试？）。
2. 判断**根因到底是测试还是实现**，不要预设：
   - 若 `_load_all_ts_codes` 是 `predict_one_day` 的合理设计（确需当日全量 ts_code），则测试应补 monkeypatch 它；
   - 若该调用其实可从已加载的特征 df 推导、或属冗余/越权 IO，则应改 `predict_one_day`。
3. 确认 `raw.daily_quote` 的列名 `ts_code` / `trade_date` 属实（落源头，别凭代码推断——见 `.claude/rules/data-integrity.md`）。

## 验收

- [ ] `test_inference_score_writer.py` 全绿。
- [ ] `uv run pytest tests/unit` 不回归（应 774 passed）。
- [ ] 修复方式与根因匹配（在 commit message / 说明里讲清是"测试漏 patch"还是"实现问题"，附 git blame 证据）。

## 约束

- 子项目 `apps/quant-pipeline` 是 Python（uv + pytest），命令在该目录下 `uv run ...`。
- 遵循 `CLAUDE.md`：中文回答、暴露权衡、`systematic-debugging` 先调查后改、修复走 `test-driven-development`。
- 与 `close_adj` 改动无关，请在 `main` 或独立分支上修，**不要**混进 `feat/close-adj-pure-hfq`。
