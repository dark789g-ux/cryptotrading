# 开发方案：修正 backtest_candle_logs.ts 时区落库 BUG

## 一、背景与问题

### 1.1 现象
回测详情 → K线记录 → 点击某根 K 线"详情" → 弹窗里勾选"仅本根有交易" → 应用筛选，
预期看到该根 K 线发生入场/出场的标的（如 GLMUSDT），实际数据行为空。

### 1.2 根因（已查清，**勿再花时间复现**）
`backtest_candle_logs.ts` 列类型为 `timestamp without time zone`，写入路径在
`apps/server/src/backtest/backtest-execution.pipeline.ts` 约 138 行：

```ts
ts: new Date(entry.ts.replace(' ', 'T') + 'Z'),
```

把一个表示 UTC 的 JS `Date` 交给 node-postgres。驱动按 **Node 进程本地时区**
（机器为 Asia/Shanghai +08）格式化为 `'2026-01-12 05:00:00.000+08'`，
PostgreSQL 解析 `timestamp without time zone` 时**忽略 TZ 段**，
最终库内存的是"Node 本地墙钟" `2026-01-12 05:00:00` —— 既不是 UTC、也不是 PG 会话墙钟（PG 会话为 UTC）。

读取路径 `candle-log.controller.ts` 的 `formatTs` 用 `getUTCxxx` 把 Date 反推回
`2026-01-11 21:00:00` 给前端展示，写读自洽，所以列表/筛选肉眼看不出问题。

但 `run-symbol-metrics.query.ts` 的裸 SQL 是按"UTC 墙钟"假设比对的：
```sql
LEFT JOIN backtest_candle_logs cl
  ON cl.run_id = $X AND cl.ts = ($2::timestamptz AT TIME ZONE 'UTC')
```
得 `2026-01-11 21:00:00` 与库里 `2026-01-12 05:00:00` 对不上 → JOIN 不到 cl 行 →
"仅本根有交易"过滤剔光所有行。

### 1.3 已上线的临时补丁
`apps/server/src/backtest/run-symbol-metrics.query.ts` 与
`apps/server/src/backtest/backtest-ts.util.ts` 已加 `fmtLocalWallClock`，
临时把入参按 Node 本地 TZ 转换后注入比对，**让筛选先恢复可用**。

但根问题没解决，新问题随时再爆：
- `kline-chart.controller.ts` 等任何对 `cl.ts` 做裸 SQL 比对的地方都会踩同样的坑；
- 一旦服务部署到非 +08 时区或 cron 任务运行 TZ 不同，全表数据语义错乱；
- 与项目硬约束"显式指定 encoding/utf-8、避免隐式转换"精神相悖。

---

## 二、目标

将 `backtest_candle_logs.ts` 列类型改为 `timestamp with time zone (timestamptz)`，
让 JS `Date` 与 PG 之间的时区往返是无歧义的，并迁移现有数据 + 移除临时补丁。

完成后：
1. 库中存的就是 UTC 瞬时；
2. 任何写入/读取/裸 SQL 比对都不再依赖"Node 本地 TZ"或"PG 会话 TZ"；
3. 前端展示与现状完全一致（仍是 UTC 墙钟字符串）。

---

## 三、影响面盘点（**必须全量改完，不得遗漏**）

### 3.1 实体
- `apps/server/src/entities/backtest-candle-log.entity.ts`
  - `@Column({ type: 'timestamp' }) ts: Date` → `@Column({ type: 'timestamptz' }) ts: Date`

### 3.2 写入路径
- `apps/server/src/backtest/backtest-execution.pipeline.ts` 写入处保持 `new Date(...+'Z')` 不变。
  改 `timestamptz` 后驱动会带本地 TZ offset 发送，PG 会**保留时区语义**正确换算为 UTC 瞬时存储。✅

### 3.3 读取路径（确认是否需要调整）
- `apps/server/src/backtest/candle-log.controller.ts`
  - `formatTs(d: Date)` 已用 `getUTCxxx` → 读 `timestamptz` 拿到 JS Date 后照样 UTC 输出，**无需改**。
  - `qb.andWhere('cl.ts >= :startTs', { startTs: jsDate })` 改 `timestamptz` 后语义自动正确。
  - `qb.andWhere('cl.ts <= :endTs', ...)` 同理。

### 3.4 裸 SQL 比对路径
- `apps/server/src/backtest/run-symbol-metrics.query.ts`
  - 改回干净写法：`AND cl.ts = $2::timestamptz`（去掉 `AT TIME ZONE 'UTC'` 与 `$X::timestamp`）。
  - 移除 `import { fmtLocalWallClock }`、移除多塞的 `tsLocal` 参数与 `pi += 2` 退回 `pi++`。
- `apps/server/src/backtest/kline-chart.controller.ts`
  - 检查所有对 `backtest_candle_logs.ts` 或类似 `timestamp(无时区)` 列的比对，统一用 `::timestamptz`。
  - 该文件已 `import { parseUTC } from './backtest-ts.util'`，看 `parseUTC` 结果是怎么进 SQL 的，按需调整。

### 3.5 工具函数
- `apps/server/src/backtest/backtest-ts.util.ts`
  - 删除 `fmtLocalWallClock`（无人调用后）。
  - `parseUTC` / `fmtTs` 保留。

### 3.6 数据迁移（**关键**）
现有 `backtest_candle_logs` 行的 `ts` 字段值是"Node 本地墙钟"（+08 已写入字段值里）。
直接 `ALTER COLUMN ts TYPE timestamptz USING ts AT TIME ZONE current_setting('TimeZone')`
会把 `'2026-01-12 05:00:00'` 当作 UTC 解释 → 错。

正确迁移：把现有"Node 本地墙钟"按 +08 反推回 UTC 瞬时：

```sql
ALTER TABLE backtest_candle_logs
  ALTER COLUMN ts TYPE timestamptz
  USING (ts AT TIME ZONE 'Asia/Shanghai');
```

> `timestamp AT TIME ZONE 'Asia/Shanghai'` 的语义是："把这个无时区时间戳当成
> Asia/Shanghai 墙钟来解读，得到对应的 UTC 瞬时"。这正是我们需要的反向修正。

迁移前先备份：
```bash
docker exec crypto-postgres pg_dump -U cryptouser -d cryptodb -t backtest_candle_logs > backup_candle_logs_$(date +%Y%m%d).sql
```

迁移后立即抽样校验：
```sql
SELECT bar_idx, ts AT TIME ZONE 'UTC' AS utc_wall
FROM backtest_candle_logs
WHERE run_id = '841c0d17-f3c6-417e-97ff-487a6dc70403'
ORDER BY bar_idx
LIMIT 5;
```
应当看到 `2026-01-11 12:00:00`、`13:00:00` … 这种 UTC 墙钟（与前端展示一致）。

### 3.7 同步排查其他疑似列
全工程 grep 一次：
```
rg "type:\s*'timestamp'\b" apps/server/src/entities
```
列出所有 `timestamp without time zone` 列，**逐个评估**是否同样写入 JS Date：
- 如是，本案同样问题，需要一并迁移；
- 如纯字符串入库且明确按 UTC 墙钟使用，做注释保留。

至少需要确认：`backtest-run.entity.ts` 的 `createdAt`、`backtest-trade.entity.ts` 的
`entryTime/exitTime` 等字段类型与写入方式。

---

## 四、执行步骤（顺序严格）

1. **环境检查**
   - 确认 Node 进程当前 TZ：`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"` 期望 `Asia/Shanghai`。
   - 确认 PG 会话 TZ：`SHOW TimeZone;` 期望 `UTC`（与现网一致）。
   - 若任一不符，**先停下来与用户确认**，因为迁移 SQL 中的 `'Asia/Shanghai'` 假设了写入时的 TZ。

2. **数据备份**
   - 执行 §3.6 的 `pg_dump` 命令，留底文件名记入 commit message。

3. **数据迁移 SQL**
   - 在事务里跑 `ALTER COLUMN ... USING ...`：
     ```sql
     BEGIN;
     ALTER TABLE backtest_candle_logs
       ALTER COLUMN ts TYPE timestamptz
       USING (ts AT TIME ZONE 'Asia/Shanghai');
     COMMIT;
     ```
   - 跑校验 SQL，确认前端原本展示的时间与 `ts AT TIME ZONE 'UTC'` 一致。

4. **代码改动**
   - 改实体 `@Column({ type: 'timestamptz' })`；
   - 还原 `run-symbol-metrics.query.ts` 的 SQL 与参数（去掉临时补丁）；
   - 删除 `fmtLocalWallClock` 及其 `import`；
   - 排查并修正 `kline-chart.controller.ts` 等其他比对点。

5. **类型自检**（硬约束）
   ```
   cd apps/server && pnpm exec tsc --noEmit
   ```
   零报错。

6. **回归用例**（让用户跑，**禁止 agent 自测**）
   - 用例 1：原 BUG 复现路径
     1) 策略"K线详情测试" → 详情
     2) "K线记录" tab
     3) 勾选"仅显示有操作的K线" → 查询
     4) 点 ts=`2026-01-11 21:00:00` 行的"详情"
     5) 弹窗勾"仅本根有交易" → 应用筛选
     6) **应当**出现 GLMUSDT 数据行
   - 用例 2：K 线图弹窗（`KlineChartModal`）正常打开、时间轴标签与候选 K 线对齐。
   - 用例 3：K线记录列表本身的时间筛选（开始/结束时间）边界值正常。
   - 用例 4：跑一次新回测，新写入数据 `ts AT TIME ZONE 'UTC'` 与日志内 ts 一致。

---

## 五、回滚预案

- 代码：git revert 本次 commit。
- 数据：用 §4.2 备份 `psql -f backup_candle_logs_YYYYMMDD.sql` 恢复表（先 `DROP TABLE backtest_candle_logs;`）。
- 临时补丁仍在 git 历史，必要时可 cherry-pick 回来兜底。

---

## 六、不要做的事（硬约束复述）

- ❌ 不要自己跑前端验证，让用户跑。
- ❌ 不要在 PowerShell 用 `&&`。
- ❌ 不要 `git log` / `git diff` 查历史。
- ❌ 不要在 SQL 里用 `'[]'::jsonb` 字面量绑定参数（用 `CAST('[]' AS jsonb)`）。
- ❌ 不要保留 `fmtLocalWallClock` 这个临时补丁；本方案完成即删，避免后人误用。
- ❌ 不要在迁移 SQL 里用 `current_setting('TimeZone')` 替代 `'Asia/Shanghai'`：
  PG 会话 TZ 是 UTC，会得到错误结果。**必须**显式指定写入时的 Node TZ。

---

## 七、产出清单（PR 必含）

1. 实体改动 diff
2. SQL 改动 diff（含 `run-symbol-metrics.query.ts` 还原、`kline-chart.controller.ts` 同步修复）
3. 工具函数清理 diff
4. 迁移脚本：`apps/server/migrations/<timestamp>-fix-candle-log-ts-tz.sql`
   （即使项目暂无 migration runner，也要把可执行 SQL 文件归档进仓库）
5. 备份文件名与执行日志（贴到 PR 描述）
6. `pnpm exec tsc --noEmit` 通过截图/日志
7. 用户回归测试结论
