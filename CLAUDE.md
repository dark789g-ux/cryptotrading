## 项目
crtptotrading:加密量化策略

## 背景
- 开发环境：windows11
- 编码为 GBK
- 我目前的TuShare积分为7000分

## 硬约束
- 用 `中文` 思考与回答
- 所有源代码文件使用 UTF-8 编码
- 涉及文件 I/O 操作时，始终显式指定 encoding='utf-8'
- 中文文本编辑与乱码处理规范：见 [doc/规范/conventions.md](doc/规范/conventions.md)
- HTML 模板必须包含 <meta charset="UTF-8">
- 数据库连接字符串使用 utf8mb4
- 对象键名使用英文（避免 Windows GBK 终端下中文裸键名解析错误）
- 涉及数据库调整时，应附带 docker exec 格式的可执行脚本。

## 技术栈
- **后端**：NestJS 10 + TypeScript + TypeORM（apps/server）
- **数据库**：PostgreSQL（通过 TypeORM 管理，Docker 本地启动）
- **存储 / AI**：腾讯云 COS + OpenAI API
- **包管理**：pnpm workspaces（monorepo）
- **部署**：Docker Compose（`docker-compose.prod.yml`）

## 常用命令
- 查询数据库：`docker exec crypto-postgres psql -U cryptouser -d cryptodb -c ...`

## Shell 规范
- 使用 PowerShell 时禁用 `&&` 连接命令，改用 `;` 或分多行执行

## NestJS 规范
- `AuthGuard` 已通过 `APP_GUARD` 注册为全局守卫，Controller 上**禁止**再加 `@UseGuards(AuthGuard)`（会导致 NestJS 在当前模块上下文解析 Guard 依赖，若未导入 `AuthModule` 则启动报 `Can't resolve dependencies`）。
- **修改 `tsconfig.json` 后必须验证构建入口**：在 `apps/server/tsconfig.json` 中新增/修改 `paths`、`include`、`rootDir` 等影响文件范围的字段后，必须运行 `pnpm --filter @cryptotrading/server build` 并确认 `nest-cli.json` 的 `entryFile` 与实际编译产物路径一致。

## A 股日期规范
- A 股 `trade_date` 存储格式为 Tushare 标准 `YYYYMMDD`（如 `'20260506'`），**禁止直接 `new Date(tradeDate)`**（返回 `Invalid Date`）
- 需要转为 `Date` 对象时，必须先插入分隔符：`` `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00Z` ``
- 仅用于展示时，使用已有的 `formatTradeDate`（前端）或 `formatTradeDateLabel`（后端）工具函数，禁止 `new Date()`

## 第三方 API 集成规范
- **接口名称必须以官方文档为准**，禁止凭变量名、注释或历史代码推断；每次新增/修改第三方 API 调用前先查文档确认接口名、参数名及必填项
- **外部服务返回空数据时必须记 `logger.warn`**：`payload.data === null` 与 `payload.data.items.length === 0` 是两条独立路径，**实现时都要单独 warn**，附带 apiName + 完整 params——曾因只 warn 了 `data=null`、漏掉 `items=[]`，让 Tushare 当日数据未发布或日期参数错误的情况伪装成"同步完成"。用于区分「权限不足/接口名错误」与「合法空结果/日期参数错误」
- **Mock 单测不验证第三方契约**：涉及第三方 API 名称、参数格式的测试，mock 永远通过，必须同时有集成测试或人工核对文档的步骤；若暂无集成测试，需在注释中标注 `// TODO: 需集成测试验证 API 契约`
- **调试第三方 API 返回空的顺序**：① 先查官方文档确认接口名/参数；② 再加日志看真实响应；③ 最后才读内部实现——禁止跳过前两步直接猜
- **`// TODO: 查文档确认` 的接口调用不得视为完成**：含此类注释的代码块不允许合入主干，必须先查文档兑现注释，再提交
- **`.catch(() => [])` 静默吞错禁止用于同步任务**：同步服务的 API 调用失败时，错误必须在响应体的 `errors` 字段中明确透出，并在日志中打印具体 API 名称和错误信息；`success: 0` + 无报错的假象会让数据空白问题极难发现
- **同步任务的 fetcher 返回 0 行必须显式 failedItems**：除 `.catch(()=>[])` 外，"`code=0` + 0 行"是另一种伪装成功——orchestrator **不得**把它当作"数据集已同步"。fetcher 返回空时必须 push 到响应体的 `errors`/`failedItems`（apiName 标 `xxx_empty`，例 `daily_empty`/`adj_factor_empty`/`no_open_trade_dates`），让"日期参数错误"和"当日数据未发布"在 UI 上立即可见——曾因 fetcher 0 行被计为"已同步"，导致前端显示 `同步完成：标的 5515，日线 0，每日指标 0，复权因子 0，技术指标 0` 这种"伪装成功"形态，用户无法判断是参数错了还是数据没发布

## NOT DO
- 原生 SQL 数组参数强转须与列类型匹配：`character varying` 列用 `::text[]`，`uuid` 列用 `::uuid[]`（如 `watchlist_items.watchlist_id` 是 `uuid`，误用 `::text[]` 会 500）
- 500 报错：开 TypeORM `logging: ['error','warn']` 并 `logger.error(err.stack)`，禁静态分析猜
- 关闭 `synchronize`
- TypeORM：`andWhere` 等字符串里禁 `'[]'::jsonb`（误绑 `:jsonb`），用 `CAST('[]' AS jsonb)`
- 禁同表 `leftJoin` 再 `getManyAndCount`+`orderBy`（0.3 空 metadata）
- 动态 SQL 构建**禁止**直接将前端字段名拼入 SQL（如 `i.${field}`）；必须经过字段名映射表翻译为实际列名，未命中映射的字段一律跳过并记 `logger.warn`
- **TypeORM `upsert` 前必须去重**：`repo.upsert(entities, conflictKeys)` 前须按 `conflictKeys` 对 `entities` 去重（保留最后一条）。PostgreSQL `ON CONFLICT DO UPDATE` 在同一批次内遇到两行冲突键相同的记录会直接报 `ON CONFLICT DO UPDATE command cannot affect row a second time`（500）。第三方 API 返回重复行时需记 `logger.warn` 并注明原始条数与去重后条数，以便后续核查 API 数据语义是否需要扩展实体联合主键。
- **数据集完整性检查的最弱可接受标准**：判断"某日数据集是否完整"必须满足以下两条，缺一不可：
  1. **行级硬约束**：所有业务上不允许 NULL 的列在该日**每一行**都非空（如 daily 的 OHLC、adj_factor 的 `adj_factor`）；合法 NULL 列（如 PE/PB 对亏损股、turnover_rate 对停牌股）不得放进硬约束
  2. **跨表行数对齐**：派生数据集的当日行数必须 `>=` 基础数据集（如 `count(adj_factor for date) >= count(daily_quotes for date)`，`count(daily_metrics for date) >= count(daily_quotes for date)`）
  "至少一行非空"（`COUNT(*) FILTER (WHERE col IS NOT NULL) > 0`）是无意义的最弱约束——曾让 A 股增量同步在数据残缺时仍判为完整、跳过补齐。
- **K 线副图对齐 key 不得假设两个后端接口的日期格式同源**：`KlineChart` 副图通过 `flowMap.get(row.open_time)` 按 `trade_date` 对齐主图，**主图 `open_time` 与副图 `trade_date` 的字符串必须按字面完全相等才能命中**。当前各后端 service 实际拼出的格式互不相同：
  - `apps/server/src/market-data/ths-index-daily/ths-index-daily.service.ts:93`（行业/板块 K 线）：`open_time` 直返 `'YYYYMMDD'`
  - `apps/server/src/market-data/a-shares/a-shares.service.ts:221`（A 股 K 线）：`open_time` 经 `formatTradeDateLabel` 转成 `'YYYY-MM-DD'`
  - `apps/server/src/market-data/money-flow/money-flow.service.ts`（资金流各维度）：`tradeDate` 直返数据库原值 `'YYYYMMDD'`
  
  新接入"K 线 + moneyFlow 副图"组合前，**先打开两侧后端 service 看 `open_time` / `tradeDate` 实际拼出的字符串**，格式不同时**由前端 fetcher 层**显式归一化（参考 `aShareDetailFetcher.ts` 的 `toIsoTradeDate`）；**禁止**让 `KlineChart` 容忍多种格式（掩盖契约不一致）或冲动改后端（影响面失控）。曾因 `mapMoneyFlowBars` 原样透传 `'20260515'` 而 A 股 K 线 `open_time` 是 `'2026-05-15'`，副图 `flowMap` 100% miss、所有 series data 都是 `null`——但 `hasFlow` 守卫只是非空判断，ECharts 仍按副图建了 grid/legend/yAxis，**柱形完全画不出却 grid/图例都在**，比直接报错更难发现。行业 Tab 当年没踩同一坑是因为 `ths-index-daily` 也直返 `'YYYYMMDD'`，与资金流凑巧同源——这种"凑巧"不是契约。

## Vue 3 watch 规范
- `watch(source, cb)` 默认**懒执行**，不响应初始值；若逻辑依赖初始值，必须加 `{ immediate: true }` 或在 `onMounted` 中补充调用
- 凡组件内有"开启时触发异步加载"的逻辑，均须检查父组件是用 `v-if`（挂载即展示）还是 `v-show`（常驻切换），选择正确的触发时机
- **`<keep-alive>` 组件规范**：被 `<keep-alive>` 包裹的组件，`onMounted` 只在首次挂载时触发一次，切换回来不会重跑；凡依赖"外部 store 可能在其它页面被更新"的异步数据加载（如策略命中结果、用户配置），必须放在 `onActivated` 中——它在首次挂载和每次从缓存激活时都会触发。`onMounted` 仅保留真正的一次性初始化（注册事件、加载用户偏好等）。排查方法：在父组件中搜索 `<keep-alive>`。
- **keep-alive 响应性陷阱**：`computed` 会响应 store 变化（UI 下拉框等显示正确），而用 `onMounted` 加载的普通 `ref` 不会自动刷新，两者响应性不对称会制造"下拉框有选项但数据不更新"的假象，遇到此类 Bug 优先排查 keep-alive 缓存。

## DO
- 单文件不超过 500 行，模块化拆分
- Modal 组件优先复用 `@/components/common/AppModal.vue`，避免直接使用 `n-modal`
- Modal 按钮控制权单一归属：使用 AppModal 时，操作按钮统一放在 `#actions` slot，子组件内部禁止自带"保存/取消"按钮，避免双重按钮问题
- **条件/表达式构建器的设计原则**：凡是涉及"比较"的 UI（条件筛选、策略规则、阈值配置等），比较目标必须同时支持**字段引用**（指标/属性）和**常量值**（用户直接输入数值）两种类型，由用户自行选择，禁止硬编码为单一类型
- **动态字段映射规范**：新增支持用户选字段的查询模块时，必须：① 建立 `FIELD_COL_MAP`（前端字段名 → `表别名.列名`）；② 跳过未知字段时记 `logger.warn`；③ 针对有前提约束的操作符（如上穿/下穿仅限单表指标），在映射表层面校验字段所属表，不满足则 warn + skip；④ 前端操作符列表须同步反映约束（`disabled`），不能仅靠后端防御
- **修改文件结构性区域后必须立即回读**：凡涉及 import 块、模块顶层声明的编辑，操作完成后须立即读取文件头部验证顺序正确，不得依赖 linter 代替人工确认
- **Naive UI 自定义选项类型**：自定义接口用于 `<n-select :options>` 时必须 `extends SelectOption`（`import type { SelectOption } from 'naive-ui'`），禁止重新声明 `label/value` 字段，否则与 `SelectMixedOption` 判别联合不兼容导致 vue-tsc 报错

## 时间规范
- DB 时间列一律 `timestamptz`，禁 `timestamp`（无 TZ 列遇 JS Date 会按 Node 本地 TZ 落库，与 UTC 错位）。
- 入库一律传 JS `Date`（UTC 瞬时）；字符串入参 `'YYYY-MM-DD HH:MM:SS'` 视为 UTC 墙钟，`new Date(s.replace(' ','T')+'Z')`。
- 出参一律 UTC 墙钟字符串：`getUTCxxx` 拼装，禁 `toLocaleString`/`toISOString().slice`。
- 裸 SQL 比对 `timestamptz` 列：`col = $n::timestamptz`，禁 `AT TIME ZONE`、禁 `::timestamp` 中转。
- 跨进程/容器假设 Node TZ 不可控，绝不用 `getHours/getMonth` 等本地方法落库或入 SQL。
- **日期选择器是本地 TZ 例外**：上述 UTC 要求**只约束 DB 入库瞬时与裸 SQL 比对**，不适用于"用户从日期选择器选的日历日"。naive-ui `n-date-picker` 的 `[number, number]` 值是**本地午夜 ms**——把它用 `getUTCFullYear/getUTCMonth/getUTCDate` 提取年月日，会让 CST 用户选的日期整体漂前 1 天（曾因此把 `20260509-20260511` 在传给后端时压成 `20260508-20260510`，导致整次同步看似完成实则一行未写）。日历日提取一律用 `getFullYear/getMonth/getDate`；`buildDefaultDateRange` 类工具同样用 `new Date(y,m,d).getTime()` 取本地午夜，不要 `Date.UTC(...)`。后端 `timestamptz` 展示函数（如 `formatUTCDate`/`formatUTCDateTime`）仍按 UTC 规则。