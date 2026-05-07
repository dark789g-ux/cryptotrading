# 资金流向页面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增「资金流向」导航页，展示个股/行业/板块/大盘四个维度的 A 股资金流向数据，支持管理员手动同步到数据库，前端从数据库查询展示。

**Architecture:** 后端新增 `MoneyFlowModule`（位于 `market-data/money-flow/`），包含四张 DB 表（对应四个维度）、查询 Service、同步 Service；前端新增 `MoneyFlowView` + 四个 Panel 组件 + 三个共用组件，API 模块统一管理请求。同步入口集成到现有 `SyncView`。

**Tech Stack:** NestJS 10 + TypeORM + PostgreSQL（后端），Vue 3 + Naive UI（前端），Tushare Pro HTTP API（数据源）

---

## 前置确认（实现前必须执行）

- [ ] **确认 Tushare 接口名**：访问 https://tushare.pro/document/2 查看「资金流向数据」分组，确认以下接口名、必填参数、返回字段：
  - 行业资金流向（THS）：预期为 `moneyflow_industry_ths`
  - 板块资金流向（THS）：预期为 `moneyflow_sector_ths`
  - 大盘资金流向（DC）：预期为 `moneyflow_dc`
  - 将确认结果更新到本计划 Task 3 的接口名处，再继续实现

---

## 文件结构总览

**新建文件：**
```
apps/server/src/
├── entities/money-flow/
│   ├── money-flow-stock.entity.ts
│   ├── money-flow-industry.entity.ts
│   ├── money-flow-sector.entity.ts
│   └── money-flow-market.entity.ts
└── market-data/money-flow/
    ├── money-flow.module.ts
    ├── money-flow.controller.ts
    ├── money-flow-sync.controller.ts
    ├── money-flow.service.ts
    ├── money-flow-sync.service.ts
    └── dto/
        ├── query-flow.dto.ts
        └── sync-flow.dto.ts

apps/web/src/
├── views/MoneyFlowView.vue
├── api/modules/moneyFlow.ts
└── components/money-flow/
    ├── FlowDateControl.vue
    ├── FlowKpiCards.vue
    ├── FlowBarChart.vue
    ├── MarketFlowPanel.vue
    ├── IndustryFlowPanel.vue
    ├── SectorFlowPanel.vue
    └── StockFlowPanel.vue
```

**修改文件：**
```
apps/server/src/app.module.ts            — 注册实体 + MoneyFlowModule
apps/web/src/router/index.ts             — 新增 /money-flow 路由
apps/web/src/components/layout/Sidebar.vue — 新增菜单项
apps/web/src/api/index.ts               — 导出 moneyFlowApi
apps/web/src/views/sync/SyncView.vue    — 新增资金流向同步入口
```

---

## Task 1：数据库实体

**Files:**
- Create: `apps/server/src/entities/money-flow/money-flow-stock.entity.ts`
- Create: `apps/server/src/entities/money-flow/money-flow-industry.entity.ts`
- Create: `apps/server/src/entities/money-flow/money-flow-sector.entity.ts`
- Create: `apps/server/src/entities/money-flow/money-flow-market.entity.ts`

- [ ] **Step 1: 创建个股资金流向实体**

```typescript
// apps/server/src/entities/money-flow/money-flow-stock.entity.ts
import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

@Entity('money_flow_stocks')
@Unique(['tsCode', 'tradeDate'])
export class MoneyFlowStockEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'ts_code', length: 16 })
  tsCode: string;

  @Index()
  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ length: 32, nullable: true })
  name: string | null;

  @Column({ name: 'pct_change', type: 'numeric', precision: 20, scale: 4, nullable: true })
  pctChange: string | null;

  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  latest: string | null;

  @Column({ name: 'net_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  netAmount: string | null;

  @Column({ name: 'net_d5_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  netD5Amount: string | null;

  @Column({ name: 'buy_lg_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buyLgAmount: string | null;

  @Column({ name: 'buy_lg_amount_rate', type: 'numeric', precision: 10, scale: 4, nullable: true })
  buyLgAmountRate: string | null;

  @Column({ name: 'buy_md_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buyMdAmount: string | null;

  @Column({ name: 'buy_md_amount_rate', type: 'numeric', precision: 10, scale: 4, nullable: true })
  buyMdAmountRate: string | null;

  @Column({ name: 'buy_sm_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buySmAmount: string | null;

  @Column({ name: 'buy_sm_amount_rate', type: 'numeric', precision: 10, scale: 4, nullable: true })
  buySmAmountRate: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

- [ ] **Step 2: 创建行业资金流向实体**

```typescript
// apps/server/src/entities/money-flow/money-flow-industry.entity.ts
// 注意：列名以查文档确认 moneyflow_industry_ths 返回字段为准，实现前检查并补全缺失列
import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

@Entity('money_flow_industries')
@Unique(['industry', 'tradeDate'])
export class MoneyFlowIndustryEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ length: 64 })
  industry: string;

  @Column({ name: 'pct_change', type: 'numeric', precision: 20, scale: 4, nullable: true })
  pctChange: string | null;

  @Column({ name: 'net_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  netAmount: string | null;

  @Column({ name: 'buy_lg_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buyLgAmount: string | null;

  @Column({ name: 'buy_md_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buyMdAmount: string | null;

  @Column({ name: 'buy_sm_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buySmAmount: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

- [ ] **Step 3: 创建板块资金流向实体**

```typescript
// apps/server/src/entities/money-flow/money-flow-sector.entity.ts
// 注意：列名以查文档确认 moneyflow_sector_ths 返回字段为准，实现前检查并补全缺失列
import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

@Entity('money_flow_sectors')
@Unique(['sector', 'tradeDate'])
export class MoneyFlowSectorEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ length: 64 })
  sector: string;

  @Column({ name: 'pct_change', type: 'numeric', precision: 20, scale: 4, nullable: true })
  pctChange: string | null;

  @Column({ name: 'net_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  netAmount: string | null;

  @Column({ name: 'buy_lg_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buyLgAmount: string | null;

  @Column({ name: 'buy_md_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buyMdAmount: string | null;

  @Column({ name: 'buy_sm_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buySmAmount: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

- [ ] **Step 4: 创建大盘资金流向实体**

```typescript
// apps/server/src/entities/money-flow/money-flow-market.entity.ts
// 注意：列名以查文档确认 moneyflow_dc 返回字段为准，实现前检查并补全缺失列
import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

@Entity('money_flow_market')
@Unique(['tradeDate'])
export class MoneyFlowMarketEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ name: 'net_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  netAmount: string | null;

  @Column({ name: 'buy_lg_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buyLgAmount: string | null;

  @Column({ name: 'buy_sm_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buySmAmount: string | null;

  @Column({ name: 'hk_net_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  hkNetAmount: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

- [ ] **Step 5: 建表（手动执行 SQL，因 synchronize: false）**

```bash
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "
CREATE TABLE IF NOT EXISTS money_flow_stocks (
  id bigserial PRIMARY KEY,
  ts_code varchar(16) NOT NULL,
  trade_date varchar(8) NOT NULL,
  name varchar(32),
  pct_change numeric(20,4),
  latest numeric(20,4),
  net_amount numeric(20,4),
  net_d5_amount numeric(20,4),
  buy_lg_amount numeric(20,4),
  buy_lg_amount_rate numeric(10,4),
  buy_md_amount numeric(20,4),
  buy_md_amount_rate numeric(10,4),
  buy_sm_amount numeric(20,4),
  buy_sm_amount_rate numeric(10,4),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_mfs_ts_code ON money_flow_stocks(ts_code);
CREATE INDEX IF NOT EXISTS idx_mfs_trade_date ON money_flow_stocks(trade_date);

CREATE TABLE IF NOT EXISTS money_flow_industries (
  id bigserial PRIMARY KEY,
  trade_date varchar(8) NOT NULL,
  industry varchar(64) NOT NULL,
  pct_change numeric(20,4),
  net_amount numeric(20,4),
  buy_lg_amount numeric(20,4),
  buy_md_amount numeric(20,4),
  buy_sm_amount numeric(20,4),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(industry, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_mfi_trade_date ON money_flow_industries(trade_date);

CREATE TABLE IF NOT EXISTS money_flow_sectors (
  id bigserial PRIMARY KEY,
  trade_date varchar(8) NOT NULL,
  sector varchar(64) NOT NULL,
  pct_change numeric(20,4),
  net_amount numeric(20,4),
  buy_lg_amount numeric(20,4),
  buy_md_amount numeric(20,4),
  buy_sm_amount numeric(20,4),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(sector, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_mfsec_trade_date ON money_flow_sectors(trade_date);

CREATE TABLE IF NOT EXISTS money_flow_market (
  id bigserial PRIMARY KEY,
  trade_date varchar(8) NOT NULL,
  net_amount numeric(20,4),
  buy_lg_amount numeric(20,4),
  buy_sm_amount numeric(20,4),
  hk_net_amount numeric(20,4),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(trade_date)
);
CREATE INDEX IF NOT EXISTS idx_mfm_trade_date ON money_flow_market(trade_date);
"
```

预期输出：每个 `CREATE TABLE` 和 `CREATE INDEX` 成功。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/entities/money-flow/
git commit -m "feat(money-flow): add four DB entities and create tables"
```

---

## Task 2：DTO 与后端 Service

**Files:**
- Create: `apps/server/src/market-data/money-flow/dto/query-flow.dto.ts`
- Create: `apps/server/src/market-data/money-flow/dto/sync-flow.dto.ts`
- Create: `apps/server/src/market-data/money-flow/money-flow.service.ts`

- [ ] **Step 1: 创建 QueryFlowDto**

```typescript
// apps/server/src/market-data/money-flow/dto/query-flow.dto.ts
export class QueryFlowDto {
  /** 单日查询（YYYYMMDD），与 start_date/end_date 互斥 */
  trade_date?: string;
  start_date?: string;
  end_date?: string;
  /** 仅个股查询支持，过滤单只股票 */
  ts_code?: string;
}
```

- [ ] **Step 2: 创建 SyncFlowDto**

```typescript
// apps/server/src/market-data/money-flow/dto/sync-flow.dto.ts
export class SyncFlowDto {
  /** 起始日期 YYYYMMDD */
  start_date: string;
  /** 结束日期 YYYYMMDD */
  end_date: string;
}
```

- [ ] **Step 3: 创建查询 Service**

```typescript
// apps/server/src/market-data/money-flow/money-flow.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MoneyFlowStockEntity } from '../../entities/money-flow/money-flow-stock.entity';
import { MoneyFlowIndustryEntity } from '../../entities/money-flow/money-flow-industry.entity';
import { MoneyFlowSectorEntity } from '../../entities/money-flow/money-flow-sector.entity';
import { MoneyFlowMarketEntity } from '../../entities/money-flow/money-flow-market.entity';
import { QueryFlowDto } from './dto/query-flow.dto';

@Injectable()
export class MoneyFlowService {
  constructor(
    @InjectRepository(MoneyFlowStockEntity)
    private readonly stockRepo: Repository<MoneyFlowStockEntity>,
    @InjectRepository(MoneyFlowIndustryEntity)
    private readonly industryRepo: Repository<MoneyFlowIndustryEntity>,
    @InjectRepository(MoneyFlowSectorEntity)
    private readonly sectorRepo: Repository<MoneyFlowSectorEntity>,
    @InjectRepository(MoneyFlowMarketEntity)
    private readonly marketRepo: Repository<MoneyFlowMarketEntity>,
  ) {}

  async queryStocks(dto: QueryFlowDto) {
    const qb = this.stockRepo.createQueryBuilder('s').orderBy('s.net_amount', 'DESC');
    if (dto.trade_date) {
      qb.where('s.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('s.trade_date >= :s AND s.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    if (dto.ts_code) {
      qb.andWhere('s.ts_code = :ts', { ts: dto.ts_code });
    }
    return qb.getMany();
  }

  async queryIndustries(dto: QueryFlowDto) {
    const qb = this.industryRepo.createQueryBuilder('i').orderBy('i.net_amount', 'DESC');
    if (dto.trade_date) {
      qb.where('i.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('i.trade_date >= :s AND i.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    return qb.getMany();
  }

  async querySectors(dto: QueryFlowDto) {
    const qb = this.sectorRepo.createQueryBuilder('s').orderBy('s.net_amount', 'DESC');
    if (dto.trade_date) {
      qb.where('s.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('s.trade_date >= :s AND s.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    return qb.getMany();
  }

  async queryMarket(dto: QueryFlowDto) {
    const qb = this.marketRepo.createQueryBuilder('m').orderBy('m.trade_date', 'ASC');
    if (dto.trade_date) {
      qb.where('m.trade_date = :d', { d: dto.trade_date });
    } else if (dto.start_date && dto.end_date) {
      qb.where('m.trade_date >= :s AND m.trade_date <= :e', { s: dto.start_date, e: dto.end_date });
    }
    return qb.getMany();
  }

  /** 各维度最新已同步的交易日 */
  async getLatestDates() {
    const [stock, industry, sector, market] = await Promise.all([
      this.stockRepo.createQueryBuilder('s').select('MAX(s.trade_date)', 'max').getRawOne<{ max: string | null }>(),
      this.industryRepo.createQueryBuilder('i').select('MAX(i.trade_date)', 'max').getRawOne<{ max: string | null }>(),
      this.sectorRepo.createQueryBuilder('s').select('MAX(s.trade_date)', 'max').getRawOne<{ max: string | null }>(),
      this.marketRepo.createQueryBuilder('m').select('MAX(m.trade_date)', 'max').getRawOne<{ max: string | null }>(),
    ]);
    return {
      stock: stock?.max ?? null,
      industry: industry?.max ?? null,
      sector: sector?.max ?? null,
      market: market?.max ?? null,
    };
  }
}
```

- [ ] **Step 4: 提交**

```bash
git add apps/server/src/market-data/money-flow/dto/ apps/server/src/market-data/money-flow/money-flow.service.ts
git commit -m "feat(money-flow): add DTOs and query service"
```

---

## Task 3：同步 Service

**Files:**
- Create: `apps/server/src/market-data/money-flow/money-flow-sync.service.ts`

> **实现前必须**：先查文档确认 `moneyflow_industry_ths`、`moneyflow_sector_ths`、`moneyflow_dc` 接口名及返回字段，更新下方 `FIELDS` 常量与映射逻辑后再实现。

- [ ] **Step 1: 创建同步 Service**

```typescript
// apps/server/src/market-data/money-flow/money-flow-sync.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MoneyFlowStockEntity } from '../../entities/money-flow/money-flow-stock.entity';
import { MoneyFlowIndustryEntity } from '../../entities/money-flow/money-flow-industry.entity';
import { MoneyFlowSectorEntity } from '../../entities/money-flow/money-flow-sector.entity';
import { MoneyFlowMarketEntity } from '../../entities/money-flow/money-flow-market.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { SyncFlowDto } from './dto/sync-flow.dto';

// TODO: 需集成测试验证 API 契约（行业/板块/大盘接口名以官方文档为准）
const STOCK_FIELDS = 'trade_date,ts_code,name,pct_change,latest,net_amount,net_d5_amount,buy_lg_amount,buy_lg_amount_rate,buy_md_amount,buy_md_amount_rate,buy_sm_amount,buy_sm_amount_rate';
const INDUSTRY_FIELDS = 'trade_date,industry,pct_change,net_amount,buy_lg_amount,buy_md_amount,buy_sm_amount'; // 查文档确认
const SECTOR_FIELDS = 'trade_date,sector,pct_change,net_amount,buy_lg_amount,buy_md_amount,buy_sm_amount'; // 查文档确认，sector 字段名以文档为准
const MARKET_FIELDS = 'trade_date,net_amount,buy_lg_amount,buy_sm_amount,hk_net_amount'; // 查文档确认

export interface MoneyFlowSyncResult {
  success: number;
  skipped: number;
  errors: string[];
}

function asNullableNumeric(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}

function asString(v: unknown): string {
  return v == null ? '' : String(v);
}

@Injectable()
export class MoneyFlowSyncService {
  private readonly logger = new Logger(MoneyFlowSyncService.name);

  constructor(
    @InjectRepository(MoneyFlowStockEntity)
    private readonly stockRepo: Repository<MoneyFlowStockEntity>,
    @InjectRepository(MoneyFlowIndustryEntity)
    private readonly industryRepo: Repository<MoneyFlowIndustryEntity>,
    @InjectRepository(MoneyFlowSectorEntity)
    private readonly sectorRepo: Repository<MoneyFlowSectorEntity>,
    @InjectRepository(MoneyFlowMarketEntity)
    private readonly marketRepo: Repository<MoneyFlowMarketEntity>,
    private readonly tushareClient: TushareClientService,
  ) {}

  async syncStocks(dto: SyncFlowDto): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    let success = 0;
    // moneyflow_ths 单次最大 6000 条，按日期循环（简单起见先整段查，数据量大时可按日切分）
    const rows = await this.tushareClient.query(
      'moneyflow_ths',
      { start_date: dto.start_date, end_date: dto.end_date },
      STOCK_FIELDS,
    ).catch((e: unknown) => { errors.push(String(e)); return []; });

    if (!rows.length) {
      this.logger.warn('moneyflow_ths 返回空数据', { start_date: dto.start_date, end_date: dto.end_date });
      return { success: 0, skipped: 0, errors };
    }

    const entities = rows.map((row) =>
      this.stockRepo.create({
        tsCode: asString(row.ts_code),
        tradeDate: asString(row.trade_date),
        name: asNullableNumeric(row.name),
        pctChange: asNullableNumeric(row.pct_change),
        latest: asNullableNumeric(row.latest),
        netAmount: asNullableNumeric(row.net_amount),
        netD5Amount: asNullableNumeric(row.net_d5_amount),
        buyLgAmount: asNullableNumeric(row.buy_lg_amount),
        buyLgAmountRate: asNullableNumeric(row.buy_lg_amount_rate),
        buyMdAmount: asNullableNumeric(row.buy_md_amount),
        buyMdAmountRate: asNullableNumeric(row.buy_md_amount_rate),
        buySmAmount: asNullableNumeric(row.buy_sm_amount),
        buySmAmountRate: asNullableNumeric(row.buy_sm_amount_rate),
      }),
    );

    const chunkSize = 1000;
    for (let i = 0; i < entities.length; i += chunkSize) {
      await this.stockRepo.upsert(entities.slice(i, i + chunkSize), ['tsCode', 'tradeDate']);
    }
    success = entities.length;
    return { success, skipped: 0, errors };
  }

  async syncIndustries(dto: SyncFlowDto): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    // 接口名以文档确认为准，下方 'moneyflow_industry_ths' 为预期值
    const rows = await this.tushareClient.query(
      'moneyflow_industry_ths', // TODO: 查文档确认
      { start_date: dto.start_date, end_date: dto.end_date },
      INDUSTRY_FIELDS,
    ).catch((e: unknown) => { errors.push(String(e)); return []; });

    if (!rows.length) {
      this.logger.warn('moneyflow_industry_ths 返回空数据', dto);
      return { success: 0, skipped: 0, errors };
    }

    const entities = rows.map((row) =>
      this.industryRepo.create({
        tradeDate: asString(row.trade_date),
        industry: asString(row.industry),
        pctChange: asNullableNumeric(row.pct_change),
        netAmount: asNullableNumeric(row.net_amount),
        buyLgAmount: asNullableNumeric(row.buy_lg_amount),
        buyMdAmount: asNullableNumeric(row.buy_md_amount),
        buySmAmount: asNullableNumeric(row.buy_sm_amount),
      }),
    );

    const chunkSize = 1000;
    for (let i = 0; i < entities.length; i += chunkSize) {
      await this.industryRepo.upsert(entities.slice(i, i + chunkSize), ['industry', 'tradeDate']);
    }
    return { success: entities.length, skipped: 0, errors };
  }

  async syncSectors(dto: SyncFlowDto): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    // 接口名以文档确认为准，下方 'moneyflow_sector_ths' 为预期值
    const rows = await this.tushareClient.query(
      'moneyflow_sector_ths', // TODO: 查文档确认
      { start_date: dto.start_date, end_date: dto.end_date },
      SECTOR_FIELDS,
    ).catch((e: unknown) => { errors.push(String(e)); return []; });

    if (!rows.length) {
      this.logger.warn('moneyflow_sector_ths 返回空数据', dto);
      return { success: 0, skipped: 0, errors };
    }

    const entities = rows.map((row) =>
      this.sectorRepo.create({
        tradeDate: asString(row.trade_date),
        sector: asString(row.sector), // 字段名以文档为准
        pctChange: asNullableNumeric(row.pct_change),
        netAmount: asNullableNumeric(row.net_amount),
        buyLgAmount: asNullableNumeric(row.buy_lg_amount),
        buyMdAmount: asNullableNumeric(row.buy_md_amount),
        buySmAmount: asNullableNumeric(row.buy_sm_amount),
      }),
    );

    const chunkSize = 1000;
    for (let i = 0; i < entities.length; i += chunkSize) {
      await this.sectorRepo.upsert(entities.slice(i, i + chunkSize), ['sector', 'tradeDate']);
    }
    return { success: entities.length, skipped: 0, errors };
  }

  async syncMarket(dto: SyncFlowDto): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    // 接口名以文档确认为准，下方 'moneyflow_dc' 为预期值
    const rows = await this.tushareClient.query(
      'moneyflow_dc', // TODO: 查文档确认
      { start_date: dto.start_date, end_date: dto.end_date },
      MARKET_FIELDS,
    ).catch((e: unknown) => { errors.push(String(e)); return []; });

    if (!rows.length) {
      this.logger.warn('moneyflow_dc 返回空数据', dto);
      return { success: 0, skipped: 0, errors };
    }

    const entities = rows.map((row) =>
      this.marketRepo.create({
        tradeDate: asString(row.trade_date),
        netAmount: asNullableNumeric(row.net_amount),
        buyLgAmount: asNullableNumeric(row.buy_lg_amount),
        buySmAmount: asNullableNumeric(row.buy_sm_amount),
        hkNetAmount: asNullableNumeric(row.hk_net_amount), // 字段名以文档为准
      }),
    );

    const chunkSize = 1000;
    for (let i = 0; i < entities.length; i += chunkSize) {
      await this.marketRepo.upsert(entities.slice(i, i + chunkSize), ['tradeDate']);
    }
    return { success: entities.length, skipped: 0, errors };
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add apps/server/src/market-data/money-flow/money-flow-sync.service.ts
git commit -m "feat(money-flow): add sync service (Tushare -> DB)"
```

---

## Task 4：NestJS 控制器与模块注册

**Files:**
- Create: `apps/server/src/market-data/money-flow/money-flow.controller.ts`
- Create: `apps/server/src/market-data/money-flow/money-flow-sync.controller.ts`
- Create: `apps/server/src/market-data/money-flow/money-flow.module.ts`
- Modify: `apps/server/src/app.module.ts`

- [ ] **Step 1: 创建查询 Controller**

```typescript
// apps/server/src/market-data/money-flow/money-flow.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { MoneyFlowService } from './money-flow.service';
import { QueryFlowDto } from './dto/query-flow.dto';

@Controller('money-flow')
export class MoneyFlowController {
  constructor(private readonly moneyFlowService: MoneyFlowService) {}

  @Get('latest-dates')
  getLatestDates() {
    return this.moneyFlowService.getLatestDates();
  }

  @Get('stocks')
  queryStocks(@Query() dto: QueryFlowDto) {
    return this.moneyFlowService.queryStocks(dto);
  }

  @Get('industries')
  queryIndustries(@Query() dto: QueryFlowDto) {
    return this.moneyFlowService.queryIndustries(dto);
  }

  @Get('sectors')
  querySectors(@Query() dto: QueryFlowDto) {
    return this.moneyFlowService.querySectors(dto);
  }

  @Get('market')
  queryMarket(@Query() dto: QueryFlowDto) {
    return this.moneyFlowService.queryMarket(dto);
  }
}
```

- [ ] **Step 2: 创建同步 Controller（仅管理员）**

```typescript
// apps/server/src/market-data/money-flow/money-flow-sync.controller.ts
import { Body, Controller, Post } from '@nestjs/common';
import { AdminOnly } from '../../auth/decorators/admin-only.decorator';
import { MoneyFlowSyncService } from './money-flow-sync.service';
import { SyncFlowDto } from './dto/sync-flow.dto';

@Controller('money-flow/sync')
export class MoneyFlowSyncController {
  constructor(private readonly syncService: MoneyFlowSyncService) {}

  @Post('stocks')
  @AdminOnly()
  syncStocks(@Body() dto: SyncFlowDto) {
    return this.syncService.syncStocks(dto);
  }

  @Post('industries')
  @AdminOnly()
  syncIndustries(@Body() dto: SyncFlowDto) {
    return this.syncService.syncIndustries(dto);
  }

  @Post('sectors')
  @AdminOnly()
  syncSectors(@Body() dto: SyncFlowDto) {
    return this.syncService.syncSectors(dto);
  }

  @Post('market')
  @AdminOnly()
  syncMarket(@Body() dto: SyncFlowDto) {
    return this.syncService.syncMarket(dto);
  }
}
```

- [ ] **Step 3: 创建 Module**

```typescript
// apps/server/src/market-data/money-flow/money-flow.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MoneyFlowStockEntity } from '../../entities/money-flow/money-flow-stock.entity';
import { MoneyFlowIndustryEntity } from '../../entities/money-flow/money-flow-industry.entity';
import { MoneyFlowSectorEntity } from '../../entities/money-flow/money-flow-sector.entity';
import { MoneyFlowMarketEntity } from '../../entities/money-flow/money-flow-market.entity';
import { MoneyFlowController } from './money-flow.controller';
import { MoneyFlowSyncController } from './money-flow-sync.controller';
import { MoneyFlowService } from './money-flow.service';
import { MoneyFlowSyncService } from './money-flow-sync.service';
import { TushareClientService } from '../a-shares/services/tushare-client.service';

@Module({
  imports: [TypeOrmModule.forFeature([
    MoneyFlowStockEntity,
    MoneyFlowIndustryEntity,
    MoneyFlowSectorEntity,
    MoneyFlowMarketEntity,
  ])],
  controllers: [MoneyFlowController, MoneyFlowSyncController],
  providers: [MoneyFlowService, MoneyFlowSyncService, TushareClientService],
})
export class MoneyFlowModule {}
```

- [ ] **Step 4: 注册到 AppModule**

在 `apps/server/src/app.module.ts` 中：
1. 在 import 块末尾添加四个实体 import：
```typescript
import { MoneyFlowStockEntity } from './entities/money-flow/money-flow-stock.entity';
import { MoneyFlowIndustryEntity } from './entities/money-flow/money-flow-industry.entity';
import { MoneyFlowSectorEntity } from './entities/money-flow/money-flow-sector.entity';
import { MoneyFlowMarketEntity } from './entities/money-flow/money-flow-market.entity';
import { MoneyFlowModule } from './market-data/money-flow/money-flow.module';
```
2. 在 `entities: [...]` 数组中追加四个实体（紧跟 `StrategyConditionHitEntity` 之后）：
```typescript
MoneyFlowStockEntity,
MoneyFlowIndustryEntity,
MoneyFlowSectorEntity,
MoneyFlowMarketEntity,
```
3. 在 `imports: [...]` 模块列表中追加（紧跟 `StrategyConditionsModule` 之后）：
```typescript
MoneyFlowModule,
```

- [ ] **Step 5: 验证后端启动**

```bash
cd apps/server
pnpm run start:dev
```

预期：服务器启动无报错，日志无 `Can't resolve dependencies`。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/market-data/money-flow/ apps/server/src/app.module.ts
git commit -m "feat(money-flow): add NestJS module, controllers and register in AppModule"
```

---

## Task 5：前端 API 模块

**Files:**
- Create: `apps/web/src/api/modules/moneyFlow.ts`
- Modify: `apps/web/src/api/index.ts`

- [ ] **Step 1: 创建 moneyFlow.ts**

```typescript
// apps/web/src/api/modules/moneyFlow.ts
import { API_BASE, post, request } from '../client'

export interface MoneyFlowQueryParams {
  trade_date?: string
  start_date?: string
  end_date?: string
  ts_code?: string
}

export interface MoneyFlowSyncParams {
  start_date: string
  end_date: string
}

export interface MoneyFlowSyncResult {
  success: number
  skipped: number
  errors: string[]
}

export interface MoneyFlowLatestDates {
  stock: string | null
  industry: string | null
  sector: string | null
  market: string | null
}

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

export interface MoneyFlowMarketRow {
  id: string
  tradeDate: string
  netAmount: string | null
  buyLgAmount: string | null
  buySmAmount: string | null
  hkNetAmount: string | null
}

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

- [ ] **Step 2: 在 api/index.ts 中导出**

查看 `apps/web/src/api/index.ts` 现有导出格式，在末尾追加：
```typescript
export { moneyFlowApi } from './modules/moneyFlow'
export type { MoneyFlowStockRow, MoneyFlowIndustryRow, MoneyFlowSectorRow, MoneyFlowMarketRow, MoneyFlowQueryParams, MoneyFlowSyncParams, MoneyFlowSyncResult, MoneyFlowLatestDates } from './modules/moneyFlow'
```

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/api/modules/moneyFlow.ts apps/web/src/api/index.ts
git commit -m "feat(money-flow): add frontend API module"
```

---

## Task 6：共用前端组件

**Files:**
- Create: `apps/web/src/components/money-flow/money-flow.types.ts`
- Create: `apps/web/src/components/money-flow/FlowDateControl.vue`
- Create: `apps/web/src/components/money-flow/FlowKpiCards.vue`
- Create: `apps/web/src/components/money-flow/FlowBarChart.vue`

> **注意**：`<script setup>` 内不能使用 `export`，共用类型统一放在 `money-flow.types.ts` 中。

- [ ] **Step 1: 创建共用类型文件**

```typescript
// apps/web/src/components/money-flow/money-flow.types.ts
export interface KpiCardItem {
  label: string
  value: string | null | undefined
  sub?: string
}

export interface BarChartRow {
  label: string
  value: number
}
```

- [ ] **Step 2: 创建 FlowDateControl（日期控制栏）**

```vue
<!-- apps/web/src/components/money-flow/FlowDateControl.vue -->
<template>
  <div class="flow-date-control">
    <div class="mode-toggle">
      <button
        class="mode-btn"
        :class="{ active: mode === 'single' }"
        @click="setMode('single')"
      >单日</button>
      <button
        class="mode-btn"
        :class="{ active: mode === 'range' }"
        @click="setMode('range')"
      >区间</button>
    </div>

    <n-date-picker
      v-if="mode === 'single'"
      :value="singleDateTs"
      type="date"
      format="yyyyMMdd"
      :is-date-disabled="isFutureDate"
      @update:value="onSingleChange"
    />
    <n-date-picker
      v-else
      :value="rangeDateTs"
      type="daterange"
      format="yyyyMMdd"
      :is-date-disabled="isFutureDate"
      @update:value="onRangeChange"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { NDatePicker } from 'naive-ui'

type DateMode = 'single' | 'range'

const emit = defineEmits<{
  change: [params: { trade_date?: string; start_date?: string; end_date?: string }]
}>()

const mode = ref<DateMode>('single')

function toYYYYMMDD(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function fromYYYYMMDD(s: string): number {
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00`).getTime()
}

// 默认今天
const todayTs = Date.now()
const singleDateTs = ref<number | null>(todayTs)
const rangeDateTs = ref<[number, number] | null>(null)

const singleYYYYMMDD = computed(() => singleDateTs.value ? toYYYYMMDD(singleDateTs.value) : '')

function isFutureDate(ts: number) {
  return ts > Date.now()
}

function setMode(m: DateMode) {
  mode.value = m
  emitCurrent()
}

function onSingleChange(ts: number | null) {
  singleDateTs.value = ts
  if (ts) emit('change', { trade_date: toYYYYMMDD(ts) })
}

function onRangeChange(ts: [number, number] | null) {
  rangeDateTs.value = ts
  if (ts) emit('change', { start_date: toYYYYMMDD(ts[0]), end_date: toYYYYMMDD(ts[1]) })
}

function emitCurrent() {
  if (mode.value === 'single' && singleDateTs.value) {
    emit('change', { trade_date: toYYYYMMDD(singleDateTs.value) })
  } else if (mode.value === 'range' && rangeDateTs.value) {
    emit('change', { start_date: toYYYYMMDD(rangeDateTs.value[0]), end_date: toYYYYMMDD(rangeDateTs.value[1]) })
  }
}

// 初始化时 emit 默认值
emitCurrent()
</script>

<style scoped>
.flow-date-control {
  display: flex;
  align-items: center;
  gap: 12px;
}
.mode-toggle {
  display: inline-flex;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  overflow: hidden;
}
.mode-btn {
  padding: 5px 14px;
  font-size: 13px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.mode-btn.active {
  background: var(--color-primary);
  color: #fff;
}
</style>
```

- [ ] **Step 3: 创建 FlowKpiCards（KPI 摘要卡片行）**

```vue
<!-- apps/web/src/components/money-flow/FlowKpiCards.vue -->
<template>
  <div class="flow-kpi-row">
    <div v-for="card in cards" :key="card.label" class="flow-kpi-card">
      <div class="kpi-label">{{ card.label }}</div>
      <div class="kpi-value" :class="valueClass(card.value)">
        <n-skeleton v-if="loading" text :width="80" />
        <template v-else>{{ formatValue(card.value) }}</template>
      </div>
      <div v-if="card.sub" class="kpi-sub">{{ card.sub }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { NSkeleton } from 'naive-ui'
import type { KpiCardItem } from './money-flow.types'

const props = defineProps<{ cards: KpiCardItem[]; loading?: boolean }>()

function formatValue(v: string | null | undefined): string {
  if (v == null || v === '') return '—'
  const n = Number(v)
  if (isNaN(n)) return v
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(2)}亿`
  return `${n.toFixed(2)}万`
}

function valueClass(v: string | null | undefined) {
  const n = Number(v)
  if (isNaN(n) || v == null) return ''
  return n > 0 ? 'positive' : n < 0 ? 'negative' : ''
}
</script>

<style scoped>
.flow-kpi-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}
.flow-kpi-card {
  background: var(--color-surface, #1e2028);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  padding: 14px 16px;
}
.kpi-label {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-bottom: 6px;
}
.kpi-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--color-text);
}
.kpi-value.positive { color: #f04747; }
.kpi-value.negative { color: #4caf8a; }
.kpi-sub {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: 4px;
}
</style>
```

- [ ] **Step 4: 创建 FlowBarChart（横向柱状图）**

```vue
<!-- apps/web/src/components/money-flow/FlowBarChart.vue -->
<!-- 纯 CSS 实现，避免引入重型图表库 -->
<template>
  <div class="flow-bar-chart">
    <div v-if="!rows.length" class="empty">暂无数据</div>
    <div v-for="row in displayRows" :key="row.label" class="bar-row">
      <div class="bar-label" :title="row.label">{{ row.label }}</div>
      <div class="bar-track">
        <div
          class="bar-fill"
          :class="row.value >= 0 ? 'positive' : 'negative'"
          :style="{ width: barWidth(row.value) }"
        />
      </div>
      <div class="bar-value" :class="row.value >= 0 ? 'positive' : 'negative'">
        {{ formatAmount(row.value) }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { BarChartRow } from './money-flow.types'

const props = defineProps<{
  rows: BarChartRow[]
  maxRows?: number
}>()

const displayRows = computed(() => {
  const sorted = [...props.rows].sort((a, b) => b.value - a.value)
  return (props.maxRows ? sorted.slice(0, props.maxRows) : sorted)
})

const maxAbs = computed(() => Math.max(...displayRows.value.map(r => Math.abs(r.value)), 1))

function barWidth(v: number): string {
  return `${Math.round((Math.abs(v) / maxAbs.value) * 100)}%`
}

function formatAmount(v: number): string {
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(2)}亿`
  return `${v.toFixed(2)}万`
}
</script>

<style scoped>
.flow-bar-chart { display: flex; flex-direction: column; gap: 6px; }
.empty { color: var(--color-text-muted); text-align: center; padding: 40px 0; }
.bar-row { display: grid; grid-template-columns: 100px 1fr 80px; align-items: center; gap: 8px; }
.bar-label { font-size: 12px; color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { height: 14px; background: color-mix(in srgb, var(--color-border) 50%, transparent); border-radius: 3px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 3px; transition: width 0.3s ease; }
.bar-fill.positive { background: #f04747; }
.bar-fill.negative { background: #4caf8a; }
.bar-value { font-size: 12px; text-align: right; }
.bar-value.positive { color: #f04747; }
.bar-value.negative { color: #4caf8a; }
</style>
```

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/money-flow/money-flow.types.ts apps/web/src/components/money-flow/FlowDateControl.vue apps/web/src/components/money-flow/FlowKpiCards.vue apps/web/src/components/money-flow/FlowBarChart.vue
git commit -m "feat(money-flow): add shared components FlowDateControl, FlowKpiCards, FlowBarChart"
```

---

## Task 7：个股 Tab（StockFlowPanel）

**Files:**
- Create: `apps/web/src/components/money-flow/StockFlowPanel.vue`

- [ ] **Step 1: 创建 StockFlowPanel**

```vue
<!-- apps/web/src/components/money-flow/StockFlowPanel.vue -->
<template>
  <div class="stock-flow-panel">
    <div class="panel-controls">
      <FlowDateControl @change="onDateChange" />
      <n-input
        v-model:value="searchQuery"
        placeholder="搜索股票代码/名称"
        clearable
        style="width: 200px"
      />
    </div>

    <FlowKpiCards :cards="kpiCards" :loading="loading" />

    <div class="panel-body">
      <div class="chart-col">
        <FlowBarChart :rows="chartRows" :max-rows="20" />
      </div>
      <div class="table-col">
        <n-data-table
          :columns="columns"
          :data="filteredRows"
          :loading="loading"
          :max-height="500"
          size="small"
          :pagination="{ pageSize: 50 }"
          :scroll-x="700"
        />
        <div v-if="!loading && !rows.length" class="empty-state">
          暂无数据，请前往
          <router-link to="/sync">数据同步</router-link>
          页面更新资金流向数据。
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'StockFlowPanel' })

import { computed, h, onActivated, ref } from 'vue'
import { NDataTable, NInput } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { moneyFlowApi, type MoneyFlowQueryParams, type MoneyFlowStockRow } from '@/api/modules/moneyFlow'
import FlowDateControl from './FlowDateControl.vue'
import FlowKpiCards from './FlowKpiCards.vue'
import FlowBarChart from './FlowBarChart.vue'
import type { KpiCardItem, BarChartRow } from './money-flow.types'

const rows = ref<MoneyFlowStockRow[]>([])
const loading = ref(false)
const searchQuery = ref('')
const currentParams = ref<MoneyFlowQueryParams>({})

const filteredRows = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return rows.value
  return rows.value.filter(r =>
    r.tsCode.toLowerCase().includes(q) || (r.name ?? '').toLowerCase().includes(q),
  )
})

const kpiCards = computed((): KpiCardItem[] => {
  const sorted = [...rows.value].sort((a, b) => Number(b.netAmount) - Number(a.netAmount))
  const top1 = sorted[0]
  const topPct = [...rows.value].sort((a, b) => Number(b.pctChange) - Number(a.pctChange))[0]
  const topLg = [...rows.value].sort((a, b) => Number(b.buyLgAmount) - Number(a.buyLgAmount))[0]
  return [
    { label: '净流入最多', value: top1?.netAmount ?? null, sub: top1 ? `${top1.name}(${top1.tsCode})` : '' },
    { label: '涨幅最高', value: topPct?.pctChange ?? null, sub: topPct ? topPct.name ?? '' : '' },
    { label: '大单净流入', value: topLg?.buyLgAmount ?? null, sub: topLg ? topLg.name ?? '' : '' },
    { label: '上榜股票数', value: String(rows.value.length), sub: '当日' },
  ]
})

const chartRows = computed((): BarChartRow[] =>
  rows.value.map(r => ({ label: r.name ?? r.tsCode, value: Number(r.netAmount) || 0 })),
)

const columns: DataTableColumns<MoneyFlowStockRow> = [
  { title: '代码', key: 'tsCode', width: 100, fixed: 'left' },
  { title: '名称', key: 'name', width: 90 },
  {
    title: '涨跌幅%',
    key: 'pctChange',
    width: 90,
    sorter: (a, b) => Number(a.pctChange) - Number(b.pctChange),
    render: (row) => {
      const v = Number(row.pctChange)
      const cls = v > 0 ? 'positive' : v < 0 ? 'negative' : ''
      return h('span', { class: cls }, `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`)
    },
  },
  {
    title: '净流入(万)',
    key: 'netAmount',
    width: 110,
    sorter: (a, b) => Number(a.netAmount) - Number(b.netAmount),
    defaultSortOrder: 'descend',
    render: (row) => {
      const v = Number(row.netAmount)
      return h('span', { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' }, v.toFixed(2))
    },
  },
  {
    title: '大单净额(万)',
    key: 'buyLgAmount',
    width: 115,
    sorter: (a, b) => Number(a.buyLgAmount) - Number(b.buyLgAmount),
    render: (row) => {
      const v = Number(row.buyLgAmount)
      return h('span', { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' }, v.toFixed(2))
    },
  },
  { title: '大单占比%', key: 'buyLgAmountRate', width: 100, render: (row) => `${Number(row.buyLgAmountRate).toFixed(2)}%` },
  {
    title: '中单净额(万)',
    key: 'buyMdAmount',
    width: 115,
    render: (row) => {
      const v = Number(row.buyMdAmount)
      return h('span', { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' }, v.toFixed(2))
    },
  },
  {
    title: '小单净额(万)',
    key: 'buySmAmount',
    width: 115,
    render: (row) => {
      const v = Number(row.buySmAmount)
      return h('span', { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' }, v.toFixed(2))
    },
  },
]

async function load() {
  if (!currentParams.value.trade_date && !currentParams.value.start_date) return
  loading.value = true
  try {
    rows.value = await moneyFlowApi.queryStocks(currentParams.value)
  } catch {
    rows.value = []
  } finally {
    loading.value = false
  }
}

function onDateChange(params: MoneyFlowQueryParams) {
  currentParams.value = params
  load()
}

onActivated(load)
</script>

<style scoped>
.stock-flow-panel { display: flex; flex-direction: column; gap: 16px; }
.panel-controls { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.panel-body { display: grid; grid-template-columns: 1fr 1.5fr; gap: 20px; }
.chart-col, .table-col { min-width: 0; }
.empty-state { color: var(--color-text-muted); text-align: center; padding: 40px; }
.empty-state a { color: var(--color-primary); }
:deep(.positive) { color: #f04747; }
:deep(.negative) { color: #4caf8a; }
</style>
```

- [ ] **Step 2: 提交**

```bash
git add apps/web/src/components/money-flow/StockFlowPanel.vue
git commit -m "feat(money-flow): add StockFlowPanel"
```

---

## Task 8：行业、板块、大盘 Tab

**Files:**
- Create: `apps/web/src/components/money-flow/IndustryFlowPanel.vue`
- Create: `apps/web/src/components/money-flow/SectorFlowPanel.vue`
- Create: `apps/web/src/components/money-flow/MarketFlowPanel.vue`

- [ ] **Step 1: 创建 IndustryFlowPanel**

```vue
<!-- apps/web/src/components/money-flow/IndustryFlowPanel.vue -->
<template>
  <div class="industry-flow-panel">
    <div class="panel-controls">
      <FlowDateControl @change="onDateChange" />
    </div>

    <FlowKpiCards :cards="kpiCards" :loading="loading" />

    <div class="panel-body">
      <div class="chart-col">
        <FlowBarChart :rows="chartRows" :max-rows="30" />
      </div>
      <div class="table-col">
        <n-data-table
          :columns="columns"
          :data="rows"
          :loading="loading"
          :max-height="500"
          size="small"
          :pagination="{ pageSize: 50 }"
        />
        <div v-if="!loading && !rows.length" class="empty-state">
          暂无数据，请前往
          <router-link to="/sync">数据同步</router-link>
          页面更新资金流向数据。
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'IndustryFlowPanel' })

import { computed, h, onActivated, ref } from 'vue'
import { NDataTable } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { moneyFlowApi, type MoneyFlowQueryParams, type MoneyFlowIndustryRow } from '@/api/modules/moneyFlow'
import FlowDateControl from './FlowDateControl.vue'
import FlowKpiCards from './FlowKpiCards.vue'
import FlowBarChart from './FlowBarChart.vue'
import type { KpiCardItem, BarChartRow } from './money-flow.types'

const rows = ref<MoneyFlowIndustryRow[]>([])
const loading = ref(false)
const currentParams = ref<MoneyFlowQueryParams>({})

const kpiCards = computed((): KpiCardItem[] => {
  const sorted = [...rows.value].sort((a, b) => Number(b.netAmount) - Number(a.netAmount))
  const top1In = sorted[0]
  const top1Out = sorted[sorted.length - 1]
  const inCount = rows.value.filter(r => Number(r.netAmount) > 0).length
  return [
    { label: '净流入最多', value: top1In?.netAmount ?? null, sub: top1In?.industry ?? '' },
    { label: '净流出最多', value: top1Out?.netAmount ?? null, sub: top1Out?.industry ?? '' },
    { label: '净流入行业数', value: String(inCount), sub: `共${rows.value.length}个行业` },
    { label: '合计净流入', value: rows.value.reduce((s, r) => s + (Number(r.netAmount) || 0), 0).toFixed(0), sub: '万元' },
  ]
})

const chartRows = computed((): BarChartRow[] =>
  rows.value.map(r => ({ label: r.industry, value: Number(r.netAmount) || 0 })),
)

const columns: DataTableColumns<MoneyFlowIndustryRow> = [
  { title: '行业', key: 'industry', width: 120 },
  { title: '涨跌幅%', key: 'pctChange', width: 90, sorter: (a, b) => Number(a.pctChange) - Number(b.pctChange), render: row => { const v = Number(row.pctChange); return h('span', { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' }, `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`) } },
  { title: '净流入(万)', key: 'netAmount', width: 110, defaultSortOrder: 'descend', sorter: (a, b) => Number(a.netAmount) - Number(b.netAmount), render: row => { const v = Number(row.netAmount); return h('span', { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' }, v.toFixed(2)) } },
  { title: '大单净额(万)', key: 'buyLgAmount', width: 115, sorter: (a, b) => Number(a.buyLgAmount) - Number(b.buyLgAmount), render: row => { const v = Number(row.buyLgAmount); return h('span', { class: v > 0 ? 'positive' : 'negative' }, v.toFixed(2)) } },
  { title: '中单净额(万)', key: 'buyMdAmount', width: 115, render: row => { const v = Number(row.buyMdAmount); return h('span', { class: v > 0 ? 'positive' : 'negative' }, v.toFixed(2)) } },
  { title: '小单净额(万)', key: 'buySmAmount', width: 115, render: row => { const v = Number(row.buySmAmount); return h('span', { class: v > 0 ? 'positive' : 'negative' }, v.toFixed(2)) } },
]

async function load() {
  if (!currentParams.value.trade_date && !currentParams.value.start_date) return
  loading.value = true
  try {
    rows.value = await moneyFlowApi.queryIndustries(currentParams.value)
  } catch {
    rows.value = []
  } finally {
    loading.value = false
  }
}

function onDateChange(params: MoneyFlowQueryParams) {
  currentParams.value = params
  load()
}

onActivated(load)
</script>

<style scoped>
.industry-flow-panel { display: flex; flex-direction: column; gap: 16px; }
.panel-controls { display: flex; align-items: center; gap: 16px; }
.panel-body { display: grid; grid-template-columns: 1fr 1.5fr; gap: 20px; }
.chart-col, .table-col { min-width: 0; }
.empty-state { color: var(--color-text-muted); text-align: center; padding: 40px; }
.empty-state a { color: var(--color-primary); }
:deep(.positive) { color: #f04747; }
:deep(.negative) { color: #4caf8a; }
</style>
```

- [ ] **Step 2: 创建 SectorFlowPanel**

```vue
<!-- apps/web/src/components/money-flow/SectorFlowPanel.vue -->
<template>
  <div class="industry-flow-panel">
    <div class="panel-controls">
      <FlowDateControl @change="onDateChange" />
    </div>

    <FlowKpiCards :cards="kpiCards" :loading="loading" />

    <div class="panel-body">
      <div class="chart-col">
        <FlowBarChart :rows="chartRows" :max-rows="30" />
      </div>
      <div class="table-col">
        <n-data-table
          :columns="columns"
          :data="rows"
          :loading="loading"
          :max-height="500"
          size="small"
          :pagination="{ pageSize: 50 }"
        />
        <div v-if="!loading && !rows.length" class="empty-state">
          暂无数据，请前往
          <router-link to="/sync">数据同步</router-link>
          页面更新资金流向数据。
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'SectorFlowPanel' })

import { computed, h, onActivated, ref } from 'vue'
import { NDataTable } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { moneyFlowApi, type MoneyFlowQueryParams, type MoneyFlowSectorRow } from '@/api/modules/moneyFlow'
import FlowDateControl from './FlowDateControl.vue'
import FlowKpiCards from './FlowKpiCards.vue'
import FlowBarChart from './FlowBarChart.vue'
import type { KpiCardItem, BarChartRow } from './money-flow.types'

const rows = ref<MoneyFlowSectorRow[]>([])
const loading = ref(false)
const currentParams = ref<MoneyFlowQueryParams>({})

const kpiCards = computed((): KpiCardItem[] => {
  const sorted = [...rows.value].sort((a, b) => Number(b.netAmount) - Number(a.netAmount))
  const top1In = sorted[0]
  const top1Out = sorted[sorted.length - 1]
  const inCount = rows.value.filter(r => Number(r.netAmount) > 0).length
  return [
    { label: '净流入最多', value: top1In?.netAmount ?? null, sub: top1In?.sector ?? '' },
    { label: '净流出最多', value: top1Out?.netAmount ?? null, sub: top1Out?.sector ?? '' },
    { label: '净流入板块数', value: String(inCount), sub: `共${rows.value.length}个板块` },
    { label: '合计净流入', value: rows.value.reduce((s, r) => s + (Number(r.netAmount) || 0), 0).toFixed(0), sub: '万元' },
  ]
})

const chartRows = computed((): BarChartRow[] =>
  rows.value.map(r => ({ label: r.sector, value: Number(r.netAmount) || 0 })),
)

const columns: DataTableColumns<MoneyFlowSectorRow> = [
  { title: '板块', key: 'sector', width: 120 },
  { title: '涨跌幅%', key: 'pctChange', width: 90, sorter: (a, b) => Number(a.pctChange) - Number(b.pctChange), render: row => { const v = Number(row.pctChange); return h('span', { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' }, `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`) } },
  { title: '净流入(万)', key: 'netAmount', width: 110, defaultSortOrder: 'descend', sorter: (a, b) => Number(a.netAmount) - Number(b.netAmount), render: row => { const v = Number(row.netAmount); return h('span', { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' }, v.toFixed(2)) } },
  { title: '大单净额(万)', key: 'buyLgAmount', width: 115, sorter: (a, b) => Number(a.buyLgAmount) - Number(b.buyLgAmount), render: row => { const v = Number(row.buyLgAmount); return h('span', { class: v > 0 ? 'positive' : 'negative' }, v.toFixed(2)) } },
  { title: '中单净额(万)', key: 'buyMdAmount', width: 115, render: row => { const v = Number(row.buyMdAmount); return h('span', { class: v > 0 ? 'positive' : 'negative' }, v.toFixed(2)) } },
  { title: '小单净额(万)', key: 'buySmAmount', width: 115, render: row => { const v = Number(row.buySmAmount); return h('span', { class: v > 0 ? 'positive' : 'negative' }, v.toFixed(2)) } },
]

async function load() {
  if (!currentParams.value.trade_date && !currentParams.value.start_date) return
  loading.value = true
  try {
    rows.value = await moneyFlowApi.querySectors(currentParams.value)
  } catch {
    rows.value = []
  } finally {
    loading.value = false
  }
}

function onDateChange(params: MoneyFlowQueryParams) {
  currentParams.value = params
  load()
}

onActivated(load)
</script>

<style scoped>
.industry-flow-panel { display: flex; flex-direction: column; gap: 16px; }
.panel-controls { display: flex; align-items: center; gap: 16px; }
.panel-body { display: grid; grid-template-columns: 1fr 1.5fr; gap: 20px; }
.chart-col, .table-col { min-width: 0; }
.empty-state { color: var(--color-text-muted); text-align: center; padding: 40px; }
.empty-state a { color: var(--color-primary); }
:deep(.positive) { color: #f04747; }
:deep(.negative) { color: #4caf8a; }
</style>
```

- [ ] **Step 3: 创建 MarketFlowPanel**

```vue
<!-- apps/web/src/components/money-flow/MarketFlowPanel.vue -->
<template>
  <div class="market-flow-panel">
    <div class="panel-controls">
      <FlowDateControl @change="onDateChange" />
    </div>

    <FlowKpiCards :cards="kpiCards" :loading="loading" />

    <div class="chart-area">
      <FlowBarChart :rows="chartRows" />
    </div>

    <div v-if="!loading && !rows.length" class="empty-state">
      暂无数据，请前往
      <router-link to="/sync">数据同步</router-link>
      页面更新资金流向数据。
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'MarketFlowPanel' })

import { computed, onActivated, ref } from 'vue'
import { moneyFlowApi, type MoneyFlowQueryParams, type MoneyFlowMarketRow } from '@/api/modules/moneyFlow'
import FlowDateControl from './FlowDateControl.vue'
import FlowKpiCards from './FlowKpiCards.vue'
import FlowBarChart from './FlowBarChart.vue'
import type { KpiCardItem, BarChartRow } from './money-flow.types'

const rows = ref<MoneyFlowMarketRow[]>([])
const loading = ref(false)
const currentParams = ref<MoneyFlowQueryParams>({})

const latestRow = computed(() => rows.value[rows.value.length - 1] ?? null)

const kpiCards = computed((): KpiCardItem[] => [
  { label: '大盘净流入', value: latestRow.value?.netAmount ?? null, sub: latestRow.value?.tradeDate ?? '' },
  { label: '主力净流入', value: latestRow.value?.buyLgAmount ?? null, sub: '大单' },
  { label: '散户净流入', value: latestRow.value?.buySmAmount ?? null, sub: '小单' },
  { label: '沪深港通', value: latestRow.value?.hkNetAmount ?? null, sub: '北向资金' },
])

const chartRows = computed((): BarChartRow[] =>
  rows.value.map(r => ({ label: r.tradeDate, value: Number(r.netAmount) || 0 })),
)

async function load() {
  if (!currentParams.value.trade_date && !currentParams.value.start_date) return
  loading.value = true
  try {
    rows.value = await moneyFlowApi.queryMarket(currentParams.value)
  } catch {
    rows.value = []
  } finally {
    loading.value = false
  }
}

function onDateChange(params: MoneyFlowQueryParams) {
  currentParams.value = params
  load()
}

onActivated(load)
</script>

<style scoped>
.market-flow-panel { display: flex; flex-direction: column; gap: 16px; }
.panel-controls { display: flex; align-items: center; gap: 16px; }
.chart-area { min-height: 200px; }
.empty-state { color: var(--color-text-muted); text-align: center; padding: 40px; }
.empty-state a { color: var(--color-primary); }
</style>
```

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/money-flow/IndustryFlowPanel.vue apps/web/src/components/money-flow/SectorFlowPanel.vue apps/web/src/components/money-flow/MarketFlowPanel.vue
git commit -m "feat(money-flow): add IndustryFlowPanel, SectorFlowPanel, MarketFlowPanel"
```

---

## Task 9：页面壳、路由、导航栏

**Files:**
- Create: `apps/web/src/views/MoneyFlowView.vue`
- Modify: `apps/web/src/router/index.ts`
- Modify: `apps/web/src/components/layout/Sidebar.vue`

- [ ] **Step 1: 创建 MoneyFlowView**

```vue
<!-- apps/web/src/views/MoneyFlowView.vue -->
<template>
  <div class="money-flow-view workspace-page">
    <div class="workspace-page-header money-flow-header">
      <div>
        <h1 class="workspace-page-title">Money Flow</h1>
        <p class="page-subtitle">A 股资金动向监测</p>
      </div>
      <div class="flow-tabs" role="tablist" aria-label="资金维度">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.key"
          class="flow-tabs__tab"
          :class="{ 'flow-tabs__tab--active': activeTab === tab.key }"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
      </div>
    </div>

    <keep-alive>
      <MarketFlowPanel v-if="activeTab === 'market'" />
      <IndustryFlowPanel v-else-if="activeTab === 'industry'" />
      <SectorFlowPanel v-else-if="activeTab === 'sector'" />
      <StockFlowPanel v-else />
    </keep-alive>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'MoneyFlowView' })

import { ref } from 'vue'
import MarketFlowPanel from '../components/money-flow/MarketFlowPanel.vue'
import IndustryFlowPanel from '../components/money-flow/IndustryFlowPanel.vue'
import SectorFlowPanel from '../components/money-flow/SectorFlowPanel.vue'
import StockFlowPanel from '../components/money-flow/StockFlowPanel.vue'

type TabKey = 'market' | 'industry' | 'sector' | 'stock'

const tabs: { key: TabKey; label: string }[] = [
  { key: 'market', label: '大盘' },
  { key: 'industry', label: '行业' },
  { key: 'sector', label: '板块' },
  { key: 'stock', label: '个股' },
]

const activeTab = ref<TabKey>('market')
</script>

<style scoped>
.money-flow-view { max-width: 1600px; }
.money-flow-header { align-items: center; }
.page-subtitle { margin: 6px 0 0; color: var(--color-text-secondary); }

.flow-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 0 2px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
}

.flow-tabs__tab {
  position: relative;
  margin: 0;
  padding: 10px 16px 12px;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: color 0.2s ease;
}

.flow-tabs__tab:hover { color: var(--color-text); }

.flow-tabs__tab--active { color: var(--color-text); }

.flow-tabs__tab--active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  background: var(--color-primary);
  border-radius: 2px 2px 0 0;
}

.flow-tabs__tab:not(.flow-tabs__tab--active)::after {
  opacity: 0;
}
</style>
```

- [ ] **Step 2: 注册路由**

在 `apps/web/src/router/index.ts` 的 `routes` 数组中，在 `symbols` 路由之后插入：

```typescript
{
  path: '/money-flow',
  name: 'money-flow',
  component: () => import('../views/MoneyFlowView.vue'),
  meta: { title: '资金流向' },
},
```

- [ ] **Step 3: 添加侧边栏菜单项**

在 `apps/web/src/components/layout/Sidebar.vue` 中：

1. 在 import 的 icon 列表中添加 `SwapHorizontalOutline`：
```typescript
import {
  ChevronBack, ChevronForward,
  TrendingUpOutline, ListOutline, SyncOutline, BookmarkOutline, SettingsOutline, CalculatorOutline,
  LogOutOutline, PersonCircleOutline, AnalyticsOutline, SwapHorizontalOutline,
} from '@vicons/ionicons5'
```

2. 在 `menuOptions` 的 `symbols` 项之后插入：
```typescript
{ label: '资金流向', key: 'money-flow', icon: renderIcon(SwapHorizontalOutline) },
```

- [ ] **Step 4: 读取文件头部验证 import 顺序正确**

```bash
# 读取 Sidebar.vue 前 70 行，确认 import 块正确
```

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/views/MoneyFlowView.vue apps/web/src/router/index.ts apps/web/src/components/layout/Sidebar.vue
git commit -m "feat(money-flow): add MoneyFlowView, route /money-flow and sidebar menu item"
```

---

## Task 10：数据同步页集成

**Files:**
- Modify: `apps/web/src/views/sync/SyncView.vue`

- [ ] **Step 1: 在 SyncView 中添加资金流向同步卡片**

在 `SyncView.vue` 现有 `data-source-grid` div 的末尾（`</div>` 闭合之前）追加一个新的 `data-source-card`：

```vue
<section class="data-source-card data-source-card--moneyflow">
  <div class="data-source-header">
    <div class="data-source-icon">
      <n-icon><swap-horizontal-outline /></n-icon>
    </div>
    <div class="data-source-heading">
      <span class="data-source-eyebrow">Money Flow</span>
      <h3 class="data-source-title">资金流向数据</h3>
      <p class="data-source-desc">同花顺/东方财富资金流向，按日期范围同步个股、行业、板块、大盘四个维度。</p>
    </div>
  </div>

  <div class="data-source-body">
    <n-form-item label="同步日期范围">
      <n-date-picker
        v-model:value="moneyFlowDateRange"
        type="daterange"
        format="yyyyMMdd"
        style="width: 100%"
      />
    </n-form-item>
    <div v-if="moneyFlowSyncResult" class="source-note">
      上次结果：个股 {{ moneyFlowSyncResult.stocks.success }} 条 / 行业 {{ moneyFlowSyncResult.industries.success }} 条 / 板块 {{ moneyFlowSyncResult.sectors.success }} 条 / 大盘 {{ moneyFlowSyncResult.market.success }} 条
    </div>
  </div>

  <div class="data-source-actions data-source-actions--single">
    <n-button
      block
      secondary
      type="primary"
      :loading="moneyFlowSyncing"
      @click="syncMoneyFlow"
    >
      <template #icon><n-icon><swap-horizontal-outline /></n-icon></template>
      同步资金流向
    </n-button>
  </div>
</section>
```

- [ ] **Step 2: 在 `<script setup>` 中添加 import 和逻辑**

在 SyncView 的 script setup 中追加：

```typescript
import { SwapHorizontalOutline } from '@vicons/ionicons5'
import { moneyFlowApi, type MoneyFlowSyncResult } from '@/api/modules/moneyFlow'

// 资金流向同步
const moneyFlowDateRange = ref<[number, number] | null>(null)
const moneyFlowSyncing = ref(false)
const moneyFlowSyncResult = ref<{
  stocks: MoneyFlowSyncResult
  industries: MoneyFlowSyncResult
  sectors: MoneyFlowSyncResult
  market: MoneyFlowSyncResult
} | null>(null)

async function syncMoneyFlow() {
  if (!moneyFlowDateRange.value) {
    window.$message?.warning('请选择同步日期范围')
    return
  }
  const [startTs, endTs] = moneyFlowDateRange.value
  function toYYYYMMDD(ts: number) {
    const d = new Date(ts)
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  }
  const params = { start_date: toYYYYMMDD(startTs), end_date: toYYYYMMDD(endTs) }

  moneyFlowSyncing.value = true
  try {
    const [stocks, industries, sectors, market] = await Promise.all([
      moneyFlowApi.syncStocks(params),
      moneyFlowApi.syncIndustries(params),
      moneyFlowApi.syncSectors(params),
      moneyFlowApi.syncMarket(params),
    ])
    moneyFlowSyncResult.value = { stocks, industries, sectors, market }
    window.$message?.success(`同步完成：个股 ${stocks.success} 条`)
  } catch (e: unknown) {
    window.$message?.error(e instanceof Error ? e.message : '同步失败')
  } finally {
    moneyFlowSyncing.value = false
  }
}
```

- [ ] **Step 3: 读取 SyncView.vue 前 10 行验证 import 无重复**

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/views/sync/SyncView.vue
git commit -m "feat(money-flow): add sync entry in SyncView for admins"
```

---

## Task 11：Lint 检查与端到端验证

- [ ] **Step 1: 前端 lint**

```bash
cd apps/web
pnpm run type-check
```

预期：无 TypeScript 类型错误。

- [ ] **Step 2: 后端编译**

```bash
cd apps/server
pnpm run build
```

预期：编译成功，无错误。

- [ ] **Step 3: 功能验证（手动）**

1. 启动后端 `pnpm run start:dev`
2. 启动前端 `pnpm run dev`
3. 访问 `/money-flow`，确认四个 Tab 可切换
4. 日期控制栏单日/区间切换正常
5. 以管理员身份访问 `/sync`，确认资金流向同步卡片存在
6. 选日期范围，点「同步资金流向」，确认返回结果（即使数据为空也应有 warn 日志）
7. 同步成功后回到 `/money-flow` 查看数据

- [ ] **Step 4: 最终提交**

```bash
git add -A
git commit -m "feat(money-flow): complete money-flow feature implementation"
```
