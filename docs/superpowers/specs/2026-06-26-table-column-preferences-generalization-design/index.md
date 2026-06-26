# 列设置用户级持久化通用化（per-table column preferences）

## 背景与目标

**问题**：自选股表格、回测指标表的"列设置"点保存后，重新进入网页就失效——因为它们只写浏览器 `localStorage`，没做用户级持久化（换设备/浏览器/清缓存即丢）。

**目标**：把这两个表的列设置接入后端 `user_preferences`，做成**用户级**保存（跟账号走、跨设备）。

**已选方案：通用重构（方案 C）**。不是只给这两个表打补丁，而是把列偏好整体重构成 **per-table 通用接口**，让现有 5 个已持久化的表也迁到同一机制，未来任何新表零后端改动。

## 现状一句话

`ColumnSettingsDrawer` 共 7 处消费方，分两类持久化：

| 类别 | 表 | 当前持久化 |
|---|---|---|
| 已持久化（后端） | A股 / 美股 / 加密 / A股指数·同花顺 / A股指数·申万 | `PUT /preferences/symbols-view`，单行大 JSON（key=`symbols_view_columns`，写死 5 scope） |
| 未持久化（localStorage） | **自选股**、**回测指标表** | `watchlist-columns` / `backtest-metrics-columns` 两个 localStorage key |

## 方案选型（为什么 C 而非 A/B）

- **A（最小补丁）**：仅扩展现有大 JSON 加 2 个 scope。改动最小，但保留"写死 scope 枚举"的旧债。
- **B（独立 key）**：两表各开独立 key。形成两套机制。
- **C（通用重构，已选）**：废弃写死的 `SymbolsViewColumnPreferences`，改 `GET/PUT /preferences/columns/:tableId` per-table 通用接口，每表一行存储。**代价是触及 5 个当前正常工作的表（回归风险）+ 一次数据迁移**，换来统一机制与可扩展性。

## 已定决策（贯穿全文）

1. **存储粒度 = 每表一行**：key 约定 `columns:<tableId>`，value 复用 `ScopeViewPreferences`（`{table, split}`），单层表只用 `table` 槽、`split` 留空。
2. **旧数据迁移 = 一次性 SQL 脚本**：把 `symbols_view_columns` 行的 5 个 scope 拆成 5 行 `columns:<scope>`，幂等、**保留旧行**作回滚兜底。不迁则老用户 5 表设置丢失。
3. **旧 endpoint 直接废弃**：不留 `symbols-view` 兼容封装。
4. **不迁移 localStorage 历史值**：以后端为单一事实源，老用户两表本机旧设置丢弃、首次按默认列展示（用户已确认"不用管 localStorage"）。

## 子文档

| 文档 | 内容 |
|---|---|
| [01-backend-and-migration.md](./01-backend-and-migration.md) | 后端通用接口（endpoint / key / value / tableId 白名单 / sanitize 复用）+ 数据迁移 SQL/PS1 |
| [02-frontend.md](./02-frontend.md) | 前端重构：API 层、通用 composable、7 个消费方改造、同步→异步行为变化 |
| [03-testing-risks-tasks.md](./03-testing-risks-tasks.md) | 测试矩阵、风险与缓解、任务拆分（subagent 派发与依赖） |

## 建议阅读顺序

`index.md`（本文）→ `01-backend-and-migration.md` → `02-frontend.md` → `03-testing-risks-tasks.md`

## 引用约定

跨文档引用统一用相对路径 + 锚点，例如 [`./01-backend-and-migration.md#tableid-白名单`](./01-backend-and-migration.md#tableid-白名单)。所有 file:line 证据指向仓库实际代码，进迁移/硬断言的事实已落源头核对。
