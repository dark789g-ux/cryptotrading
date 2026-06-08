# 02 · 后端模块设计

[← 返回 index](./index.md) · [← 01-architecture](./01-architecture.md)

后端完全仿现有 SSE 范式模板 `ths-index-daily`。下方所有范式引用均已派 Explore 子代理核实 file:line。

## 目录结构与注册

```text
apps/server/src/market-data/base-data-sync/
├─ base-data-sync.module.ts        TypeOrmModule.forFeature([TradeCal,StkLimit,Suspend])
│                                   controllers:[BaseDataSyncController]
│                                   providers:[BaseDataSyncService, TushareClientService]
├─ base-data-sync.controller.ts    @Controller('base-data'): @Get('sync/run') SSE + @Get('range')
├─ base-data-sync.service.ts       sync(dto,onProgress) + startSync(Subject+锁) + getStoredRange()
└─ base-data-sync.types.ts         SyncDto / SyncEvent / SyncResult / ErrorItem
+ app.module.ts                     imports 数组追加 BaseDataSyncModule
```

**双注册铁律**：三实体已在 `app.module.ts:112-114` 根 `entities` 数组，但**无 forFeature**。新模块必须 `TypeOrmModule.forFeature([TradeCalEntity, StkLimitEntity, SuspendEntity])` 才能 `@InjectRepository`。`TushareClientService` 在 ths-index-daily 是**本地 provide**（非全局 export），新模块同样在自己 providers 里直接列它；它依赖 `ConfigService`，而 `ConfigModule` 全局（`app.module.ts:89` `isGlobal:true`），无需单独 import。

**无需 migration**：三表已建（M1 Part C），仅补 forFeature。

## 控制器（SSE，仿 `ths-index-daily-sync.controller.ts`）

```text
@Controller('base-data')            // 单控制器：sync 与 range 共用前缀但各自路由
class BaseDataSyncController {
  @Get('sync/run')                  // → /api/base-data/sync/run
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  run(@Query() raw, @Res() res) {
    // 1) guard: start_date/end_date 为 8 位 YYYYMMDD、start<=end，否则 400/SSE error
    // 2) res.flushHeaders()                       ← 必须在 subscribe 前
    // 3) const subject = this.service.startSync(dto)
    // 4) const sub = subject.subscribe({
    //      next: e => res.write(`data: ${JSON.stringify(e)}\n\n`),
    //      complete: () => res.end(), error: () => res.end() })
    // 5) res.on('close', () => sub.unsubscribe())
  }

  @Get('range')              // → /api/base-data/range（库存范围，驱动前端增量默认）
  range() { return this.service.getStoredRange() }
}
```

> ★关键细节（范式）：`res.flushHeaders()` 必须在 `subject.subscribe` **之前**，确保客户端连接建立即收 200 + SSE 头，长耗时同步不超时断连（ths 控制器第 28→29 行顺序不可颠倒）。

## 服务（仿 `ths-index-daily-sync.service.ts`）

### startSync（异步 + 单飞锁）

```text
startSync(dto): Subject<SyncEvent> {
  const subject = new Subject<SyncEvent>()
  if (this.isSyncing) {
    setTimeout(() => { subject.next({type:'error', message:'同步进行中'}); subject.complete() }, 0)
    return subject
  }
  this.isSyncing = true
  setTimeout(async () => {
    try {
      const result = await this.sync(dto, e => subject.next(e))
      subject.next({ type:'done', message: result.errors.length?`完成，${result.errors.length} 项失败`:'同步完成', result })
    } catch (e) { subject.next({ type:'error', message: String(e) }) }
    finally { this.isSyncing = false; subject.complete() }
  }, 0)
  return subject
}
```

### sync(dto, onProgress) —— 串行 4 步（依赖顺序硬保证）

```text
async sync(dto, onProgress): Promise<SyncResult> {
  const errors: ErrorItem[] = []; let success = 0, skipped = 0

  // ── Step1 trade_cal ──────────────────────────────
  onProgress({type:'progress', phase:'trade_cal', ...})
  const calRows = await runWithRetry(() =>
    this.tushareClient.query('trade_cal',
      { exchange:'SSE', start_date, end_date }, TRADE_CAL_FIELDS))
  if (calRows.length === 0) errors.push({ apiName:'trade_cal_empty', params })
  else { await upsert trade_cal (is_open: parseInt(str), 键['exchange','calDate']); success += n }

  // ── Step2 取开市日 (查库, 不再调 Tushare) ─────────
  const openDates = await this.tradeCalRepo.find(
    { where:{ exchange:'SSE', isOpen:1, calDate: Between(start,end) } }) → cal_date[]
  if (openDates.length === 0) {
    errors.push({ apiName:'no_open_trade_dates', params }); return { success, skipped, errors } }

  // ── Step3 stk_limit 逐开市日 ─────────────────────
  for (const d of openDates) {
    const rows = await runWithRetry(() => this.tushareClient.query('stk_limit',{trade_date:d}, STK_LIMIT_FIELDS))
    if (rows.length === 0) { errors.push({apiName:'stk_limit_empty', params:{trade_date:d}}); continue }
    await upsert stk_limit (键['tsCode','tradeDate']); success += rows.length
  }

  // ── Step4 suspend_d 逐开市日 ─────────────────────
  for (const d of openDates) {
    const rows = await runWithRetry(() => this.tushareClient.query('suspend_d',{trade_date:d}, SUSPEND_FIELDS))
    if (rows.length === 0) { errors.push({apiName:'suspend_d_empty', params:{trade_date:d}}); continue } // 可能正常
    await upsert suspend_d (键['tsCode','tradeDate','suspendType']); success += rows.length  // ★3 列键
  }
  return { success, skipped, errors }
}
```

### 字段映射（验证已落源头）

| 表 | Tushare 出参 → 实体列 | upsert 冲突键 | 类型转换 |
|---|---|---|---|
| trade_cal | exchange→exchange · cal_date→calDate · is_open→isOpen · pretrade_date→pretradeDate | `['exchange','calDate']` | **is_open str→smallint** (parseInt) |
| stk_limit | trade_date→tradeDate · ts_code→tsCode · pre_close→preClose · up_limit→upLimit · down_limit→downLimit | `['tsCode','tradeDate']` | numeric 原样字符串入库 |
| suspend_d | ts_code→tsCode · trade_date→tradeDate · suspend_timing→suspendTiming · suspend_type→suspendType | `['tsCode','tradeDate','suspendType']` ★3 列 | suspend_timing 可 None → null |

> upsert 前用 `deduplicateBy(rows, 冲突键)` 显式去重（仿 ths 服务 209 行），避免同批冲突；分批 1000 行。每行写 `updated_at = now`。

### getStoredRange()（驱动前端增量默认 + 库存标签）

```text
getStoredRange(): { stkLimit:{min,max}, suspend:{min,max}, tradeCal:{min,max} }
// 用 MAX(trade_date)/MIN 三表各查一次。
// ★增量水位锚定 stk_limit.max(trade_date)：stk_limit 每开市日每只票都有行，稠密可靠；
//   trade_cal 含未来日历(不可用作水位)、suspend_d 稀疏(无停牌日无行，max 会偏旧)。
```

## data-integrity 错误处理（硬规范）

落实 `.claude/rules/data-integrity.md`：

1. **空数据 warn + failedItem**：每个 Tushare 调用 `rows.length===0` → `logger.warn(apiName + 完整 params)` + `errors.push({apiName:'xxx_empty', params})`。apiName：`trade_cal_empty` / `no_open_trade_dates` / `stk_limit_empty` / `suspend_d_empty`。
   - 复用 `tushareClient.query`（已封装 envelope）；服务层只能见到 `TushareRow[]`，故按 ths 范式只判 `length===0`。`payload.data===null` 的双路径区分在 `tushareClient` 内部，属既有共享行为，不在本任务改造范围。
2. **禁 `.catch(()=>[])` 静默吞错**：错误全部进 `result.errors`，并 `logger` 打印具体 apiName + error。
3. **0 行不得伪装成功**：`success` 只累计真实写入行数；空调用计入 `errors`，前端 done 事件能看到。
4. **suspend_d 弱对齐**：suspend_d 的 `_empty` 仅 warn/记录，**不**进「跨表行数对齐」硬断言（它可合法为空），避免误杀正常稀疏日。stk_limit 才参与跨表对齐校验（每开市日应有行）。

## DTO / 类型（`base-data-sync.types.ts` 或并入 shared-types）

```text
SyncDto      = { start_date:string; end_date:string; syncMode:'incremental'|'overwrite' }
SyncEvent    = { type:'progress'; phase:string; current:number; total:number; percent:number; message:string }
             | { type:'done'; message:string; result:SyncResult }
             | { type:'error'; message:string }
ErrorItem    = { apiName:string; params:Record<string,unknown> }
SyncResult   = { success:number; skipped:number; errors:ErrorItem[] }
StoredRange  = { stkLimit:{min:string|null;max:string|null}; suspend:{...}; tradeCal:{...} }
```

> 对象键名一律英文（防 PowerShell GBK 裸中文键报错）；源文件 UTF-8。

> ★`syncMode` **后端不分支**：`sync()` 的 Step1-4 一律幂等 upsert，**不**因 overwrite 做区间 DELETE，也**不**因 incremental 改变写入逻辑——两种模式后端写入行为完全相同。`syncMode` 仅供**前端**用于：① `openModal` 计算默认日期范围（incremental=水位+1 起，overwrite=用户全选）；② 复用 `DataSyncModal` 现成 props。后端收到后可忽略其值（保留入 DTO 仅为 query 透传与未来扩展余地）。

## 重启提醒

后端 `dev` 是 `nest start`（无 watch）。新增 controller/route 后**必须** `pnpm --filter @cryptotrading/server build` + 重启后端进程，否则前端撞 404。

[下一篇：03-frontend →](./03-frontend.md)
