# DB 表结构文档体系设计

**状态：** 待审阅（**2026-06-28 修订**：不维护 `doc/db/tables/` 与 refresh 脚本；以 `quick-guide/` 场景为核心，表结构按需 `\d` 查真库）

**日期：** 2026-06-28  
**目标：** 建立 `doc/db/` 为唯一权威的表结构文档体系，配合半自动 refresh 脚本与扩展后的 `db-inspect` skill，让 agent 按需读取必要结构、查库后沉淀快捷场景，并在 migration 后保持文档与真库一致。

---

## 1. 背景与动机

### 1.1 现状

项目**没有**与真库同步的全库表结构手册。schema 信息分散在：

| 来源 | 路径 | 问题 |
|------|------|------|
| 量化 spec | `doc/specs/2026-05-17-quant-model-training/01-pg-schema.md` | 仅覆盖 quant 四 schema；宣称「所有表 DDL」不准确 |
| 分层原则 | `doc/量化/02-数据分层与PG-schema.md` | 有过时命名（如 `raw.ts_daily`） |
| 功能 design | `docs/superpowers/specs/*/02-data-model.md` | 随功能增量；DDL 与真库可能漂移 |
| 代码 | ~82 entity + 65 NestJS migration + 21 Alembic | 权威但 agent 检索成本高 |
| db-inspect skill | `.claude/skills/db-inspect/SKILL.md` | 只读查库模板；不读/写文档 |

### 1.2 目标

1. **全表覆盖**：5 个 schema（`public` / `raw` / `factors` / `ml` / `research`）所有表均有标准结构文档。
2. **按需阅读**：agent 通过索引 + 快捷指南定位，不必每次 `\d` 或翻 entity。
3. **高频沉淀**：任务场景型快捷指南随查库迭代；全表结构在 migration 后 refresh。
4. **不偏移**：`doc/db/` 为 agent **阅读入口**（须与真库同步）；旧 spec DDL 段落废弃，仅保留设计决策。

### 1.3 已确认决策

| 项 | 决策 |
|----|------|
| 覆盖范围 | 全库所有表 |
| 快捷指南组织 | 按任务/场景（目的 → 表/列 → SQL → 表链接） |
| 单表详细度 | 标准结构（见 §4.2：列/类型/nullable/索引 + 人工 join 键） |
| 同步策略 | 半自动：脚本 refresh AUTO 段 + 人工语义注解 |
| Skill | 扩展现有 `db-inspect`（读文档 → 查库 → 按需沉淀） |
| 与旧文档 | 新体系唯一权威；旧 DDL 迁移后 redirect |

---

## 2. 总体架构

```text
                    ┌─────────────────────┐
                    │   doc/db/index.md   │
                    │ 作用 / 维护约定 /   │
                    │ 全表索引（AUTO）    │
                    └──────────┬──────────┘
           ┌───────────────────┼───────────────────┐
           ▼                   ▼                   ▼
   quick-guide/          tables/            scripts/
   任务场景路由          每表标准结构        refresh-tables.ps1
   （人工为主）          （AUTO + 人工注解）  （列/索引/索引表）
           │                   │
           └─────────┬─────────┘
                     ▼
            .claude/skills/db-inspect/
            读文档 → psql → 沉淀评估
```

### 2.1 权威源与阅读入口（两层）

**内容真源**（refresh 脚本写入依据，冲突时以此为准）：

```text
真库 information_schema  >  migration SQL / Alembic  >  TypeORM entity  >  旧 design spec DDL（已废弃）
```

**Agent 阅读入口**（查结构时的第一选择，须通过 refresh 与内容真源对齐）：

```text
doc/db/index.md  →  quick-guide/  →  tables/*/*.md  →  （兜底）docker exec \d
```

Agent 查表结构时：**优先读 `doc/db/tables/`**；仅在文档缺失、用户要求核实、或 refresh 后仍不一致时，才 `\d` 真库。

---

## 3. 目录结构

```text
doc/db/
├── index.md                      # 入口：体系说明 + 维护约定 + AUTO 全表索引
├── quick-guide/
│   ├── index.md                  # 场景目录（按任务分类）
│   └── <scenario-slug>.md        # 单场景：目的 / 表列 / SQL / 链接 / 坑
├── tables/
│   ├── public/
│   ├── raw/
│   ├── factors/
│   ├── ml/
│   └── research/
│       └── <table>.md            # 一表一文件
└── scripts/
    └── refresh-tables.ps1        # 从真库 refresh AUTO 段
```

**命名约定：**

- 表文件名：与 PG `table_name` 一致（snake_case），如 `daily_quote.md`。
- 场景文件名：kebab-case 英文 slug，如 `a-share-daily-coverage.md`。
- 对象键名、SQL 别名用英文（PowerShell GBK 兼容）。

---

## 4. 文档模板

### 4.1 `index.md`（人工 + AUTO）

必含章节：

1. **Purpose** — 本文档体系作用（agent 必读入口）。
2. **Maintenance** — 何时 refresh、何时写 quick-guide、权威源优先级、禁止双处维护 DDL。
3. **Table Registry** — AUTO 段，refresh 生成全表链接表（标记格式见下）。
4. **Related Docs** — 指向 `doc/量化/02-*`（原则）、`.claude/rules/database-sql.md`（硬规则）；旧 spec 仅历史设计链接。

**Table Registry AUTO 标记：**

```markdown
## Table Registry
<!-- AUTO:BEGIN table-registry -->
| schema | table | doc |
|--------|-------|-----|
| raw | daily_quote | [daily_quote](./tables/raw/daily_quote.md) |
<!-- AUTO:END table-registry -->
```

### 4.2 单表 `tables/<schema>/<table>.md`

```markdown
# {schema}.{table}

## Purpose
（人工）一行用途 + 数据来源/同步模块。

## Columns
<!-- AUTO:BEGIN columns -->
| column | type | nullable | default | notes |
|--------|------|----------|---------|-------|
| ts_code | character varying | NO | | |
<!-- AUTO:END columns -->
（`notes` 列不在 refresh 范围，留空供人工填写。）

## Indexes & Constraints
<!-- AUTO:BEGIN constraints -->
| name | type | definition |
|------|------|------------|
<!-- AUTO:END constraints -->

## Common Joins
（人工）典型 join 键与关联表。

## Source Links
（人工）entity / migration / 历史 design spec（如有）。
```

**新建文件时：** Purpose 默认 `<!-- TODO(purpose): 补充用途 -->`；Wave 2 补全后**删除 TODO 标记**，替换为正式描述。

### 4.3 快捷指南 `quick-guide/<scenario>.md`

```markdown
# 场景：<中文标题>

## Purpose
本次查询要回答什么问题。

## Tables & Columns
- `raw.daily_quote` — `ts_code`, `trade_date`, `close`
- ...

## Example SQL
\`\`\`sql
SELECT ...
\`\`\`

## Related Table Docs
- [daily_quote](../tables/raw/daily_quote.md)

## Pitfalls
（可选）trade_date 格式、权限、性能 LIMIT 等。
```

### 4.4 `quick-guide/index.md`

按任务域分组（示例）：

| 域 | 示例场景 |
|----|----------|
| sync / 覆盖 | A 股日线覆盖、美股 Yahoo 同步状态 |
| quant | 因子覆盖、labels、ml.jobs |
| market-data | money_flow 聚合、指数 AMV |
| strategy / backtest | （随使用增量） |

---

## 5. `refresh-tables.ps1`

### 5.1 职责

通过 `docker exec crypto-postgres psql` 查询 `information_schema`，对每个表：

1. 若 `tables/<schema>/<table>.md` 不存在 → 按模板创建。
2. 若已存在 → **仅**替换 AUTO 标记段内容。
3. 更新 `index.md` 的 `Table Registry` AUTO 段。

### 5.2 CLI

```powershell
# 首次 bootstrap 全库
./doc/db/scripts/refresh-tables.ps1 -Init

# migration 后刷新单个 schema
./doc/db/scripts/refresh-tables.ps1 -Schema raw

# 刷新单表
./doc/db/scripts/refresh-tables.ps1 -Schema raw -Table daily_quote

# 预览变更
./doc/db/scripts/refresh-tables.ps1 -Schema public -DryRun
```

### 5.3 数据查询（实现参考）

- 列：`information_schema.columns`（`table_schema`, `table_name`, `column_name`, `data_type`, `is_nullable`, `column_default`）。
- 约束/索引：`pg_constraint` + `pg_indexes`（或 psql `\d` 的等价 SQL）。
- Schema 范围：`public`, `raw`, `factors`, `ml`, `research`；排除 `pg_*`。
- **对象范围：** 仅 `information_schema.tables` 中 `table_type = 'BASE TABLE'`；**不含** VIEW / MATERIALIZED VIEW。

### 5.4 AUTO 段合并规则

```text
refresh 前文件
    │
    ├─ 找到 AUTO:BEGIN … AUTO:END → 替换中间内容
    ├─ 找不到标记 → 在 Purpose 后插入完整 AUTO 段（Init 模式）
    └─ Purpose / Common Joins / Source Links → 永不覆盖
```

### 5.5 写入与失败处理

**正常模式（无 `-DryRun`）：** 在内存中组装本次 scope 的全部文件变更，校验通过后**一次性落盘**；任一步失败则不写任何文件。

**`-DryRun` 模式：** 仅向 stdout 打印将创建/更新的文件路径与 AUTO 段 diff，**不写盘**。

`-Init`、单 schema、单表三种 scope 均遵循上述两种模式。

**失败：**

- Docker / DB 不可达 → 非零退出，不部分写盘。
- 真库无此表但 entity 存在 → 跳过并在 stderr 警告（提示 migration 未执行）。

---

## 6. 扩展 `db-inspect` skill

### 6.1 读文档流程（新增，置顶）

```text
触发 db-inspect
    │
    ▼
读 doc/db/index.md
    │
    ├─ quick-guide/index.md 有匹配场景？
    │     YES → 用场景 SQL + 表链接，必要时读单表 doc
    │
    └─ NO → 读涉及表的 tables/*/*.md
              │
              └─ 仍不足 → docker exec psql（现有模板）
```

### 6.2 查库后沉淀协议（新增）

查库结束后**必须评估**，按条件执行：

| 条件 | 动作 |
|------|------|
| 满足「可沉淀」判定（见下）且 quick-guide 无对应条目 | 新增场景 md + 更新 quick-guide/index.md |
| 发现 doc 未记录的 join/列用法 | 补单表 `Common Joins` |
| 文档列定义与 `\d` 不一致 | 运行 refresh；核对 Purpose |
| 刚提交/执行 migration | **必须** refresh 受影响 schema；检查相关场景 SQL |
| 一次性 ad-hoc | 不写 |

**「可沉淀」判定**（满足任一即可写入 quick-guide）：

1. 同一任务域内，**第二次**出现相同或等价查询模式；
2. 查询含 **non-trivial** 逻辑（多表 join、非 obvious 过滤、域特有坑）；
3. 用户明确要求「记入快捷指南」。

### 6.3 migration 后 refresh 清单（新增）

NestJS migration（`apps/server/src/migration/*.sql`）或 Alembic revision 落地后：

1. 跑 `refresh-tables.ps1` 对应 schema（或 `-Init` 若跨 schema）。
2. 若表为新建：补 Purpose、Source Links。
3. 检查 quick-guide 中引用该表的 SQL 是否仍有效。
4. 旧 `02-data-model.md` **不写 DDL**，仅确保链接指向 `doc/db/tables/...`。

### 6.4 现有模板迁移

skill 内 10 条常用查询**保留**直至首批迁移验收通过；每条加 `(→ doc/db/quick-guide/xxx.md)`。

**迁移完成条件（全部满足后可从 skill 删除 SQL 正文）：**

1. `quick-guide/` 存在与 skill § 常用查询模式一一对应的 ≥10 个场景 slug；
2. `quick-guide/index.md` 已链接全部场景；
3. skill 内每条旧模板已改为仅保留链接（无内联 SQL）。

完成后 skill 只保留连接模板 + 读文档/沉淀协议；SQL 以 quick-guide 为准。schema 列表须覆盖含 `research` 在内的 5 个 schema。

### 6.5 skill description 更新

触发词扩展：`schema 文档`、`doc/db`、`refresh-tables`、更新表结构文档、快捷检索指南。

---

## 7. 旧文档迁移

| 旧路径 | 处理 |
|--------|------|
| `doc/specs/.../01-pg-schema.md` | redirect 至 `doc/db/index.md`；删 DDL 段；保留 sync 所有权等设计段落 |
| `doc/量化/02-数据分层与PG-schema.md` | 保留分层原则；表名改为链接 `doc/db/`；修正过时命名 |
| `docs/superpowers/specs/*/02-data-model.md` | 删 DDL 段，改为一行链接 `doc/db/tables/...`；保留 design rationale |
| `CLAUDE.md` 文档地图 | 新增 `doc/db/index.md` 为 DB 结构阅读入口 |

**统一策略：** 保留原文件 + 顶部 redirect + 删除 DDL 正文段。

**禁止：** 在旧 spec 与新 `doc/db/` 双处维护同一张表的列定义。

---

## 8. Bootstrap 实施步骤

```text
Wave 1 — 骨架
  1. 创建 doc/db/ 目录 + index.md（人工约定段）
  2. 实现 refresh-tables.ps1
  3. 运行 -Init 生成全表骨架

Wave 2 — 语义补全（可分多次 session）
  4. 按 schema 批量补 Purpose / Source Links（从 entity 注释、旧 spec 摘录）
  5. 补 Common Joins（优先 raw / factors / ml 高频表）

Wave 3 — 快捷指南
  6. 从 db-inspect 现有 10 条模板迁入 quick-guide
  7. 更新 db-inspect skill（读文档 + 沉淀协议）

Wave 4 — 旧文档
  8. 旧 spec 加 redirect；CLAUDE.md 文档地图更新
```

---

## 9. 验收标准

| # | 检查项 |
|---|--------|
| 1 | `refresh-tables.ps1 -Init` 后 Table Registry 覆盖 5 schema 全部 BASE TABLE |
| 2 | 二次 `-DryRun` 无文件变更 |
| 3 | 抽样 5 表：AUTO 段与 `\d` 列/索引一致 |
| 4 | agent 路径：index → quick-guide → 单表 doc → psql，无需 `\d` |
| 5 | 模拟 migration 改列 → refresh 后 AUTO 更新、Purpose 保留 |
| 6 | 旧 spec 顶部有 redirect，无独立 DDL 维护 |

---

## 10. 非目标（YAGNI）

- 不建 ERD 图片或外链可视化。
- 不做 CI 自动 refresh（仅 skill 协议 + migration 后手动/ agent 触发）。
- 不从 TypeORM decorator 反向生成（真库为准，entity 仅 Source Links）。
- 不合并 quant `schema_contract.py` 到文档（runtime 校验保持独立）。

---

## 11. 风险与缓解

| 风险 | 缓解 |
|------|------|
| bootstrap 80+ 表 Purpose 空泛 | `TODO(purpose)` 标记 + 按 schema 分批；优先高频表 |
| refresh 覆盖人工误改 AUTO 段 | 明确标记边界；DryRun 预览 |
| quick-guide 膨胀 | index 分组 + 合并重复场景 |
| 旧 spec redirect 遗漏 | CLAUDE.md 单入口；agent 读 doc/db 优先 |
