---
paths:
  - "apps/server/**/*.ts"
  - "apps/web/**/*.{vue,ts}"
---

# 时间 / 日期

## DB 时间列一律 timestamptz

禁 `timestamp`（无 TZ 列遇 JS Date 按 Node 本地 TZ 落库，与 UTC 错位）。

## 入库一律传 JS Date（UTC 瞬时）

字符串入参 `'YYYY-MM-DD HH:MM:SS'` 视为 UTC 墙钟：`new Date(s.replace(' ','T')+'Z')`。

## 出参一律 UTC 墙钟字符串

用 `getUTCxxx` 拼装，禁 `toLocaleString`/`toISOString().slice`。

## 裸 SQL 比对 timestamptz 列

`col = $n::timestamptz`，禁 `AT TIME ZONE`、禁 `::timestamp` 中转。

## 跨进程/容器 Node TZ 不可控

绝不用 `getHours/getMonth` 等本地方法落库或入 SQL。

## 日期选择器是本地 TZ 例外

上述 UTC 要求只约束 DB 入库瞬时与裸 SQL 比对，**不适用于**用户从日期选择器选的日历日。

naive-ui `n-date-picker` 的 `[number, number]` 值是**本地午夜 ms**：
- 用 `getUTCFullYear/getUTCMonth/getUTCDate` 提取会让 CST 用户日期整体漂前 1 天
- **教训**：曾把 `20260509-20260511` 压成 `20260508-20260510` 导致整次同步看似完成实则一行未写

日历日提取一律用 `getFullYear/getMonth/getDate`；`buildDefaultDateRange` 等工具用 `new Date(y,m,d).getTime()` 取本地午夜。

后端 `timestamptz` 展示函数（`formatUTCDate`/`formatUTCDateTime`）仍按 UTC 规则。

## A 股 trade_date 存储格式

为 Tushare 标准 `YYYYMMDD`（如 `'20260506'`），**禁止直接 `new Date(tradeDate)`**（返回 `Invalid Date`）。

转 `Date` 须插分隔符：
```javascript
`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00Z`
```

仅用于展示用已有 `formatTradeDate`（前端）/ `formatTradeDateLabel`（后端），禁 `new Date()`。

## K 线副图对齐 key 不得假设两个后端接口的日期格式同源

`KlineChart` 副图通过 `flowMap.get(row.open_time)` 按 `trade_date` 对齐主图，**字符串必须字面相等**才能命中。

各 service 实际拼出的格式互不相同（如 `2026-05-15` vs `20260515`）：
- **禁止**让 `KlineChart` 容忍多种格式（掩盖契约不一致）
- **禁止**冲动改后端（影响面失控）
- 回到契约层统一
