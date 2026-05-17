# b1_v2 回测每日持仓浏览器（一次性本地 HTML）

- 状态：approved
- 作者：renmaoyuan
- 日期：2026-05-17

## 1. 背景与目标

已有一次 touzikexue.com 公开的 b1_v2 回测（slug `20260516_162608_b1_v2_2025-01-01_to_2026-05-15_top2_min0p0i100p0o`）的原始 JSON 数据落在本地 `.claude/worktrees/tzkx/`（meta/trades/daily/bench 共 4 个 JSON、~280KB）。目标是产出**一个本地 HTML**，可视化"**每天的持仓**"，作为分析该策略仓位行为的一次性观察工具。

**明确不做的事**：
- 不并入 `apps/web` 或任何已有子工程。
- 不做美化、动画、响应式适配、移动端、国际化、登录。
- 不引入打包工具、TypeScript、构建步骤。
- 不画行业分类、个股 K 线、因子归因、回测对照（数据维度不够）。
- 不计算"真实浮盈"——`daily.json` 缺逐股每日收盘价，写出来会误导（详见 §5）。

## 2. 数据源

放在与 HTML 同目录的现成文件，**不重新下载**：

| 文件 | 内容（已实测） | 用途 |
|---|---|---|
| `meta.json` | strategy_name / params / stats（trade_count=190、final_capital=2,029,506.62 等） | 顶部 KPI 条与抽屉文案 |
| `trades.json` | 190 笔成交，每笔含 `symbol/name/buy_date/buy_price/buy_value/buy_pct/holding_days/sells[]/last_sell_date/last_sell_reason` | 重建每日持仓集合、买卖标记 |
| `daily.json` | 328 个交易日的逐日快照：`date/capital_after_close/cash/positions_market_value/open_positions/is_market_bull/in_active_wave/allow_buy_and_hold/buy_count/buy_min_score/buy_avg_score/...` | 主图净值曲线、持仓数副图、活跃波段高亮 |
| `bench.json` | `{series:[{name,symbol,rows:[{date,close,nav}]}, ...]}`；含 **3** 条：`上证指数 / 中证1000 / 同花顺全A`，每条 328 行，`nav` 已预归一化到首日=1.0 | 基准线（仅取 `同花顺全A`） |

字段名以**实测 JSON 实物为准**；UI 中字段渲染规则见 §6。

## 3. 文件结构

```
.claude/worktrees/tzkx/
├── meta.json         （已有）
├── trades.json       （已有）
├── daily.json        （已有）
├── bench.json        （已有）
└── holdings.html     （新增；单文件，含 <style>/<script>，ECharts via CDN）
```

`.claude/worktrees/` 已被仓库根 `.gitignore` 覆盖，**该 HTML 与 JSON 都不会被 git 跟踪**，符合"不合并到项目"的要求。

启动方式（写在 HTML 顶部 `<!-- HOWTO -->` 注释里，并在页面右下角的"使用提示"小框里复述一遍）：

```
cd C:\codes\cryptotrading\.claude\worktrees\tzkx
python -m http.server 8765
# 浏览器打开 http://localhost:8765/holdings.html
```

## 4. 页面结构

整页一屏，自上而下：

```
┌─────────────────────────────────────────────────────────┐
│ 顶部 KPI 条                                              │
│   策略名 · 回测区间                                       │
│   总收益 / 年化 / 最大回撤 / 胜率 / 成交笔数 / 持仓天数    │
├─────────────────────────────────────────────────────────┤
│ 主图（高 ~55vh）                                         │
│   - 红实线：策略净值（基准化到初始资金 1.0）              │
│   - 橙虚线：同花顺全 A（同样基准化到 1.0）                │
│   - 淡绿背景色块：is_market_bull=1 且 in_active_wave=1   │
│   - 红色上三角：每笔买入 (buy_date, 当日净值)             │
│   - 蓝色下三角：每笔最终退出 (last_sell_date, 当日净值)   │
│ 副图（高 ~15vh）                                         │
│   - 蓝灰柱状：daily.open_positions（0..10）              │
│   - 与主图共享 X 轴 + dataZoom 滑块                       │
├─────────────────────────────────────────────────────────┤
│ 底部说明小字：字段口径、数据日期、加载提示                │
└─────────────────────────────────────────────────────────┘
       ↓ 点击主/副图任意一点 → 右侧抽屉滑出
┌─── 右侧抽屉 (固定宽 420px, position:fixed) ────────┐
│ 日期标题 + 关闭 ×                                   │
│ ─────────────────────────────────────────────    │
│ A. 净值与资金块                                     │
│    净值倍数 / 较前日变动 / 总资产 / 持仓市值 / 现金  │
│ B. 市场状态标记块                                   │
│    多头 / 活跃波段 / 买入门控 三个布尔徽章           │
│ C. 今日成交块                                       │
│    ▲ 买入：股票 价格 仓位%                          │
│    ▼ 卖出：股票 价格 退出原因（含 partial_tp_lvN）   │
│    （无成交时显示 "今日无成交"）                     │
│ D. 当日持仓表（按"截至今日累计已实现+剩余成本"降序） │
│    代码 / 名称 / 持有天数 / 买入价 / 累计盈亏% / 仓位 │
└──────────────────────────────────────────────────┘
```

抽屉打开/关闭、KPI 条内容、底部说明、活跃波段色块均**无动画**——`display:none` 切换即可。

## 5. 关键数据重建算法

### 5.1 每日持仓集合

`daily.open_positions` 只是计数，没有具体标的。需要从 `trades.json` 倒推每日 `holdings[date] = [position, ...]`。**伪代码**：

```
holdings = {}  // date -> List<positionSnapshot>，行键 (symbol, buy_date) 复合
for t in trades:
    cost = t.buy_value
    pos = { symbol, name, buy_date: t.buy_date, buy_price: t.buy_price,
            cost_initial: t.buy_value, cost_remaining: t.buy_value,
            sells: t.sells, last_sell_date: t.last_sell_date }
    // 闭区间：buy_date（含）到 last_sell_date（含）每天都计入持仓
    // last_sell_date 当日抽屉 C 块显示 ▼ 卖出事件，D 块仍含此持仓行（语义：收盘后卖出）
    for d in trading_dates where buy_date <= d <= last_sell_date:
        holdings[d].push(snapshot(pos, d))
```

"snapshot(pos, d)" 计算：按 `pos.sells` 中 `sell_date < d` 的所有分批卖出（**严格小于**，避免当日卖出被双计），累计已实现 PnL；`sell_date === d` 的卖出**仅记入抽屉 C 块（成交事件）**、不在 D 块持仓表中扣减剩余成本。需要预先按 `sell_date` 升序处理 `sells[]`。

trading_dates 取自 `daily.json` 里所有 `date` 字段（328 个），跳过非交易日。

**同标的多次买入**：实测数据中如 603036 如通股份共 4 笔、000807 云铝股份共 3 笔。行键采用 `(symbol, buy_date)` 复合键——若同一日 D 表中确实出现同代码（实测扫一遍当前数据没有这种情况），按两行渲染，名称列后追加买入日小字 `(2025-01-21 起)` 以示区分。

### 5.2 买/卖标记

- 买入标记：每笔 trade 一个点 `{ date: t.buy_date, y: navByDate[t.buy_date] }`，type=`triangle`，红色。
- 退出标记：每笔 trade 取 `t.last_sell_date` 一个点，type=`triangle`、`symbolRotate:180`，蓝色。
- 不画分批 partial_tp 点（数量太多且抽屉里能看见详细 sells[]）。

### 5.3 活跃波段高亮

扫描 `daily.json` 按 date 升序，连续满足 `is_market_bull===1 && in_active_wave===1` 的天数视作一个段，记录**闭区间** `[startDate, endDate]`（首末日均含）。在 ECharts `markArea` 中渲染，xAxis 起点用 `startDate`、终点用 `nextTradingDayAfter(endDate)`——以保证色块覆盖到 `endDate` 当日的柱体（ECharts category 轴的 markArea 终点是"到该刻度前"的语义）。如 endDate 已是数据末日，则用 `endDate` 本身作终点。颜色 `rgba(34,197,94,0.08)`，无边框。

### 5.4 净值基准化

策略净值序列 = `daily[i].capital_after_close / daily[0].capital_after_close`（用 daily[0] 而非 `meta.params.initial_capital`，避免对 meta 的额外耦合；二者实测等价均 = 1,000,000）。

基准序列：

```js
const benchRows = bench.series.find(s => s.name === '同花顺全A').rows;
// benchRows[i] = { date, close, nav }
// nav 字段已经按首日=1.0 预归一化，直接当 y 用，不再做任何除法
```

注意 daily 与 bench 都从 `2025-01-02` 起、共 328 个交易日，按 date 升序天然对齐，不必做日期 join。

### 5.5 持仓表盈亏字段口径（重要）

由于无逐股每日收盘价，**不能展示"当日 mark-to-market 浮盈"**——直接写 0.00% 会被误读为浮盈为零。因此：

- 列名改为 **"已实现盈亏%（截至当日）"**，并带表头 tooltip 注明语义。
- 计算口径：

```
该笔交易中，所有 sells[].sell_date < 当前查看日期 的已实现 PnL 之和 / buy_value
```

- 当前查看日期 ≤ buy_date 或该笔尚未发生任何 partial sell 时，**该格显示 `—` 而非 `+0.00%`**，避免误读为"今日浮盈 0"。
- 当前查看日期 === last_sell_date 那行抽屉 D 表（按 §5.1 闭区间仍含）显示截至前一日的累计已实现，C 块同时列出今日 ▼ 退出事件。

> 这是经过认真权衡后的妥协：试图凑出真实浮盈需要再去 Tushare 拉每日收盘价，会让"简单 HTML"膨胀成数据同步项目，违反 §1 范围。

## 6. UI 细节约定

| 项 | 取值 |
|---|---|
| 主图高度 | `55vh` |
| 副图高度 | `15vh` |
| 抽屉宽度 | `420px`（PC 浏览器视口默认 ≥ 1280px，不做窄屏适配） |
| 字号 | 默认 13px，KPI 数字 22px |
| 主题色 | 净值红 `#E53935`，基准橙 `#FB8C00`，买入红 `#E53935`，卖出蓝 `#1E88E5`，活跃波段绿底 `rgba(34,197,94,0.08)` |
| 涨跌色 | 涨红跌绿（A 股习惯） |
| 日期显示 | `YYYY-MM-DD (周X)`，周几用 `['日','一','二','三','四','五','六'][new Date(...).getDay()]` |
| 金额格式化 | ≥1e4 显示"X.X万"；≥1e8 显示"X.XX亿" |
| 状态徽章 | 多头/活跃波段/门控 三个，亮起=绿底白字，未亮=灰底灰字 |
| 持仓表盈亏列 | 列名 "已实现盈亏%（截至当日）"，未发生 partial sell 显示 `—`，详见 §5.5 |

## 7. 实施步骤

合并为单一实施任务，**一个 agent / 一次会话**就能做完，**不**适合 dispatching-parallel-agents 拆分。理由：单文件 HTML 内 `<style>` / `<script>` / 数据重建算法共享同一份 `state.byDate` 闭包与 DOM 引用，强行三路并行需要先冻结接口契约，开销 > 收益。

1. 写 `holdings.html`：HTML 骨架 + `<style>` + ECharts CDN + `<script>`。
2. `<script>` 入口 `Promise.all([fetch meta/trades/daily/bench])`，串联到 `render(data)`。
3. 实现 §5.1~5.4 的数据重建，缓存到 `state.byDate[date]`。
4. 实现 ECharts 双子图（主+副），共享 X 轴 + dataZoom + markArea + markPoint。
5. 实现抽屉的 4 个块（A 资金 / B 状态 / C 成交 / D 持仓表）与曲线点击事件。
6. 顶部 KPI 条直接读 `meta.stats`。
7. **本地验证 checklist**（必跑）：
   - [ ] `python -m http.server 8765` 启动后打开页面无控制台报错
   - [ ] KPI 条数值与 `meta.stats` 一致（总收益 +102.95% / 年化 +67.99% / 回撤 7.5% / 胜率 44.74% / 成交 190 / 持仓 110）
   - [ ] 主图末端净值倍数显示 ≈ 2.03（= 2,029,506.62 / 1,000,000）
   - [ ] 副图 2026-05-15 持仓柱 = 6（与 daily.json 末行 `open_positions=6` 对齐）
   - [ ] 点击 2025-08-14 抽屉显示买入"688168 安博通"
   - [ ] 点击 2026-05-15 抽屉持仓数 = 6 与副图一致
   - [ ] 活跃波段背景块覆盖了 2026-04 至 05 持续多头那段
   - [ ] 抽屉"累计盈亏%"对一笔已知有 partial_tp 的标的（如爱玛科技 2025-01-16）做手工核对

## 8. 风险与开放问题

- **CDN 不可用**：CDN 链接失败时 ECharts 不加载，页面白屏。在 `<script>` 里加一段 `if (typeof echarts === 'undefined')` 的 fallback 提示文案，告知用户检查网络或换 unpkg。
- **抽屉点击命中**：ECharts 点击事件 `params.componentType` 可能是 `markPoint`/`markArea`/`series`，统一通过 `params.dataIndex` 或 `params.value[0]`（X 轴值）映射回日期；buy/sell markPoint 命中时优先用 markPoint 自带的 `coord[0]`，其它命中按 X 轴值。

## 9. 不在范围

- 不写测试（一次性脚本，验证靠 §7.7 人工 checklist）。
- 不写 README（HTML 内嵌使用说明 + 本 spec 已足够）。
- 不进 git。
- 不做参数化（slug 写死在这一次回测；下次回测换数据时重跑数据下载流程后此 HTML 自动反映新数据）。
