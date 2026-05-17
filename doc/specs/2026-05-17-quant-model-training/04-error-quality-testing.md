# 错误处理 / 数据质量门禁 / 测试策略

> 本文档是 [00-index.md](00-index.md) 的子文档。M2 起所有里程碑 agent 都必须读本文档。

## 1 错误处理总则

- **同步任务失败必须显式在响应体 `errors[]` / `failedItems[]` 中透出**（CLAUDE.md 既立硬规矩）。Python `sync` 模块对应：`tushare_client` 三种空数据情形（`data=None` / `items=[]` / `code≠0`）必须**分路径** `logger.warn(api_name, params)` 并把 `<api_name>_empty` 写 `ml.quality_reports`
- **Python worker 任何未捕获异常必须把 traceback 全量写到 `ml.jobs.error_text`** 并把 `status='failed'`；禁止 `except: pass`；禁止 `try / except / log / continue` 静默吞错
- **NestJS controller 报 500**：开 TypeORM `logging:['error','warn']` + `logger.error(err.stack)`，禁止静态分析猜
- **PG 作业队列并发安全**：worker 取 job 用 `SELECT ... FROM ml.jobs WHERE status='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`
- **artifact 写盘失败处理**：`./artifacts/{model_run_id}/` 写不进去 → job `failed` + 清理半成品目录；不允许 `model.txt` 落库但 metrics 没写完的半态

## 2 数据质量门禁（最致命，独立成节）

- **训练前必检**（M2 起强制）：当日因子表行级硬约束 + 跨表对齐 + PIT 三铁律全绿才允许进 `training/runner.py`；否则 job 直接 `status='blocked'` + `blocked_reason='<rule_name>'`
- **推理前必检**（M2 起强制）：当日 `raw.daily_quote` 完整（行级 OHLC 非空 + 与上一交易日股票数差 < 5%）才允许 `inference`；否则 `ml.scores_daily` 不允许写入当日（避免半量评分误导前端）
- **5% 阈值的边界**：节假日前后 / 科创板批量上市当周 / 大规模摘牌期 5% 易误杀。允许通过 `params.row_count_drift_threshold` 在调用方按交易日维度临时放宽到 10%，但需在 `ml.quality_reports` 记一条 `level='info'` 的"阈值临时放宽"事件留痕
- **门禁不可被 `--force` 绕过**——CLI 不提供该旗标；要绕只能改代码（被代码评审拦截）
- **CLAUDE.md "fetcher 返回 0 行必须显式 failedItems" 同样适用**：sync 模块的 fetcher 返回空必须 push 到响应体 `failedItems`（`api_name` 标 `daily_empty` / `adj_factor_empty` / 等），让前端 / 日志立即可见
- **Python 侧 `logger.warn` 双写**：CLAUDE.md 原文以 NestJS 为语境。Python `tushare_client` 与各 runner 在记录 warn 时，**同时**做两件事：(1) 结构化 JSON 日志（含 `job_id` 上下文）；(2) `INSERT INTO ml.quality_reports`（rule + detail）。两者缺一不可——日志方便实时排查，DB 行让前端 quality 看板可见

## 3 测试策略

| 层级 | 范围 | 工具 |
|---|---|---|
| 单元 | 每个 factor / label / 工具函数 | pytest + pytest-cov（阈值 80%） |
| 契约 | TuShare 接口字段、PG schema | pytest + 真实小样本回归（人工对照后冻结） |
| 集成 | sync → factors → labels → train → infer 全链路 | pytest + docker-postgres 一次性测试库 |
| NestJS | controller + service | Jest（项目已有约定） |
| 端到端 UI | quant 三视图主流程 | **手测打卡**（不引 Playwright；不要求自动化） |

**单测红线**：
- 因子 / sync 单测使用 mock 数据时，必须同时存在一份"小样本真实数据"集成测试（避免 CLAUDE.md 的 "mock 单测不验证第三方契约" 陷阱）
- `# TODO: 查文档确认` 的接口调用不得视为完成，含此注释的代码不允许合入主干

**集成测试库管理**：本地用 `docker compose -f docker-compose.test.yml` 起一个固定容器名 `crypto-postgres-test`，端口 `15432`（避开生产 `5432`）；pytest fixture `db_session` 在每次 session 起前 `DROP SCHEMA raw, factors, ml CASCADE` 再用 Alembic / 手写 migration 重建，保证隔离。

**Vue 单文件 ≤ 500 行 CI 校验**（M4 交付物 9）：在 `apps/web` 加一份 pre-commit hook 或 lint rule，扫描 `views/quant/**` 与 `components/quant/**` 下 `.vue` 文件总行数，超 500 直接 fail。校验脚本作为该 M4 交付物的一部分被 review。
