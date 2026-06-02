# AMV 一键同步接线 + 概念板块扶正为一级类别 — 设计

> 创建日期：2026-06-02 ｜ 状态：待实现 ｜ 关联前序：
> [`../2026-06-01-active-mv-stock-industry-design.md`](../2026-06-01-active-mv-stock-industry-design.md)（个股/行业 AMV 原设计）

## 背景与目标

`OneClickSyncPanel`（一键同步）当前第 4 步"活跃市值 0AMV"**只算大盘单一指数 `930903.CSI`**
（走 `POST /api/oamv/sync`）。个股 AMV、行业指数 AMV、概念板块 AMV 虽已实现并落库，却
**都没接进一键同步**。

更深的问题：`IndustryAmvService.resolveIndexCodes()` 只按 `.TI` 后缀扫成分股、**不按 type 过滤**，
导致行业指数（`ths_index_catalog.type='I'`）和概念板块（`type='N'`）的 AMV 被**一锅塞进同一张
`industry_amv_daily` 表**（真 DB：I=36420 行/588 个，N=24466 行/396 个）。"概念板块"在数据层、
查询层、前端展示层都和行业混淆，用户无法区分。

> 术语已落真 DB 核实：`type='N'` 的指数名为"人工智能/数字货币/特斯拉概念/NFT概念/光伏概念"等，
> **就是同花顺概念/题材板块**，即用户语境里的"板块指数"。`type='I'` 为"白酒Ⅲ/风电整机/
> 汽车与汽车零部件(A股)"等行业指数。

**本设计的两个目标：**

1. **接线**：把个股 / 行业 / 概念 AMV 计算接进一键同步（按日增量），并把误导性的
   "活跃市值 0AMV"步骤标签改为"大盘 0AMV"。
2. **扶正**：把概念板块（`type='N'`）从行业里**拆出来成一级类别**——独立表 `concept_amv_daily`、
   独立端点 `/api/active-mv/concept/*`、前端独立展示，并修复 `resolveIndexCodes` 的"无 type 过滤"病根。

数据模型采用 **方案 B（双表）**：物理隔离、表名诚实、镜像项目既有
`money_flow_industry` / `money_flow_sector` 双表惯例。

## 子文档清单与阅读顺序

| 顺序 | 文档 | 内容 |
|------|------|------|
| 1 | [`./01-oneclick-sync-wiring.md`](./01-oneclick-sync-wiring.md) | 接线：一键同步新增 AMV 步骤、步骤重命名、耗时/timeout 处理 |
| 2 | [`./02-backend-concept-firstclass.md`](./02-backend-concept-firstclass.md) | 扶正后端：新表、service 参数化、`resolveIndexCodes` type 过滤、新端点、fail-fast |
| 3 | [`./03-migration.md`](./03-migration.md) | 迁移：建表 + 搬 24466 行 N 数据 + 行数对齐校验（含 docker exec 脚本） |
| 4 | [`./04-frontend.md`](./04-frontend.md) | 前端：板块 tab 补 0AMV 副图、API 封装、待核实的 ts_code 同源性 |
| 5 | [`./05-task-split-and-verification.md`](./05-task-split-and-verification.md) | 并行任务的无重叠文件域切分 + 验证门槛 |

建议先读 `index.md`（本文）→ `02`（核心架构）→ `03`（迁移）→ `01` → `04` → `05`。

## 跨文档引用约定

两种引用各管一边，不混用：

- **文档间引用**：用相对路径**只链到文件**（如 [`./02-backend-concept-firstclass.md`](./02-backend-concept-firstclass.md)），
  不带中文标题锚点——中文 `#锚点` 在多数渲染器下 slug 规则不一、跳不准；子文档够短，定位到文件即可。
- **代码引用**：用 `file_path:line_number` 形式（如 `industry-amv.service.ts:168-181`），终端内可点击直达。

## 已核实事实（写入硬断言/迁移前的真源依据）

- `ths_index_catalog` 有 `ts_code` / `type`('I'|'N') / `name` 列（`apps/server/src/entities/index-catalog/ths-index-catalog.entity.ts:21-22`）。
- `ths_member_stocks` **无 type 列**（仅 `ts_code` / `con_code` / `con_name`），故按 type 过滤
  **必须 join `ths_index_catalog`**（`apps/server/src/entities/money-flow/ths-member-stock.entity.ts`）。
- join 键 `ths_member_stocks.ts_code = ths_index_catalog.ts_code` 已真 DB 验证（588 I / 396 N 有成分股）。
- `industry_amv_daily` 当前真 DB 行数：`type='I'` 36420 行、`type='N'` 24466 行。
- AMV 同步端点均为**普通 POST**（非 SSE）；个股全量 ~4000 只最坏 ~13 分钟。

## 实现前必做的真源核对（不得带假设进代码）

1. 写 `resolveIndexCodes` 的 `c.type=:type` 过滤前，亲查真 DB 一条样本确认 join 命中。
2. 前端把概念 AMV 副图挂到"板块"tab 前，**核实 `SectorFlowPanel` 行的 ts_code 是否就是
   THS `type='N'` 的 `.TI` 指数代码**（详见 `04-frontend.md`）。若编码不同源，另接入口、不强挂。
3. 迁移脚本执行后必跑行数对齐校验（详见 `03-migration.md`）。
