# DB 查库文档

## Purpose

`doc/db/` 维护**高频查库场景**（快捷指南），供 agent 在 `db-inspect` 时优先匹配复用 SQL 与业务上下文。

**表结构不在此目录维护。** 需要列定义、索引、约束时，按需用命令行查真库：

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d raw.daily_quote"
```

也可查 TypeORM entity（`apps/server/src/entities/`）或 migration SQL（`apps/server/src/migration/`、`apps/quant-pipeline/.../migrations/`）。

覆盖 5 个 schema：`public`、`raw`、`factors`、`ml`、`research`（BASE TABLE）。

## Maintenance

| 时机 | 动作 |
|------|------|
| 高频查询可复用 | 新增或更新 `quick-guide/<scenario-slug>.md`，并登记 `quick-guide/index.md` |
| migration 改表后 | 检查相关 quick-guide 场景 SQL 是否仍有效；表结构以 `\d` 真库为准 |
| 一次性 ad-hoc | 不写文档 |

**「可沉淀」判定**（满足任一即可写入 quick-guide）：

1. 同一任务域内，**第二次**出现相同或等价查询模式；
2. 查询含 **non-trivial** 逻辑（多表 join、非 obvious 过滤、域特有坑）；
3. 用户明确要求「记入快捷指南」。

**禁止**在 quick-guide 与旧 design spec 中双处维护同一段 DDL。

## 阅读路径

```text
doc/db/index.md  →  quick-guide/index.md  →  匹配场景文件
                                              ↓ 未命中
                                    docker exec psql（见 db-inspect skill）
```

## Related Docs

- [快捷指南目录](./quick-guide/index.md)
- [db-inspect skill](../../.claude/skills/db-inspect/SKILL.md) — 查库与沉淀协议
- [数据分层原则](../量化/02-数据分层与PG-schema.md) — schema 分层与设计决策
- [database-sql 硬规则](../../.claude/rules/database-sql.md) — SQL 编写约束
