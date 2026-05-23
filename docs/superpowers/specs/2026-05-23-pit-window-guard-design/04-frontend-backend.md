# 04. 前后端校验

## 4.1 后端 NestJS 校验

`apps/server/src/modules/quant/factors/`：

### 4.1.1 DTO 不变（保留 1-400 范围）

`dto/update-factor.dto.ts`（现有）：

```typescript
export class UpdateFactorDto {
  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @IsOptional() @IsIn(['price', 'fundamental', 'industry', 'mixed'])
  category?: string;

  @IsOptional() @IsInt() @Min(1) @Max(400)
  pit_window_days?: number;

  @IsOptional() @IsIn(['trade_date', 'ann_date'])
  pit_anchor?: string;

  @IsOptional() @IsInt() @Min(0)
  display_order?: number;
}
```

**不在 DTO 加 `min_trade_days` 字段**——它是契约不可改，PATCH 不接受。

### 4.1.2 Service 跨字段校验（新增）

`factors.service.ts:update`：

```typescript
import { BadRequestException } from '@nestjs/common';

// 与 Python factors/constants.py 同步
const PIT_WINDOW_COEFFICIENT = 2.0;

async update(
  factorId: string,
  factorVersion: string,
  dto: UpdateFactorDto,
): Promise<FactorDefinition> {
  const row = await this.repo.findOneOrFail({
    where: { factor_id: factorId, factor_version: factorVersion },
  });

  // 应用补丁后的最终值
  const finalPitWindow = dto.pit_window_days ?? row.pit_window_days;
  const minTradeDays = row.min_trade_days;
  const required = Math.ceil(minTradeDays * PIT_WINDOW_COEFFICIENT);

  if (finalPitWindow < required) {
    throw new BadRequestException({
      code: 'PIT_WINDOW_TOO_SMALL',
      message:
        `pit_window_days 必须 >= ${required}（` +
        `min_trade_days ${minTradeDays} × ${PIT_WINDOW_COEFFICIENT}）`,
      detail: { declared: finalPitWindow, required, min_trade_days: minTradeDays },
    });
  }

  await this.repo.update({ factor_id: factorId, factor_version: factorVersion }, dto);
  return this.repo.findOneOrFail({
    where: { factor_id: factorId, factor_version: factorVersion },
  });
}
```

### 4.1.3 Entity 补字段

`apps/server/src/entities/ml/factor-definition.entity.ts`：

```typescript
@Entity({ schema: 'factors', name: 'factor_definitions' })
export class FactorDefinition {
  // ... 现有字段 ...

  @Column({ type: 'int', name: 'min_trade_days' })
  min_trade_days!: number;
}
```

### 4.1.4 GET 接口暴露 min_trade_days

- `GET /api/quant/factors/:id` 响应类型已自动通过 entity → response DTO 暴露
- `GET /api/quant/factors`（列表）同步暴露
- `apps/web/src/api/modules/quant.ts` 的 `FactorDefinition` interface 加 `min_trade_days: number`

### 4.1.5 GET 接口暴露 jobs.warnings（job 结束后历史回看）

SSE 仅在 job 运行期推送 `warnings_summary`（聚合计数）。job 结束 / SSE 断开后，前端需从 GET 拉全量 warnings 详情：

- `GET /api/quant/jobs/:id` 响应 DTO 加 `warnings: WarningItem[]`
  ```typescript
  interface WarningItem {
    type: 'factor_window_short' | 'factor_window_retry_failed' | 'trade_cal_not_synced';
    ts: string;          // ISO UTC
    factor_id: string;
    factor_version?: string;
    trade_date?: string;
    detail?: Record<string, unknown>;
  }
  ```
- 前端 `QuantJobs` 详情页 `onMounted` 拉一次完整 warnings；运行中再叠加 SSE 增量更新 summary
- 列表接口 `GET /api/quant/jobs` 可暴露 `warnings_count: number`（仅总数，不暴露明细），便于在列表页打小红点

## 4.2 前端 FactorEditModal 实时校验

`apps/web/src/components/quant/FactorEditModal.vue`。

### 4.2.1 UI 形态

```text
┌─ 编辑因子: momentum_20d ───────────────────────────────────┐
│                                                            │
│  factor_id:        momentum_20d  (只读)                    │
│  factor_version:   v1            (只读)                    │
│                                                            │
│  描述: [_______________________________________________]   │
│                                                            │
│  类别: ( ) price  ( ) fundamental  ( ) industry  ( ) mixed │
│                                                            │
│  PIT 窗口  [   30  ] 天                                    │
│  ⚠ 该因子需 21 个交易日，pit_window_days 必须 >= 42        │ ← 红字
│                                                            │
│  PIT 锚点: ( ) trade_date  ( ) ann_date                    │
│                                                            │
│  显示顺序: [  10  ]                                        │
│                                                            │
│  ⚠ 修改 pit_window_days / category / pit_anchor 需重跑因子 │
│                                                            │
│              [取消]   [保存 (禁用)]                         │
└────────────────────────────────────────────────────────────┘
```

校验通过时：

```text
┌─ 编辑因子: momentum_20d ───────────────────────────────────┐
│  ...                                                       │
│  PIT 窗口  [   50  ] 天                                    │
│  · 该因子需 21 个交易日，pit_window_days >= 42 即可        │ ← 灰字
│  ...                                                       │
│              [取消]   [保存]                                │
└────────────────────────────────────────────────────────────┘
```

### 4.2.2 实现要点

```vue
<script setup lang="ts">
// 与后端 factors.service.ts 同步
const PIT_WINDOW_COEFFICIENT = 2.0

const minRequired = computed(() => {
  if (!props.factor) return 0
  return Math.ceil(props.factor.min_trade_days * PIT_WINDOW_COEFFICIENT)
})

const windowValid = computed(() => {
  const w = form.value?.pit_window_days
  if (typeof w !== 'number' || !Number.isFinite(w)) return false
  return w >= 1 && w <= 400 && w >= minRequired.value
})

const windowHint = computed(() => {
  if (!props.factor) return ''
  const tail = `pit_window_days 必须 >= ${minRequired.value}`
  return `该因子需 ${props.factor.min_trade_days} 个交易日，${tail}`
})

const windowHintLevel = computed(() => (windowValid.value ? 'info' : 'error'))
</script>

<template>
  <n-form-item label="PIT 窗口" required>
    <n-input-number
      v-model:value="form.pit_window_days"
      :min="1"
      :max="400"
      :status="windowValid ? undefined : 'error'"
    />
    <span class="unit-label">天</span>
    <div class="hint" :class="`hint--${windowHintLevel}`">
      {{ windowHint }}
    </div>
  </n-form-item>
</template>

<style scoped>
.hint { font-size: 12px; margin-top: 4px; }
.hint--info  { color: var(--color-text-muted); }
.hint--error { color: var(--n-error-color, #d03050); }
</style>
```

### 4.2.3 保存按钮控制

AppModal 的 `#actions` slot 内：

```vue
<n-button type="primary" :disabled="!windowValid || !hasChanges" @click="onSave">
  保存
</n-button>
```

`windowValid` 为 false 时按钮禁用；按钮 tooltip（hover）显示 hint 文案，便于发现"为啥点不了"。

### 4.2.4 PATCH 失败兜底

即便前端校验通过，后端仍可能返 400（如并发改动、系数不一致）。`onSave` 的错误处理：

```typescript
async function onSave() {
  try {
    const updated = await quantApi.updateFactor(props.factor!.factor_id, patch)
    emit('saved', updated)
    closeModal()
  } catch (e) {
    const err = e as { code?: string; message?: string }
    if (err.code === 'PIT_WINDOW_TOO_SMALL') {
      errorText.value = err.message ?? 'pit_window_days 校验失败'
    } else {
      errorText.value = `保存失败：${(e as Error).message}`
    }
  }
}
```

错误显示在 `<n-alert>` 区，不关闭 Modal，让用户改完再试。

## 4.3 FactorTable 列展示

`apps/web/src/components/quant/FactorTable.vue`：

**决策**：不加 `min_trade_days` 列。

理由：
- 是契约信息，对日常运营无价值，只在编辑时关心
- 表格已多列（factor_id、版本、类别、PIT 窗口、PIT 锚点、状态、操作），不再加宽
- 用户需要时在 FactorEditModal 即可看到

## 4.4 前后端常量同步策略

3 处硬编码 `2.0`：

| 位置 | 文件 | 注释指向 |
|---|---|---|
| Python | `apps/quant-pipeline/src/quant_pipeline/factors/constants.py` | 单点定义 |
| NestJS | `apps/server/src/modules/quant/factors/factors.service.ts` | 注释指向 constants.py |
| Vue | `apps/web/src/components/quant/FactorEditModal.vue` | 注释指向 constants.py |

**为什么不建 shared 包**：
- `packages/shared-types/` 主要给类型用，加运行时常量需扩 ESM build
- 3 处人工同步可靠（每个 PR 都会改 spec 提到的 3 处之一时被 reviewer 抓）
- 改系数本身是低频事件（年级别），不值得引入额外构建复杂度

**保险**：DB CHECK 约束 (`pit_window_days >= min_trade_days × 2`) 是最后兜底——即便 3 处常量被改不一致，DB 也写不进非法值。
