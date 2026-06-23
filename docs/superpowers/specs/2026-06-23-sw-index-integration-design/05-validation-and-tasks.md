# 05 · 验证标准 + 风险 + SDD 任务拆分

## 5.1 验证标准

**数据层**：
- `sw_index_catalog` 三级计数 = 31 / 134 / 346（首次全量后）
- sw 行情抽样对拍：`pe`/`pb` 直填；`vol` 万股→手 ×100；`amount` 万元→千元 ×10（与 Tushare 原值核对）
- `pe`/`pb` 仅 `category='sw'` 行非空，`market`/`industry`/`concept` 行合法 NULL

**接口**：
- `GET /api/sw-index-daily/sync?syncMode=overwrite` 全量回填成功（目录灌满 + 行情落库）
- `GET /api/indices/latest?type=sw&level=1` 返回申万一级指数列表（非空）
- one-click-sync 含 `sw-index-daily` step，跑通增量

**前端**：
- 申万 sub-tab 显示 + 一/二/三级切换（各级行数对）
- pe/pb 列仅申万区显示，同花顺区无
- 行点击弹 K 线 Modal，副图 VOL/KDJ/MACD + 主图 MA/MACD/KDJ/BBI/BRICK

**门禁**：
- 后端 `pnpm --filter @cryptotrading/server exec jest` 全绿（含 sw service 单测）
- 前端 `pnpm --filter @cryptotrading/web type-check` + `vite build` + `lint:quant-lines` 全绿
- migration `docker exec` 可执行（A/B 两个 `.ps1`）

## 5.2 风险与对策

| 风险 | 对策 |
|------|------|
| `sw_daily`/`index_classify` 字段名/单位凭转述写错 | **T2 前置 gate**：实施前 `tushare-sync-dev` skill 查文档冻结字段清单（[02 §2.7](./02-backend-sync.md)），字段未冻结不准动 fetcher |
| `SwIndexCatalog` 漏 app.module 根注册 → EntityMetadataNotFound 500 | 双注册检查清单（[01 §1.5](./01-data-model.md)） |
| 单位换算漏 ×100/×10 → 数据差 10/100 倍 | fetcher map 内集中换算 + 单测对拍 |
| 组件拆分破坏 T7/T8 已验证的 resize/reload | 保留 onMounted+onActivated 双触发、indexPanelRef.resize（[04 §4.2](./04-frontend.md)） |
| 真机 e2e 勾申万列偏好留脚印 | 验完恢复默认（[04 §4.6](./04-frontend.md)） |

## 5.3 SDD 任务拆分（独立文件域）

| 任务 | 文件域（互不相交） | 依赖 |
|------|-------------------|------|
| **T1 数据层** | `migration/20260623000001-*.sql/.ps1`、`migration/20260623000002-*.sql/.ps1`、`entities/index-daily/index-daily-quote.entity.ts`、`entities/sw-index/sw-index-catalog.entity.ts`、`app.module.ts` | 无 |
| **T2 后端同步** | `market-data/sw-index-daily/`（全新目录） | T1（实体/migration） |
| **T3 前端 sub-tab** | `components/symbols/a-shares-index/*`、`market-data/index-daily/index-daily.service.ts`（level 查询） | T1（pe/pb 类型） |
| **T4 one-click 并入** ⚠️共享 | `one-click-sync/*`、`components/sync/oneClickSync.types.ts`、`views/sync/SyncView.vue` | T2 + 大盘 T2 |

**并行度**：T1 先行；T2、T3 可并行（文件域不交：T2 在 `sw-index-daily/`，T3 在 `a-shares-index/` + `index-daily.service.ts`）；**T4 必须串行**（与大盘 one-click 共享 `one-click-sync/`，单 agent 一次加 sw+market 两 step）。

> T3 改 `index-daily.service.ts` 的 getLatest 加 sw+level 分支，与大盘无冲突（大盘不改 getLatest，改 `market-index-sync.service.ts` + `index-catalog/`）。

## 5.4 实施顺序建议

1. **T1**（数据层）→ 跑 migration + 实体双注册 + jest
2. **T2 ∥ T3**（后端同步 ‖ 前端 sub-tab）并行
3. **T4**（one-click 并入，含大盘 market step）串行收尾
4. 首次全量回填 `GET /api/sw-index-daily/sync?syncMode=overwrite` + 真机 e2e

## 5.5 交接 prompt 处置

本 spec 实现合入后，`prompts/add-sw-index-integration.md` 移入 `prompts/archive/`（或删除）。
