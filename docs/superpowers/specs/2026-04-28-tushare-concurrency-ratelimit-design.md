# Tushare 并发 + 自适应限速 设计文档

日期：2026-04-28

## 背景

当前 A 股同步流程为纯串行：`for` 循环逐个交易日，每日顺序调用 `daily`、`daily_basic`、`adj_factor` 三个 Tushare 接口。无并发，也无主动限速机制（仅有被动重试）。历史回填约 1500+ 个交易日，串行耗时过长。

## 目标

- 按交易日维度并发同步，多个日期同时处理
- 在 `TushareClientService` 层统一限速：固定最小间隔 + 遇限流时自动降速、自动恢复
- 并发数和间隔参数通过 `.env` 配置

---

## 架构

### 变更文件

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `tushare-client.service.ts` | 改造 | 新增并发控制 + 自适应限速 |
| `a-shares-sync.service.ts` | 改造 | 串行 for 循环 → Promise.all 并发 |
| `.env` / `.env.example` | 新增 | 三个配置变量 |

---

## 第一部分：TushareClientService 限速器

### 并发控制

使用 `p-limit` 包裹每次 HTTP 请求。

```
TUSHARE_CONCURRENCY=5   # 默认值，最大同时在途请求数
```

超出上限的请求自动排队，不丢弃。

### 最小间隔

维护实例变量 `lastRequestAt: number`（上次请求发出的时间戳）和 `currentIntervalMs: number`（当前生效间隔）。

每次请求进入 p-limit 队列后、实际发出前：

```
wait = currentIntervalMs - (now - lastRequestAt)
if (wait > 0) sleep(wait)
lastRequestAt = now
```

### 自适应调速

- **遇限流**（`shouldRetryTusharePayload` 返回 true）：
  `currentIntervalMs = min(currentIntervalMs * 2, TUSHARE_MAX_INTERVAL_MS)`
- **请求成功**：
  `currentIntervalMs = max(currentIntervalMs * 0.9, TUSHARE_MIN_INTERVAL_MS)`

初始值 `currentIntervalMs = TUSHARE_MIN_INTERVAL_MS`。

效果：正常时匀速；被限流后踩刹车；流量恢复后逐步提速（约 7 次成功后恢复一半间隔）。

---

## 第二部分：ASharesSyncService 并发

### 并发模型

将当前 `for` 循环改为 `Promise.all`，所有交易日同时启动，实际并发由 `TushareClientService` 的 p-limit 控制，SyncService 层不再加额外限制。

每个日期内部处理顺序不变：

```
daily → daily_basic → adj_factor（串行）
```

### 共享状态

JS 单线程，无竞态风险，计数器和 Set/Map 直接累加：

- `quotes`、`metrics`、`adjFactors`、`skippedDates`、`skippedDatasets`（number）
- `changedRanges`（`Map<string, string>`）
- `latestAdjFactorChanged`（`Set<string>`）
- `failedItems`（`ASharesSyncFailedItem[]`）

### 进度上报

不再按"当前第几个日期"线性推进，改为已完成数量驱动：

```
completedDates++
emit({ percent: calculateSyncPercent(completedDates, total), ... })
```

每完成一个日期 emit 一次，顺序不保证，总数准确。

---

## 第三部分：环境变量

新增至 `.env` 和 `.env.example`：

```env
# Tushare 并发与限速
TUSHARE_CONCURRENCY=5
TUSHARE_MIN_INTERVAL_MS=200
TUSHARE_MAX_INTERVAL_MS=5000
```

- `TUSHARE_CONCURRENCY`：最大并发 Tushare 请求数（p-limit 上限）
- `TUSHARE_MIN_INTERVAL_MS`：正常情况下请求间最小间隔（ms）
- `TUSHARE_MAX_INTERVAL_MS`：限流时自适应间隔的上限（ms）

配置在 `TushareClientService` 构造函数中一次性读取，不支持热更新，重启生效。

---

## 不在范围内

- SyncService 层的日期级并发数配置（由 TushareClientService 的请求并发数间接控制，不单独暴露）
- 跨进程/多实例的全局限速（当前单进程部署，不需要）
- 历史回填的单独入口（复用现有同步接口，传入 startDate/endDate 即可）
