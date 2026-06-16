# 05 · 测试矩阵 · 任务切分 · 上线验证

← 返回 [index.md](./index.md)

## 测试矩阵

| 层 | 工具 | 关键断言 |
|----|------|---------|
| Python | pytest | `fetch_us_index` 空数据双路径 + 重试耗尽 raise；`us_index` 幂等 upsert（2 表）+ `window_empty`/`empty` 路径透出；`calc_us_indicators` 关键值非空；`_ROUTES["us_index_sync"]` 名字对；**`_runner_us_index_sync` 缺 date_range → 默认 `20100101:<today>`（不 raise）、非冒号串 → ValueError** |
| NestJS | jest | `/us-index-daily` getKlines 映射 `KlineChartBar`（`open_time` YYYY-MM-DD、**KDJ 平铺键 `'KDJ.K/.D/.J'`**、BBI、null 透传、升序）；date-range 返回 `{start,end}`；sync 存 `date_range` 冒号串 + 写 `run_type='us_index_sync'` + 非法入参 400 |
| 前端 | vitest + **vite build** | api URL/参数；UsIndexPanel 加载/同步/resize；TabsContainer 切 tab resize；**build 必绿**（type-check 查不出 SFC 编译错） |

## 任务切分（文件域互不相交 → 多 agent 并行不冲突）

```text
┌ Task A · 迁移 + 实体 + 双注册 ───────────────────────────────────┐
│ apps/server/migrations/<ts>-create-us-index.sql + .ps1            │
│ apps/server/src/entities/raw/us-index-daily-quote.entity.ts      │
│ apps/server/src/entities/raw/us-index-daily-indicator.entity.ts  │
│ apps/server/src/app.module.ts          (entities[] 加 2 行)       │  ← 此文件仅 A 动
└──────────────────────────────────────────────────────────────────┘
┌ Task B · NestJS 模块 ────────────────────────────────────────────┐
│ apps/server/src/market-data/us-index-daily/**  (module/controller │
│   /service/types/utils + service.spec)                            │
│ apps/server/src/entities/ml/ml-job.entity.ts   (+'us_index_sync') │  ← 仅 B 动
│ apps/server/src/modules/quant/dto/create-job.dto.ts (+1)          │  ← 仅 B 动
│ 依赖 A 的实体可编译                                                │
└──────────────────────────────────────────────────────────────────┘
┌ Task C · Python 管线 ────────────────────────────────────────────┐
│ apps/quant-pipeline/src/quant_pipeline/sync/akshare_client.py(改) │  ← 仅 C 动
│   sync/us_index.py(新) · sync/us_index_orchestrator.py(新)        │
│   worker/dispatcher.py(改) · cli.py(改)                           │  ← 仅 C 动
│ tests/unit/test_akshare_index_client.py · test_us_index.py        │
│   + test_sync_dispatcher_route.py(追加断言)                       │
│ 代码独立; 落库 e2e 需 A 已建表                                     │
└──────────────────────────────────────────────────────────────────┘
┌ Task D · 前端 ───────────────────────────────────────────────────┐
│ apps/web/src/components/symbols/UsStocksTabsContainer.vue(新)     │
│ apps/web/src/components/symbols/us-index/UsIndexPanel.vue(新)     │
│ apps/web/src/api/modules/market/usIndexDaily.ts(新)              │
│ apps/web/src/views/market/SymbolsView.vue(改)                    │  ← 仅 D 动
│ + vitest; 依赖 B 接口                                             │
└──────────────────────────────────────────────────────────────────┘
```

**依赖顺序**：`A → (B ‖ C) → D → e2e`。

- A 先：实体供 B 编译、表供 C 落库。
- B、C 可并行（无共享文件）。
- D 依赖 B 的 HTTP 契约。
- 冲突复核：`app.module.ts`(A) · `ml-job.entity.ts`+`create-job.dto.ts`(B) · `dispatcher.py`+`cli.py`+`akshare_client.py`(C) · `SymbolsView.vue`(D) —— 四组互不相交。**派 agent 禁用 worktree 隔离**（Windows 锁文件），靠文件域切分避冲突。

## 上线 / 真机 e2e（顺序敏感）

```text
1. 跑迁移:   apps/server/migrations/<ts>-create-us-index.ps1   → \d 校验两表
2. CLI 首灌: cd apps/quant-pipeline; uv run quant us-index-sync --date-range 20100101:<today> --symbols .NDX
   验: docker exec crypto-postgres psql ... -c
       "SELECT count(*), max(trade_date), (SELECT close FROM raw.us_index_daily ORDER BY trade_date DESC LIMIT 1) FROM raw.us_index_daily"
       → 行数 ~3099, 最新 trade_date=20260615, close ≈ 30543（对照 2026-06-15）
       "SELECT count(*) FROM raw.us_index_indicator WHERE ma5 IS NOT NULL"  → 非空
3. 重启后端: preview_stop + preview_start dev（nest start 无 watch，新模块/路由才生效）
4. 验接口:   GET /api/us-index-daily/date-range?index_code=.NDX → {start,end}（非空）
             GET /api/us-index-daily?index_code=.NDX&start_date=20100101&end_date=20260615 → KlineChartBar[]
             （start_date/end_date 必填, 缺失返 400; 用 date-range 返回的 {start,end} 或上述实值）
             抽查一条 bar: open_time 形如 '2026-06-15'（YYYY-MM-DD）、含 'KDJ.K'/'KDJ.D'/'KDJ.J' 平铺键非空
5. 真机 UI:  美股 Tab → 二级「美股指数」标签 →
             ✓ KlineChart 渲染纳指100 主图 + MA 均线
             ✓ 副图 VOL/KDJ/MACD 有值（非空白）
             ✓ 在「美股」「美股指数」二级标签间切换 → 图正常 resize（不塌缩/不空白）
             ✓ 切到别的顶层 Tab 再切回 → resize 正常
             ✓ 点「同步指数数据」(无参) → 派 us_index_sync job → UsSyncProgressModal 跑通
               → worker 兜底默认全量, job 走到 success（**不报 date_range ValueError**, 区别于 us-stocks latent bug）→ success 后刷新
```

> e2e 若触发写库的用户偏好（KlineChart 副图 prefsKey="us-index" 的 localStorage、列偏好等），验完按 `CLAUDE.md` 规范恢复默认，别在账号留脚印。

## 完成后

按 `prompts/` 约定：删除 `prompts/add-us-index-subtab.md` 或移入 `prompts/archive/`。提交按子系统分层（`feat(us-index): ...` 数据/后端/Python/前端分 commit；`.claude/rules` 无关不混入），交接 commit 用 `docs(...)`。
