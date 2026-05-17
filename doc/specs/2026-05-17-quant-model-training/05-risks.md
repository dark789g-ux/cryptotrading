# 风险与开放议题

> 本文档是 [00-index.md](00-index.md) 的子文档。M0 / M4 agent 必须读；M1-M3 agent 推荐读相关条目。

## 1 Roadmap 90 天压在本地 Windows 单机能否跑动

LightGBM CPU 训练对 5500 支 × 6 年 × 30 因子 × Walk-Forward 6 fold 是分钟级，可接受；Optuna 50 trial 是数小时级，过夜可。若后续因子膨胀到 100+，需考虑迁到 Linux server。**M4 复盘报告里给出"是否需要扩容"的判断**，本 spec 不预设云方案。

## 2 strategy-aware labeling 与未来 A 股回测引擎的对齐风险

（已纳入 M2 显式交付物）

labeling 模拟的出场规则（MA5 / -8% 止损 / max_hold 20）必须与未来 A 股回测引擎用同一份代码。**M2 实现时把 `strategy/exit_rules.py` 抽出为可被回测引擎 `import` 的独立模块**，并在该模块顶部用注释明确声明此约束。

## 3 A 股 daily 频回测引擎当前不存在

现有 `BacktestRunner` 仅服务加密。若未来要把模型评分接入"A 股模拟盘"，需另起一份 "A 股 daily 回测引擎" spec。**本 spec 明确不包含此项**。

## 4 数据迁移期 NestJS 与 Python 的发布顺序

必须 NestJS entity 切到 `raw` 之后立即跑 migration，再启动 Python sync。中间窗口内既有 NestJS 同步会失败。**M0 验收要求附 "6 步发布序列 + 2 步回滚序列" 作为 README 一节**（[01-pg-schema.md](01-pg-schema.md) §6 已给出原型，含 git tag `quant-migration-base`）。

## 5 TuShare 7000 积分对 P1 财务接口的覆盖度需验证

doc/06 说够用，但 `fina_indicator` / `disclosure_date` 等接口的实际权限要在 M1 首次拉数据时确认。若不足需触发"是否升级积分"议题，**不在本 spec 范围内决策**。

## 6 Windows 路径分隔符在 artifact_uri / log_url 上的跨平台陷阱

全程用 POSIX 风格存库（`./artifacts/<uuid>/model.txt`），不存盘符；前端下载链接由 NestJS 拼当前主机 base URL。Python 侧用 `pathlib.PurePosixPath` 序列化。

## 7 PG LISTEN/NOTIFY 跨进程注意事项

（已在 [00-index.md](00-index.md) §3 通信契约中定义具体行为）

独立长连接 / 重连后重新 LISTEN / 订阅者断开清理 / NOTIFY payload ≤ 1KB。

## 8 Worker 崩溃与 reaper 死锁

reaper 把 `status='running'` 行回收为 `pending` 是基于 `heartbeat_at` 超时，但如果**所有** worker 都崩溃同时无人启动 reaper，job 永远不会被回收。reaper 必须在 Python worker 启动时**先跑一次**（覆盖上一次崩溃留下的 orphan），并在常驻轮询里每 60 秒跑一次。**reaper 与 worker 同进程同生命周期**，避免出现"reaper 在跑但 worker 全死"的诡异态。

## 9 Optuna RDB storage 的 schema 占用

Optuna 用 PG RDB storage 时会在指定 schema 下建一组自带表（`studies`、`trials`、`trial_values` 等）。spec 决策：放在 `ml` schema 下（前缀 `optuna_*`），与 `ml.jobs` 并列；不放 `factors` / `raw`。Alembic migration 不管理 Optuna 自建表，由 Optuna 库自己 `optuna.create_study(..., storage=..., load_if_exists=True)` 触发。
