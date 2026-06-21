# 03 · 筛选模块改造

> 前置：[02-calc-and-db.md](./02-calc-and-db.md)（roc10/20/60 已落库）。本篇把已提交的方案 A（现算）改造成读预存列。

## 3.1 改造目标

commit `788faf5` 提交的方案 A 是「OFFSET 子查询现算 + rocParams.n 任意可调」。落库后改为「读 `i.roc10/20/60` 预存列 + rocParams 三选一」，与表格同源。

```text
改造前后对比
┌──────────────────────────────────────────────────────────────┐
│ 方案 A（已提交，要删）          落库方案（本篇，要改）         │
├──────────────────────────────────────────────────────────────┤
│ field: 'roc'（单 key）          field: 'roc10'|'roc20'|'roc60'│
│ rocParams: { n: 任意 }          （删 rocParams）              │
│ query-builder OFFSET 子查询     读 i.roc10/20/60 预存列       │
│ resolveRocN / buildRocExpr      （删除）                       │
│ RocCfg interface                （删除）                       │
└──────────────────────────────────────────────────────────────┘
```

## 3.2 后端改造

### 3.2a 删除 query-builder 的现算分支

`strategy-conditions.query-builder.ts`：
- 删除 `RocCfg` interface、`DEFAULT_ROC_N`、`resolveRocN`、`buildRocExpr` 私有方法。
- 删除 `build()` for 循环里的 `if (field === 'roc' && rocCfg)` 早退分支。
- 删除 `build()` 签名的 `rocCfg?: RocCfg` 参数。
- 删除 `buildAShareQuery`/`buildCryptoQuery` 里传入的 rocCfg 实参（含 crypto 的 `undefined, undefined` 占位）。

### 3.2b 改为静态列映射（进 types.ts）

`strategy-conditions.types.ts`，`ASHARE_FIELD_COL_MAP`（:4-49）加三行：

```ts
  roc10: 'i.roc10',
  roc20: 'i.roc20',
  roc60: 'i.roc60',
```

`CRYPTO_FIELD_COL_MAP`（:69-90）加三行：

```ts
  roc10: 'k.roc10',
  roc20: 'k.roc20',
  roc60: 'k.roc60',
```

> 加入静态映射后，ROC 三档走 query-builder 的**普通字段分支**（与 `ma5`/`kdj_j` 完全一样），自动支持 gt/gte/lt/lte/eq/neq/cross_above/cross_below 全部操作符——cross 也自动支持（prev 子查询取前一根的 roc 值，已在 query-builder 现有 cross 逻辑里）。
>
> ⚠️ **cross 仅 strategy-conditions 模块（query-builder）支持**。表格自带的筛选路径（`a-shares-query.sql.ts` / `symbols.service.ts`）映射表无 cross 操作符，本就不支持 cross，ROC 落库不改变这一点。详见 [04.6 cross 支持的路径边界](./04-table-columns.md#46-cross-支持的路径边界)。

### 3.2c 实体/DTO 删除 rocParams

`strategy-condition.entity.ts` 的 `StrategyConditionItem`：删除 `rocParams?: { n: number }`（恢复到 commit 788faf5 之前）。

`dto/create-strategy-condition.dto.ts` 同步删除。

> ⚠️ 兼容性：已入库的条件集若含 `field:'roc'` + `rocParams`，改造后 `field:'roc'` 不再是合法字段（变为 `roc10/20/60`）。需评估是否有已保存的 ROC 条件——若有，回填迁移把 `{field:'roc', rocParams:{n:10}}` 改写为 `{field:'roc10'}`。鉴于方案 A 刚提交、尚无线上数据，预计无存量，但实现时须确认。

### 3.2d 单测改造

`strategy-conditions.query-builder.roc.spec.ts`（方案 A 的 16 个测试）整体**重写**：删 OFFSET 子查询相关断言，改为断言「读预存列」。保留的核心用例：
- `roc10 gt 5` → SQL 含 `i.roc10 > $1`
- crypto `roc20 lt 0` → SQL 含 `k.roc20 < $1`
- cross_above：`roc10 cross_above 0` → EXISTS 前一根子查询（走现有 cross 逻辑）
- 多条件 AND、compareField 模式仍适用

## 3.3 前端改造

### 3.3a conditionFieldMeta.ts：roc 改三档

`A_SHARE_FIELDS` 和 `CRYPTO_FIELDS` 里，删除方案 A 的单条 `{ label: '动量(ROC)', value: 'roc', ... isRoc: true }`，改为三条：

```ts
  { label: '动量10日', value: 'roc10', supportsCross: true, valueUnit: '%' },
  { label: '动量20日', value: 'roc20', supportsCross: true, valueUnit: '%' },
  { label: '动量60日', value: 'roc60', supportsCross: true, valueUnit: '%' },
```

> `supportsCross: true`：落库后 ROC 走普通字段分支，cross（穿越 0 轴）天然支持。比方案 A（首版不支持 cross）更强。

删除 `isRoc` 标记、`ROC_FIELD_VALUES`、`DEFAULT_ROC_N`、`isRocField`（方案 A 的 helper，不再需要——三档各自是普通字段，无需特殊参数框）。

### 3.3b ConditionRows.vue：删 ROC 参数框

删除方案 A 加的 ROC template（`v-if="showRocParams"`）和 `showRocParams`/`rocNView`/`handleRocNChange` 函数、import（`DEFAULT_ROC_N`/`isRocField`）、`delete cond.rocParams` 清理。

ROC 三档变成普通字段，**不需要行内参数框**（周期固定在列名里：roc10 就是 10 日）。与 `ma5`/`ma30` 体验一致。

### 3.3c API 客户端：删 rocParams

`api/modules/strategy/strategyConditions.ts` 的 `StrategyConditionItem`：删除 `rocParams?: { n: number }`。

## 3.4 改动文件清单（筛选改造）

| 文件 | 改动 |
|---|---|
| `strategy-conditions.query-builder.ts` | 删 RocCfg/resolveRocN/buildRocExpr/ROC 分支/rocCfg 参数 |
| `strategy-conditions.types.ts` | ASHARE/CRYPTO_FIELD_COL_MAP 各加 roc10/20/60 |
| `strategy-condition.entity.ts` | 删 rocParams |
| `dto/create-strategy-condition.dto.ts` | 删 rocParams |
| `strategy-conditions.query-builder.roc.spec.ts` | 重写为读预存列断言 |
| `conditionFieldMeta.ts` | roc 单条→roc10/20/60 三条；删 isRoc/helper |
| `ConditionRows.vue` | 删 ROC 参数框及相关函数 |
| `api/.../strategyConditions.ts` | 删 rocParams |
