# M1 · 因子库 v1 + PIT 检测（2 周）

> 本里程碑文档是 [00-index.md](00-index.md) 的子文档。
> **实施 agent 必读**：[01-pg-schema.md](01-pg-schema.md)、[02-quant-pipeline.md](02-quant-pipeline.md)、[04-error-quality-testing.md](04-error-quality-testing.md)。
> **方法论参考**：`doc/量化/03-PIT与数据质量.md`、`doc/量化/07-行业板块因子.md`。

## 目标

产出 doc/07 MVP 约 30 维因子（量价 20 + 行业派生 10），通过 PIT 审计。

## 交付物

1. `factors/base.py` 抽象类，含 PIT 窗口声明 API
2. **30 个因子实现 + 每个一份单测**（PIT 窗口 / 极值 / 缺失 / 复权）
3. `factors.daily_factors`（按 `factor_version` 分区）写入完成，覆盖 2018 至今
4. 数据质量门禁 doc/03 八项 + 落 `ml.quality_reports`（rule 清单见 [01-pg-schema.md](01-pg-schema.md) §4.3）
5. PIT 自动审计（doc/03 三铁律 + 三幽灵 Bug 检测）作为独立 `quant quality pit-audit` 命令
6. **Python 侧** `apps/quant-pipeline/sync/` 新增 `raw.stk_limit / raw.suspend_d / raw.index_classify / raw.index_member / raw.fina_indicator / raw.trade_cal` 6 张表的同步实现（[01-pg-schema.md](01-pg-schema.md) §5 所有权划分）；NestJS sync 不动既有 5 张表，但 entity / repo 要能只读新 6 张表

## 验收门槛

- 每个因子的 PIT 单测全绿
- 历史日（如 2024-06-30）抽 5 个因子人工核对值（与 TuShare 原始数据 / 公开行情对照）
- 行级硬约束：所有非 NULL 因子在合规交易日 100% 非空（doc/03 最弱可接受标准）
- 跨表对齐：`count(factors.daily_factors WHERE trade_date=X) >= count(raw.daily_quote WHERE trade_date=X)`
- `fina_indicator` 必须以 `ann_date` 而非 `end_date` 入库（PIT 铁律）

## 任务拆解（建议交付顺序）

| # | 任务 | 文件域 | 估时 |
|---|---|---|---|
| 1 | `factors/base.py` 抽象类设计（PIT 窗口声明 / 注册表接口） | `apps/quant-pipeline/src/quant_pipeline/factors/base.py`、`registry.py` | 1 天 |
| 2 | Python sync 新增 6 张表（trade_cal 优先，其它依赖它） | `apps/quant-pipeline/src/quant_pipeline/sync/` | 3 天 |
| 3 | NestJS 只读 entity / repo（6 张新表） | `apps/server/src/entities/a-share/`（沿用 raw schema） | 0.5 天 |
| 4 | 量价因子 20 个（动量 / 波动率 / 成交量等） + 单测 | `apps/quant-pipeline/src/quant_pipeline/factors/price/` + `tests/unit/` | 3 天 |
| 5 | 行业派生因子 10 个 + 中性化 + 单测 | `apps/quant-pipeline/src/quant_pipeline/factors/industry/` | 2 天 |
| 6 | `factors/runner.py` + 历史回填（2018 至今） | `apps/quant-pipeline/src/quant_pipeline/factors/runner.py` | 1 天 |
| 7 | quality 八项检验 + PIT 三铁律审计 | `apps/quant-pipeline/src/quant_pipeline/quality/` | 2 天 |
| 8 | 历史日人工核对 + 验收报告 | 文档 | 0.5 天 |

## 与其它里程碑的依赖关系

- 依赖 M0 完成（schema 已就位、worker 骨架可跑）
- 阻塞 M2：M2 的训练特征矩阵需要本里程碑的 `factors.daily_factors` + Python sync 已就位

## 风险与注意事项

- ⚠️ TuShare `fina_indicator` 在 7000 积分下的实际权限以 M1 首次拉数据为准（[05-risks.md](05-risks.md) §5）；若发现接口空数据，按 [04-error-quality-testing.md](04-error-quality-testing.md) §1 三种空路径分别 `logger.warn` + 落 `ml.quality_reports`
- ⚠️ 行业派生因子必须用 PIT 安全的 `index_member`（**当时**成份股，不是当前成份股）；这是 doc/03"三幽灵 Bug"之一
- ⚠️ 复权陷阱：因子计算前必须用 `adj_factor` 反推后复权价；单测中故意构造一笔分红事件验证
- ⚠️ Python sync 新增的 6 张表 upsert 前必须按 PK 去重（CLAUDE.md 既立硬约束）；遇到 TuShare 返回重复行需 `logger.warn` 注明原始条数与去重后条数
