# Shared DTO Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `packages/shared-types` 共享包，让前后端通过同一份 TypeScript 接口定义描述 API 响应结构，在编译期捕获字段名不一致问题。

**Architecture:** 使用 TypeScript path alias（不依赖 pnpm 包安装）将 `@cryptotrading/shared-types` 解析到 `packages/shared-types/src/index.ts` 的 `.ts` 源文件，Vite 和 NestJS 均无需额外构建步骤。后端 service 方法通过显式返回类型标注与共享接口挂钩，前端 API 模块直接 import 共享接口替换本地重复定义。以 money-flow 模块为落地示例，验证完整链路后，其他模块按同样模式扩展。

**Tech Stack:** TypeScript 5.3、pnpm workspaces、Vite alias、NestJS tsconfig paths、pure interface（无运行时代码）

---

## 文件结构

```
packages/
  shared-types/
    tsconfig.json               新建：IDE 支持 & 类型检查入口
    src/
      index.ts                  新建：统一 re-export
      money-flow.ts             新建：money-flow 响应 / 请求接口
apps/
  server/
    tsconfig.json               修改：增加 paths 别名
    src/market-data/money-flow/
      money-flow.service.ts     修改：为 querySectors 等加明确返回类型
  web/
    tsconfig.json               修改：增加 paths 别名
    vite.config.ts              修改：增加 resolve alias
    src/api/modules/moneyFlow.ts 修改：删除本地重复接口，改为从共享包 import
```

---

## Task 1: 创建 shared-types 包骨架

**Files:**
- Create: `packages/shared-types/tsconfig.json`
- Create: `packages/shared-types/src/index.ts`

- [ ] **Step 1: 创建目录并写 tsconfig**

在 `packages/shared-types/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": false,
    "skipLibCheck": true,
    "declaration": true,
    "noEmit": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 2: 创建入口文件**

在 `packages/shared-types/src/index.ts`：

```typescript
export * from './money-flow'
```

- [ ] **Step 3: 验证目录结构**

运行：`ls packages/shared-types/src`

预期输出：列出 `index.ts`

---

## Task 2: 编写 money-flow 共享接口

**Files:**
- Create: `packages/shared-types/src/money-flow.ts`

设计原则：
- 字段名以后端实体属性名（camelCase）为准，与数据库无关
- 板块名称字段用 `sector`（对齐 `MoneyFlowSectorEntity.sector`）
- 行业名称字段用 `industry`（对齐 `MoneyFlowIndustryEntity.industry`）
- numeric 列用 `string | null`（TypeORM 返回 numeric 类型为 string）

- [ ] **Step 1: 创建共享接口文件**

新建 `packages/shared-types/src/money-flow.ts`：

```typescript
/** GET /money-flow/stocks 查询参数 */
export interface MoneyFlowQueryParams {
  trade_date?: string
  start_date?: string
  end_date?: string
  ts_code?: string
}

/** POST /money-flow/sync/* 同步参数 */
export interface MoneyFlowSyncParams {
  start_date: string
  end_date: string
}

/** 同步任务返回结果 */
export interface MoneyFlowSyncResult {
  success: number
  skipped: number
  errors: string[]
}

/** GET /money-flow/latest-dates */
export interface MoneyFlowLatestDates {
  stock: string | null
  industry: string | null
  sector: string | null
  market: string | null
}

/** GET /money-flow/stocks 单行 */
export interface MoneyFlowStockRow {
  id: string
  tsCode: string
  tradeDate: string
  name: string | null
  pctChange: string | null
  latest: string | null
  netAmount: string | null
  netD5Amount: string | null
  buyLgAmount: string | null
  buyLgAmountRate: string | null
  buyMdAmount: string | null
  buyMdAmountRate: string | null
  buySmAmount: string | null
  buySmAmountRate: string | null
}

/** GET /money-flow/industries 单行 */
export interface MoneyFlowIndustryRow {
  id: string
  tradeDate: string
  industry: string
  pctChange: string | null
  netAmount: string | null
  buyLgAmount: string | null
  buyMdAmount: string | null
  buySmAmount: string | null
}

/** GET /money-flow/sectors 单行 */
export interface MoneyFlowSectorRow {
  id: string
  tradeDate: string
  sector: string
  pctChange: string | null
  netAmount: string | null
  buyLgAmount: string | null
  buyMdAmount: string | null
  buySmAmount: string | null
}

/** GET /money-flow/market 单行 */
export interface MoneyFlowMarketRow {
  id: string
  tradeDate: string
  netAmount: string | null
  buyLgAmount: string | null
  buySmAmount: string | null
  hkNetAmount: string | null
}
```

> **注意**：`MoneyFlowSectorRow.sector` 与 `MoneyFlowSectorEntity.sector`（已在上次修复中重命名）完全对齐。若发现其他字段不一致，以实体属性名为准修改此文件。

---

## Task 3: 配置 server 的 TypeScript path alias

**Files:**
- Modify: `apps/server/tsconfig.json`

- [ ] **Step 1: 在 server tsconfig 加入 paths**

将 `apps/server/tsconfig.json` 改为：

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "declaration": true,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "ES2021",
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "skipLibCheck": true,
    "strictNullChecks": false,
    "noImplicitAny": false,
    "strictBindCallApply": false,
    "forceConsistentCasingInFileNames": false,
    "noFallthroughCasesInSwitch": false,
    "paths": {
      "@cryptotrading/shared-types": ["../../packages/shared-types/src/index.ts"],
      "@cryptotrading/shared-types/*": ["../../packages/shared-types/src/*"]
    }
  }
}
```

> `baseUrl: "./"` 已存在，paths 相对于该 baseUrl 解析，`../../packages/...` 从 `apps/server/` 向上两级到 monorepo 根。

- [ ] **Step 2: 验证 IDE 能解析别名**

在 `apps/server/src/market-data/money-flow/money-flow.service.ts` 顶部临时加一行（验证后删掉）：

```typescript
import type { MoneyFlowSectorRow } from '@cryptotrading/shared-types'
```

若 IDE 无红线报错，说明路径解析正确。删掉该临时 import。

---

## Task 4: 为 server service 方法加返回类型标注

**Files:**
- Modify: `apps/server/src/market-data/money-flow/money-flow.service.ts`

这是方案的核心价值：让 TypeScript 在编译期校验后端返回的字段名与共享接口一致。

- [ ] **Step 1: 引入共享类型并标注 querySectors 返回类型**

修改 `apps/server/src/market-data/money-flow/money-flow.service.ts` 头部，加入 import：

```typescript
import type {
  MoneyFlowStockRow,
  MoneyFlowIndustryRow,
  MoneyFlowSectorRow,
  MoneyFlowMarketRow,
  MoneyFlowLatestDates,
} from '@cryptotrading/shared-types'
```

然后为四个查询方法加返回类型（使用 `Promise<MoneyFlowXxxRow[]>`）：

```typescript
async queryStocks(dto: QueryFlowDto): Promise<MoneyFlowStockRow[]> {
  // ... 原有实现不变
}

async queryIndustries(dto: QueryFlowDto): Promise<MoneyFlowIndustryRow[]> {
  // ... 原有实现不变
}

async querySectors(dto: QueryFlowDto): Promise<MoneyFlowSectorRow[]> {
  // ... 原有实现不变
}

async queryMarket(dto: QueryFlowDto): Promise<MoneyFlowMarketRow[]> {
  // ... 原有实现不变
}

async getLatestDates(): Promise<MoneyFlowLatestDates> {
  // ... 原有实现不变
}
```

> **关键效果**：若实体字段名与 `MoneyFlowSectorRow` 不一致（如把 `sector` 改回 `name`），`tsc` 编译时就会报 `Property 'sector' is missing in type 'MoneyFlowSectorEntity'`，错误在后端编译期暴露。

- [ ] **Step 2: 检查 linter / tsc 是否报错**

在 `apps/server` 目录运行：

```bash
pnpm exec tsc --noEmit
```

预期：无错误输出（exit code 0）。

若报 `Cannot find module '@cryptotrading/shared-types'`，说明 tsconfig paths 未生效，检查 Task 3 的路径是否正确。

---

## Task 5: 配置 web 的 TypeScript path alias 和 Vite alias

**Files:**
- Modify: `apps/web/tsconfig.json`
- Modify: `apps/web/vite.config.ts`

- [ ] **Step 1: 在 web tsconfig 加入 paths**

将 `apps/web/tsconfig.json` 改为：

```json
{
  "extends": "@vue/tsconfig/tsconfig.dom.json",
  "include": ["src/**/*", "src/**/*.vue"],
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"],
      "@cryptotrading/shared-types": ["../../packages/shared-types/src/index.ts"],
      "@cryptotrading/shared-types/*": ["../../packages/shared-types/src/*"]
    },
    "strict": false
  }
}
```

- [ ] **Step 2: 在 vite.config.ts 加入 resolve alias**

将 `apps/web/vite.config.ts` 改为：

```typescript
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@cryptotrading/shared-types': resolve(__dirname, '../../packages/shared-types/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    allowedHosts: ['mytrading.s7.tunnelfrp.com'],
    port: 5173,
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
```

> Vite 的 alias 负责运行时（dev server & build）解析；tsconfig paths 负责 IDE & `vue-tsc` 类型检查。两者必须同时配置。

---

## Task 6: 迁移前端 money-flow API 模块

**Files:**
- Modify: `apps/web/src/api/modules/moneyFlow.ts`

- [ ] **Step 1: 替换本地接口定义为共享 import**

将 `apps/web/src/api/modules/moneyFlow.ts` 改为：

```typescript
import { API_BASE, post, request } from '../client'
export type {
  MoneyFlowQueryParams,
  MoneyFlowSyncParams,
  MoneyFlowSyncResult,
  MoneyFlowLatestDates,
  MoneyFlowStockRow,
  MoneyFlowIndustryRow,
  MoneyFlowSectorRow,
  MoneyFlowMarketRow,
} from '@cryptotrading/shared-types'
import type { MoneyFlowQueryParams, MoneyFlowSyncParams, MoneyFlowSyncResult } from '@cryptotrading/shared-types'
import type { MoneyFlowStockRow, MoneyFlowIndustryRow, MoneyFlowSectorRow, MoneyFlowMarketRow, MoneyFlowLatestDates } from '@cryptotrading/shared-types'

function buildQs(params: MoneyFlowQueryParams): string {
  const qs = new URLSearchParams()
  if (params.trade_date) qs.set('trade_date', params.trade_date)
  if (params.start_date) qs.set('start_date', params.start_date)
  if (params.end_date) qs.set('end_date', params.end_date)
  if (params.ts_code) qs.set('ts_code', params.ts_code)
  const s = qs.toString()
  return s ? `?${s}` : ''
}

export const moneyFlowApi = {
  getLatestDates: () =>
    request<MoneyFlowLatestDates>(`${API_BASE}/money-flow/latest-dates`),

  queryStocks: (params: MoneyFlowQueryParams) =>
    request<MoneyFlowStockRow[]>(`${API_BASE}/money-flow/stocks${buildQs(params)}`),

  queryIndustries: (params: MoneyFlowQueryParams) =>
    request<MoneyFlowIndustryRow[]>(`${API_BASE}/money-flow/industries${buildQs(params)}`),

  querySectors: (params: MoneyFlowQueryParams) =>
    request<MoneyFlowSectorRow[]>(`${API_BASE}/money-flow/sectors${buildQs(params)}`),

  queryMarket: (params: MoneyFlowQueryParams) =>
    request<MoneyFlowMarketRow[]>(`${API_BASE}/money-flow/market${buildQs(params)}`),

  syncStocks: (params: MoneyFlowSyncParams) =>
    post<MoneyFlowSyncResult>(`${API_BASE}/money-flow/sync/stocks`, params),

  syncIndustries: (params: MoneyFlowSyncParams) =>
    post<MoneyFlowSyncResult>(`${API_BASE}/money-flow/sync/industries`, params),

  syncSectors: (params: MoneyFlowSyncParams) =>
    post<MoneyFlowSyncResult>(`${API_BASE}/money-flow/sync/sectors`, params),

  syncMarket: (params: MoneyFlowSyncParams) =>
    post<MoneyFlowSyncResult>(`${API_BASE}/money-flow/sync/market`, params),
}
```

> `export type { ... } from` 将共享类型透传给其他前端模块，保持现有 `import { MoneyFlowSectorRow } from '@/api/modules/moneyFlow'` 调用方无感迁移。

- [ ] **Step 2: 运行前端 type-check 验证无错误**

在 `apps/web` 目录运行：

```bash
pnpm type-check
```

预期：无错误（exit code 0）。

---

## Task 7: 端到端冒烟验证

- [ ] **Step 1: 启动后端**

```bash
cd apps/server
pnpm dev
```

预期：NestJS 启动成功，无 `Cannot find module '@cryptotrading/shared-types'` 报错。

- [ ] **Step 2: 启动前端**

```bash
cd apps/web
pnpm dev
```

预期：Vite 启动成功，浏览器打开后切换到"资金流向 - 板块"Tab，表格和柱状图的板块名称正常显示。

- [ ] **Step 3: 提交**

```bash
git add packages/shared-types apps/server/tsconfig.json apps/server/src/market-data/money-flow/money-flow.service.ts apps/web/tsconfig.json apps/web/vite.config.ts apps/web/src/api/modules/moneyFlow.ts
git commit -m "feat: add shared-types package and migrate money-flow DTOs"
```

---

## 后续扩展指引

新增其他模块的共享类型，只需：

1. 在 `packages/shared-types/src/` 新建 `<module>.ts`
2. 在 `packages/shared-types/src/index.ts` 加 `export * from './<module>'`
3. 后端 service 方法标注返回类型
4. 前端 API 模块用 `export type { ... } from '@cryptotrading/shared-types'` 替换本地定义

无需任何构建、安装步骤。

---

## 自检

**Spec 覆盖：**
- ✅ 创建 shared-types 骨架
- ✅ money-flow 所有接口迁移
- ✅ 后端编译期校验（service 返回类型标注）
- ✅ 前端零感知迁移（`export type` 透传）
- ✅ Vite alias + tsconfig paths 双配置

**Placeholder 扫描：** 无 TBD / TODO / "类似上面"。

**类型一致性：** `MoneyFlowSectorRow.sector` 在 Task 2 定义，在 Task 4 被 server service 引用，与 Task 6 前端 import 完全对齐。
