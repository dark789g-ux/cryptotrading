# 每日复盘（Daily Review）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 cryptotrading 主项目接入「每日复盘」功能：admin 触发 → 后端聚合当日 A 股数据 → DeepSeek 思考模式生成 Markdown 复盘文章 → 前端列表/详情/SSE 进度展示。

**Architecture:** NestJS `daily-review` 模块负责编排 5 阶段（validate → fetch → build → LLM → finalize），数据/文章存 PG 的 `daily_review` 表（jsonb + text），进度走内存 SSE。前端 Vue 3 + Naive UI 新增侧边栏导航、列表页、详情页与 ECharts 图表。

**Tech Stack:** NestJS 10 + TypeORM + PostgreSQL；OpenAI SDK 指向 `https://api.deepseek.com`；Vue 3 + Naive UI + ECharts；SSE (`@nestjs/common` `MessageEvent`)。

**Spec:** [docs/superpowers/specs/2026-05-12-daily-review-design.md](../specs/2026-05-12-daily-review-design.md)

---

## 文件结构总览

### 后端

```
apps/server/src/
  entities/daily-review/
    daily-review.entity.ts              新建：实体（§4.1）
  migration/
    2026-05-12-daily-review.sql         新建：建表迁移
  daily-review/
    daily-review.module.ts              新建：模块装配
    daily-review.controller.ts          新建：REST + SSE
    daily-review.service.ts             新建：5 阶段编排
    snapshot-builder.service.ts         新建：DB 聚合 + Tushare index_daily
    deepseek.service.ts                 新建：LLM 流式调用
    daily-review-progress.gateway.ts    新建：内存 SSE Subject 中转
    prompts/article-prompt.ts           新建：system + user 模板常量
    dto/
      create-review.dto.ts              新建
      list-query.dto.ts                 新建
    daily-review.types.ts               新建：SnapshotPayload / ProgressEvent
  app.module.ts                         修改：注册 DailyReviewModule
```

### 前端

```
apps/web/src/
  router/index.ts                       修改：新增 2 条路由
  components/layout/Sidebar.vue         修改：菜单项 + activeKey 前缀匹配
  views/
    DailyReviewView.vue                 新建：列表页
    DailyReviewDetailView.vue           新建：详情页
  components/daily-review/
    ReviewCreateButton.vue              新建
    ReviewListTable.vue                 新建
    ReviewProgressBar.vue               新建
    ReviewSnapshotCards.vue             新建
    ReviewIndustryChart.vue             新建
    ReviewMoneyFlowChart.vue            新建
    ReviewArticleViewer.vue             新建
  composables/
    useDailyReviewApi.ts                新建
    useDailyReviewProgress.ts           新建
  types/daily-review.ts                 新建：与后端共享的 DTO 类型
```

---

## PR-0：先期调研（不写代码，输出调研结论）

**目的：** 把 spec §7 的三处数据缺口落实为可执行的代码方案，避免 PR-2 写一半才发现 SQL 走不通。**全部以输出 `docs/superpowers/notes/2026-05-12-daily-review-investigation.md` 为交付物**。

### Task 0.1：核对 a_share_daily_quotes 表结构

**Files:**
- Read: `apps/server/src/entities/a-share/a-share-daily-quote.entity.ts`

- [ ] **Step 1：读实体，确认列**

预期：表名 `a_share_daily_quotes`，列含 `ts_code`、`trade_date`、`pct_chg`、`amount`、`vol`、`close`，**无** `limit_status`。numeric 列以 string 返回。

- [ ] **Step 2：在调研笔记记录**

写入 `docs/superpowers/notes/2026-05-12-daily-review-investigation.md`：

```markdown
## a_share_daily_quotes
- 表名：a_share_daily_quotes（注意复数）
- 涨跌停字段：**不存在 limit_status 列**
- 替代方案：用 pct_chg 近似
  - 主板 (ts_code 6 开头 或 0 开头)：pct_chg >= 9.9 视为涨停，<= -9.9 视为跌停
  - 创业板 (300 开头) / 科创板 (688 开头)：pct_chg >= 19.9 / <= -19.9
- numeric 列在原生 SQL 中需 ::numeric 强转，TypeORM 取出来是 string
```

### Task 0.2：调研 money_flow 系列表的字段口径

**Files:**
- Read: `apps/server/src/entities/money-flow/money-flow-market.entity.ts`
- Read: `apps/server/src/entities/money-flow/money-flow-industry.entity.ts`
- Read: `apps/server/src/entities/money-flow/money-flow-sector.entity.ts`
- Read: `apps/server/src/entities/money-flow/money-flow-stock.entity.ts`

- [ ] **Step 1：逐个读实体，记录主键 + 金额字段 + 单位**

把每张表的关键字段名、金额单位（万元/元）、是否每日全量同步写入调研笔记 `## money_flow_*` 章节。

- [ ] **Step 2：记录可用聚合方式**

例：`money_flow_industry` 是否按 (industry_code, trade_date) 唯一？取行业 TOP10 的 ORDER BY 字段是 `pct_change` 还是 `net_amount`？写明确。

### Task 0.3：查 Tushare index_daily 接口文档

**前置：必须先调用 `tushare-sync-dev` skill 查文档**（CLAUDE.md 第三方 API 集成规范）。

- [ ] **Step 1：跑文档脚本**

```powershell
python "c:\codes\cryptotrading\.claude\skills\tushare-sync-dev\fetch_tushare_doc.py" index_daily
```

- [ ] **Step 2：在调研笔记记录**

```markdown
## Tushare index_daily
- 接口名（确认与文档完全一致）：
- 入参：ts_code / trade_date / start_date / end_date / 必填项
- 返回字段：ts_code / trade_date / close / open / high / low / pre_close / change / pct_chg / vol / amount
- 金额单位（万元/元/亿元）：
- 积分门槛：
- 单次返回上限：
- 当日数据更新时间：
- 4 个 ts_code 对照：上证 000001.SH / 深证 399001.SZ / 创业板 399006.SZ / 科创50 000688.SH
```

### Task 0.4：查 Tushare 凭证与现有调用封装

**Files:**
- Read: `apps/server/src/market-data/a-shares/sync/a-shares-sync-utils.ts`

- [ ] **Step 1：grep tushare token 与 HTTP 客户端**

```powershell
# 在仓库根执行
```

```
grep -rE "tushare|TUSHARE_TOKEN|pro_api" apps/server/src --include="*.ts" -l
```

- [ ] **Step 2：在笔记记录复用方式**

记录现有 Tushare 调用是 axios/openapi/自封装、token env 变量名、限速封装是否可复用。如果有 `TushareClient` 一类的服务，PR-2 优先注入它而不是新写。

### Task 0.5：重读 DeepSeek skill 文档

**前置：必须先调用 `deepseek-api` skill 重读文档**。

- [ ] **Step 1：读 SKILL.md 与详尽文档**

```powershell
# 列出 deepseek-api skill 文件
```

```
ls c:\codes\cryptotrading\.claude\skills\deepseek-api
```

读取 `thinking_mode.md` 与 `multi_round_chat.md`。

- [ ] **Step 2：把关键参数固化到笔记**

```markdown
## DeepSeek 思考模式（PR-3 编码前最后一次确认）
- 模型名（thinking_mode.md 明示）：
- base_url：https://api.deepseek.com
- extra_body 参数结构：{ thinking: { type: 'enabled' }, reasoning_effort: 'high' }
- 流式 chunk 字段：delta.content / delta.reasoning_content
- 单轮无 tools，reasoning_content 不需要回传后续请求
- 禁用参数：temperature / top_p / presence_penalty / frequency_penalty
- 超时建议：240s
```

### Task 0.6：提交调研笔记

- [ ] **Step 1：commit**

```
git add docs/superpowers/notes/2026-05-12-daily-review-investigation.md
git commit -m "docs(daily-review): 完成 PR-0 数据/接口调研"
```

---

## PR-1：实体 + migration + 模块骨架

### Task 1.1：新建实体

**Files:**
- Create: `apps/server/src/entities/daily-review/daily-review.entity.ts`

- [ ] **Step 1：写实体**

```ts
import {
  Column, CreateDateColumn, Entity, Index,
  PrimaryGeneratedColumn, Unique, UpdateDateColumn,
} from 'typeorm';

export type DailyReviewStatus = 'pending' | 'fetching' | 'generating' | 'completed' | 'failed';

@Entity('daily_review')
@Unique(['tradeDate'])
export class DailyReviewEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'trade_date', type: 'varchar', length: 8 })
  tradeDate: string;

  @Index()
  @Column({ type: 'varchar', length: 16 })
  status: DailyReviewStatus;

  @Column({ type: 'jsonb', nullable: true })
  snapshot: unknown | null;

  @Column({ name: 'article_md', type: 'text', nullable: true })
  articleMd: string | null;

  @Column({ name: 'reasoning_content', type: 'text', nullable: true })
  reasoningContent: string | null;

  @Column({ name: 'llm_model', type: 'varchar', length: 64, nullable: true })
  llmModel: string | null;

  @Column({ name: 'token_usage', type: 'jsonb', nullable: true })
  tokenUsage: { prompt: number; completion: number; reasoning: number; total: number } | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ name: 'created_by_id', type: 'uuid' })
  createdById: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
```

- [ ] **Step 2：commit**

```
git add apps/server/src/entities/daily-review/daily-review.entity.ts
git commit -m "feat(daily-review): 新增 DailyReview 实体"
```

### Task 1.2：写 migration SQL

**Files:**
- Create: `apps/server/src/migration/2026-05-12-daily-review.sql`

- [ ] **Step 1：写迁移 SQL**

```sql
CREATE TABLE IF NOT EXISTS daily_review (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_date         VARCHAR(8)  NOT NULL,
  status             VARCHAR(16) NOT NULL,
  snapshot           JSONB,
  article_md         TEXT,
  reasoning_content  TEXT,
  llm_model          VARCHAR(64),
  token_usage        JSONB,
  error_message      TEXT,
  created_by_id      UUID         NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_review_trade_date ON daily_review(trade_date);
CREATE INDEX IF NOT EXISTS idx_daily_review_status ON daily_review(status);
CREATE INDEX IF NOT EXISTS idx_daily_review_created_at ON daily_review(created_at DESC);
```

- [ ] **Step 2：执行并验证**

```
docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -f - < apps/server/src/migration/2026-05-12-daily-review.sql
```

```
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d daily_review"
```

预期：列与索引与上一步定义一致。

- [ ] **Step 3：commit**

```
git add apps/server/src/migration/2026-05-12-daily-review.sql
git commit -m "feat(daily-review): 新增 daily_review 建表 migration"
```

### Task 1.3：定义共享类型

**Files:**
- Create: `apps/server/src/daily-review/daily-review.types.ts`

- [ ] **Step 1：写类型**

```ts
export type IndexQuote = { tsCode: string; name: string; close: number; pctChg: number; amount: number };
export type LimitStats = { upCount: number; downCount: number; brokenCount: number };
export type UpdownDist = { up: number; down: number; flat: number; limitUp: number; limitDown: number };
export type SectorRow  = { name: string; pctChg: number; leader: string };
export type StockRow   = { tsCode: string; name: string; mainNetIn?: number; pctChg?: number; turnoverRate?: number; amount?: number };

export interface SnapshotPayload {
  indices: IndexQuote[];
  limitStats: LimitStats;
  updownDist: UpdownDist;
  industryRank: SectorRow[];
  conceptRank: SectorRow[];
  moneyFlow: {
    market: { mainNetIn: number };
    stocksTopIn: StockRow[];
    stocksTopOut: StockRow[];
  };
  strongStocks: StockRow[];
  volumeTop: StockRow[];
  generatedAt: string;
}

export type ProgressStage =
  | 'validate' | 'fetch' | 'build' | 'reasoning' | 'writing' | 'finalize'
  | 'completed' | 'failed';

export type ProgressEvent =
  | { stage: 'validate' | 'fetch' | 'build' | 'reasoning' | 'writing' | 'finalize'; percent: number; message?: string }
  | { stage: 'completed'; percent: 100 }
  | { stage: 'failed'; percent: number; error: string };
```

- [ ] **Step 2：commit**

```
git add apps/server/src/daily-review/daily-review.types.ts
git commit -m "feat(daily-review): 新增 SnapshotPayload / ProgressEvent 共享类型"
```

### Task 1.4：定义 DTO

**Files:**
- Create: `apps/server/src/daily-review/dto/create-review.dto.ts`
- Create: `apps/server/src/daily-review/dto/list-query.dto.ts`

- [ ] **Step 1：写 CreateReviewDto**

```ts
import { IsOptional, IsString, Matches } from 'class-validator';

export class CreateReviewDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{8}$/, { message: 'tradeDate 必须是 YYYYMMDD' })
  tradeDate?: string;
}
```

- [ ] **Step 2：写 ListQueryDto**

```ts
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { DailyReviewStatus } from '../../entities/daily-review/daily-review.entity';

export class ListQueryDto {
  @IsOptional()
  @IsEnum(['pending', 'fetching', 'generating', 'completed', 'failed'])
  status?: DailyReviewStatus;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  pageSize?: number = 20;
}
```

- [ ] **Step 3：commit**

```
git add apps/server/src/daily-review/dto
git commit -m "feat(daily-review): 新增 CreateReviewDto 与 ListQueryDto"
```

### Task 1.5：模块骨架（controller / service 占位 + 注册到 app）

**Files:**
- Create: `apps/server/src/daily-review/daily-review.controller.ts`
- Create: `apps/server/src/daily-review/daily-review.service.ts`
- Create: `apps/server/src/daily-review/daily-review.module.ts`
- Modify: `apps/server/src/app.module.ts`

- [ ] **Step 1：写 service 占位**

```ts
import { Injectable } from '@nestjs/common';

@Injectable()
export class DailyReviewService {
  async list() { return { items: [], total: 0 }; }
  async getDetail(_tradeDate: string) { return null; }
}
```

- [ ] **Step 2：写 controller 占位（仅 GET 列表）**

```ts
import { Controller, Get, Param, Query } from '@nestjs/common';
import { DailyReviewService } from './daily-review.service';
import { ListQueryDto } from './dto/list-query.dto';

@Controller('api/daily-review')
export class DailyReviewController {
  constructor(private readonly svc: DailyReviewService) {}

  @Get()
  list(@Query() q: ListQueryDto) {
    return this.svc.list();
  }

  @Get(':tradeDate')
  detail(@Param('tradeDate') tradeDate: string) {
    return this.svc.getDetail(tradeDate);
  }
}
```

- [ ] **Step 3：写 module**

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DailyReviewEntity } from '../entities/daily-review/daily-review.entity';
import { DailyReviewController } from './daily-review.controller';
import { DailyReviewService } from './daily-review.service';

@Module({
  imports: [TypeOrmModule.forFeature([DailyReviewEntity])],
  controllers: [DailyReviewController],
  providers: [DailyReviewService],
})
export class DailyReviewModule {}
```

- [ ] **Step 4：在 app.module.ts 注册**

打开 `apps/server/src/app.module.ts`，在 `imports: []` 数组里加入 `DailyReviewModule`。

- [ ] **Step 5：构建验证**

```
pnpm --filter @cryptotrading/server build
```

预期：通过，无 TS 错误。

- [ ] **Step 6：commit**

```
git add apps/server/src/daily-review apps/server/src/app.module.ts
git commit -m "feat(daily-review): 接入模块骨架（controller/service/module + app 注册）"
```

### Task 1.6：列表/详情真正读 DB

**Files:**
- Modify: `apps/server/src/daily-review/daily-review.service.ts`

- [ ] **Step 1：注入 repo 并实现 list/getDetail**

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DailyReviewEntity } from '../entities/daily-review/daily-review.entity';
import { ListQueryDto } from './dto/list-query.dto';

@Injectable()
export class DailyReviewService {
  constructor(
    @InjectRepository(DailyReviewEntity)
    private readonly repo: Repository<DailyReviewEntity>,
  ) {}

  async list(q: ListQueryDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const qb = this.repo.createQueryBuilder('r')
      .orderBy('r.tradeDate', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);
    if (q.status) qb.andWhere('r.status = :s', { s: q.status });
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  async getDetail(tradeDate: string) {
    const row = await this.repo.findOne({ where: { tradeDate } });
    if (!row) throw new NotFoundException(`复盘 ${tradeDate} 不存在`);
    return row;
  }
}
```

- [ ] **Step 2：修 controller 把 q 传进去**

```ts
@Get()
list(@Query() q: ListQueryDto) {
  return this.svc.list(q);
}
```

- [ ] **Step 3：手动验证**

```
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "INSERT INTO daily_review (trade_date, status, created_by_id) VALUES ('20260512', 'completed', gen_random_uuid())"
```

启动 server，curl `/api/daily-review`，预期返回 `{ items: [{ tradeDate: '20260512', ... }], total: 1, page: 1, pageSize: 20 }`。

清理：

```
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "DELETE FROM daily_review WHERE trade_date='20260512'"
```

- [ ] **Step 4：commit**

```
git add apps/server/src/daily-review
git commit -m "feat(daily-review): list/detail 接入 repo"
```

---

## PR-2：snapshot-builder（DB 聚合 + Tushare 指数日线）

### Task 2.1：写 snapshot-builder 骨架与 validate

**Files:**
- Create: `apps/server/src/daily-review/snapshot-builder.service.ts`
- Test: `apps/server/src/daily-review/snapshot-builder.service.spec.ts`

- [ ] **Step 1：写失败的测试 — 缺数据返回 422 信号**

```ts
import { Test } from '@nestjs/testing';
import { SnapshotBuilderService } from './snapshot-builder.service';
import { DataSource } from 'typeorm';

describe('SnapshotBuilderService.validate', () => {
  let svc: SnapshotBuilderService;
  let mockDs: Partial<DataSource>;

  beforeEach(async () => {
    mockDs = { query: jest.fn().mockResolvedValue([{ count: '0' }]) };
    const mod = await Test.createTestingModule({
      providers: [
        SnapshotBuilderService,
        { provide: DataSource, useValue: mockDs },
      ],
    }).compile();
    svc = mod.get(SnapshotBuilderService);
  });

  it('a 股日线无数据时抛错', async () => {
    await expect(svc.validate('20260512')).rejects.toThrow(/A股日线/);
  });
});
```

- [ ] **Step 2：跑测试确认失败**

```
pnpm --filter @cryptotrading/server test snapshot-builder
```

预期：FAIL（service 未实现）。

- [ ] **Step 3：实现 validate**

```ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class SnapshotBuilderService {
  constructor(private readonly ds: DataSource) {}

  async validate(tradeDate: string) {
    const [{ count }] = await this.ds.query(
      'SELECT COUNT(*)::int AS count FROM a_share_daily_quotes WHERE trade_date = $1',
      [tradeDate],
    );
    if (count === 0) {
      throw new UnprocessableEntityException(
        `${tradeDate} 的 A 股日线数据尚未同步，请先到「数据同步」补齐`,
      );
    }
  }
}
```

- [ ] **Step 4：跑测试确认通过**

```
pnpm --filter @cryptotrading/server test snapshot-builder
```

预期：PASS。

- [ ] **Step 5：commit**

```
git add apps/server/src/daily-review/snapshot-builder.service.ts apps/server/src/daily-review/snapshot-builder.service.spec.ts
git commit -m "feat(daily-review): snapshot-builder.validate"
```

### Task 2.2：聚合涨跌停 / 涨跌分布

**Files:**
- Modify: `apps/server/src/daily-review/snapshot-builder.service.ts`
- Modify: `apps/server/src/daily-review/snapshot-builder.service.spec.ts`

- [ ] **Step 1：写测试**

```ts
it('aggregateUpdown 按板块阈值正确计算涨停/跌停/上涨/下跌', async () => {
  (mockDs.query as jest.Mock).mockResolvedValueOnce([
    { up: '3000', down: '1500', flat: '200', limit_up: '80', limit_down: '5' },
  ]);
  const r = await svc.aggregateUpdown('20260512');
  expect(r).toEqual({ updownDist: { up: 3000, down: 1500, flat: 200, limitUp: 80, limitDown: 5 }, limitStats: { upCount: 80, downCount: 5, brokenCount: 0 } });
});
```

- [ ] **Step 2：跑测试确认失败**

- [ ] **Step 3：实现 aggregateUpdown**

```ts
async aggregateUpdown(tradeDate: string) {
  // pct_chg 是 numeric/string，需 ::numeric；板块判断：
  //   创业板/科创板 (ts_code 以 300/688 开头) → 阈值 ±19.9
  //   主板 → 阈值 ±9.9
  const [row] = await this.ds.query(
    `SELECT
       SUM(CASE WHEN pct_chg::numeric  >  0 THEN 1 ELSE 0 END) AS up,
       SUM(CASE WHEN pct_chg::numeric  <  0 THEN 1 ELSE 0 END) AS down,
       SUM(CASE WHEN pct_chg::numeric  =  0 THEN 1 ELSE 0 END) AS flat,
       SUM(CASE
         WHEN (ts_code LIKE '300%' OR ts_code LIKE '688%') AND pct_chg::numeric >= 19.9 THEN 1
         WHEN ts_code NOT LIKE '300%' AND ts_code NOT LIKE '688%' AND pct_chg::numeric >= 9.9 THEN 1
         ELSE 0 END) AS limit_up,
       SUM(CASE
         WHEN (ts_code LIKE '300%' OR ts_code LIKE '688%') AND pct_chg::numeric <= -19.9 THEN 1
         WHEN ts_code NOT LIKE '300%' AND ts_code NOT LIKE '688%' AND pct_chg::numeric <= -9.9 THEN 1
         ELSE 0 END) AS limit_down
     FROM a_share_daily_quotes
     WHERE trade_date = $1`,
    [tradeDate],
  );
  return {
    updownDist: {
      up: +row.up, down: +row.down, flat: +row.flat,
      limitUp: +row.limit_up, limitDown: +row.limit_down,
    },
    limitStats: { upCount: +row.limit_up, downCount: +row.limit_down, brokenCount: 0 },
  };
}
```

`brokenCount: 0`：当前无炸板字段，先填 0，prompt 中说明此为近似值。

- [ ] **Step 4：跑测试确认通过**

- [ ] **Step 5：commit**

```
git commit -am "feat(daily-review): snapshot-builder.aggregateUpdown"
```

### Task 2.3：聚合行业 / 概念 TOP10

> 实际字段名以 **PR-0 Task 0.2 笔记**为准；下面占位字段需替换。

**Files:**
- Modify: `apps/server/src/daily-review/snapshot-builder.service.ts`
- Modify: `apps/server/src/daily-review/snapshot-builder.service.spec.ts`

- [ ] **Step 1：写测试**

```ts
it('aggregateSectors 行业取 pct_chg 降序前 10', async () => {
  (mockDs.query as jest.Mock).mockResolvedValueOnce([
    { name: '半导体', pct_chg: '6.59', leader: '寒武纪' },
    { name: '光通信', pct_chg: '5.21', leader: '中际旭创' },
  ]);
  (mockDs.query as jest.Mock).mockResolvedValueOnce([]);
  const r = await svc.aggregateSectors('20260512');
  expect(r.industryRank[0]).toEqual({ name: '半导体', pctChg: 6.59, leader: '寒武纪' });
});
```

- [ ] **Step 2：跑测试确认失败**

- [ ] **Step 3：实现 aggregateSectors（按 PR-0 笔记填实际列名）**

```ts
async aggregateSectors(tradeDate: string) {
  // 字段名以 PR-0 Task 0.2 笔记为准
  const industry = await this.ds.query(
    `SELECT name, pct_change::numeric AS pct_chg, leader_name AS leader
       FROM money_flow_industry WHERE trade_date = $1
       ORDER BY pct_change::numeric DESC LIMIT 10`,
    [tradeDate],
  );
  const concept = await this.ds.query(
    `SELECT name, pct_change::numeric AS pct_chg, leader_name AS leader
       FROM money_flow_sector WHERE trade_date = $1
       ORDER BY pct_change::numeric DESC LIMIT 10`,
    [tradeDate],
  );
  const map = (r: any) => ({ name: r.name, pctChg: +r.pct_chg, leader: r.leader ?? '' });
  return { industryRank: industry.map(map), conceptRank: concept.map(map) };
}
```

- [ ] **Step 4：跑测试 + commit**

```
pnpm --filter @cryptotrading/server test snapshot-builder
git commit -am "feat(daily-review): snapshot-builder.aggregateSectors"
```

### Task 2.4：聚合资金流向（市场 + 个股 TOP/BOTTOM 20）

**Files:** 同上

- [ ] **Step 1：写测试（个股 TOP/BOTTOM 各 1 条断言）**

```ts
it('aggregateMoneyFlow 返回市场净流入 + 个股 TOP/BOTTOM 20', async () => {
  (mockDs.query as jest.Mock)
    .mockResolvedValueOnce([{ main_net_in: '12345600' }])       // market
    .mockResolvedValueOnce([{ ts_code: '688256.SH', name: '寒武纪', main_net_in: '4000000000' }]) // top in
    .mockResolvedValueOnce([{ ts_code: '601318.SH', name: '中国平安', main_net_in: '-2500000000' }]); // top out
  const r = await svc.aggregateMoneyFlow('20260512');
  expect(r.market.mainNetIn).toBe(12345600);
  expect(r.stocksTopIn[0].mainNetIn).toBe(4000000000);
  expect(r.stocksTopOut[0].mainNetIn).toBe(-2500000000);
});
```

- [ ] **Step 2：跑测试确认失败**

- [ ] **Step 3：实现 aggregateMoneyFlow**（金额单位以 PR-0 笔记为准，必要时乘以 10000 归一为「元」）

```ts
async aggregateMoneyFlow(tradeDate: string) {
  const [market] = await this.ds.query(
    `SELECT main_net_amount::numeric AS main_net_in
       FROM money_flow_market WHERE trade_date = $1`,
    [tradeDate],
  );
  const topIn = await this.ds.query(
    `SELECT ts_code, name, main_net_amount::numeric AS main_net_in
       FROM money_flow_stock WHERE trade_date = $1
       ORDER BY main_net_amount::numeric DESC LIMIT 20`,
    [tradeDate],
  );
  const topOut = await this.ds.query(
    `SELECT ts_code, name, main_net_amount::numeric AS main_net_in
       FROM money_flow_stock WHERE trade_date = $1
       ORDER BY main_net_amount::numeric ASC LIMIT 20`,
    [tradeDate],
  );
  const map = (r: any) => ({ tsCode: r.ts_code, name: r.name, mainNetIn: +r.main_net_in });
  return {
    market: { mainNetIn: +(market?.main_net_in ?? 0) },
    stocksTopIn: topIn.map(map),
    stocksTopOut: topOut.map(map),
  };
}
```

- [ ] **Step 4：测试 + commit**

```
git commit -am "feat(daily-review): snapshot-builder.aggregateMoneyFlow"
```

### Task 2.5：聚合强势股 + 成交额 TOP

**Files:** 同上

- [ ] **Step 1：写测试**

```ts
it('aggregateStrongAndVolume 过滤 ST、取 TOP20', async () => {
  (mockDs.query as jest.Mock)
    .mockResolvedValueOnce([{ ts_code: '688256.SH', name: '寒武纪', pct_chg: '20.0', turnover_rate: '15.2' }])
    .mockResolvedValueOnce([{ ts_code: '600519.SH', name: '贵州茅台', amount: '4500000000', pct_chg: '0.5' }]);
  const r = await svc.aggregateStrongAndVolume('20260512');
  expect(r.strongStocks[0].pctChg).toBe(20.0);
  expect(r.volumeTop[0].amount).toBe(4500000000);
});
```

- [ ] **Step 2：跑测试确认失败**

- [ ] **Step 3：实现**

```ts
async aggregateStrongAndVolume(tradeDate: string) {
  const strong = await this.ds.query(
    `SELECT q.ts_code, s.name, q.pct_chg::numeric AS pct_chg, q.turnover_rate::numeric AS turnover_rate
       FROM a_share_daily_quotes q
       JOIN symbol s ON s.ts_code = q.ts_code
       WHERE q.trade_date = $1
         AND s.name NOT ILIKE '%ST%'
       ORDER BY q.pct_chg::numeric DESC LIMIT 20`,
    [tradeDate],
  );
  const vol = await this.ds.query(
    `SELECT q.ts_code, s.name, q.amount::numeric AS amount, q.pct_chg::numeric AS pct_chg
       FROM a_share_daily_quotes q
       JOIN symbol s ON s.ts_code = q.ts_code
       WHERE q.trade_date = $1
       ORDER BY q.amount::numeric DESC LIMIT 20`,
    [tradeDate],
  );
  return {
    strongStocks: strong.map((r: any) => ({ tsCode: r.ts_code, name: r.name, pctChg: +r.pct_chg, turnoverRate: +r.turnover_rate })),
    volumeTop:    vol.map((r:    any) => ({ tsCode: r.ts_code, name: r.name, amount: +r.amount, pctChg: +r.pct_chg })),
  };
}
```

`symbol` 表名以 entities/symbol/ 中实际命名为准（编码时核对）。`turnover_rate` 列若不存在，去掉该字段返回 `undefined`。

- [ ] **Step 4：测试 + commit**

```
git commit -am "feat(daily-review): snapshot-builder.aggregateStrongAndVolume"
```

### Task 2.6：调 Tushare 取大盘指数日线

**Files:**
- Modify: `apps/server/src/daily-review/snapshot-builder.service.ts`
- Modify: `apps/server/src/daily-review/snapshot-builder.service.spec.ts`

> 接口名 / 参数 / 字段以 **PR-0 Task 0.3 笔记**为准。下面使用 `index_daily` 假设；编码时核对。

- [ ] **Step 1：写测试（mock TushareClient）**

```ts
it('fetchIndices 拼装 4 个指数', async () => {
  const tushare = { call: jest.fn().mockResolvedValue({
    items: [
      { ts_code: '000001.SH', close: '4225.02', pct_chg: '1.08', amount: '450000000' },
      { ts_code: '399001.SZ', close: '13280',   pct_chg: '1.42', amount: '380000000' },
      { ts_code: '399006.SZ', close: '2870',    pct_chg: '1.85', amount: '180000000' },
      { ts_code: '000688.SH', close: '1430',    pct_chg: '4.65', amount: '90000000'  },
    ]
  })};
  // 注入 tushare client
  // ...
  const r = await svc.fetchIndices('20260512');
  expect(r).toHaveLength(4);
  expect(r[0]).toMatchObject({ tsCode: '000001.SH', name: '上证指数', close: 4225.02, pctChg: 1.08 });
});
```

- [ ] **Step 2：跑测试确认失败**

- [ ] **Step 3：实现**

注入项目已有的 Tushare 客户端（PR-0 Task 0.4 笔记中记录的）。

```ts
const INDEX_LIST = [
  { tsCode: '000001.SH', name: '上证指数' },
  { tsCode: '399001.SZ', name: '深证成指' },
  { tsCode: '399006.SZ', name: '创业板指' },
  { tsCode: '000688.SH', name: '科创50' },
] as const;

async fetchIndices(tradeDate: string): Promise<IndexQuote[]> {
  const results = await Promise.all(INDEX_LIST.map(async (idx) => {
    const resp = await this.tushare.call('index_daily', {
      ts_code: idx.tsCode,
      trade_date: tradeDate,
    });
    const row = resp.items?.[0];
    if (!row) {
      this.logger.warn(
        `[index_daily_empty] ts_code=${idx.tsCode} trade_date=${tradeDate}`,
      );
      return { tsCode: idx.tsCode, name: idx.name, close: 0, pctChg: 0, amount: 0 };
    }
    return {
      tsCode: idx.tsCode, name: idx.name,
      close: +row.close, pctChg: +row.pct_chg, amount: +row.amount,
    };
  }));
  return results;
}
```

注意 CLAUDE.md 第三方 API 规范：空数据必须 `logger.warn`。

- [ ] **Step 4：测试 + commit**

```
git commit -am "feat(daily-review): snapshot-builder.fetchIndices via Tushare index_daily"
```

### Task 2.7：buildSnapshot 装配总入口

**Files:**
- Modify: `apps/server/src/daily-review/snapshot-builder.service.ts`

- [ ] **Step 1：写测试**

```ts
it('buildSnapshot 串联所有子聚合，输出 SnapshotPayload', async () => {
  jest.spyOn(svc, 'validate').mockResolvedValue();
  jest.spyOn(svc, 'aggregateUpdown').mockResolvedValue({ updownDist: { up:1, down:1, flat:0, limitUp:0, limitDown:0 }, limitStats: { upCount:0, downCount:0, brokenCount:0 } });
  jest.spyOn(svc, 'aggregateSectors').mockResolvedValue({ industryRank: [], conceptRank: [] });
  jest.spyOn(svc, 'aggregateMoneyFlow').mockResolvedValue({ market: { mainNetIn: 0 }, stocksTopIn: [], stocksTopOut: [] });
  jest.spyOn(svc, 'aggregateStrongAndVolume').mockResolvedValue({ strongStocks: [], volumeTop: [] });
  jest.spyOn(svc, 'fetchIndices').mockResolvedValue([]);
  const r = await svc.buildSnapshot('20260512');
  expect(r.generatedAt).toMatch(/T/);
  expect(r.updownDist.up).toBe(1);
});
```

- [ ] **Step 2：实现**

```ts
async buildSnapshot(tradeDate: string): Promise<SnapshotPayload> {
  await this.validate(tradeDate);
  const [indices, ud, sec, mf, sv] = await Promise.all([
    this.fetchIndices(tradeDate),
    this.aggregateUpdown(tradeDate),
    this.aggregateSectors(tradeDate),
    this.aggregateMoneyFlow(tradeDate),
    this.aggregateStrongAndVolume(tradeDate),
  ]);
  return {
    indices,
    ...ud,
    ...sec,
    moneyFlow: mf,
    ...sv,
    generatedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 3：测试 + commit**

```
git commit -am "feat(daily-review): snapshot-builder.buildSnapshot 装配"
```

### Task 2.8：在 module 中注册 SnapshotBuilderService

**Files:**
- Modify: `apps/server/src/daily-review/daily-review.module.ts`

- [ ] **Step 1：providers 加入 SnapshotBuilderService**

```ts
providers: [DailyReviewService, SnapshotBuilderService],
```

确保该 module 已经能拿到 `DataSource` 与 Tushare 客户端（按 PR-0 Task 0.4 决定是否 import 上游 module）。

- [ ] **Step 2：build + commit**

```
pnpm --filter @cryptotrading/server build
git commit -am "feat(daily-review): 注册 SnapshotBuilderService"
```

---

## PR-3：deepseek.service + prompt 模板

### Task 3.1：写 prompt 模板

**Files:**
- Create: `apps/server/src/daily-review/prompts/article-prompt.ts`

- [ ] **Step 1：写 system + user 模板**

```ts
export const SYSTEM_PROMPT = `你是一位资深 A 股策略分析师，文风参考彭博终端与高盛中国研报。
请根据用户提供的当日 A 股市场数据快照，输出一篇 5000-8000 字的 Markdown 复盘文章。

【严格要求】
- 文章必须包含以下八段（每段以 ## 二级标题起首，按顺序）：
  1. 开篇声明（注明 AI 生成 + 投资建议免责）
  2. 一、先给结论（核心线 + 下一交易日判断 + 资金切换路径）
  3. 二、大盘全景（指数、成交、涨跌分布、情绪）
  4. 三、重点板块拆解（行业 TOP / 概念 TOP 中选 2-3 个）
  5. 四、潜力板块跟踪
  6. 五、资金流向解读（主力净流入/净流出 TOP）
  7. 六、综合结论与策略建议
  8. 七、重点个股观察池（强势股 + 成交 TOP 中选 5-10 只）
- 涨跌停统计的"炸板数"字段当前为近似值（固定为 0），请在第三段以一句话注明
- 数据中所有金额单位为「元」，正文中请按金额量级换算为亿/万亿展示
- 禁止虚构未在数据中出现的个股名称、板块、数字
- 禁止给出明确的买卖点价格
- 末尾必须重复一行：「仅用于学习研究，不构成投资建议」`;

export function buildUserPrompt(snapshot: unknown): string {
  return `以下是 ${(snapshot as any).generatedAt} 的当日 A 股市场数据快照（JSON）：

\`\`\`json
${JSON.stringify(snapshot, null, 2)}
\`\`\`

请按 system 中规定的结构生成复盘文章。`;
}
```

- [ ] **Step 2：commit**

```
git add apps/server/src/daily-review/prompts/article-prompt.ts
git commit -m "feat(daily-review): 新增 article prompt 模板"
```

### Task 3.2：写 DeepSeek service（带 thinking）

**前置：再次重读 [.claude/skills/deepseek-api/thinking_mode.md](../../../.claude/skills/deepseek-api/thinking_mode.md) 与 [multi_round_chat.md](../../../.claude/skills/deepseek-api/multi_round_chat.md)，按 PR-0 Task 0.5 笔记锁定 model 字符串。**

**Files:**
- Create: `apps/server/src/daily-review/deepseek.service.ts`
- Test: `apps/server/src/daily-review/deepseek.service.spec.ts`

- [ ] **Step 1：写测试 — 流式分别累加 content / reasoning_content**

```ts
import { DeepseekService } from './deepseek.service';

describe('DeepseekService.generateArticle', () => {
  it('分别累加 reasoning_content 与 content', async () => {
    const fakeStream = (async function* () {
      yield { choices: [{ delta: { reasoning_content: '思考A' } }] };
      yield { choices: [{ delta: { reasoning_content: '思考B' } }] };
      yield { choices: [{ delta: { content: '正文A' } }] };
      yield { choices: [{ delta: { content: '正文B' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: {
        prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 200, total_tokens: 350,
      }};
    })();

    const client = { chat: { completions: { create: jest.fn().mockResolvedValue(fakeStream) } } };
    const svc = new DeepseekService(client as any, { model: 'deepseek-test' });

    const events: any[] = [];
    const r = await svc.generateArticle('snapshot json', (e) => events.push(e));

    expect(r.article).toBe('正文A正文B');
    expect(r.reasoning).toBe('思考A思考B');
    expect(r.tokenUsage).toEqual({ prompt: 100, completion: 50, reasoning: 200, total: 350 });
    expect(events.map(e => e.stage)).toEqual(['reasoning', 'reasoning', 'writing', 'writing']);
  });

  it('extra_body 含 thinking enabled 且不传 temperature', async () => {
    const client = { chat: { completions: { create: jest.fn().mockResolvedValue((async function*(){})()) } } };
    const svc = new DeepseekService(client as any, { model: 'deepseek-test' });
    await svc.generateArticle('x', () => {});
    const callArgs = (client.chat.completions.create as jest.Mock).mock.calls[0][0];
    expect(callArgs.stream).toBe(true);
    expect(callArgs.extra_body).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
    expect(callArgs.temperature).toBeUndefined();
    expect(callArgs.top_p).toBeUndefined();
  });
});
```

- [ ] **Step 2：跑测试确认失败**

- [ ] **Step 3：实现 service**

```ts
import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompts/article-prompt';
import type { ProgressEvent } from './daily-review.types';

export interface DeepseekConfig { model: string; }

@Injectable()
export class DeepseekService {
  private readonly logger = new Logger(DeepseekService.name);

  constructor(
    private readonly client: OpenAI,
    private readonly config: DeepseekConfig,
  ) {}

  async generateArticle(
    snapshotJson: string,
    onProgress: (e: ProgressEvent) => void,
  ): Promise<{ article: string; reasoning: string; tokenUsage: any }> {
    const stream: any = await this.client.chat.completions.create({
      model: this.config.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(JSON.parse(snapshotJson)) },
      ],
      stream: true,
      // @ts-expect-error extra_body 是 deepseek 扩展
      extra_body: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
    });

    let reasoning = '', article = '', usage: any = null;
    let stage: 'reasoning' | 'writing' = 'reasoning';

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning_content) {
        reasoning += delta.reasoning_content;
        onProgress({ stage: 'reasoning', percent: this.estimatePercent('reasoning', reasoning.length) });
      }
      if (delta?.content) {
        if (stage === 'reasoning') stage = 'writing';
        article += delta.content;
        onProgress({ stage: 'writing', percent: this.estimatePercent('writing', article.length) });
      }
      if (chunk.usage) usage = chunk.usage;
    }

    return {
      article, reasoning,
      tokenUsage: usage ? {
        prompt: usage.prompt_tokens,
        completion: usage.completion_tokens,
        reasoning: usage.reasoning_tokens ?? 0,
        total: usage.total_tokens,
      } : null,
    };
  }

  private estimatePercent(s: 'reasoning' | 'writing', chars: number): number {
    if (s === 'reasoning') return 40 + Math.min(25, Math.floor((chars / 4000) * 25));
    return 65 + Math.min(30, Math.floor((chars / 8000) * 30));
  }
}
```

- [ ] **Step 4：测试 + commit**

```
pnpm --filter @cryptotrading/server test deepseek
git commit -am "feat(daily-review): deepseek.service 思考模式流式生成"
```

### Task 3.3：在 module 中提供 OpenAI client 与 DeepseekService

**Files:**
- Modify: `apps/server/src/daily-review/daily-review.module.ts`

- [ ] **Step 1：添加 providers**

```ts
import OpenAI from 'openai';
import { ConfigService } from '@nestjs/config';
import { DeepseekService } from './deepseek.service';

const deepseekClientProvider = {
  provide: OpenAI,
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) => new OpenAI({
    apiKey: cfg.getOrThrow<string>('DEEPSEEK_API_KEY'),
    baseURL: cfg.get<string>('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com',
    timeout: 240_000,
  }),
};

const deepseekServiceProvider = {
  provide: DeepseekService,
  inject: [OpenAI, ConfigService],
  useFactory: (client: OpenAI, cfg: ConfigService) =>
    new DeepseekService(client, { model: cfg.get<string>('DEEPSEEK_MODEL') || '<按 PR-0 笔记填>' }),
};

// providers: [..., deepseekClientProvider, deepseekServiceProvider]
```

- [ ] **Step 2：在 apps/server/.env.example 加入新变量**

```
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=<按 PR-0 笔记填>
```

- [ ] **Step 3：commit**

```
git commit -am "feat(daily-review): 注册 DeepseekService + 环境变量"
```

---

## PR-4：service 编排 + SSE 进度推送

### Task 4.1：写进度网关

**Files:**
- Create: `apps/server/src/daily-review/daily-review-progress.gateway.ts`

- [ ] **Step 1：实现**

```ts
import { Injectable } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import type { ProgressEvent } from './daily-review.types';

@Injectable()
export class DailyReviewProgressGateway {
  private subjects = new Map<string, Subject<ProgressEvent>>();

  emit(tradeDate: string, e: ProgressEvent) {
    const s = this.subjects.get(tradeDate);
    if (s) s.next(e);
    if (e.stage === 'completed' || e.stage === 'failed') {
      s?.complete();
      this.subjects.delete(tradeDate);
    }
  }

  observe(tradeDate: string): Observable<ProgressEvent> {
    let s = this.subjects.get(tradeDate);
    if (!s) {
      s = new Subject<ProgressEvent>();
      this.subjects.set(tradeDate, s);
    }
    return s.asObservable();
  }

  hasActive(tradeDate: string) {
    return this.subjects.has(tradeDate);
  }
}
```

- [ ] **Step 2：commit**

```
git add apps/server/src/daily-review/daily-review-progress.gateway.ts
git commit -m "feat(daily-review): 进度推送网关（内存 Subject）"
```

### Task 4.2：service 编排 5 阶段

**Files:**
- Modify: `apps/server/src/daily-review/daily-review.service.ts`
- Test: `apps/server/src/daily-review/daily-review.service.spec.ts`

- [ ] **Step 1：写 startGeneration 的失败路径测试**

```ts
it('startGeneration: 数据缺失时 status 标 failed 并 emit failed', async () => {
  jest.spyOn(builder, 'buildSnapshot').mockRejectedValue(
    new UnprocessableEntityException('A股日线缺失'),
  );
  await svc.startGeneration({ tradeDate: '20260512' }, 'user-1');
  const row = await repo.findOne({ where: { tradeDate: '20260512' } });
  expect(row?.status).toBe('failed');
  expect(row?.errorMessage).toMatch(/A股日线缺失/);
});
```

- [ ] **Step 2：跑测试确认失败**

- [ ] **Step 3：实现 startGeneration**

```ts
async startGeneration(dto: CreateReviewDto, userId: string) {
  const tradeDate = dto.tradeDate ?? await this.resolveLatestTradeDate();

  if (this.gateway.hasActive(tradeDate)) {
    throw new ConflictException(`${tradeDate} 已有生成任务在进行`);
  }

  const existing = await this.repo.findOne({ where: { tradeDate } });
  const row = existing ?? this.repo.create({ tradeDate, createdById: userId });
  row.status = 'fetching';
  row.snapshot = null; row.articleMd = null; row.reasoningContent = null;
  row.tokenUsage = null; row.errorMessage = null;
  await this.repo.save(row);

  // 触发异步任务，不 await
  this.runPipeline(row.id, tradeDate).catch((err) => {
    this.logger.error(`pipeline crashed for ${tradeDate}: ${err.stack}`);
  });

  return { tradeDate, status: row.status };
}

private async runPipeline(id: string, tradeDate: string) {
  try {
    this.gateway.emit(tradeDate, { stage: 'validate', percent: 1 });

    this.gateway.emit(tradeDate, { stage: 'fetch', percent: 10 });
    const snapshot = await this.builder.buildSnapshot(tradeDate);

    this.gateway.emit(tradeDate, { stage: 'build', percent: 35 });
    await this.repo.update(id, { snapshot, status: 'generating' });

    const { article, reasoning, tokenUsage } = await this.deepseek.generateArticle(
      JSON.stringify(snapshot),
      (e) => this.gateway.emit(tradeDate, e),
    );

    this.gateway.emit(tradeDate, { stage: 'finalize', percent: 97 });
    if (article.length < 2000) {
      throw new Error(`文章长度异常 (${article.length} chars)`);
    }
    await this.repo.update(id, {
      articleMd: article,
      reasoningContent: reasoning,
      tokenUsage,
      llmModel: this.deepseek.modelName,
      status: 'completed',
    });
    this.gateway.emit(tradeDate, { stage: 'completed', percent: 100 });
  } catch (err: any) {
    await this.repo.update(id, { status: 'failed', errorMessage: err.message });
    this.gateway.emit(tradeDate, { stage: 'failed', percent: 0, error: err.message });
  }
}

private async resolveLatestTradeDate(): Promise<string> {
  const [r] = await this.ds.query(
    'SELECT MAX(trade_date) AS d FROM a_share_daily_quotes',
  );
  if (!r?.d) throw new UnprocessableEntityException('尚无任何 A 股日线数据');
  return r.d;
}
```

`deepseek.modelName` 需要在 DeepseekService 里 expose 一个 `get modelName() { return this.config.model; }`。

- [ ] **Step 4：跑测试 + commit**

```
pnpm --filter @cryptotrading/server test daily-review.service
git commit -am "feat(daily-review): 5 阶段编排 + 异常处理"
```

### Task 4.3：controller 接入 POST 与 SSE

**Files:**
- Modify: `apps/server/src/daily-review/daily-review.controller.ts`

- [ ] **Step 1：实现 POST + DELETE + SSE**

```ts
import {
  Body, Controller, Delete, Get, Param, Post, Query, Sse, MessageEvent, Req,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { AdminOnly } from '<项目已有 admin 装饰器路径>';
import { DailyReviewService } from './daily-review.service';
import { DailyReviewProgressGateway } from './daily-review-progress.gateway';
import { CreateReviewDto } from './dto/create-review.dto';
import { ListQueryDto } from './dto/list-query.dto';

@Controller('api/daily-review')
export class DailyReviewController {
  constructor(
    private readonly svc: DailyReviewService,
    private readonly gateway: DailyReviewProgressGateway,
  ) {}

  @Get()
  list(@Query() q: ListQueryDto) { return this.svc.list(q); }

  @Get(':tradeDate')
  detail(@Param('tradeDate') tradeDate: string, @Req() req: any) {
    return this.svc.getDetail(tradeDate, req.user);
  }

  @Post()
  @AdminOnly()
  create(@Body() dto: CreateReviewDto, @Req() req: any) {
    return this.svc.startGeneration(dto, req.user.id);
  }

  @Delete(':tradeDate')
  @AdminOnly()
  remove(@Param('tradeDate') tradeDate: string) {
    return this.svc.remove(tradeDate);
  }

  @Sse(':tradeDate/stream')
  stream(@Param('tradeDate') tradeDate: string): Observable<MessageEvent> {
    return this.gateway.observe(tradeDate).pipe(
      map((e) => ({ data: e } as MessageEvent)),
    );
  }
}
```

`AdminOnly` 装饰器路径以 PR-0 调研笔记中记录为准（项目已有）；如果没有，按 CLAUDE.md 不要新加 `@UseGuards(AuthGuard)`，而是写一个轻量 `AdminGuard` 注册到 `APP_GUARD` 或者用 metadata + AuthGuard 共同处理。

`getDetail(tradeDate, user)` 在 service 中：非 admin 用户从返回中剔除 `reasoningContent`。

- [ ] **Step 2：在 service 实现 remove 与 getDetail 的 user 过滤**

```ts
async remove(tradeDate: string) {
  const r = await this.repo.delete({ tradeDate });
  if (r.affected === 0) throw new NotFoundException();
  return { ok: true };
}

async getDetail(tradeDate: string, user: { isAdmin: boolean }) {
  const row = await this.repo.findOne({ where: { tradeDate } });
  if (!row) throw new NotFoundException();
  if (!user.isAdmin) {
    const { reasoningContent, tokenUsage, llmModel, ...rest } = row;
    return rest;
  }
  return row;
}
```

- [ ] **Step 3：手动 e2e**

启动 server，先用 `INSERT` 写一条 status=fetching 的假数据，curl `/api/daily-review/20260512/stream`，预期 EventSource 一直挂着；调 `gateway.emit('20260512', {stage:'completed', percent:100})` 看是否能收到事件并自动关闭。

- [ ] **Step 4：commit**

```
git commit -am "feat(daily-review): controller 接入 POST/DELETE/SSE"
```

---

## PR-5：前端列表 + 创建弹窗

### Task 5.1：前端共享类型

**Files:**
- Create: `apps/web/src/types/daily-review.ts`

- [ ] **Step 1：从后端类型复制**

```ts
export type DailyReviewStatus = 'pending' | 'fetching' | 'generating' | 'completed' | 'failed';

export interface DailyReviewListItem {
  id: string;
  tradeDate: string;
  status: DailyReviewStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProgressEvent =
  | { stage: 'validate' | 'fetch' | 'build' | 'reasoning' | 'writing' | 'finalize'; percent: number; message?: string }
  | { stage: 'completed'; percent: 100 }
  | { stage: 'failed'; percent: number; error: string };

export const STAGE_LABEL: Record<ProgressEvent['stage'], string> = {
  validate: '校验数据', fetch: '采集数据', build: '构建快照',
  reasoning: 'AI 推理中', writing: 'AI 撰写中', finalize: '校验中',
  completed: '已完成', failed: '失败',
};
```

- [ ] **Step 2：commit**

```
git add apps/web/src/types/daily-review.ts
git commit -m "feat(web/daily-review): 共享类型"
```

### Task 5.2：API composable

**Files:**
- Create: `apps/web/src/composables/useDailyReviewApi.ts`

- [ ] **Step 1：实现**

```ts
import { http } from '@/lib/http'; // 项目已有 http 客户端
import type { DailyReviewListItem } from '@/types/daily-review';

export function useDailyReviewApi() {
  return {
    list: (params: { status?: string; page?: number; pageSize?: number } = {}) =>
      http.get<{ items: DailyReviewListItem[]; total: number; page: number; pageSize: number }>('/api/daily-review', { params }),
    detail: (tradeDate: string) =>
      http.get<any>(`/api/daily-review/${tradeDate}`),
    create: (tradeDate?: string) =>
      http.post<{ tradeDate: string; status: string }>('/api/daily-review', { tradeDate }),
    remove: (tradeDate: string) =>
      http.delete(`/api/daily-review/${tradeDate}`),
  };
}
```

`@/lib/http` 路径以项目实际为准（PR-0 调研中记录）。

- [ ] **Step 2：commit**

```
git commit -am "feat(web/daily-review): API composable"
```

### Task 5.3：进度订阅 composable

**Files:**
- Create: `apps/web/src/composables/useDailyReviewProgress.ts`

- [ ] **Step 1：实现**

```ts
import { ref, onUnmounted } from 'vue';
import type { ProgressEvent } from '@/types/daily-review';

export function useDailyReviewProgress(tradeDate: string) {
  const stage  = ref<ProgressEvent['stage']>('validate');
  const percent = ref(0);
  const error  = ref<string | null>(null);
  const done   = ref(false);

  const es = new EventSource(`/api/daily-review/${tradeDate}/stream`, { withCredentials: true });
  es.onmessage = (ev) => {
    const e = JSON.parse(ev.data) as ProgressEvent;
    stage.value = e.stage; percent.value = e.percent;
    if (e.stage === 'failed') error.value = e.error;
    if (e.stage === 'completed' || e.stage === 'failed') { done.value = true; es.close(); }
  };
  es.onerror = () => { es.close(); error.value ??= '连接断开'; done.value = true; };

  onUnmounted(() => es.close());

  return { stage, percent, error, done };
}
```

- [ ] **Step 2：commit**

```
git commit -am "feat(web/daily-review): SSE 进度订阅 composable"
```

### Task 5.4：进度条组件

**Files:**
- Create: `apps/web/src/components/daily-review/ReviewProgressBar.vue`

- [ ] **Step 1：实现**

```vue
<template>
  <div class="review-progress">
    <n-progress
      type="line"
      :percentage="percent"
      :status="error ? 'error' : (done ? 'success' : 'default')"
      :indicator-placement="'inside'"
    />
    <span class="stage">{{ STAGE_LABEL[stage] }}{{ error ? `：${error}` : '' }}</span>
  </div>
</template>
<script setup lang="ts">
import { NProgress } from 'naive-ui';
import { useDailyReviewProgress } from '@/composables/useDailyReviewProgress';
import { STAGE_LABEL } from '@/types/daily-review';
const props = defineProps<{ tradeDate: string }>();
const { stage, percent, error, done } = useDailyReviewProgress(props.tradeDate);
</script>
<style scoped>
.review-progress { display: flex; align-items: center; gap: 8px; min-width: 220px; }
.stage { font-size: 12px; color: var(--color-text-muted); white-space: nowrap; }
</style>
```

- [ ] **Step 2：commit**

```
git commit -am "feat(web/daily-review): ReviewProgressBar 组件"
```

### Task 5.5：创建按钮 + 弹窗

**Files:**
- Create: `apps/web/src/components/daily-review/ReviewCreateButton.vue`

- [ ] **Step 1：实现**

```vue
<template>
  <template v-if="auth.isAdmin.value">
    <n-button type="primary" @click="open = true">新增复盘</n-button>
    <AppModal v-model:show="open" title="新增复盘" @ok="submit" :loading="loading">
      <n-form-item label="交易日">
        <n-date-picker v-model:value="ts" type="date" :default-value="defaultTs" />
      </n-form-item>
      <n-alert v-if="exists" type="warning">该交易日已有复盘，提交将覆盖现有版本</n-alert>
    </AppModal>
  </template>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton, NDatePicker, NFormItem, NAlert, useMessage } from 'naive-ui';
import AppModal from '@/components/common/AppModal.vue';
import { useAuth } from '@/composables/hooks/useAuth';
import { useDailyReviewApi } from '@/composables/useDailyReviewApi';

const emit = defineEmits<{ created: [tradeDate: string] }>();
const props = defineProps<{ existingDates: string[] }>();

const auth = useAuth();
const api = useDailyReviewApi();
const msg = useMessage();
const open = ref(false);
const loading = ref(false);

// 默认取最近一个工作日的本地午夜 ms（CLAUDE.md 日期选择器本地 TZ 例外）
const defaultTs = (() => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
})();
const ts = ref<number | null>(defaultTs);

function formatYmd(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}
const tradeDate = computed(() => ts.value ? formatYmd(ts.value) : '');
const exists = computed(() => tradeDate.value && props.existingDates.includes(tradeDate.value));

async function submit() {
  if (!ts.value) return;
  loading.value = true;
  try {
    await api.create(tradeDate.value);
    open.value = false;
    emit('created', tradeDate.value);
  } catch (err: any) {
    msg.error(err?.message || '提交失败');
  } finally {
    loading.value = false;
  }
}
</script>
```

- [ ] **Step 2：commit**

```
git commit -am "feat(web/daily-review): ReviewCreateButton 弹窗"
```

### Task 5.6：列表表格

**Files:**
- Create: `apps/web/src/components/daily-review/ReviewListTable.vue`

- [ ] **Step 1：实现**

```vue
<template>
  <n-data-table
    :columns="columns"
    :data="items"
    :pagination="pagination"
    remote
    @update:page="emit('page', $event)"
  />
</template>
<script setup lang="ts">
import { computed, h } from 'vue';
import { NDataTable, NTag, NButton, NSpace } from 'naive-ui';
import { useRouter } from 'vue-router';
import { useAuth } from '@/composables/hooks/useAuth';
import ReviewProgressBar from './ReviewProgressBar.vue';
import type { DailyReviewListItem } from '@/types/daily-review';

const props = defineProps<{ items: DailyReviewListItem[]; total: number; page: number; pageSize: number }>();
const emit = defineEmits<{ page: [page: number]; regenerate: [tradeDate: string]; remove: [tradeDate: string] }>();

const router = useRouter();
const auth = useAuth();

const STATUS_MAP: Record<string, { label: string; type: 'success' | 'warning' | 'error' | 'info' }> = {
  pending:    { label: '待生成', type: 'info' },
  fetching:   { label: '采集中', type: 'warning' },
  generating: { label: '生成中', type: 'warning' },
  completed:  { label: '已完成', type: 'success' },
  failed:     { label: '失败',   type: 'error' },
};

const columns = computed(() => [
  { title: '交易日', key: 'tradeDate' },
  {
    title: '状态', key: 'status',
    render: (r: DailyReviewListItem) =>
      r.status === 'fetching' || r.status === 'generating'
        ? h(ReviewProgressBar, { tradeDate: r.tradeDate })
        : h(NTag, { type: STATUS_MAP[r.status].type }, () => STATUS_MAP[r.status].label),
  },
  { title: '更新时间', key: 'updatedAt', render: (r: DailyReviewListItem) => new Date(r.updatedAt).toLocaleString() },
  {
    title: '操作', key: 'actions',
    render: (r: DailyReviewListItem) => h(NSpace, {}, () => [
      h(NButton, { size: 'small', onClick: () => router.push({ name: 'daily-review-detail', params: { tradeDate: r.tradeDate } }) }, () => '查看'),
      ...(auth.isAdmin.value ? [
        h(NButton, { size: 'small', onClick: () => emit('regenerate', r.tradeDate) }, () => '重生成'),
        h(NButton, { size: 'small', type: 'error', onClick: () => emit('remove', r.tradeDate) }, () => '删除'),
      ] : []),
    ]),
  },
]);

const pagination = computed(() => ({
  page: props.page, pageSize: props.pageSize, itemCount: props.total, showSizePicker: false,
}));
</script>
```

- [ ] **Step 2：commit**

```
git commit -am "feat(web/daily-review): ReviewListTable 列表"
```

### Task 5.7：列表视图 + 路由 + 侧边栏

**Files:**
- Create: `apps/web/src/views/DailyReviewView.vue`
- Modify: `apps/web/src/router/index.ts`
- Modify: `apps/web/src/components/layout/Sidebar.vue`

- [ ] **Step 1：写视图**

```vue
<template>
  <div class="page">
    <div class="page-header">
      <h2>每日复盘</h2>
      <ReviewCreateButton :existing-dates="existingDates" @created="onCreated" />
    </div>
    <ReviewListTable
      :items="data.items"
      :total="data.total"
      :page="data.page"
      :page-size="data.pageSize"
      @page="loadPage"
      @regenerate="onRegenerate"
      @remove="onRemove"
    />
  </div>
</template>
<script setup lang="ts">
import { onActivated, onMounted, reactive, computed } from 'vue';
import { useMessage } from 'naive-ui';
import ReviewCreateButton from '@/components/daily-review/ReviewCreateButton.vue';
import ReviewListTable from '@/components/daily-review/ReviewListTable.vue';
import { useDailyReviewApi } from '@/composables/useDailyReviewApi';

const api = useDailyReviewApi();
const msg = useMessage();
const data = reactive({ items: [], total: 0, page: 1, pageSize: 20 });
const existingDates = computed(() => data.items.map((i: any) => i.tradeDate));

async function loadPage(page = 1) {
  const r = await api.list({ page, pageSize: data.pageSize });
  Object.assign(data, r);
}

onMounted(loadPage);
onActivated(loadPage); // CLAUDE.md keep-alive 规范

async function onCreated(tradeDate: string) {
  msg.success(`已开始生成 ${tradeDate}`);
  await loadPage(1);
}
async function onRegenerate(tradeDate: string) {
  await api.create(tradeDate);
  msg.success(`已开始重生成 ${tradeDate}`);
  await loadPage(data.page);
}
async function onRemove(tradeDate: string) {
  await api.remove(tradeDate);
  msg.success(`已删除 ${tradeDate}`);
  await loadPage(data.page);
}
</script>
<style scoped>
.page { padding: 16px 24px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
</style>
```

- [ ] **Step 2：路由新增**

打开 `apps/web/src/router/index.ts`，在 `routes` 数组末尾追加：

```ts
{
  path: '/daily-review',
  name: 'daily-review',
  component: () => import('../views/DailyReviewView.vue'),
  meta: { title: '每日复盘' },
},
{
  path: '/daily-review/:tradeDate',
  name: 'daily-review-detail',
  component: () => import('../views/DailyReviewDetailView.vue'),
  meta: { title: '复盘详情' },
},
```

- [ ] **Step 3：侧边栏改 activeKey + 加菜单项**

打开 `apps/web/src/components/layout/Sidebar.vue`：

第 79 行替换：

```ts
const activeKey = computed(() => {
  const name = route.name as string;
  if (name?.startsWith('daily-review')) return 'daily-review';
  return name;
});
```

第 88 行（资金流向后）插入：

```ts
{ label: '每日复盘', key: 'daily-review', icon: renderIcon(NewspaperOutline) },
```

并在 imports 中追加 `NewspaperOutline`。

- [ ] **Step 4：build 验证**

```
pnpm --filter @cryptotrading/web build
```

- [ ] **Step 5：commit**

```
git commit -am "feat(web/daily-review): 列表视图 + 路由 + 侧边栏"
```

---

## PR-6：前端详情页 + 图表 + Markdown + admin 操作

### Task 6.1：SnapshotCards 顶部卡片

**Files:**
- Create: `apps/web/src/components/daily-review/ReviewSnapshotCards.vue`

- [ ] **Step 1：实现**

```vue
<template>
  <div class="cards">
    <div class="row">
      <div v-for="ix in snapshot.indices" :key="ix.tsCode" class="card">
        <div class="card-name">{{ ix.name }}</div>
        <div class="card-value">{{ ix.close.toFixed(2) }}</div>
        <div :class="['card-chg', ix.pctChg >= 0 ? 'up' : 'down']">
          {{ ix.pctChg >= 0 ? '+' : '' }}{{ ix.pctChg.toFixed(2) }}%
        </div>
      </div>
    </div>
    <div class="row">
      <div class="card">涨家 {{ snapshot.updownDist.up }}</div>
      <div class="card">跌家 {{ snapshot.updownDist.down }}</div>
      <div class="card">涨停 {{ snapshot.limitStats.upCount }}</div>
      <div class="card">跌停 {{ snapshot.limitStats.downCount }}</div>
    </div>
  </div>
</template>
<script setup lang="ts">
defineProps<{ snapshot: any }>();
</script>
<style scoped>
.cards { display: flex; flex-direction: column; gap: 12px; }
.row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.card { background: var(--color-bg-elevated); border: 1px solid var(--color-border); border-radius: 8px; padding: 12px; }
.card-name { font-size: 12px; color: var(--color-text-muted); }
.card-value { font-size: 20px; font-weight: 600; margin-top: 4px; }
.card-chg.up { color: #e74c3c; }
.card-chg.down { color: #27ae60; }
</style>
```

- [ ] **Step 2：commit**

```
git commit -am "feat(web/daily-review): SnapshotCards 顶部卡片"
```

### Task 6.2：行业 / 资金流 ECharts

**Files:**
- Create: `apps/web/src/components/daily-review/ReviewIndustryChart.vue`
- Create: `apps/web/src/components/daily-review/ReviewMoneyFlowChart.vue`

- [ ] **Step 1：行业图（横向柱状图）**

```vue
<template><div ref="el" style="height: 320px"></div></template>
<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import * as echarts from 'echarts';
const props = defineProps<{ items: { name: string; pctChg: number }[] }>();
const el = ref<HTMLDivElement>(); let chart: echarts.ECharts | null = null;
function render() {
  if (!chart) return;
  chart.setOption({
    grid: { left: 80, right: 30, top: 10, bottom: 30 },
    xAxis: { type: 'value', axisLabel: { formatter: '{value}%' } },
    yAxis: { type: 'category', data: props.items.map(i => i.name).reverse() },
    series: [{
      type: 'bar',
      data: props.items.map(i => ({ value: i.pctChg, itemStyle: { color: i.pctChg >= 0 ? '#e74c3c' : '#27ae60' } })).reverse(),
      label: { show: true, position: 'right', formatter: '{c}%' },
    }],
  });
}
onMounted(() => { chart = echarts.init(el.value!); render(); });
onUnmounted(() => chart?.dispose());
watch(() => props.items, render, { deep: true });
</script>
```

- [ ] **Step 2：资金流图（双向条形图）**

类似结构，正负方向用 `barGap: '-100%'` 或两个 series。略——参考行业图 + 项目已有的 useECharts。

- [ ] **Step 3：commit**

```
git commit -am "feat(web/daily-review): 行业与资金流 ECharts"
```

### Task 6.3：Markdown 文章查看器

**Files:**
- Create: `apps/web/src/components/daily-review/ReviewArticleViewer.vue`

- [ ] **Step 1：实现（用 markdown-it）**

```vue
<template>
  <div class="viewer">
    <aside class="toc">
      <h4>目录</h4>
      <ul>
        <li v-for="h in headings" :key="h.id"><a :href="`#${h.id}`">{{ h.text }}</a></li>
      </ul>
    </aside>
    <article class="content" v-html="html" />
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';

const props = defineProps<{ md: string }>();
const md = new MarkdownIt({ html: false, linkify: true });
const html = computed(() => md.render(props.md));
const headings = computed(() => {
  const out: { id: string; text: string }[] = [];
  for (const line of props.md.split('\n')) {
    const m = /^##\s+(.+)/.exec(line);
    if (m) {
      const text = m[1].trim();
      out.push({ id: text.replace(/\s+/g, '-'), text });
    }
  }
  return out;
});
</script>
<style scoped>
.viewer { display: grid; grid-template-columns: 200px 1fr; gap: 24px; }
.toc { position: sticky; top: 16px; align-self: start; }
.content :deep(h2) { margin-top: 32px; }
</style>
```

`markdown-it` 若未在 web 依赖中：

```
pnpm --filter @cryptotrading/web add markdown-it
pnpm --filter @cryptotrading/web add -D @types/markdown-it
```

- [ ] **Step 2：commit**

```
git commit -am "feat(web/daily-review): ArticleViewer + 目录"
```

### Task 6.4：详情视图

**Files:**
- Create: `apps/web/src/views/DailyReviewDetailView.vue`

- [ ] **Step 1：实现**

```vue
<template>
  <div class="page">
    <div class="page-header">
      <n-button text @click="router.push({ name: 'daily-review' })">← 返回列表</n-button>
      <span class="title">{{ tradeDate }} 复盘</span>
      <n-dropdown trigger="click" :options="menuOptions" @select="onMenu">
        <n-button>...</n-button>
      </n-dropdown>
    </div>

    <template v-if="row?.status === 'fetching' || row?.status === 'generating'">
      <n-alert type="info">复盘正在生成</n-alert>
      <ReviewProgressBar :trade-date="tradeDate" />
    </template>
    <template v-else-if="row?.status === 'failed'">
      <n-alert type="error" :title="'生成失败'">{{ row.errorMessage }}</n-alert>
      <n-button v-if="auth.isAdmin.value" @click="regenerate">重试</n-button>
    </template>
    <template v-else-if="row?.snapshot">
      <ReviewSnapshotCards :snapshot="row.snapshot" />
      <h3>行业资金流向 TOP10</h3>
      <ReviewIndustryChart :items="row.snapshot.industryRank" />
      <h3>主力资金净流入 / 净流出 TOP10</h3>
      <ReviewMoneyFlowChart :top-in="row.snapshot.moneyFlow.stocksTopIn" :top-out="row.snapshot.moneyFlow.stocksTopOut" />
      <n-collapse v-if="auth.isAdmin.value && row.reasoningContent">
        <n-collapse-item title="查看 AI 推理过程" name="reasoning">
          <pre class="reasoning">{{ row.reasoningContent }}</pre>
        </n-collapse-item>
      </n-collapse>
      <ReviewArticleViewer :md="row.articleMd" />
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NAlert, NButton, NCollapse, NCollapseItem, NDropdown, useMessage } from 'naive-ui';
import ReviewSnapshotCards from '@/components/daily-review/ReviewSnapshotCards.vue';
import ReviewIndustryChart from '@/components/daily-review/ReviewIndustryChart.vue';
import ReviewMoneyFlowChart from '@/components/daily-review/ReviewMoneyFlowChart.vue';
import ReviewArticleViewer from '@/components/daily-review/ReviewArticleViewer.vue';
import ReviewProgressBar from '@/components/daily-review/ReviewProgressBar.vue';
import { useAuth } from '@/composables/hooks/useAuth';
import { useDailyReviewApi } from '@/composables/useDailyReviewApi';

const route = useRoute(); const router = useRouter();
const auth = useAuth(); const api = useDailyReviewApi(); const msg = useMessage();
const tradeDate = route.params.tradeDate as string;
const row = ref<any>(null);

async function load() { row.value = await api.detail(tradeDate); }
onMounted(load);

async function regenerate() {
  await api.create(tradeDate); msg.success('已重新触发'); await load();
}
async function remove() {
  await api.remove(tradeDate); msg.success('已删除'); router.push({ name: 'daily-review' });
}
function copyMd() {
  navigator.clipboard.writeText(row.value.articleMd); msg.success('已复制 Markdown');
}
function downloadMd() {
  const blob = new Blob([row.value.articleMd], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `${tradeDate}.md`; a.click();
}

const menuOptions = computed(() => [
  { label: '复制 Markdown', key: 'copy' },
  { label: '下载 .md',      key: 'download' },
  ...(auth.isAdmin.value ? [
    { label: '重新生成', key: 'regen' },
    { label: '删除',     key: 'remove' },
  ] : []),
]);
function onMenu(key: string) {
  if (key === 'copy') copyMd();
  if (key === 'download') downloadMd();
  if (key === 'regen') regenerate();
  if (key === 'remove') remove();
}
</script>
<style scoped>
.page { padding: 16px 24px; }
.page-header { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
.title { font-size: 18px; font-weight: 600; margin-right: auto; }
.reasoning { white-space: pre-wrap; font-family: monospace; font-size: 12px; max-height: 400px; overflow: auto; }
</style>
```

- [ ] **Step 2：build + 手动验证**

```
pnpm --filter @cryptotrading/web build
```

启动 web + server，admin 登录，点击「新增复盘」选今天 → 列表出现「生成中」 → 详情页看进度条 → 完成后看文章。

- [ ] **Step 3：commit**

```
git commit -am "feat(web/daily-review): 详情视图 + admin 操作"
```

---

## 自检（Self-Review）

### 1. Spec coverage

| Spec 章节 | 对应 Task |
|---|---|
| §4.1 实体 | Task 1.1 |
| §4.2 SnapshotPayload | Task 1.3 |
| §5.1 REST | Task 1.6, 4.3 |
| §5.1 SSE | Task 4.3 |
| §5.2 模块结构 | PR-1 ~ PR-4 |
| §5.3 五阶段 | Task 4.2 |
| §5.4 DeepSeek 调用 | Task 3.2 |
| §5.5 错误处理 | Task 2.1（缺数据 422）、Task 4.2（pipeline 异常）、Task 4.3（409 并发） |
| §6 前端 | PR-5 + PR-6 |
| §6.8 SSE 事件结构 | Task 1.3 + Task 5.3 |
| §7 前置数据缺口 | PR-0 |
| §8 migration | Task 1.2 |
| §9 配置 | Task 3.3 |
| §10 测试 | Task 2.x / 3.2 / 4.2 |

### 2. 占位符扫描

- 「按 PR-0 笔记填」出现在 Task 2.3、2.5、3.3 — **保留**，因为这些是 PR-0 调研产物的真实依赖；执行 PR-2/3 前必须先完成 PR-0
- 「AdminOnly 装饰器路径」在 Task 4.3 — 在 PR-0 Task 0.4 中应一并记录；如执行时发现项目无此装饰器，按 CLAUDE.md NestJS 规范用 metadata + 全局 AuthGuard 实现

### 3. 类型一致性

- `SnapshotPayload`、`ProgressEvent`、`DailyReviewStatus` 在前后端各定义一次（后端 Task 1.3，前端 Task 5.1），字段一致
- DeepSeek service 暴露 `modelName` getter（Task 3.2 隐含 + Task 4.2 使用）

---

## 执行选择

计划完整，已落到 `docs/superpowers/plans/2026-05-12-daily-review.md`。两种执行方式：

1. **Subagent-Driven（推荐）** — 我按 task 派发 fresh subagent，task 之间复核
2. **Inline Execution** — 当前会话内按 task 推进，checkpoint 回看

请选择。
