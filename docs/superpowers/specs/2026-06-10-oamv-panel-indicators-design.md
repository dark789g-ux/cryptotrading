# 0AMV 面板全套指标点亮设计（方案二·全套落库）

日期：2026-06-10
状态：已获用户批准的设计，待实现
前置：`oamv_daily` 已有 `amv_dif/amv_dea/amv_macd` 三列（migration `20260610_oamv_daily_macd.sql`，同日已应用），0AMV 数据已覆盖 20210901~20260609（1152 行，SSE 交易日零缺失）。

## 1. 背景与目标

标的筛选页（`/symbols`）→"活跃市值"tab（`ActiveMarketValuePanel.vue`）画大盘 0AMV 指数（930903.CSI 合成，存 `oamv_daily`）的 K 线，但所有指标字段硬编码 null：主图 MA 图例显示 `--`，副图（VOL/KDJ/MACD/BRICK）全部空白格子。`KlineChart` 的副图**不自算指标、直接读 row 字段**（`klineChartOptions.ts:164-179`）。

目标：主图 MA5/MA30/MA60/MA120/MA240 + KDJ 副图 + MACD 副图全部显示真实数据；VOL 与 BRICK 从该面板移除（用户已确认：VOL 不做、BRICK 本次不做）。

方案决策（用户选定方案二）：**MA/KDJ 八列全套落库**，与既有 MACD 三列同模式。附带优势：落库列将来可直接进大盘择时条件（如 "0AMV close>ma60"，EXISTS join 现成可用），本次不做接线。

## 2. 数据流总览

```text
Tushare index_daily(930903.CSI)
   │ sync0amv（拉数 + 计算 0AMV 四价 + upsert OHLC）
   ▼
oamv_daily (trade_date, open/high/low/close,
            amv_dif/amv_dea/amv_macd,          ← 已有
            ma5/ma30/ma60/ma120/ma240,         ← 本次新增
            kdj_k/kdj_d/kdj_j)                 ← 本次新增
   │ sync 末尾 recomputeIndicatorsAll()：全量重算 11 列
   ▼
GET /api/oamv/data?days=250  （repo.find 全实体，零改动自动带新列）
   ▼
ActiveMarketValuePanel.chartData：mapOamvToChartBar 透传映射
   ▼
KlineChart（通用 MACD/KDJ 副图壳 + 主图 MA 线）
```

## 3. Schema（migration）

文件：`apps/server/migrations/20260610_oamv_daily_indicators.sql` + 同名 `.ps1`（docker exec 格式，参照 `20260610_oamv_daily_macd.ps1`）。

```sql
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS ma5    double precision;
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS ma30   double precision;
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS ma60   double precision;
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS ma120  double precision;
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS ma240  double precision;
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS kdj_k  double precision;
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS kdj_d  double precision;
ALTER TABLE oamv_daily ADD COLUMN IF NOT EXISTS kdj_j  double precision;
```

- 全部可空（序列头部预热段为 null 属正常语义）。
- 类型 `double precision` 与 `amv_*` 三列一致；列名对齐 `raw.daily_indicator`（ma5/kdj_k 等）。
- `.ps1` 校验断言：8 列存在（`information_schema.columns` count = 8）。
- 不在 migration 内回填（回填走 §5 的 overwrite sync）。

## 4. 后端

### 4.1 实体

`apps/server/src/entities/oamv/oamv-daily.entity.ts`：加 8 个 nullable 字段（`ma5..ma240`、`kdjK/kdjD/kdjJ`，`@Column({ name: 'kdj_k', type: 'double precision', nullable: true })` 式），驼峰属性名 → 蛇形列名。

### 4.2 计算与落库（oamv.service.ts）

- `recomputeMacdAll()` **改名扩展**为 `recomputeIndicatorsAll()`（调用点仅 sync0amv 内一处）：
  1. 读全序列 `tradeDate/open/high/low/close` ASC；
  2. **MACD：继续用既有 `calcMacd`（active-mv/amv-formula，通达信式 tdEma 12/26/9）**——硬约束：不得换成 `calcIndicators` 的等价 EMA 实现。理由：落库 MACD 是择时条件（搬砖-05/05C）的权威源，已与真机 run 对账；换实现引入浮点末位漂移，柱≈0 的边界日可能出现"图上正柱但筛选未开仓"的歧义；
  3. **MA/KDJ：用共享 `calcIndicators`（`apps/server/src/indicators/indicators.ts:117`）**，输入 KlineRow（`volume` 喂 0，open_time 喂 trade_date），取输出 `MA5..MA240`（严格 SMA，不足期 null）与 `'KDJ.K'/'KDJ.D'/'KDJ.J'`（周期 9，初始 K=D=50）。忽略其 MACD 输出。先例：ths-index-daily（行业指数）已用 calcIndicators，指数序列复用无障碍；
  4. 数组组装抽纯函数 `buildIndicatorArrays(rows)`（输入行数组，输出 `{ tradeDates, dif, dea, macd, ma5..ma240, kdjK, kdjD, kdjJ }` 各数组，NaN→null）。**落点钦定**：oamv 目录新建独立纯函数文件 `apps/server/src/market-data/oamv/oamv-indicators.ts` 并 export（jest 直接 import，不 mock service）；
  5. 一次 `UPDATE oamv_daily o SET ... FROM unnest($1::text[], $2::float8[], ...)` 写 11 列（扩展现有 4 数组 unnest 到 12 数组）。
- 日志：保留现有"全量重算完成，更新 N 行"格式，文案改为含指标范围。
- 空表行为不变：warn + 跳过。

### 4.3 接口

`get0amvData` **零改动**：`repo.find` 全实体自动带新列；250 天窗口里 MA240 有值（全历史落库值，预热在 2022-09 前完成——真 DB 核验序列第 240 个交易日为 2022-08-29）。

## 5. 回填

migration 应用后，跑一次**全量 overwrite sync**（`{startDate:'20210901', syncMode:'overwrite'}`，真实**管理员**会话调 `POST /api/oamv/sync`——该端点 `@AdminOnly()`）→ 全段 OHLC 同口径重算 upsert → 触发 `recomputeIndicatorsAll()` 填满 8 新列。

**注意**：
1. 增量模式 0 新行会提前 `return { synced: 0 }` 不触发重算，所以回填必须用 overwrite；
2. **禁止小窗口 overwrite**（实现期实测教训）：sync 的 0AMV 四价合成含 tdSma 递推，仅带 30 天预热——小窗口 overwrite 会用短预热口径**覆盖该窗口的 OHLC**（实测 20260601 起 8 行 close 漂移 ~2%、20260609 amv_macd 从 -5135 漂到 -4390），制造段界不一致。回填/修复一律全量 overwrite（20210901 起，幂等确定，实测恢复后逐位一致）。

## 6. 前端

### 6.1 类型（apps/web/src/api/modules/market/oamv.ts）

`OamvData` 接口补 11 个可选字段（后端实体驼峰序列化）：

```ts
amvDif?: number | null;  amvDea?: number | null;  amvMacd?: number | null;
ma5?: number | null;  ma30?: number | null;  ma60?: number | null;
ma120?: number | null;  ma240?: number | null;
kdjK?: number | null;  kdjD?: number | null;  kdjJ?: number | null;
```

（`amvDif/amvDea/amvMacd` 当前接口本来就缺，顺带补上。）

### 6.2 映射（ActiveMarketValuePanel.vue）

- `chartData` 的逐字段映射抽成纯函数 `mapOamvToChartBar(d: OamvData): KlineChartBar`。**落点钦定**：同目录工具文件 `apps/web/src/components/symbols/oamvChartMapping.ts`（`<script setup>` 不能 export 命名函数，独立 .ts 让 vitest 直接 import）：
  - `MA5: d.ma5 ?? null` …… `MA240: d.ma240 ?? null`
  - `'KDJ.K': d.kdjK ?? null`、`'KDJ.D': d.kdjD ?? null`、`'KDJ.J': d.kdjJ ?? null`
  - `DIF: d.amvDif ?? null`、`DEA: d.amvDea ?? null`、`MACD: d.amvMacd ?? null`
  - 其余字段维持现状（volume: 0、BBI: null、brickChart: undefined）。
- **副图壳用通用 `'MACD'`/`'KDJ'`**（路线 A）：本面板主图就是 0AMV，row.DIF 即"本图主序列的 DIF"，语义正确；不用专属 `'0AMV_MACD'` 副图（那是个股页叠加 AMV 序列的场景）。
- `oamvAvailableSubplots`：`['VOL','KDJ','MACD','BRICK']` → `['KDJ','MACD']`。旧 localStorage 偏好（`kline-chart-prefs:oamv`）会被 `normalizePrefs` 按新白名单自动过滤，无需迁移。

### 6.3 合规标注

模板在图表卡片内加一行 `AMV_CAPTION_BASE`（`@/composables/kline/amvCaption`，"0AMV 为活跃市值指标，信号未回测校准，仅供参考"），参照 `AShareDetailDrawer.vue:41` 的无条件渲染方式；其 `.amv-caption` 是该组件 **scoped** 样式（同文件 227-232 行），需把这段 CSS 复制进 ActiveMarketValuePanel 自己的 scoped style。

## 7. 错误处理

- 序列头部预热段 null：MA 线/KDJ 线自然断开、图例显示 `--`（KlineChart 既有行为，无需改）。
- 接口缺新字段（后端未升级/旧缓存）：`?? null` 兜底回退到现状（空白），不报错。
- recompute 失败：sync 抛错由现有 controller 错误链路透出，不静默。

## 8. 测试与验证标准

**单测**：
- 后端 jest（oamv 域新增 spec）：`buildIndicatorArrays` 用 ~10 行已知小序列锚定——**KDJ 递推种子为 50，但首行输出 K = 50×⅔ + rsv/3 ≠ 50（除非 rsv=50）；fixture 首行构造 high==low 走 rsv=50 分支，从而首行 K=D=50**、J=3K-2D；MA5 前 4 行 null 第 5 行等于窗口均值；NaN→null 转换；MACD 数组与 `calcMacd` 直接输出逐位一致。
- 前端 vitest：`mapOamvToChartBar` 字段透传、缺字段 `?? null` 兜底、日期 YYYYMMDD→YYYY-MM-DD。
- 既有门禁：server build、web type-check + vite build 全绿。

**真机 e2e**（顺序）：
1. 应用 migration（.ps1 断言 8 列）；
2. 重启后端（nest 无热加载）；
3. 真实会话 overwrite 小窗口 sync → 触发全量回填；
4. DB 断言：`SELECT count(*) FROM oamv_daily WHERE trade_date>='20221001' AND (ma5 IS NULL OR ... OR kdj_j IS NULL)` = 0（预热段之外 8 列全非空）；`ma240` 首个非空日 ≈ 序列头后 240 个交易日；
5. 打开面板：MA 图例有数值、KDJ/MACD 副图有线/柱、VOL/BRICK 副图消失、合规标注可见；
6. MACD 柱正负与搬砖-05C 择时窗口肉眼对照一致（如 2026-06-09 柱为负）。

## 9. 范围外（明确不做）

- BRICK 砖形图副图（个股信号算法在大盘指数上的意义未验证，成本最高）；
- VOL 副图（0AMV 无成交量概念，源指数成交额未落库）；
- 0AMV 的 MA/KDJ 进择时条件字段映射（将来需要时在 `ASHARE_MARKET_AMV_COL_MAP` 加一行即可）；
- 个股页 `0AMV_MACD` 副图与 AMV 序列接口的任何改动。
