# 08 · 持久化与 migration

## 已核 DB 事实(2026-06-14,进 migration 前已落源头)

- `portfolio_sim_run.config` 是 **jsonb**(`portfolio-sim-run.entity.ts:38`)→ 配置 schema 扩展
  (rankSpec/sizing/circuitBreaker)**无需 migration**,richer JSON 即可。
- `portfolio_sim_fill` 约束**只有 PK + FK,无 CHECK**(已查 `pg_constraint`)→ 新 skipReason
  `'cooldown'`/`'drawdown_halt'`/`'sized_out'` 进现有 `skip_reason varchar(16)` 无阻;`rank_field='composite'`
  进 `varchar(16)` 无阻。

## 唯一 migration:portfolio_sim_fill 加两列

为「逐因子透明」(用户定:一步到位加列),给 fill 加:

```sql
-- migrations/2026-06-14-portfolio-sim-fill-factor-values.sql
ALTER TABLE portfolio_sim_fill
  ADD COLUMN IF NOT EXISTS factor_values jsonb NULL,     -- {factorKey: value|null, ...} 逐因子原始值
  ADD COLUMN IF NOT EXISTS rank_score    numeric NULL;   -- composite 综合分(单因子=该因子值;none=null)
```

- `factor_values jsonb`:每笔(taken/skipped 都写,**含熔断冻结 skip 的笔**)的逐因子原始值。
- `rank_score numeric`:composite 综合分。`rank_value`(现列)继续写同值,保现有展示/排序兜底不破。
- 幂等 `IF NOT EXISTS`;无回填(老 run 这两列 NULL,详情降级显示「—」)。
- 无 CHECK/索引改动;`factor_values` 不进 WHERE/ORDER(仅展示),无需索引。

### 配套 .ps1(docker exec,项目规范)

```text
migrations/2026-06-14-portfolio-sim-fill-factor-values.ps1
  → 内置 docker exec crypto-postgres psql -U cryptouser -d cryptodb -f /.../*.sql
    (参照 apps/server/migrations/*.ps1 既有格式;UTF-8;PowerShell 禁 &&)
```

> migration 走 `migrations/*.sql` + 同名 `.ps1`;TypeORM `synchronize:false`,schema 变更一律走 migration。
> 本表无 Alembic(那是 quant-pipeline),无需 stamp。

## 实体更新(`portfolio-sim-fill.entity.ts`)

```text
+ @Column({ type:'jsonb',   nullable:true, name:'factor_values' }) factorValues: Record<string, number|null> | null
+ @Column({ type:'numeric', nullable:true, name:'rank_score'    }) rankScore: string | null
  skipReason 联合类型:增 'cooldown' | 'drawdown_halt' | 'sized_out'   // TS 层,DB 无 CHECK 不需改约束
```

- numeric 列 JS 侧仍以 string 取回(防精度),沿用现有 `rank_value`/`alloc` 模式。
- **TypeORM 实体双注册**(规范):fill 实体已注册,加列不新增实体 → 无需动 app.module entities 数组。

## runner 落库(`portfolio-sim.runner.ts`,`toFillEntity` 现 `:216-241`)

writing 阶段把 `EngineFill` 落 `portfolio_sim_fill` 时,新增/更正写入:

```text
factor_values = fill.factorValues ?? null
rank_score    = fill.rankScore ?? null
rank_value    = fill.rankScore ?? fill.rankValue ?? null      # composite 写综合分(rankValue 仅老 run 兜底)
skip_reason   = fill.skipReason ?? null                       # 含新 cooldown/drawdown_halt/sized_out
weight_entry  = fill.weightEntry ?? null                      # 现为有效权重 alloc/navRef(见 04)
# rank_field 经 resolveRankSpec 派生(不再直接读 source.rankField):
factors       = resolveRankSpec(source)                       # source 由 sourceIdx 取
rank_field    = factors.length>1 ? 'composite'
                : factors.length===1 ? factors[0].factor : 'none'
```

- **关键**:`toFillEntity` 现仅持 config+EngineFill、直接读 `source.rankField`;须引入 `resolveRankSpec(source)`
  派生 `rank_field`,否则 composite/legacy run 的 `rank_field` 落库值与实际排序口径不符。
- fill 是 append insert(非 upsert),无 conflictKey 去重问题;保持现有批量写法,补上述列。
- config 快照已是 jsonb 全量存(含 rankSpec/sizing/circuitBreaker),天然带上。

## 向后兼容(读)

- 老 run 的 `config` 无 rankSpec/sizing/circuitBreaker → 引擎经 `resolveRankSpec` 适配(01)、sizing 缺省
  fixed、circuitBreaker 缺省全关 → **行为与改造前一致**。
- 老 fill 的 `factor_values`/`rank_score` 为 NULL → 详情降级,不报错。
- **anchorMode 既有锚点 run 重放**:rankSpec 适配 + Phase2/3 旁路 → `realizedRetNet≡ret` 不变,
  既有 `anchor_check` 自校验仍 pass。
