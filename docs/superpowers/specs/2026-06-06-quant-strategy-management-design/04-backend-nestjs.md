# 04 · NestJS 后端

← 返回 [index](./index.md) ｜ 上一篇 [03 Python](./03-python-pipeline.md)

完全镜像现有 `modules/quant/labels/`（出处见 index §4）。AdminGuard 沿用现有
controller 风格（**勿**在 controller 上加 `@UseGuards(AuthGuard)`，见 `.claude/rules/nestjs.md`）。

## 1. 实体 `StrategyDefinitionEntity`

文件 `apps/server/src/entities/ml/strategy-definition.entity.ts`，镜像
`label-definition.entity.ts`：

```text
@Entity({ schema: 'factors', name: 'strategy_definitions' })
@Index('idx_strategy_definitions_enabled', ['enabled'])
class StrategyDefinitionEntity:
  @PrimaryColumn name='strategy_id'      varchar(64)   strategyId
  @PrimaryColumn name='strategy_version' varchar(16)   strategyVersion
  @Column        type='text'                            name
  @Column name='exit_rules' type='jsonb' default '[]'   exitRules: ExitRuleDef[]
  @Column type='text' nullable                          description: string|null
  @Column type='boolean' default true                   enabled
  @Column name='display_order' type='int' default 0     displayOrder
  @Column name='created_at' type='timestamptz' default now()  createdAt
```

`ExitRuleDef` 类型 `{ type: string; params: Record<string, number> }`，放
`packages/shared-types/`（前后端共享，见 [05](./05-frontend.md)）。

**⚠ 实体双注册（项目踩过的坑 [[project_typeorm_entity_dual_registration]]）：**
1. `modules/quant/strategies/strategies.module.ts` `TypeOrmModule.forFeature([StrategyDefinitionEntity])`
2. `app.module.ts` 根 `entities` 数组
漏 ② → 编译绿、运行时 `EntityMetadataNotFound` 500。

## 2. 模块目录 `modules/quant/strategies/`

```text
modules/quant/strategies/
  strategies.module.ts          forFeature + 导出 QuantStrategiesService
  strategies.controller.ts      @Controller('quant/strategies')
  strategies.service.ts         list/findOne/create/update
  dto/create-strategy.dto.ts    EXIT_RULE_TYPES 枚举 + 规则校验
  dto/update-strategy.dto.ts    仅 name/description/enabled/display_order
```
在 `quant.module.ts` 导入 `QuantStrategiesModule`（与 LabelsModule 并列）。

## 3. HTTP 接口（全局前缀 `/api`，AdminGuard）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/quant/strategies` | 列表，支持 `?enabled=true\|false` |
| GET | `/api/quant/strategies/exit-rule-types` | 出场规则 type 枚举 + 每种 params 元信息（供前端动态表单） |
| GET | `/api/quant/strategies/:id/:version` | 单条 |
| POST | `/api/quant/strategies` | 新建（或新版本） |
| PATCH | `/api/quant/strategies/:id/:version` | 仅改展示字段 |

**路由顺序**：`exit-rule-types` 静态段必须声明在 `:id/:version` 之前，否则被参数路由捕获。

## 4. DTO 校验（CreateStrategyDto）

`exit_rules` 是 discriminated union 数组，class-validator 方案：

```text
EXIT_RULE_TYPES = ['stop_loss','ma_break','max_hold','take_profit','trailing_stop'] as const

class ExitRuleDto:
  @IsIn(EXIT_RULE_TYPES) type
  @IsObject() params: Record<string, number>
  // params 形状按 type 二次校验（见下）

class CreateStrategyDto:
  @Matches(/^[a-z0-9_]{1,64}$/) strategyId
  @Matches(/^v\d+$/)            strategyVersion
  @IsString @MaxLength(100)     name
  @IsOptional @MaxLength(500)   description
  @IsArray @ArrayNotEmpty @ValidateNested({each:true}) @Type(()=>ExitRuleDto)  exitRules
```

**params 按 type 的范围校验**（DTO 自定义 validator 或 service 层显式校验，与 Python
`build_exit_rules` [03 §5](./03-python-pipeline.md#5-校验与-fail-fast) 范围一一对应）：

| type | 校验 |
|------|------|
| stop_loss | `params.pct` float ∈ (0,1) |
| ma_break | `params.period` int ∈ [2,250] |
| max_hold | `params.days` int ∈ [1,250] |
| take_profit | `params.pct` float ∈ (0,5] |
| trailing_stop | `params.pct` float ∈ (0,1) |

**跨规则约束**：`exit_rules` 非空、**恰含一条 max_hold**、每种 type 至多一条 → 不满足 422。

`exit-rule-types` 接口返回上表（type + 各 param 名/类型/范围/默认值），让前端
ExitRulesEditor 动态渲染参数框、且范围是**后端单一真相源**（前端不硬编码范围）。

## 5. Service 行为

- `list(enabled?)`：按 `display_order, strategy_id, strategy_version` 排序。
- `findOne(id, version)`：404 if 无。
- `create(dto)`：PK 冲突 → 409（同 id@version 已存在）；落库前再跑一遍 params 范围 + 跨规则校验。
- `update(id, version, dto)`：**只** patch `name/description/enabled/display_order`；
  dto 携带 exit_rules/strategy_id/version 一律忽略或 422（语义字段不可改，与 label 一致）。

## 6. 标签侧接线（labels 模块）

### 6.1 create-label DTO（dto/create-label.dto.ts）
strategy_aware 分支：base_params 从 `{max_hold_days∈[10,30]}` 改为
`{strategy_id, strategy_version}`（fwd_ret 分支不变）。

### 6.2 labels.service 校验引用
- `QuantStrategiesModule` 导出 service，`LabelsModule` 导入它。
- 建 strategy_aware 标签时：校验 `base_params.{strategy_id, strategy_version}` 指向的
  策略**存在且 enabled=true**，否则 422（fail-fast，引用完整性）。
- `expandForTraining`（labels.service）：strategy_aware 标签展开后 base_params 原样回传
  `{strategy_id, strategy_version}`（Python 侧解析 exit_rules）。建议在 job 创建时**再校验一次**
  策略仍 enabled（防标签建好后策略被禁用）。

## 7. shared-types

`packages/shared-types/` 增：
- `ExitRuleDef`、`ExitRuleType`、`StrategyDefinition`（响应 DTO 形状）。
- `exit-rule-types` 响应类型 `ExitRuleTypeMeta`。
前端 api service 与 ExitRulesEditor 共用，避免前后端形状漂移。
