# 05 · 阶段0 前置条件、阶段5 验证标准、错误处理/回滚

[← 返回 index](./index.md) · 上一篇 [04 重算与级联](./04-recompute-and-cascade.md)

## 阶段0 前置条件（只读，开工前逐项确认）

```text
□ 重查真DB现状(01 的重查命令), 记录两 scheme / 两 fs 的真实 dmax —— 范围动态取, 不硬编码
□ 代码树在 6779c79+ : git log --oneline -3 应见 6779c79 / 172e5f4
□ 删 __pycache__ 防陈旧 .pyc:
    Get-ChildItem apps\quant-pipeline -Recurse -Directory -Filter __pycache__ | Remove-Item -Recurse -Force
□ alembic 已 head (20260606_0004): cd apps\quant-pipeline; uv run alembic current
□ 腾内存到 4–6G 空闲(关浏览器/IDE/重进程; 保留 docker postgres + 不并发 worker job)
□ ml.jobs 无 in-flight: SELECT id,run_type,status FROM ml.jobs WHERE status IN ('pending','running');
    重算窗口内不触发任何 prepare/train job(避免叠加内存 + 表竞争)
```

> 说明：因驱动用 `uv run python` 直调当前代码树，不依赖 worker 进程的代码版本；"删 __pycache__" 是为防直调时加载到陈旧 .pyc。

## 阶段5 验证标准

### 重算前
临时 scheme diff 量化差异（[03](./03-measure-and-calibrate.md) 已完成），决定要不要做、做哪些 scheme。问题③ 必须 PASS。

### 重算后（逐 scheme + 逐 fs）

```text
□ 抽样次新股: list_date<20230103 但上市<60交易日的票, 在早期被正确剔
    (取几个具体 ts_code, 对比重算前后该票早期行是否消失)
□ close≈ma5 边界点: 拿探查 W2 里翻转的样本, 核对 exit_reason 用新值
□ 无幽灵行: 重算后该 scheme 不存在"新码不产出却仍在表"的行(验 DELETE 生效)
□ 总行数变化合理: 较旧值略减(bug3 更严格), 减量与探查外推吻合
□ feature_matrix 行数 ≤ labels 且按 (trade_date,ts_code) 对齐
□ fs 指纹未变: 重建后仍是 fs_60bc257fb173 / fs_9b5ff4d69c1e (护门已断言, 重算后再确认行落对 fs)
```

### 全量回归
```powershell
cd apps\quant-pipeline; uv run pytest -q   # 基线 941 passed
```

## 错误处理 / 回滚（用户选了不备份）

- **安全网 = 阶段1 探查门**：动 prod 前已证 ①新码口径正确 ②月度驱动==整段。过不了门**绝不 DELETE**。
- **唯一不可逆 = DELETE**：独立步、二次确认；其后月度循环幂等可续，崩溃重跑自收敛（window-invariant 保证），禁忌仅"别重 DELETE"。
- **OOM / 崩溃**：重跑循环跳过已物化月即可；反复 OOM → 降 chunk 粒度（季→月→双周）重跑。
- **并发护栏**：窗口内 `ml.jobs` 无 in-flight 且不触发 job；两 scheme 串行。
- **失败可见**：任何 chunk 异常立即停 + 打印 `scheme + date_range + 异常`，不 `.catch(()=>[])` 静默吞（data-integrity 规范）。
- **无快速回滚的代价显式承认**：一旦 DELETE 后重算反复失败且无法恢复，受影响 scheme 需从头重算（数据来源是 raw 行情，确定性可重建，但耗时）。这是"不备份"的已知代价，已与用户确认。

## 执行产出与交接

- 探查报告（[03 收尾](./03-measure-and-calibrate.md#收尾与产出)）。
- 重算后：更新记忆 `project_labels_features_incremental_prepare`，记录实际重算了哪些 scheme、行数变化、是否重训/promote 模型。
- 决策门处、模型 promote 处均为人工确认点，不自动续跑。
