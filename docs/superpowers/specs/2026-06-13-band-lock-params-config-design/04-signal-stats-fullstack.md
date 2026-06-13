# 04 · signal-stats 全栈落地（DTO / 校验 / 存储 / 模拟 / 前端）

> signal-stats 是用户「自行配置 → run → 看前向统计」的主战场。这条链路给完整 4 控件。
> 路径前缀 `apps/server/src/strategy-conditions/signal-stats/`、`apps/web/src/views/strategy/`。

## 一、DTO（`dto/create-signal-test.dto.ts`）

trailing_lock 专属，4 个顶层可选字段（与现有扁平风格一致；不传 = 用默认）：

```ts
/** 止损缓冲系数（仅 trailing_lock）。留空=0.999；范围 (0,1]，量化到 0.001。 */
stopRatio?: number;
/** 成本地板系数（仅 trailing_lock）。留空=0.999；范围 [0.001,9.999]，允许 >1（锁盈）。量化到 0.001。 */
floorRatio?: number;
/** 启用成本地板（仅 trailing_lock）。留空=true。 */
floorEnabled?: boolean;
/** 锁定后 MA5 离场是否要求 MA5 下行（仅 trailing_lock）。留空=true。 */
ma5RequireDown?: boolean;
```

## 二、service 校验（`signal-stats.service.ts` `validateDto`，现 `:295-305` trailing_lock 分支）

在 trailing_lock 分支内追加（fail-fast，沿用 `BadRequestException`）：

```text
stopRatio:      若提供 → 量化后 NNNN∈[1,1000]（ratio∈[0.001,1.0]），否则 400
floorRatio:     若提供 → 量化后 NNNN∈[1,9999]（ratio∈[0.001,9.999]），否则 400
floorEnabled:   若提供 → boolean
ma5RequireDown: 若提供 → boolean
```

非 trailing_lock 模式传这 4 个字段 → 400（保持模式纯净；前端本就只在 trailing_lock 分支送）。

> `floorRatio` 上界 9.999 来自 scheme 4 位定宽编码（02 §3.1）；锁盈实务远不及此，纯防御。

## 三、存储：entity + migration

### entity（`apps/server/src/entities/strategy/signal-test.entity.ts`）

加一个 jsonb 列（该表 `buy_conditions`/`exit_conditions` 已是 jsonb，风格一致）：

```ts
/** 波段跟踪止损额外参数；null = 全默认（存量行零漂移）。 */
@Column({ type: 'jsonb', nullable: true, name: 'band_lock_params' })
bandLockParams: {
  stopRatio: number; floorRatio: number;
  floorEnabled: boolean; ma5RequireDown: boolean;
} | null;
```

service 落库：trailing_lock 且任一字段非默认 → 组装完整 4 字段对象存入；全默认 → 存 `null`。
读取构造 ExitConfig 时：`null` → 用 4 个默认值。

> ⚠️ 新实体列须同时在 `app.module` 根 entities 数组确认已注册（本表已注册，仅加列不涉新实体）。

### migration（`apps/server/migrations/`，`.sql` + 同名 `.ps1`）

```sql
-- 20260613_add_band_lock_params_to_signal_test.sql
ALTER TABLE signal_test ADD COLUMN IF NOT EXISTS band_lock_params jsonb;
```

`.ps1` 内置 `docker exec crypto-postgres psql -U cryptouser -d cryptodb -f ...`（参照现有 migration 配对）。
nullable 无 DEFAULT → 存量行 = `null` → 读时全默认 → **零漂移**。无 CHECK（与现有 `max_hold` 列风格一致，约束在 service）。

## 四、模拟器：构造 ExitConfig 透传

ExitConfig 的**唯一构造处** = `signal-stats.runner.ts:156-167`（`doExecute` 内，把 entity → `exit`
传给 `simulator.simulateSignalsBatched`）。trailing_lock 分支现 `:162-164`：
`exit = { mode:'trailing_lock', maxHold: maxHold ?? undefined }`。

改造：
- `:111` 解构 `test` 字段处加 `bandLockParams`。
- `:162-164` trailing_lock 分支补 4 字段（从 `test.bandLockParams`，null→默认）：

```ts
exit = { mode: 'trailing_lock', maxHold: maxHold ?? undefined,
  stopRatio:      bandLockParams?.stopRatio      ?? 0.999,
  floorRatio:     bandLockParams?.floorRatio     ?? 0.999,
  floorEnabled:   bandLockParams?.floorEnabled   ?? true,
  ma5RequireDown: bandLockParams?.ma5RequireDown ?? true };
```

`decideBandLock` 已在 03 接收这些字段（`simulator.ts:193-197` `simulateTradeCore` 透传 `exit.*`）。
MA5 取数/窗口（5）不动。

## 五、前端表单（`apps/web/src/views/strategy/SignalTestForm.vue`）

### 5.1 布局（trailing_lock 分支，现 `:52-68` 仅 maxHold）

```text
出场模式   ○固定N日   ○卖出条件命中   ◉波段跟踪止损
┌─ 波段跟踪止损参数 ─────────────────────────────┐
│ 最长持有(留空不封顶)  [____] 日                 │
│ 止损缓冲系数 (?)      [0.999]  min .001 max 1   │
│ 成本地板系数 (?)      [0.999]  ← floorEnabled关则灰│
│ 启用成本地板 (?)      [● on ]                   │
│ MA5需下行才离场 (?)   [● on ]                   │
└────────────────────────────────────────────────┘
```

控件：
- `stopRatio`：`n-input-number` `:min="0.001" :max="1" :step="0.001" :precision="3"`，默认 0.999。
- `floorRatio`：`n-input-number` `:min="0.001" :step="0.001" :precision="3"`，默认 0.999，
  `:disabled="!form.floorEnabled"`。
- `floorEnabled`：`n-switch`，默认 true。
- `ma5RequireDown`：`n-switch`，默认 true。
- 每个配 `(?)` 字段说明 tooltip（沿用项目「? 字段说明」惯例，复用现有 tooltip 组件/模式）。

### 5.2 form 状态 / watch / 提交

- `form` 初值（现 `:170-180`）加 `stopRatio:0.999, floorRatio:0.999, floorEnabled:true, ma5RequireDown:true`。
- `initialData`/`prefillData` 回填（现 `:182-218`）：从 `data.bandLockParams`（null→默认）回填 4 字段。
- 切换出场模式 watch（现 `:223-232`）：切到 trailing_lock 时这 4 个**保持默认/上次值**即可
  （它们的默认就是现状值，不像 maxHold 需复位 null）。
- 提交 `handleSubmit`（现 `:301-304` trailing_lock 分支）：**只上送非默认字段**（与 `maxHold ?? undefined`
  同思路），4 个全默认则一个都不送 → 后端存 `band_lock_params=null`。

### 5.3 行数约束

`SignalTestForm.vue` 现 317 行；加约 50 行后 ~370 行，仍 < 500（满足 code-organization）。
若逼近上限，把 trailing_lock 参数块抽成子组件 `BandLockParamFields.vue`。

## 六、验证点（进 06）

- 存量方案（`band_lock_params=null`）run 结果与改造前一致（零漂移）。
- 非默认方案 run：手算几笔逐位吻合（stop / ma5_exit / 锁盈地板拦截）。
- 非 trailing_lock 模式误送 4 字段 → 400。
- `vite build` 通过（不只 type-check）；真机点开 `/strategy` signal-test 页不白屏。
