# 完成 A 股指数二级 TAB（T7-T9 交接）

## 目标
完成「A 股数据」TAB 下「A 股指数」二级 TAB 的剩余前端 + 真机 e2e（T7-T9）。后端已全通。

## 现状摸底（已完成，commit 全在 `feat/a-shares-index-tab`，未推 origin）

| commit | 任务 |
|---|---|
| `706e3c6` | spec: `docs/superpowers/specs/2026-06-22-a-shares-index-tab-design.md` |
| `1a8cc10` | T2 catalog 扩展（type='M' + 8 大盘清单 + `GET /api/index-catalog` 查询） |
| `3eaddd6` | T5 列偏好加 `aSharesIndex` scope（前后端 7 处，无 migration） |
| `420724c` | T6 `ASharesTabsContainer` + `SymbolsView` 接入（stub `ASharesIndexPanel`） |
| `d742395` | T1 统一指数日线表迁移（`ths_index_daily`→`index_daily`+category+industry-amv 断言兼容） |
| `22e2517` | T3 大盘 `index_daily` 同步（`MarketIndexSyncService` + `GET /api/ths-index-daily/sync/market`） |
| `ca841b9` | T4 查询接口（`GET /api/indices/latest` + `/api/index-daily` + 旧路径薄封装 WHERE category） |

后端就绪：统一表 `index_daily_quotes`/`indicators`（+category）已建 + 迁移 SQL 已写（**未执行**，T9 跑）；catalog/同步/查询接口全通；列偏好 scope 就绪；前端容器 + stub 就绪。`pnpm --filter @cryptotrading/server build` + jest（ths-index-daily|active-mv 47 测试）绿。

## 剩余 T7-T9

### T7 `ASharesIndexPanel` 行情表（覆盖 stub）
文件（`apps/web/src/components/symbols/a-shares-index/`，目录已含 T6 的 stub Panel + T6 没建其他文件）：
- `ASharesIndexPanel.vue`（覆盖 stub）—— 行情表：远程分页/排序/类型筛选(market/industry/concept/all)/搜索 + 列设置 scope=`aSharesIndex`。**参考 `apps/web/src/components/symbols/ASharesPanel.vue` + `a-shares/useASharesQuery.ts` 模式**
- `useASharesIndexQuery.ts` —— 列表查询 composable，调 `GET /api/indices/latest?type=&q=&sort=&order=&page=&pageSize=`
- `aSharesIndexColumns.ts` —— 列定义（代码/名称/收盘/涨跌%/成交量/[成交额]/[市值]，复用 `createASharesColumnDefs` 的 `formatMarketCap`/`formatAmount` 等格式器）
- `types.ts` —— `IndexLatestRow`/`IndexCatalogRow`（与后端 `apps/server/src/market-data/index-daily/index-daily.types.ts` 对齐）
- 前端 API 模块：新建 `apps/web/src/api/modules/market/indexDaily.ts`（`getLatestList`/`queryKline`），或扩展现有

依赖：T4 接口（`/api/indices/latest`）+ T5 scope（`aSharesIndex`）+ T6 stub
边界：只碰 `a-shares-index/` 4 文件 + 新 API 模块

### T8 `ASharesIndexKlineModal`（K 线 Modal）
文件：`apps/web/src/components/symbols/a-shares-index/ASharesIndexKlineModal.vue`
- 复用 `AppModal`（`@/components/common/AppModal.vue`，操作按钮放 `#actions` slot）+ `KlineChart`（`@/components/kline/KlineChart.vue`）
- 调 `GET /api/index-daily?ts_code=&start_date=&end_date=`，MA/MACD/KDJ/成交量副图。**参考 `apps/web/src/components/symbols/us-index/UsIndexPanel.vue` 的 KlineChart 用法**
- T7 行情表点行打开此 Modal

依赖：T4（K线接口）

### T9 migration 执行 + 真机 e2e
1. **跑 migration**（先落源记数）：
   ```powershell
   docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT type, COUNT(*) FROM ths_index_catalog GROUP BY type"
   powershell apps/server/src/migration/20260622120000-create-unified-index-daily.ps1
   ```
   验证：`index_daily_quotes` 行数 ≥ 旧表；category 分布（market=8 含新增 4 宽基、industry/concept 与落源一致）；旧表已 RENAME `_legacy`
2. **重启后端**（先问用户，别擅自动 dev 服务）：后端 `dev` 是 `nest start` 无 watch，migration/新接口需重启才生效
3. **真机 e2e**：
   - 旧路径回归：`/api/ths-index-daily?ts_code=881101.TI` 返回正确 K 线（**不含大盘行情**）；money-flow 行业/概念趋势 Modal + KDJ recalc 正常；★**industry-amv 同步不因 assertSuffixes throw**（迁移第 7 步验证，阻断项）
   - 新接口：`/api/indices/latest?type=market` 返回 8 大盘；`/api/index-daily?ts_code=000001.SH` 返回上证 K 线
   - 触发大盘同步：`GET /api/ths-index-daily/sync/market?start_date=20210101&end_date=20260622`（AdminOnly，需登录态），验证 index_daily 落库 + 指标重算
   - 前端：A 股数据 TAB 下「股票/A 股指数」二级 TAB；行情表 400+ 行可分页/排序/搜索/类型筛选；点行弹 K 线 Modal（MA/MACD/KDJ 副图）
   - 列偏好：勾选 aSharesIndex 列 → 刷新持久化（save→load 不丢，证明前后端 scope 同步）；**验完恢复默认，别在用户账号留脚印**
4. **门禁**：`pnpm --filter @cryptotrading/web type-check` + `pnpm --filter @cryptotrading/web build`（vite，必跑）+ `pnpm --filter @cryptotrading/server exec jest` + `lint:quant-lines`（新 Vue ≤500 行）全绿

## 硬约束 / 项目规范
- **vue3-frontend.md**：keep-alive + 懒加载路由，合并前跑 vite build 不只 type-check；`display-directive="show:lazy"` 不改 show；`defineProps`/`withDefaults` 默认值禁引用局部 const；Modal 复用 AppModal（`#actions` slot，子组件禁自带保存/取消按钮）；改 import 块后立即回读验证顺序
- **datetime.md**：trade_date YYYYMMDD varchar，禁 `new Date('YYYYMMDD')`；K 线 `open_time` 保持 YYYYMMDD 字面串契约（否则 money-flow/AMV 副图合并断）
- **e2e**：写了持久化状态（列偏好）验完恢复默认
- **后端 dev 是 nest start 无 watch**：改后端代码后必须重启；e2e 前确认后端跑最新代码
- **重启用户环境先问**：kill/重启用户在跑的 dev/DB 前先问，只读探测不用问
- **数据源**：大盘走 Tushare `index_daily`（2000 积分当前满足），行业/概念走 `ths_daily`；spec【Tushare index_daily 事实】已查证（pct_chg 非 pct_change、vol 手、amount 千元、无 total_mv/float_mv）

## ECONNRESET 教训（重要）
本会话 opus 子 agent **反复 ECONNRESET**（T1 两次、T3/T4 各一次），对"写代码"任务不稳定，常在写文件前断（0 产物）。批次1 的 T2/T5/T6 子 agent 成功过（间歇性 API 抽风）。新会话策略：
- 可重试 SDD 子 agent（可能成功）
- 或直接实现（T7-T9 任务定义明确 + 参考现有模式 ASharesPanel/UsIndexPanel）；T1/T3/T4 是控制者自己实现的（build+jest 绿），可作范例

## 前序进度
批次1（T1/T2/T5/T6）+ 批次2（T3/T4）全完成并分层 commit。后端全通。剩前端 T7/T8 + e2e T9。migration SQL 已写未执行。spec 在 `docs/superpowers/specs/2026-06-22-a-shares-index-tab-design.md`，其【验证标准】章节是 T9 验收清单。

完成后：删除本交接（`chore(a-shares-index): 删除已实现的交接提示词`），分支按用户偏好 FF 合入本地 main（参考 memory 中其他美股/A股项目的合并模式）。
