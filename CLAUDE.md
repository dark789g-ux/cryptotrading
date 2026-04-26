## 项目
crtptotrading:加密量化策略

## 背景
- 开发环境：windows11
- 编码为 GBK

## 硬约束
- 所有源代码文件使用 UTF-8 编码
- 涉及文件 I/O 操作时，始终显式指定 encoding='utf-8'
- 中文文本编辑与乱码处理规范：见 [doc/规范/conventions.md](doc/规范/conventions.md)
- HTML 模板必须包含 <meta charset="UTF-8">
- 数据库连接字符串使用 utf8mb4
- 对象键名使用英文（避免 Windows GBK 终端下中文裸键名解析错误）
- 涉及数据库调整时，应附带 docker exec 格式的可执行脚本。

## 技术栈
- **前端**：Vue 3 + TypeScript + Vite + Naive UI + Vue Router（apps/web）
- **后端**：NestJS 10 + TypeScript + TypeORM（apps/server）
- **数据库**：PostgreSQL（通过 TypeORM 管理，Docker 本地启动）
- **存储 / AI**：腾讯云 COS + OpenAI API
- **包管理**：pnpm workspaces（monorepo）
- **部署**：Docker Compose（`docker-compose.prod.yml`）

## 常用命令
- 查询数据库：`docker exec crypto-postgres psql -U cryptouser -d cryptodb -c ...`

## NOT DO
- 禁在 PowerShell 命令中用 `&&`；正确：`cd apps/web; pnpm exec tsc` 或分两次调用 Shell
- ECharts custom series 禁用 `data.map()` 产生 `null` 项：null 项仍会触发 `renderItem`，`api.value(n)` 返回 `0`，`typeof 0 === 'number'` 绕过空值检查，在 y=0 处生成幽灵柱并破坏 yAxis 量程；必须用 `data.flatMap()` 过滤掉 `null`（见 [ECharts custom series 规范](#echarts-custom-series-规范)）
- ECharts custom series 过滤 null 后禁用 `params.dataIndex` 定位 x：`params.dataIndex` 是过滤后数组的局部索引，与 category 轴错位；应将原始索引 `idx` 存入 data 第 0 维，renderItem 中用 `api.value(0)` 取出作为 x 坐标
- 禁 `any`，改用 `unknown` + 类型收窄
- 禁在 `.vue` / `.ts` / `.css` 中手写 `#xxxxxx` / `rgba(...)` 颜色值，必须到 `apps/web/src/styles/tokens` 里引用
- 原生 SQL ID 参数用 `::text[]`（ID 列均为 `character varying`），禁 `::uuid[]`
- 500 报错：开 TypeORM `logging: ['error','warn']` 并 `logger.error(err.stack)`，禁静态分析猜
- 关闭 `synchronize`
- 禁 `arr[i]||{}` 再读属性（会成 `{}`）
- 禁猜 naive-ui 是否导出某类型（用本地联合或查声明）
- TypeORM：`andWhere` 等字符串里禁 `'[]'::jsonb`（误绑 `:jsonb`），用 `CAST('[]' AS jsonb)`
- 禁同表 `leftJoin` 再 `getManyAndCount`+`orderBy`（0.3 空 metadata）
- 不要设计导出CSV的功能。

## DO
- 优先用 `Naive UI` 组件，禁止自建
- 表头排序走后端接口，禁止前端排序
- 用 `中文` 思考与回答
- 单文件不超过 500 行，模块化拆分
- 大改后类型自检：`apps/server` 执行 `pnpm exec tsc --noEmit`；`apps/web` 执行 `pnpm exec vue-tsc --noEmit`（勿新增报错）
- tokens 中找不到需要的颜色或样式时，必须先 `AskUserQuestion` 向用户确认，禁止擅自新增

## ECharts custom series 规范

基于 Brick 副图柱体不显示的实际踩坑总结：

1. **数据不能含 null 项**  
   custom series `data` 中的 `null` 项仍触发 `renderItem`，`api.value(n)` 对 null 项返回 `0`。用 `typeof x !== 'number'` 无法拦截，结果在 y=0 渲染幽灵柱，破坏 yAxis 自动量程。  
   正确：用 `flatMap` 过滤，只保留有效项。

2. **x 坐标定位不能依赖 params.dataIndex**  
   过滤 null 后，`params.dataIndex` 是新数组的局部下标，与 category 轴原始位置错位。  
   正确：将原始数组索引 `idx` 存入 data 第 0 维，renderItem 中用 `api.value(0)` 取出。

3. **多系列共享 yAxis 会压缩量程**  
   若值域差异悬殊的系列共用同一 yAxis（如 BRICK 值 ~4.5、DELTA 值 ~1），yAxis 自动缩放至最大范围，导致差值小的系列柱体几乎不可见。  
   正确：各系列按值域绑定独立 yAxis（`position: 'right'` 叠加在同一 grid）。

## 时间规范
- DB 时间列一律 `timestamptz`，禁 `timestamp`（无 TZ 列遇 JS Date 会按 Node 本地 TZ 落库，与 UTC 错位）。
- 入库一律传 JS `Date`（UTC 瞬时）；字符串入参 `'YYYY-MM-DD HH:MM:SS'` 视为 UTC 墙钟，`new Date(s.replace(' ','T')+'Z')`。
- 出参一律 UTC 墙钟字符串：`getUTCxxx` 拼装，禁 `toLocaleString`/`toISOString().slice`。
- 裸 SQL 比对 `timestamptz` 列：`col = $n::timestamptz`，禁 `AT TIME ZONE`、禁 `::timestamp` 中转。
- 跨进程/容器假设 Node TZ 不可控，绝不用 `getHours/getMonth` 等本地方法落库或入 SQL。

## UI / UX
- UI 设计规范参考 @.prompts/misc/DESIGN-binance.md
- K 线图参考 @apps/web/src/components/backtest/KlineChartModal.vue
- 样式统一走 @apps/web/src/styles/design-system.css；需新增 token 时须先与用户确认

## 表格开发规范
- 分页 / 表头排序 / 筛选：全后端；筛与排序基于全量数据。
- 默认勿行点；交互放 `操作` 列。
- 排序：`n-data-table` 内置。
- 远程：未点表头时列 `sortOrder` 恒 false（无假高亮）；请求可仍带默认 `sortBy`/`sortOrder`。
- `explicitSort`：辨默认与点击（同默认同列同向亦显式须亮）。清序或重置筛 → 默认且 `explicitSort=false`；仅筛不改。`runId` 缓存须含 `explicitSort`。
- 表格默认带分页器，有[10,20,50]3个选项，默认为10

### n-data-table `remote` 模式分页规范（经验教训）
`n-data-table` 开启 `remote` 后，组件**不会**接管任何数据或分页状态的管理，所有行为必须由调用方显式控制。以下规范由实际踩坑总结：

1. **必须显式监听分页事件**  
   必须同时绑定 `@update:page` 和 `@update:page-size` 事件处理器，在回调中手动更新响应式状态（如 `page.value`、`pageSize.value`），并触发重新加载。  
   错误示例：只绑定 `@update:sorter`，不处理分页事件 → 分页器点击后数值不更新。

2. **`pagination` 必须包含 `itemCount`**  
   `remote` 模式下分页器依赖 `itemCount` 计算总页数和翻页按钮状态。缺少该字段会导致分页器显示异常。  
   正确：`pagination` computed 中始终包含 `itemCount: total.value`。

3. **`:data` 必须是当前页数据，组件不做切片**  
   `remote=true` 时，Naive UI 假设 `:data` 已经是后端分页后的当前页数据，**不会**自动根据 `page`/`pageSize` 做 slice。  
   若后端未分页而前端声明 `remote=true`，表格将始终展示全部行，出现"分页器变了但行数不变"的脱节现象。

4. **前后端分页接口必须对齐**  
   前端使用 `remote` 即承诺后端已分页。后端接口必须：
   - 接收 `page`/`pageSize`（或 `skip`/`take`）参数
   - 返回统一的分页结构，如 `{ rows, total, page, pageSize }`
   - 优先使用项目中已有模式（TypeORM `findAndCount`、QueryBuilder `skip`/`take` + `getManyAndCount`、原生 SQL `LIMIT`/`OFFSET`）

5. **新增分页表格前，先参考已有实现**  
   前端参考 `SymbolsView.vue`、`BacktestDetail.vue`（`page`/`pageSize`/`total` ref + computed `paginationState`）；  
   后端参考 `candle-log.controller.ts`、`symbols.service.ts`（统一返回 `{ rows, total, page, pageSize }`）。
