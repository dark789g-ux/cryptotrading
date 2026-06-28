---
name: db-inspect
description: 对 PostgreSQL 数据库执行只读检查时使用。优先读 doc/db/quick-guide 匹配场景，表结构按需 docker exec psql 查询；查库后评估是否沉淀 quick-guide。触发词：查数据库、检查表、行数、数据覆盖、schema、docker exec psql、DB 状态、doc/db、快捷检索指南、quick-guide。
---

# DB Inspect（数据库检查）

## 读文档流程

触发本 skill 时**先匹配场景、再查库**：

```text
触发 db-inspect
    │
    ▼
读 doc/db/index.md → quick-guide/index.md
    │
    ├─ 有匹配场景？  YES → 用场景 SQL + Pitfalls
    │
    └─ NO → docker exec psql（连接模板见下）
              │
              ├─ 需表结构 → \d schema.table
              └─ 需 ad-hoc SQL → 自行编写 SELECT
```

**阅读入口**：[doc/db/index.md](../../../doc/db/index.md) → [doc/db/quick-guide/index.md](../../../doc/db/quick-guide/index.md)

**表结构**：不在 doc 中维护；按需执行：

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d <schema>.<table>"
```

## 查库后沉淀协议

查库结束后**必须评估**，按条件执行：

| 条件 | 动作 |
|------|------|
| 满足「可沉淀」判定且 quick-guide 无对应条目 | 新增 `doc/db/quick-guide/<scenario-slug>.md` + 更新 `quick-guide/index.md` |
| migration 改表导致场景 SQL 失效 | 更新对应 quick-guide 场景 |
| 一次性 ad-hoc | 不写 |

**「可沉淀」判定**（满足任一即可写入 quick-guide）：

1. 同一任务域内，**第二次**出现相同或等价查询模式；
2. 查询含 **non-trivial** 逻辑（多表 join、非 obvious 过滤、域特有坑）；
3. 用户明确要求「记入快捷指南」。

## migration 后检查

NestJS migration 或 Alembic revision 落地后：

1. 检查 [quick-guide/](../../../doc/db/quick-guide/) 中引用该表的 SQL 是否仍有效。
2. 旧 `02-data-model.md` **不写 DDL**；表结构以 `\d` 真库为准。

## 概述

通过 `docker exec crypto-postgres psql` 执行**只读**查询。SQL 以 quick-guide 为准；本节保留连接模板与协议。

## 连接模板

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "<SQL>"
```

多条 SQL 用多个 `-c`：

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT ..." -c "SELECT ..."
```

## 常用查询模式

场景 SQL 见 [doc/db/quick-guide/index.md](../../../doc/db/quick-guide/index.md)：

| # | 场景 | 链接 |
|---|------|------|
| 1 | 表行数 + 日期范围 | [table-row-count-date-range.md](../../../doc/db/quick-guide/table-row-count-date-range.md) |
| 2 | Schema 内表清单 | [schema-table-list.md](../../../doc/db/quick-guide/schema-table-list.md) |
| 3 | 单表结构（`\d`） | [table-structure-describe.md](../../../doc/db/quick-guide/table-structure-describe.md) |
| 4 | 因子覆盖检查 | [factor-coverage-by-version.md](../../../doc/db/quick-guide/factor-coverage-by-version.md) |
| 5 | 特定交易日因子完整性 | [factor-completeness-by-trade-date.md](../../../doc/db/quick-guide/factor-completeness-by-trade-date.md) |
| 6 | 缺失数据检测 | [missing-data-vs-expected.md](../../../doc/db/quick-guide/missing-data-vs-expected.md) |
| 7 | Quality Reports | [quality-reports-check.md](../../../doc/db/quick-guide/quality-reports-check.md) |
| 8 | ml.jobs 状态 | [ml-jobs-status.md](../../../doc/db/quick-guide/ml-jobs-status.md) |
| 9 | 标签表检查 | [labels-coverage-by-scheme.md](../../../doc/db/quick-guide/labels-coverage-by-scheme.md) |
| 10 | A 股基础表覆盖 | [a-share-symbols-coverage.md](../../../doc/db/quick-guide/a-share-symbols-coverage.md) |

## 注意事项

- **只读操作**：所有查询均为 SELECT，不要在此 skill 中执行 INSERT/UPDATE/DELETE。
- **PowerShell 编码**：SQL 中的中文在 PowerShell GBK 环境下可能乱码，优先用英文别名（AS rows, AS days）。
- **多表对比时用多个 `-c`**：比 UNION 更清晰，输出自动分段。
- **长输出截断**：加 `LIMIT` 防止输出过大；统计查询优先用 count/agg 而非 SELECT *。
- **Schema 范围**：`public`、`raw`、`factors`、`ml`、`research` 五个 schema 均可能涉及。
