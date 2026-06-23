# 真机 e2e：申万行业指数接入 + 大盘宽基动态范围

> 自包含交接提示词。整段贴给全新会话即可执行真机 e2e，不依赖前置对话。

## 一句话目标

对 2026-06-23 合入本地 main 的两套 A 股指数功能做**真机 e2e**：
1. **申万行业指数接入**（`category='sw'` + pe/pb 估值）
2. **大盘宽基动态范围**（管理页面动态发现+勾选，废弃硬编码 `MARKET_INDEX_LIST`）

门禁/单测已全绿（后端 jest 1855、前端 type-check/vite build/lint:quant-lines），但**全程无真实 Tushare 数据 + 前端 UI 验证**。本任务是上线前唯一未做的真机验证。

## 现状摸底（file:line 为证，已实现合入 main）

- **spec**：`docs/superpowers/specs/2026-06-23-sw-index-integration-design/` + `2026-06-23-market-index-dynamic-scope-design/`（各 index.md + 5 子文档，含验证标准 05）
- **commit**：本地 main `fde16f0`→`a298122`（10 commit，**未推 origin**）
- **migration 已落 DB**（SW-T1 真机跑过，crypto-postgres 已含 `index_daily_quotes.pe/pb` 列 + `sw_index_catalog` 表）
- 申万后端：`apps/server/src/market-data/sw-index-daily/sw-index-daily-sync.service.ts`
- 申万前端：`apps/web/src/components/symbols/a-shares-index/ASharesIndexSwPanel.vue`（sub-tab 容器 `ASharesIndexPanel.vue`）
- 大盘 scope：`apps/server/src/market-data/index-catalog/market-index-scope.service.ts` + `classifyNoise.ts`
- 大盘管理页：`apps/web/src/views/sync/MarketIndexScopePanel.vue`
- one-click 并入：`apps/server/src/market-data/one-click-sync/step-runners-index-daily.ts`

## e2e 前置

1. **后端跑的是 main 最新（a298122）**：`nest start` **无 watch**，若后端在跑旧代码须重启。**重启后端/DB/端口进程前先问用户**（项目规范，memory `feedback_ask_before_restarting_user_env`）；只读探测不用问。
2. **AdminOnly 接口需 admin 登录态**：浏览器已登录 admin（UI 路径），或 API 带 session cookie。
3. **migration 已落**（确认 `sw_index_catalog` 表 + `index_daily_quotes.pe/pb` 列；若缺跑 `apps/server/src/migration/2026062300000{1,2}-*.ps1`）。
4. 推荐用 `browser-driving` skill 驱动 UI、`db-inspect` skill 查 DB。

## 链路 1：申万全量回填 + 前端

### 1a. 首次全量同步（API，AdminOnly）
```
GET /api/sw-index-daily/sync?start_date=20210101&end_date=<最近收盘交易日,≤昨天>&syncMode=overwrite
```
sw_daily 默认 2021 版，20210101 起 ≈ 全史。end_date 钉最近收盘日（别拉今天，盘中/未发布）。

**验证**：
- 响应 `success=true`，`errors` 为空或仅 `sw_daily_empty`（当日未发布）
- `sw_index_catalog` 三级计数（期望 **31 / 134 / 346**，2021 版）：
```bash
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c \
  "SELECT level, count(*) FROM sw_index_catalog GROUP BY level ORDER BY level;"
```
- `index_daily_quotes category='sw'` 落库 + pe/pb 非空：
```sql
SELECT count(*), count(pe), count(pb) FROM index_daily_quotes WHERE category='sw';
```
- **单位对拍**（抽样 1 行核对 Tushare 原值）：
```sql
SELECT ts_code, trade_date, close, vol_hand, amount, pe, pb, total_mv_wan
FROM index_daily_quotes WHERE category='sw' ORDER BY random() LIMIT 1;
-- vol_hand = Tushare vol(万股)×100；amount = amount(万元)×10；pe/pb 直填；total_mv_wan 万元一致
```

### 1b. 查询接口
```
GET /api/indices/latest?type=sw&level=1   # 一级 31
GET /api/indices/latest?type=sw&level=2   # 二级 134
GET /api/indices/latest?type=sw&level=3   # 三级 346
```
验证：返回申万列表，`name` 来自 sw_index_catalog（**非 tsCode fallback**），`pe/pb` 非空，其它 category 行 `pe/pb` 合法 NULL。

### 1c. 前端 UI（browser-driving）
「A 股指数」面板：
- 顶部 sub-tab：**同花顺指数 / 申万指数**（新增）
- 切「申万指数」→ 层级切换（一/二/三级）→ 各级行数对
- **pe/pb 列仅申万区显示**（同花顺区无）
- 行点击 → K 线 Modal（副图 VOL/KDJ/MACD，主图 MA/MACD/KDJ/BBI/BRICK）
- **回归**：切「同花顺指数」→ 原 n-select（全部/大盘/行业/概念）+ 表格正常

> 注：n-modal KlineChart 在 **dev 可能不渲染**（memory `reference-n-modal-lazy-teleport-slot-klinechart`，HMR 累积坑，production build 正常）。若 dev 不渲染，`vite build` 预览或记为已知项。

## 链路 2：大盘动态范围管理

### 2a. 发现候选（API，AdminOnly）
```
GET /api/market-index-scope/discover
```
验证返回 ~158 候选，每个含 `noise_tags`：
- 退市（exp_date 非空）/ 跨境外币（USD/HKD/港股/美股/三板/东盟/中韩）/ 收益版（收益/R/净收益）/ 重复（多挂牌）/ 中小盘
- `in_scope` 标注（是否已在 type='M' 范围）

> ⚠️ `index_basic` 的 category 字段文档未穷举（"规模指数/综合指数"是查证值）。真机**抽样核对**返回行 category 实际取值，若有变体候选数会偏差——记录。

### 2b. 管理 UI（browser-driving，/sync → 「大盘宽基范围」tab）
- 当前范围（初始 8 个）+ 候选清单（带噪声彩色标签）
- 「隐藏疑似噪声」开关默认开（隐藏退市/跨境/收益版；中小盘/重复不隐藏）
- 测「加入范围」一个新指数（如 `000016.SH` 上证50 若不在）→ 进入当前范围
- 测「移除」一个 → 离开

### 2c. 持久化 + 动态生效
```sql
SELECT ts_code, name FROM ths_index_catalog WHERE type='M' ORDER BY ts_code;
```
- add/remove 后该查询变化（持久化）
- **前端大盘 Tab**（「A 股指数」n-select「大盘」）：**目录即时**反映新范围（queryMarket 改读 catalog）
- **行情需同步才有**：新指数目录即时显示但行情行为空 → 触发 `GET /api/ths-index-daily/sync/market?start_date=&end_date=` → 行情落库 → 大盘 Tab 行情列填充

### 2d. ⚠️ e2e 完恢复初始 8 个（不留脚印）
e2e 改了 catalog type='M'，**验完恢复**：
```sql
DELETE FROM ths_index_catalog WHERE type='M';
INSERT INTO ths_index_catalog (ts_code, name, type, exchange) VALUES
  ('000001.SH','上证指数','M','A'),('399001.SZ','深证成指','M','A'),
  ('399006.SZ','创业板指','M','A'),('000688.SH','科创50','M','A'),
  ('000300.SH','沪深300','M','A'),('000016.SH','上证50','M','A'),
  ('000905.SH','中证500','M','A'),('000852.SH','中证1000','M','A');
```

## 链路 3：one-click 两新 step

触发一键同步（UI `/sync` A 股一键同步，或 API）。验证：
- 步骤列表含 **sw-index-daily（申万指数日线）** + **market-index-daily（大盘指数日线）**，位置在「指数日线(ths)」后（STEP_ORDER 现 10 项）
- sw step 走 SSE 进度（startSync），market step 走 await（sync）—— 进度条正常推进、**不卡 99**
- 完成后无异常 failedItems（或仅当日未发布的合理 empty）
- 申万/大盘行情增量落库

> one-click 全增量；首次全量回填走链路 1a / `GET /api/ths-index-daily/sync/market`（与现有 AMV step 注释口径一致 `step-runners.ts:411`）。

## 已知坑/注意

1. **后端 dev 无 watch**：改代码须重启。本 e2e 无代码改动，但要确认后端进程是 main 最新（a298122），否则新接口 404 / 行为是旧的。
2. **tushare 字段已查证冻结**（SW-T2 实证）：sw_daily `pct_change`（非 pct_chg）/**无 pre_close**（有 change）/ts_code 后缀 `.SI`（非 .SW）/mv 万元；index_classify `level=L1|L2|L3 + src=SW2021` 输出**树结构**（parent_code，非扁平 l1/l2 code）。真机返回与预期不符先核对这些。
3. **filterExistingDates 跨 category 既有 bug**（ths/sw 共有，未修，建议另开 issue）：增量同步按 trade_date 查 DISTINCT 不分 category，共享表致可能误跳。**全量 overwrite 不受影响**；若增量异常改走全量。
4. **4 个预先存在 vitest 红**（INDICATOR_KEYS 25→28，main 既有，与本功能无关）—— 不是本次引入，别误判。
5. **列偏好 e2e**：申万区用独立 scope `'aSharesIndexSw'`，若 e2e 勾了列偏好，验完恢复默认（项目规范不留脚印）。
6. **n-modal KlineChart dev 渲染**：见链路 1c 注。

## 验证标准（e2e 通过判据，摘自 spec 05）

- **申万**：catalog 三级 31/134/346；pe/pb 直填 + vol×100/amount×10 对拍；申万 sub-tab + 三级切换 + pe/pb 列 + K线Modal；同花顺区回归不破
- **大盘**：discover ~158 候选 + 噪声标签正确；add/remove 持久化；前端大盘 Tab 动态；**e2e 完恢复初始 8 个**
- **one-click**：sw/market 两 step 出现 + 进度上报 + 无异常 failedItems

## 硬约束

- **重启后端/DB/端口进程前先问用户**（memory `feedback_ask_before_restarting_user_env`），只读探测不用问
- **e2e 改了用户数据必恢复**（大盘 catalog type='M' 范围、列偏好）—— 见链路 2d 恢复 SQL
- UI 验证用 `browser-driving` skill（含强制复盘协议）；DB 查询用 `db-inspect` skill
- 发现 bug 落源头交接（`prompts/` 新建），别在用户账号留脚印

## 前序进度

- 2026-06-23 brainstorming（2 spec + SubAgent 自审修订）→ SDD（7 任务 3 批次并行 + 每任务审查 + 最终审查）→ FF 合入本地 main（10 commit `fde16f0`→`a298122` 未推 origin）
- 门禁/单测全绿、最终审查通过（三条端到端链路贯通、DI 注入链闭合、data-integrity 全遵守）
- **真机 e2e 是唯一未做项**（本交接目标）
- 项目 memory：`project_sw_index_integration` + `project_market_index_dynamic_scope`（含本 e2e 待办）
