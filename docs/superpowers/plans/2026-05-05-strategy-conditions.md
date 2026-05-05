# 买入策略筛选功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现买入策略筛选功能，支持用户定义策略条件组合，运行后标记符合条件的标的，用户可选择性筛选。

**Architecture:** 后端新增 `strategy-conditions` 模块提供 CRUD 和运行 API，前端新增策略条件管理页面和组件，扩展现有标的筛选面板集成策略条件选择和结果展示。

**Tech Stack:** NestJS, TypeORM, PostgreSQL, Vue 3, Naive UI, Pinia

---

## 文件结构

### 后端文件

| 文件路径 | 职责 |
|----------|------|
| `apps/server/src/entities/strategy-condition.entity.ts` | 策略条件实体定义 |
| `apps/server/src/strategy-conditions/strategy-conditions.module.ts` | 模块定义 |
| `apps/server/src/strategy-conditions/strategy-conditions.controller.ts` | 控制器 |
| `apps/server/src/strategy-conditions/strategy-conditions.service.ts` | 服务层 |
| `apps/server/src/strategy-conditions/dto/create-strategy-condition.dto.ts` | 创建 DTO |
| `apps/server/src/strategy-conditions/dto/update-strategy-condition.dto.ts` | 更新 DTO |
| `apps/server/src/strategy-conditions/dto/run-strategy-condition.dto.ts` | 运行响应 DTO |

### 前端文件

| 文件路径 | 职责 |
|----------|------|
| `apps/web/src/api/modules/strategyConditions.ts` | API 模块 |
| `apps/web/src/stores/strategyConditions.ts` | Pinia Store |
| `apps/web/src/views/StrategyConditionsView.vue` | 策略条件管理页面 |
| `apps/web/src/components/strategy-conditions/StrategyConditionBuilder.vue` | 条件构建器组件 |
| `apps/web/src/components/symbols/common/StrategyConditionPicker.vue` | 条件选择器组件 |

### 修改文件

| 文件路径 | 修改内容 |
|----------|----------|
| `apps/server/src/app.module.ts` | 注册 StrategyConditionsModule |
| `apps/web/src/router/index.ts` | 添加路由 |
| `apps/web/src/components/layout/AppSider.vue` | 添加菜单项 |
| `apps/web/src/components/symbols/a-shares/ASharesPanel.vue` | 集成策略条件 |
| `apps/web/src/components/symbols/CryptoSymbolsPanel.vue` | 集成策略条件 |
| `apps/web/src/components/symbols/a-shares/ASharesFilters.vue` | 添加筛选项 |

---

## Task 1: 后端 - 创建策略条件实体

**Files:**
- Create: `apps/server/src/entities/strategy-condition.entity.ts`

- [ ] **Step 1: 创建实体文件**

```typescript
// apps/server/src/entities/strategy-condition.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { UserEntity } from './user.entity';

export type TargetType = 'crypto' | 'a-share';

export interface StrategyConditionItem {
  field: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'cross_above' | 'cross_below';
  value?: number;
  compareField?: string;
}

@Entity('strategy_conditions')
export class StrategyConditionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @Column({ type: 'varchar', length: 20, name: 'target_type' })
  targetType: TargetType;

  @Column({ type: 'jsonb', default: '[]' })
  conditions: StrategyConditionItem[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;
}
```

- [ ] **Step 2: 创建数据库表**

```bash
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "
CREATE TABLE IF NOT EXISTS strategy_conditions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  target_type VARCHAR(20) NOT NULL,
  conditions JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_strategy_conditions_user_id ON strategy_conditions(user_id);
CREATE INDEX idx_strategy_conditions_target_type ON strategy_conditions(target_type);
"
```

- [ ] **Step 3: 验证表创建**

```bash
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d strategy_conditions"
```

Expected: 显示表结构，包含所有字段和索引

- [ ] **Step 4: 提交**

```bash
git add apps/server/src/entities/strategy-condition.entity.ts
git commit -m "feat: add strategy condition entity"
```

---

## Task 2: 后端 - 创建 DTO

**Files:**
- Create: `apps/server/src/strategy-conditions/dto/create-strategy-condition.dto.ts`
- Create: `apps/server/src/strategy-conditions/dto/update-strategy-condition.dto.ts`

- [ ] **Step 1: 创建 CreateStrategyConditionDto**

```typescript
// apps/server/src/strategy-conditions/dto/create-strategy-condition.dto.ts
import { IsString, IsArray, IsIn, ValidateNested, IsOptional, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

class StrategyConditionItemDto {
  @IsString()
  field: string;

  @IsIn(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'cross_above', 'cross_below'])
  operator: string;

  @IsOptional()
  @IsNumber()
  value?: number;

  @IsOptional()
  @IsString()
  compareField?: string;
}

export class CreateStrategyConditionDto {
  @IsString()
  name: string;

  @IsIn(['crypto', 'a-share'])
  targetType: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StrategyConditionItemDto)
  conditions: StrategyConditionItemDto[];
}
```

- [ ] **Step 2: 创建 UpdateStrategyConditionDto**

```typescript
// apps/server/src/strategy-conditions/dto/update-strategy-condition.dto.ts
import { PartialType } from '@nestjs/mapped-types';
import { CreateStrategyConditionDto } from './create-strategy-condition.dto';

export class UpdateStrategyConditionDto extends PartialType(CreateStrategyConditionDto) {}
```

- [ ] **Step 3: 提交**

```bash
git add apps/server/src/strategy-conditions/dto/
git commit -m "feat: add strategy condition DTOs"
```

---

## Task 3: 后端 - 创建策略条件服务

**Files:**
- Create: `apps/server/src/strategy-conditions/strategy-conditions.service.ts`

- [ ] **Step 1: 创建服务文件**

```typescript
// apps/server/src/strategy-conditions/strategy-conditions.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StrategyConditionEntity } from '../entities/strategy-condition.entity';
import { CreateStrategyConditionDto } from './dto/create-strategy-condition.dto';
import { UpdateStrategyConditionDto } from './dto/update-strategy-condition.dto';

export interface RunResult {
  hits: Array<{
    tsCode: string;
    name: string;
    matchedConditions: string[];
  }>;
  totalHits: number;
  totalScanned: number;
}

@Injectable()
export class StrategyConditionsService {
  constructor(
    @InjectRepository(StrategyConditionEntity)
    private readonly repo: Repository<StrategyConditionEntity>,
  ) {}

  async create(userId: string, dto: CreateStrategyConditionDto): Promise<StrategyConditionEntity> {
    const entity = this.repo.create({
      ...dto,
      userId,
    });
    return this.repo.save(entity);
  }

  async findAll(userId: string, targetType?: string): Promise<StrategyConditionEntity[]> {
    const where: any = { userId };
    if (targetType) {
      where.targetType = targetType;
    }
    return this.repo.find({ where, order: { createdAt: 'DESC' } });
  }

  async findOne(id: string, userId: string): Promise<StrategyConditionEntity> {
    const entity = await this.repo.findOne({ where: { id, userId } });
    if (!entity) {
      throw new NotFoundException('Strategy condition not found');
    }
    return entity;
  }

  async update(id: string, userId: string, dto: UpdateStrategyConditionDto): Promise<StrategyConditionEntity> {
    const entity = await this.findOne(id, userId);
    Object.assign(entity, dto);
    return this.repo.save(entity);
  }

  async remove(id: string, userId: string): Promise<void> {
    const entity = await this.findOne(id, userId);
    await this.repo.remove(entity);
  }

  async run(id: string, userId: string): Promise<RunResult> {
    const entity = await this.findOne(id, userId);
    // TODO: 实现 SQL 查询逻辑
    return {
      hits: [],
      totalHits: 0,
      totalScanned: 0,
    };
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add apps/server/src/strategy-conditions/strategy-conditions.service.ts
git commit -m "feat: add strategy conditions service"
```

---

## Task 4: 后端 - 实现策略条件运行逻辑

**Files:**
- Modify: `apps/server/src/strategy-conditions/strategy-conditions.service.ts`

- [ ] **Step 1: 实现 A 股查询逻辑**

```typescript
// 在 StrategyConditionsService 类中添加

private buildAShareQuery(conditions: any[]): string {
  const whereClauses: string[] = [];

  for (const cond of conditions) {
    const { field, operator, value, compareField } = cond;

    if (operator === 'cross_above' || operator === 'cross_below') {
      // 时序比较需要昨天的数据
      const direction = operator === 'cross_above' ? '<' : '>';
      whereClauses.push(`
        EXISTS (
          SELECT 1 FROM a_share_daily_indicators prev
          WHERE prev.ts_code = i.ts_code
            AND prev.trade_date = (
              SELECT MAX(trade_date) FROM a_share_daily_indicators
              WHERE trade_date < i.trade_date AND ts_code = i.ts_code
            )
            AND prev.${field} ${direction} prev.${compareField}
        )
        AND i.${field} ${operator === 'cross_above' ? '>' : '<'} i.${compareField}
      `);
    } else if (compareField) {
      // 字段间比较
      whereClauses.push(`i.${field} ${this.getSqlOperator(operator)} i.${compareField}`);
    } else {
      // 固定值比较
      whereClauses.push(`i.${field} ${this.getSqlOperator(operator)} ${value}`);
    }
  }

  return whereClauses.join(' AND ');
}

private getSqlOperator(operator: string): string {
  const operatorMap: Record<string, string> = {
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    eq: '=',
    neq: '!=',
  };
  return operatorMap[operator] || '=';
}
```

- [ ] **Step 2: 实现加密货币查询逻辑**

```typescript
// 在 StrategyConditionsService 类中添加

private buildCryptoQuery(conditions: any[]): string {
  const whereClauses: string[] = [];

  for (const cond of conditions) {
    const { field, operator, value, compareField } = cond;

    if (operator === 'cross_above' || operator === 'cross_below') {
      const direction = operator === 'cross_above' ? '<' : '>';
      whereClauses.push(`
        EXISTS (
          SELECT 1 FROM klines prev
          WHERE prev.symbol = k.symbol
            AND prev.interval = k.interval
            AND prev.open_time = (
              SELECT MAX(open_time) FROM klines
              WHERE open_time < k.open_time AND symbol = k.symbol AND interval = k.interval
            )
            AND prev.${field} ${direction} prev.${compareField}
        )
        AND k.${field} ${operator === 'cross_above' ? '>' : '<'} k.${compareField}
      `);
    } else if (compareField) {
      whereClauses.push(`k.${field} ${this.getSqlOperator(operator)} k.${compareField}`);
    } else {
      whereClauses.push(`k.${field} ${this.getSqlOperator(operator)} ${value}`);
    }
  }

  return whereClauses.join(' AND ');
}
```

- [ ] **Step 3: 实现 run 方法**

```typescript
// 修改 run 方法

async run(id: string, userId: string): Promise<RunResult> {
  const entity = await this.findOne(id, userId);
  const { conditions, targetType } = entity;

  if (conditions.length === 0) {
    return { hits: [], totalHits: 0, totalScanned: 0 };
  }

  let query: string;
  let params: any[] = [];

  if (targetType === 'a-share') {
    const whereClause = this.buildAShareQuery(conditions);
    query = `
      SELECT
        s.ts_code as "tsCode",
        s.name,
        ARRAY[${conditions.map((_, i) => `$${i + 1}`).join(',')}] as "matchedConditions"
      FROM a_share_symbols s
      JOIN a_share_daily_indicators i ON s.ts_code = i.ts_code
      WHERE i.trade_date = (SELECT MAX(trade_date) FROM a_share_daily_indicators)
        AND s.list_status = 'L'
        AND ${whereClause}
      ORDER BY s.ts_code
    `;
  } else {
    const whereClause = this.buildCryptoQuery(conditions);
    query = `
      SELECT
        k.symbol as "tsCode",
        k.symbol as name,
        ARRAY[${conditions.map((_, i) => `$${i + 1}`).join(',')}] as "matchedConditions"
      FROM klines k
      WHERE k.interval = '1d'
        AND k.open_time = (
          SELECT MAX(open_time) FROM klines WHERE symbol = k.symbol AND interval = '1d'
        )
        AND ${whereClause}
      ORDER BY k.symbol
    `;
  }

  // 构建条件描述
  const conditionDescriptions = conditions.map(c => {
    if (c.compareField) {
      return `${c.field} ${c.operator} ${c.compareField}`;
    }
    return `${c.field} ${c.operator} ${c.value}`;
  });

  const result = await this.repo.query(query, params);

  return {
    hits: result.map((row: any) => ({
      tsCode: row.tsCode,
      name: row.name,
      matchedConditions: conditionDescriptions,
    })),
    totalHits: result.length,
    totalScanned: 0, // TODO: 添加总数查询
  };
}
```

- [ ] **Step 4: 提交**

```bash
git add apps/server/src/strategy-conditions/strategy-conditions.service.ts
git commit -m "feat: implement strategy condition run logic"
```

---

## Task 5: 后端 - 创建控制器

**Files:**
- Create: `apps/server/src/strategy-conditions/strategy-conditions.controller.ts`

- [ ] **Step 1: 创建控制器**

```typescript
// apps/server/src/strategy-conditions/strategy-conditions.controller.ts
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { StrategyConditionsService } from './strategy-conditions.service';
import { CreateStrategyConditionDto } from './dto/create-strategy-condition.dto';
import { UpdateStrategyConditionDto } from './dto/update-strategy-condition.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('strategy-conditions')
@UseGuards(JwtAuthGuard)
export class StrategyConditionsController {
  constructor(private readonly service: StrategyConditionsService) {}

  @Post()
  create(@Request() req: any, @Body() dto: CreateStrategyConditionDto) {
    return this.service.create(req.user.id, dto);
  }

  @Get()
  findAll(@Request() req: any, @Query('targetType') targetType?: string) {
    return this.service.findAll(req.user.id, targetType);
  }

  @Get(':id')
  findOne(@Request() req: any, @Param('id') id: string) {
    return this.service.findOne(id, req.user.id);
  }

  @Put(':id')
  update(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateStrategyConditionDto,
  ) {
    return this.service.update(id, req.user.id, dto);
  }

  @Delete(':id')
  remove(@Request() req: any, @Param('id') id: string) {
    return this.service.remove(id, req.user.id);
  }

  @Post(':id/run')
  run(@Request() req: any, @Param('id') id: string) {
    return this.service.run(id, req.user.id);
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add apps/server/src/strategy-conditions/strategy-conditions.controller.ts
git commit -m "feat: add strategy conditions controller"
```

---

## Task 6: 后端 - 创建模块并注册

**Files:**
- Create: `apps/server/src/strategy-conditions/strategy-conditions.module.ts`
- Modify: `apps/server/src/app.module.ts`

- [ ] **Step 1: 创建模块文件**

```typescript
// apps/server/src/strategy-conditions/strategy-conditions.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StrategyConditionEntity } from '../entities/strategy-condition.entity';
import { StrategyConditionsController } from './strategy-conditions.controller';
import { StrategyConditionsService } from './strategy-conditions.service';

@Module({
  imports: [TypeOrmModule.forFeature([StrategyConditionEntity])],
  controllers: [StrategyConditionsController],
  providers: [StrategyConditionsService],
  exports: [StrategyConditionsService],
})
export class StrategyConditionsModule {}
```

- [ ] **Step 2: 在 app.module.ts 中注册**

```typescript
// 在 app.module.ts 的 imports 数组中添加
import { StrategyConditionsModule } from './strategy-conditions/strategy-conditions.module';

@Module({
  imports: [
    // ... 其他模块
    StrategyConditionsModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 3: 验证后端启动**

```bash
cd apps/server && pnpm run start:dev
```

Expected: 服务正常启动，无报错

- [ ] **Step 4: 提交**

```bash
git add apps/server/src/strategy-conditions/strategy-conditions.module.ts apps/server/src/app.module.ts
git commit -m "feat: register strategy conditions module"
```

---

## Task 7: 前端 - 创建 API 模块

**Files:**
- Create: `apps/web/src/api/modules/strategyConditions.ts`

- [ ] **Step 1: 创建 API 模块**

```typescript
// apps/web/src/api/modules/strategyConditions.ts
import { http } from '../http';

export interface StrategyConditionItem {
  field: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'cross_above' | 'cross_below';
  value?: number;
  compareField?: string;
}

export interface StrategyCondition {
  id: string;
  name: string;
  userId: string;
  targetType: 'crypto' | 'a-share';
  conditions: StrategyConditionItem[];
  createdAt: string;
  updatedAt: string;
}

export interface RunResult {
  hits: Array<{
    tsCode: string;
    name: string;
    matchedConditions: string[];
  }>;
  totalHits: number;
  totalScanned: number;
}

export interface CreateStrategyConditionDto {
  name: string;
  targetType: 'crypto' | 'a-share';
  conditions: StrategyConditionItem[];
}

export interface UpdateStrategyConditionDto {
  name?: string;
  conditions?: StrategyConditionItem[];
}

export const strategyConditionsApi = {
  create(data: CreateStrategyConditionDto) {
    return http.post<StrategyCondition>('/strategy-conditions', data);
  },

  findAll(targetType?: string) {
    return http.get<StrategyCondition[]>('/strategy-conditions', {
      params: { targetType },
    });
  },

  findOne(id: string) {
    return http.get<StrategyCondition>(`/strategy-conditions/${id}`);
  },

  update(id: string, data: UpdateStrategyConditionDto) {
    return http.put<StrategyCondition>(`/strategy-conditions/${id}`, data);
  },

  remove(id: string) {
    return http.delete(`/strategy-conditions/${id}`);
  },

  run(id: string) {
    return http.post<RunResult>(`/strategy-conditions/${id}/run`);
  },
};
```

- [ ] **Step 2: 提交**

```bash
git add apps/web/src/api/modules/strategyConditions.ts
git commit -m "feat: add strategy conditions API module"
```

---

## Task 8: 前端 - 创建 Pinia Store

**Files:**
- Create: `apps/web/src/stores/strategyConditions.ts`

- [ ] **Step 1: 创建 Store**

```typescript
// apps/web/src/stores/strategyConditions.ts
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  strategyConditionsApi,
  StrategyCondition,
  RunResult,
} from '../api/modules/strategyConditions';

export const useStrategyConditionsStore = defineStore('strategyConditions', () => {
  const conditions = ref<StrategyCondition[]>([]);
  const runResults = ref<Map<string, RunResult>>(new Map());
  const loading = ref(false);
  const runningId = ref<string | null>(null);

  const getConditionsByTargetType = computed(() => {
    return (targetType: 'crypto' | 'a-share') =>
      conditions.value.filter(c => c.targetType === targetType);
  });

  const getRunResultsByTargetType = computed(() => {
    return (targetType: 'crypto' | 'a-share') => {
      const result = new Map<string, RunResult>();
      runResults.value.forEach((value, key) => {
        const condition = conditions.value.find(c => c.id === key);
        if (condition && condition.targetType === targetType) {
          result.set(key, value);
        }
      });
      return result;
    };
  });

  async function fetchConditions(targetType?: string) {
    loading.value = true;
    try {
      const { data } = await strategyConditionsApi.findAll(targetType);
      conditions.value = data;
    } finally {
      loading.value = false;
    }
  }

  async function createCondition(dto: {
    name: string;
    targetType: 'crypto' | 'a-share';
    conditions: any[];
  }) {
    const { data } = await strategyConditionsApi.create(dto);
    conditions.value.unshift(data);
    return data;
  }

  async function updateCondition(id: string, dto: { name?: string; conditions?: any[] }) {
    const { data } = await strategyConditionsApi.update(id, dto);
    const index = conditions.value.findIndex(c => c.id === id);
    if (index !== -1) {
      conditions.value[index] = data;
    }
    return data;
  }

  async function deleteCondition(id: string) {
    await strategyConditionsApi.remove(id);
    conditions.value = conditions.value.filter(c => c.id !== id);
    runResults.value.delete(id);
  }

  async function runCondition(id: string) {
    runningId.value = id;
    try {
      const { data } = await strategyConditionsApi.run(id);
      runResults.value.set(id, data);
      return data;
    } finally {
      runningId.value = null;
    }
  }

  function clearRunResults() {
    runResults.value.clear();
  }

  return {
    conditions,
    runResults,
    loading,
    runningId,
    getConditionsByTargetType,
    getRunResultsByTargetType,
    fetchConditions,
    createCondition,
    updateCondition,
    deleteCondition,
    runCondition,
    clearRunResults,
  };
});
```

- [ ] **Step 2: 提交**

```bash
git add apps/web/src/stores/strategyConditions.ts
git commit -m "feat: add strategy conditions store"
```

---

## Task 9: 前端 - 创建策略条件构建器组件

**Files:**
- Create: `apps/web/src/components/strategy-conditions/StrategyConditionBuilder.vue`

- [ ] **Step 1: 创建组件**

```vue
<!-- apps/web/src/components/strategy-conditions/StrategyConditionBuilder.vue -->
<template>
  <div class="strategy-condition-builder">
    <n-form :model="form" label-placement="left" label-width="80">
      <n-form-item label="条件组名称">
        <n-input v-model:value="form.name" placeholder="输入条件组名称" />
      </n-form-item>

      <n-form-item label="目标类型">
        <n-radio-group v-model:value="form.targetType" :disabled="!!editId">
          <n-radio-button value="a-share">A 股</n-radio-button>
          <n-radio-button value="crypto">加密货币</n-radio-button>
        </n-radio-group>
      </n-form-item>

      <n-divider>条件列表</n-divider>

      <div v-for="(condition, index) in form.conditions" :key="index" class="condition-row">
        <n-space align="center">
          <n-select
            v-model:value="condition.field"
            :options="fieldOptions"
            placeholder="选择指标"
            style="width: 180px"
          />
          <n-select
            v-model:value="condition.operator"
            :options="operatorOptions"
            placeholder="选择操作符"
            style="width: 140px"
          />
          <template v-if="isCompareToField(condition.operator)">
            <n-select
              v-model:value="condition.compareField"
              :options="fieldOptions"
              placeholder="比较指标"
              style="width: 180px"
            />
          </template>
          <template v-else>
            <n-input-number
              v-model:value="condition.value"
              placeholder="数值"
              style="width: 120px"
            />
          </template>
          <n-button type="error" text @click="removeCondition(index)">
            <template #icon><n-icon><trash-icon /></n-icon></template>
          </n-button>
        </n-space>
      </div>

      <n-button type="dashed" block @click="addCondition" class="add-btn">
        <template #icon><n-icon><add-icon /></n-icon></template>
        添加条件
      </n-button>
    </n-form>

    <div class="actions">
      <n-button @click="$emit('cancel')">取消</n-button>
      <n-button type="primary" :loading="saving" @click="handleSave">保存</n-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { NForm, NFormItem, NInput, NSelect, NInputNumber, NButton, NIcon, NSpace, NDivider, NRadioGroup, NRadioButton } from 'naive-ui';
import { Add as AddIcon, Trash as TrashIcon } from '@vicons/ionicons5';
import { StrategyConditionItem } from '../../api/modules/strategyConditions';

interface Props {
  editId?: string;
  initialData?: {
    name: string;
    targetType: 'crypto' | 'a-share';
    conditions: StrategyConditionItem[];
  };
}

const props = defineProps<Props>();
const emit = defineEmits<{
  save: [data: { name: string; targetType: string; conditions: StrategyConditionItem[] }];
  cancel: [];
}>();

const saving = ref(false);

const form = ref({
  name: '',
  targetType: 'a-share' as 'crypto' | 'a-share',
  conditions: [] as StrategyConditionItem[],
});

watch(() => props.initialData, (data) => {
  if (data) {
    form.value = {
      name: data.name,
      targetType: data.targetType,
      conditions: [...data.conditions],
    };
  }
}, { immediate: true });

const aShareFields = [
  { label: 'KDJ_J', value: 'kdj_j' },
  { label: 'KDJ_K', value: 'kdj_k' },
  { label: 'KDJ_D', value: 'kdj_d' },
  { label: 'MACD_DIF', value: 'macd_dif' },
  { label: 'MACD_DEA', value: 'macd_dea' },
  { label: 'MACD_HIST', value: 'macd_hist' },
  { label: 'BBI', value: 'bbi' },
  { label: 'MA5', value: 'ma5' },
  { label: 'MA10', value: 'ma10' },
  { label: 'MA20', value: 'ma20' },
  { label: 'MA30', value: 'ma30' },
  { label: 'MA60', value: 'ma60' },
  { label: 'MA120', value: 'ma120' },
  { label: 'MA240', value: 'ma240' },
  { label: 'ATR14', value: 'atr14' },
  { label: '盈亏比', value: 'profit_loss_ratio' },
  { label: '换手率', value: 'turnover_rate' },
  { label: '量比', value: 'volume_ratio' },
  { label: 'PE', value: 'pe' },
  { label: 'PE_TTM', value: 'pe_ttm' },
  { label: 'PB', value: 'pb' },
  { label: '总市值', value: 'total_mv' },
  { label: '流通市值', value: 'circ_mv' },
  { label: '收盘价', value: 'close' },
  { label: '开盘价', value: 'open' },
  { label: '最高价', value: 'high' },
  { label: '最低价', value: 'low' },
  { label: '成交量', value: 'volume' },
  { label: '成交额', value: 'amount' },
  { label: '涨跌幅', value: 'pct_chg' },
  { label: '砖形图', value: 'brick' },
  { label: '砖形图变动', value: 'brick_delta' },
  { label: '砖形图信号', value: 'brick_xg' },
];

const cryptoFields = [
  { label: 'KDJ_J', value: 'kdj_j' },
  { label: 'KDJ_K', value: 'kdj_k' },
  { label: 'KDJ_D', value: 'kdj_d' },
  { label: 'MACD_DIF', value: 'macd_dif' },
  { label: 'MACD_DEA', value: 'macd_dea' },
  { label: 'MACD_HIST', value: 'macd_hist' },
  { label: 'BBI', value: 'bbi' },
  { label: 'MA5', value: 'ma5' },
  { label: 'MA10', value: 'ma10' },
  { label: 'MA20', value: 'ma20' },
  { label: 'MA30', value: 'ma30' },
  { label: 'MA60', value: 'ma60' },
  { label: 'MA120', value: 'ma120' },
  { label: 'MA240', value: 'ma240' },
  { label: 'ATR14', value: 'atr14' },
  { label: '盈亏比', value: 'profit_loss_ratio' },
  { label: '收盘价', value: 'close' },
  { label: '开盘价', value: 'open' },
  { label: '最高价', value: 'high' },
  { label: '最低价', value: 'low' },
  { label: '成交量', value: 'volume' },
  { label: '成交额', value: 'amount' },
];

const fieldOptions = computed(() => {
  return form.value.targetType === 'a-share' ? aShareFields : cryptoFields;
});

const operatorOptions = [
  { label: '大于', value: 'gt' },
  { label: '大于等于', value: 'gte' },
  { label: '小于', value: 'lt' },
  { label: '小于等于', value: 'lte' },
  { label: '等于', value: 'eq' },
  { label: '不等于', value: 'neq' },
  { label: '上穿', value: 'cross_above' },
  { label: '下穿', value: 'cross_below' },
];

function isCompareToField(operator: string) {
  return ['cross_above', 'cross_below'].includes(operator) || true; // 所有操作符都支持字段比较
}

function addCondition() {
  form.value.conditions.push({
    field: '',
    operator: 'lt',
    value: undefined,
    compareField: undefined,
  });
}

function removeCondition(index: number) {
  form.value.conditions.splice(index, 1);
}

function handleSave() {
  if (!form.value.name) {
    window.$message?.warning('请输入条件组名称');
    return;
  }
  if (form.value.conditions.length === 0) {
    window.$message?.warning('请添加至少一个条件');
    return;
  }
  emit('save', { ...form.value });
}
</script>

<style scoped>
.strategy-condition-builder {
  padding: 16px;
}

.condition-row {
  margin-bottom: 12px;
  padding: 12px;
  background: var(--n-color);
  border-radius: 4px;
}

.add-btn {
  margin-top: 12px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 24px;
}
</style>
```

- [ ] **Step 2: 提交**

```bash
git add apps/web/src/components/strategy-conditions/StrategyConditionBuilder.vue
git commit -m "feat: add strategy condition builder component"
```

---

## Task 10: 前端 - 创建策略条件管理页面

**Files:**
- Create: `apps/web/src/views/StrategyConditionsView.vue`

- [ ] **Step 1: 创建页面**

```vue
<!-- apps/web/src/views/StrategyConditionsView.vue -->
<template>
  <div class="strategy-conditions-view">
    <n-card title="策略条件管理">
      <template #header-extra>
        <n-button type="primary" @click="showBuilder = true">
          <template #icon><n-icon><add-icon /></n-icon></template>
          新建条件组
        </n-button>
      </template>

      <n-data-table
        :columns="columns"
        :data="store.conditions"
        :loading="store.loading"
        :bordered="false"
      />
    </n-card>

    <n-modal
      v-model:show="showBuilder"
      :title="editingId ? '编辑条件组' : '新建条件组'"
      style="width: 800px"
    >
      <StrategyConditionBuilder
        :edit-id="editingId"
        :initial-data="editingData"
        @save="handleSave"
        @cancel="showBuilder = false"
      />
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, h, onMounted } from 'vue';
import { NCard, NButton, NIcon, NDataTable, NModal, NTag, NSpace, NPopconfirm } from 'naive-ui';
import { Add as AddIcon, Create as EditIcon, Trash as TrashIcon } from '@vicons/ionicons5';
import { useStrategyConditionsStore } from '../stores/strategyConditions';
import { StrategyCondition } from '../api/modules/strategyConditions';
import StrategyConditionBuilder from '../components/strategy-conditions/StrategyConditionBuilder.vue';

const store = useStrategyConditionsStore();
const showBuilder = ref(false);
const editingId = ref<string | undefined>();

const editingData = computed(() => {
  if (!editingId.value) return undefined;
  const condition = store.conditions.find(c => c.id === editingId.value);
  return condition
    ? {
        name: condition.name,
        targetType: condition.targetType,
        conditions: condition.conditions,
      }
    : undefined;
});

const columns = [
  {
    title: '名称',
    key: 'name',
  },
  {
    title: '目标类型',
    key: 'targetType',
    render(row: StrategyCondition) {
      return h(NTag, { type: row.targetType === 'a-share' ? 'info' : 'warning' }, {
        default: () => row.targetType === 'a-share' ? 'A 股' : '加密货币',
      });
    },
  },
  {
    title: '条件数',
    key: 'conditions',
    render(row: StrategyCondition) {
      return row.conditions.length;
    },
  },
  {
    title: '创建时间',
    key: 'createdAt',
    render(row: StrategyCondition) {
      return new Date(row.createdAt).toLocaleString();
    },
  },
  {
    title: '操作',
    key: 'actions',
    render(row: StrategyCondition) {
      return h(NSpace, {}, {
        default: () => [
          h(NButton, {
            size: 'small',
            onClick: () => {
              editingId.value = row.id;
              showBuilder.value = true;
            },
          }, {
            icon: () => h(NIcon, null, { default: () => h(EditIcon) }),
            default: () => '编辑',
          }),
          h(NPopconfirm, {
            onPositiveClick: () => store.deleteCondition(row.id),
          }, {
            trigger: () => h(NButton, {
              size: 'small',
              type: 'error',
            }, {
              icon: () => h(NIcon, null, { default: () => h(TrashIcon) }),
              default: () => '删除',
            }),
            default: () => '确定删除该条件组？',
          }),
        ],
      });
    },
  },
];

async function handleSave(data: { name: string; targetType: string; conditions: any[] }) {
  try {
    if (editingId.value) {
      await store.updateCondition(editingId.value, data);
    } else {
      await store.createCondition(data);
    }
    showBuilder.value = false;
    editingId.value = undefined;
    window.$message?.success('保存成功');
  } catch (error) {
    window.$message?.error('保存失败');
  }
}

onMounted(() => {
  store.fetchConditions();
});
</script>

<style scoped>
.strategy-conditions-view {
  padding: 16px;
}
</style>
```

- [ ] **Step 2: 提交**

```bash
git add apps/web/src/views/StrategyConditionsView.vue
git commit -m "feat: add strategy conditions view"
```

---

## Task 11: 前端 - 创建策略条件选择器组件

**Files:**
- Create: `apps/web/src/components/symbols/common/StrategyConditionPicker.vue`

- [ ] **Step 1: 创建组件**

```vue
<!-- apps/web/src/components/symbols/common/StrategyConditionPicker.vue -->
<template>
  <div class="strategy-condition-picker">
    <n-space align="center">
      <n-select
        v-model:value="selectedIds"
        :options="conditionOptions"
        multiple
        placeholder="选择策略条件"
        style="width: 300px"
        :loading="store.loading"
      />
      <n-button
        type="primary"
        :loading="isRunning"
        :disabled="selectedIds.length === 0"
        @click="handleRun"
      >
        运行
      </n-button>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { NSelect, NButton, NSpace } from 'naive-ui';
import { useStrategyConditionsStore } from '../../../stores/strategyConditions';

interface Props {
  targetType: 'crypto' | 'a-share';
}

const props = defineProps<Props>();
const emit = defineEmits<{
  run: [results: Map<string, any>];
}>();

const store = useStrategyConditionsStore();
const selectedIds = ref<string[]>([]);
const isRunning = ref(false);

const conditionOptions = computed(() => {
  return store.getConditionsByTargetType(props.targetType).map(c => ({
    label: c.name,
    value: c.id,
  }));
});

async function handleRun() {
  isRunning.value = true;
  try {
    for (const id of selectedIds.value) {
      await store.runCondition(id);
    }
    emit('run', store.runResults);
    window.$message?.success('策略运行完成');
  } catch (error) {
    window.$message?.error('策略运行失败');
  } finally {
    isRunning.value = false;
  }
}

onMounted(() => {
  store.fetchConditions(props.targetType);
});
</script>

<style scoped>
.strategy-condition-picker {
  display: inline-flex;
}
</style>
```

- [ ] **Step 2: 提交**

```bash
git add apps/web/src/components/symbols/common/StrategyConditionPicker.vue
git commit -m "feat: add strategy condition picker component"
```

---

## Task 12: 前端 - 集成到 A 股面板

**Files:**
- Modify: `apps/web/src/components/symbols/a-shares/ASharesPanel.vue`
- Modify: `apps/web/src/components/symbols/a-shares/ASharesFilters.vue`

- [ ] **Step 1: 在 ASharesPanel.vue 中添加策略条件选择器**

```vue
<!-- 在 ASharesPanel.vue 的筛选条件区域添加 -->
<template>
  <div>
    <!-- 现有内容 -->
    <n-card>
      <n-space vertical>
        <!-- 策略条件选择器 -->
        <StrategyConditionPicker
          target-type="a-share"
          @run="handleStrategyRun"
        />

        <!-- 现有筛选条件 -->
        <ASharesFilters
          v-model:filters="filters"
          :strategy-run-results="strategyRunResults"
          @apply="handleApplyFilters"
        />
      </n-space>
    </n-card>

    <!-- 表格 -->
    <n-data-table :columns="columns" :data="filteredData" />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import StrategyConditionPicker from '../common/StrategyConditionPicker.vue';
import { useStrategyConditionsStore } from '../../../stores/strategyConditions';

const strategyStore = useStrategyConditionsStore();
const strategyRunResults = ref<Map<string, any>>(new Map());

function handleStrategyRun(results: Map<string, any>) {
  strategyRunResults.value = results;
}
</script>
```

- [ ] **Step 2: 添加表格列"买入信号"**

```typescript
// 在 columns 定义中添加
{
  title: '买入信号',
  key: 'buySignal',
  width: 200,
  render(row: any) {
    const hits: string[] = [];
    strategyRunResults.value.forEach((result, conditionId) => {
      const condition = strategyStore.conditions.find(c => c.id === conditionId);
      if (condition && result.hits.some((h: any) => h.tsCode === row.tsCode)) {
        hits.push(condition.name);
      }
    });
    if (hits.length === 0) return '-';
    return h(NSpace, {}, {
      default: () => hits.map(name => h(NTag, { type: 'success', size: 'small' }, { default: () => name })),
    });
  },
},
```

- [ ] **Step 3: 在 ASharesFilters.vue 中添加筛选项**

```vue
<!-- 在 ASharesFilters.vue 中添加 -->
<template>
  <n-space>
    <!-- 现有筛选条件 -->

    <!-- 买入信号筛选 -->
    <n-select
      v-model:value="selectedStrategyConditions"
      :options="strategyConditionOptions"
      multiple
      placeholder="按策略条件筛选"
      clearable
      style="width: 200px"
    />
  </n-space>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useStrategyConditionsStore } from '../../../stores/strategyConditions';

const strategyStore = useStrategyConditionsStore();
const selectedStrategyConditions = ref<string[]>([]);

const strategyConditionOptions = computed(() => {
  return strategyStore.conditions
    .filter(c => c.targetType === 'a-share')
    .map(c => ({
      label: c.name,
      value: c.id,
    }));
});
</script>
```

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/symbols/a-shares/
git commit -m "feat: integrate strategy conditions into A shares panel"
```

---

## Task 13: 前端 - 集成到加密货币面板

**Files:**
- Modify: `apps/web/src/components/symbols/CryptoSymbolsPanel.vue`

- [ ] **Step 1: 添加策略条件选择器和表格列**

```vue
<!-- 在 CryptoSymbolsPanel.vue 中添加 -->
<template>
  <div>
    <n-card>
      <n-space vertical>
        <!-- 策略条件选择器 -->
        <StrategyConditionPicker
          target-type="crypto"
          @run="handleStrategyRun"
        />

        <!-- 现有筛选条件 -->
      </n-space>
    </n-card>

    <!-- 表格 -->
    <n-data-table :columns="columns" :data="data" />
  </div>
</template>

<script setup lang="ts">
import { ref, h } from 'vue';
import { NTag, NSpace } from 'naive-ui';
import StrategyConditionPicker from './common/StrategyConditionPicker.vue';
import { useStrategyConditionsStore } from '../../stores/strategyConditions';

const strategyStore = useStrategyConditionsStore();
const strategyRunResults = ref<Map<string, any>>(new Map());

function handleStrategyRun(results: Map<string, any>) {
  strategyRunResults.value = results;
}

// 在 columns 中添加买入信号列
const columns = [
  // ... 现有列
  {
    title: '买入信号',
    key: 'buySignal',
    width: 200,
    render(row: any) {
      const hits: string[] = [];
      strategyRunResults.value.forEach((result, conditionId) => {
        const condition = strategyStore.conditions.find(c => c.id === conditionId);
        if (condition && result.hits.some((h: any) => h.tsCode === row.symbol)) {
          hits.push(condition.name);
        }
      });
      if (hits.length === 0) return '-';
      return h(NSpace, {}, {
        default: () => hits.map(name => h(NTag, { type: 'success', size: 'small' }, { default: () => name })),
      });
    },
  },
];
</script>
```

- [ ] **Step 2: 提交**

```bash
git add apps/web/src/components/symbols/CryptoSymbolsPanel.vue
git commit -m "feat: integrate strategy conditions into crypto panel"
```

---

## Task 14: 前端 - 添加路由和菜单

**Files:**
- Modify: `apps/web/src/router/index.ts`
- Modify: `apps/web/src/components/layout/AppSider.vue`

- [ ] **Step 1: 添加路由**

```typescript
// 在 router/index.ts 中添加
{
  path: '/strategy-conditions',
  name: 'StrategyConditions',
  component: () => import('../views/StrategyConditionsView.vue'),
  meta: { title: '策略条件' },
},
```

- [ ] **Step 2: 添加菜单项**

```vue
<!-- 在 AppSider.vue 的菜单中添加 -->
<n-menu-item key="strategy-conditions">
  <template #icon><n-icon><analytics-icon /></n-icon></template>
  策略条件
</n-menu-item>
```

- [ ] **Step 3: 验证页面访问**

```bash
cd apps/web && pnpm run dev
```

Expected: 访问 `/strategy-conditions` 页面正常显示

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/router/index.ts apps/web/src/components/layout/AppSider.vue
git commit -m "feat: add strategy conditions route and menu"
```

---

## Task 15: 测试与验证

- [ ] **Step 1: 启动后端服务**

```bash
cd apps/server && pnpm run start:dev
```

Expected: 服务正常启动

- [ ] **Step 2: 启动前端服务**

```bash
cd apps/web && pnpm run dev
```

Expected: 前端正常启动

- [ ] **Step 3: 测试创建策略条件**

1. 访问 `/strategy-conditions`
2. 点击"新建条件组"
3. 填写名称，选择目标类型
4. 添加条件：KDJ_J < 20
5. 保存

Expected: 条件组创建成功，列表中显示

- [ ] **Step 4: 测试运行策略条件**

1. 访问 A 股标的页面
2. 选择刚创建的策略条件
3. 点击"运行"

Expected: 表格中显示符合条件的标的，"买入信号"列显示标签

- [ ] **Step 5: 测试筛选功能**

1. 在筛选栏中勾选策略条件
2. 点击"应用"

Expected: 只显示符合条件的标的

- [ ] **Step 6: 提交所有更改**

```bash
git add .
git commit -m "feat: complete strategy conditions feature"
```

---

## 自检清单

- [ ] 所有文件路径正确
- [ ] 类型定义一致
- [ ] API 端点与前端调用匹配
- [ ] 组件 props 与使用处匹配
- [ ] 无 TODO/TBD 占位符
- [ ] 错误处理完整
- [ ] 边界情况处理
