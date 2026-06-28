# 快捷指南

按任务域索引高频查库场景。每个场景含 Purpose、涉及表/列、Example SQL、Pitfalls。Agent 触发 `db-inspect` 时**优先在此匹配**。

阅读路径：[doc/db/index.md](../index.md) → 本页 → 场景文件；未命中则 `docker exec psql` 按需查库。

## sync / 覆盖

| 场景 | 说明 |
|------|------|
| [table-row-count-date-range](./table-row-count-date-range.md) | 表行数 + 交易日 min/max（最常用） |
| [schema-table-list](./schema-table-list.md) | 5 个 schema 内 BASE TABLE 清单 |
| [table-structure-describe](./table-structure-describe.md) | psql `\d` 查单表结构 |
| [a-share-symbols-coverage](./a-share-symbols-coverage.md) | A 股标的 master 覆盖与行业回填 |

## quant

| 场景 | 说明 |
|------|------|
| [factor-coverage-by-version](./factor-coverage-by-version.md) | 按 factor_id / version 汇总覆盖 |
| [factor-completeness-by-trade-date](./factor-completeness-by-trade-date.md) | 特定交易日各 ts_code 因子数抽查 |
| [missing-data-vs-expected](./missing-data-vs-expected.md) | expected universe vs 因子缺失计数 |
| [labels-coverage-by-scheme](./labels-coverage-by-scheme.md) | 标签按 scheme 行数与日期范围 |
| [quality-reports-check](./quality-reports-check.md) | ml.quality_reports 汇总与 critical |
| [ml-jobs-status](./ml-jobs-status.md) | ml.jobs 队列状态与最近任务 |

## market-data

（随使用增量。）

## strategy / backtest

（随使用增量。）
