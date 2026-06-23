# 大盘宽基动态范围（管理页面）— 设计

> 独立 spec。与 `2026-06-23-sw-index-integration-design` 无代码耦合，
> 唯一共享文件域是 `one-click-sync/`（两任务各加一个 step），见 [03-one-click-sync.md](./03-one-click-sync.md)。

## 一句话目标

把大盘宽基指数（`category='market'`）的拉取范围从**硬编码 8 个白名单**（`MARKET_INDEX_LIST`）改为**前端管理页面维护的动态范围**：用户在 sync 域管理页面点「从 index_basic 发现候选」（~158 个基础宽基，规则预标噪声），勾选纳入范围，持久化后既当前端大盘 Tab 目录、又当同步清单。

## 背景

现状大盘同步是**孤岛**：`MarketIndexSyncService` 遍历硬编码 `MARKET_INDEX_LIST`（8 个）逐个拉 `index_daily`，入口 `GET /api/ths-index-daily/sync/market`（AdminOnly），**不在一键同步、前端无 UI**（`useThsIndexDailySync.ts` 死代码）。用户原始诉求"动态拉全大盘宽基（怕漏/怕人为只挑 8 个）"，实拉 `index_basic` 发现"全拉"含大量噪声（158 个基础宽基里仅 ~30 主流，其余跨境/退市/收益版/中小盘）。A 股大盘宽基是 ~30 的收敛集（非开放集）。

**方案 D2**（拍板）：动态发现 + 前端管理页面勾选 —— 动态发现解决"怕漏"，UI 管理解决"噪声/可控"。

## 数据流

```text
  [管理页面 /sync 大盘宽基范围] 点"发现候选"
        │
        ▼
  Tushare index_basic (market=SSE/SZSE/CSI, category=规模/综合指数)
        │ ~158 个基础宽基
        ▼ 即时算 noise_tag（退市/跨境/收益版/多挂牌）
  候选清单（带噪声标签，「隐藏疑似噪声」默认开）
        │ 用户勾选「加入范围」/「移除」
        ▼ upsert(add) / delete(remove)
  ths_index_catalog (type='M') ◄═══ 范围真源（单一数据源）
        │
        ├─▶ MarketIndexSyncService 读 type='M' 全部 tsCode（替代 MARKET_INDEX_LIST）
        │        │ 5 年分段拉 index_daily
        │        ▼
        │   index_daily_quotes (category='market') → recalculateForSymbols
        │
        └─▶ 前端「大盘」Tab（n-select 大盘选项，数据动态来自范围）
```

## 已定决策（2026-06-23 brainstorming 拍板）

1. **方案 D2**：动态发现 + 前端管理页面勾选（不做纯手动添加）
2. **管理页面放 sync 域**（`/sync` 加 tab「大盘宽基范围」）
3. **范围真源 = `ths_index_catalog` `type='M'`**（零新表/零新字段/零 migration，见 [01](./01-data-model.md)）
4. **`MarketIndexSyncService` 改读 catalog `type='M'`**，废弃 `MARKET_INDEX_LIST`
5. **并入一键同步 step**（增量），首次全量走已存在的 `GET /api/ths-index-daily/sync/market`
6. **噪声规则即时算、预标不强制**（用户仍可勾选任何候选）
7. 候选清单来自 `index_basic`（即时查询，不持久化候选）

## 子文档清单

| 文档 | 内容 |
|------|------|
| [01-data-model.md](./01-data-model.md) | 复用 catalog type='M'，零 migration，安全论证 |
| [02-backend.md](./02-backend.md) | MarketIndexScopeService + sync 改造 + 废弃 LIST + controller |
| [03-one-click-sync.md](./03-one-click-sync.md) | 并入 market-index-daily step |
| [04-frontend-scope-page.md](./04-frontend-scope-page.md) | 管理页面 wireframe + 噪声标签 |
| [05-validation-and-tasks.md](./05-validation-and-tasks.md) | 验证 + 噪声规则明细 + 风险 + SDD 拆分 |

## 阅读顺序

`01` → `02` → `03` → `04` → `05`。

## 硬约束

- **Tushare `index_basic` 参数（`category` 字段名/可选值/返回字段）必须先用 `tushare-sync-dev` skill 查文档**，禁止凭交接文档"规模指数/综合指数"转述写进硬逻辑
- **data-integrity**：空数据双路径 warn；0 行 failedItems（`index_daily_empty`）；禁 `.catch(()=>[])`
- 单文件 ≤500 行；源文件 UTF-8；`.vue` 改动合并前跑 `vite build`
- 真机 e2e 若改了大盘范围（增删 catalog type='M'），验完恢复初始 8 个（不留脚印）

## 相关

- 申万行业指数接入（独立任务）：`../2026-06-23-sw-index-integration-design/index.md`
- 交接来源（实施后归档）：`prompts/improve-market-index-sync.md`
