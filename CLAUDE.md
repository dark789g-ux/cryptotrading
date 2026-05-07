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

## A 股日期规范
- A 股 `trade_date` 存储格式为 Tushare 标准 `YYYYMMDD`（如 `'20260506'`），**禁止直接 `new Date(tradeDate)`**（返回 `Invalid Date`）
- 需要转为 `Date` 对象时，必须先插入分隔符：`` `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00Z` ``
- 仅用于展示时，使用已有的 `formatTradeDate`（前端）或 `formatTradeDateLabel`（后端）工具函数，禁止 `new Date()`

## 第三方 API 集成规范
- **接口名称必须以官方文档为准**，禁止凭变量名、注释或历史代码推断；每次新增/修改第三方 API 调用前先查文档确认接口名、参数名及必填项
- **外部服务返回空数据时必须记 `logger.warn`**：当外部 API 返回 `code=0` 但 `data=null`/空数组时，不得静默返回 `[]`，须 warn 并附带请求参数，以区分「权限不足」与「合法空结果」
- **Mock 单测不验证第三方契约**：涉及第三方 API 名称、参数格式的测试，mock 永远通过，必须同时有集成测试或人工核对文档的步骤；若暂无集成测试，需在注释中标注 `// TODO: 需集成测试验证 API 契约`
- **调试第三方 API 返回空的顺序**：① 先查官方文档确认接口名/参数；② 再加日志看真实响应；③ 最后才读内部实现——禁止跳过前两步直接猜

## NOT DO
- 原生 SQL 数组参数强转须与列类型匹配：`character varying` 列用 `::text[]`，`uuid` 列用 `::uuid[]`（如 `watchlist_items.watchlist_id` 是 `uuid`，误用 `::text[]` 会 500）
- 500 报错：开 TypeORM `logging: ['error','warn']` 并 `logger.error(err.stack)`，禁静态分析猜
- 关闭 `synchronize`
- TypeORM：`andWhere` 等字符串里禁 `'[]'::jsonb`（误绑 `:jsonb`），用 `CAST('[]' AS jsonb)`
- 禁同表 `leftJoin` 再 `getManyAndCount`+`orderBy`（0.3 空 metadata）
- 动态 SQL 构建**禁止**直接将前端字段名拼入 SQL（如 `i.${field}`）；必须经过字段名映射表翻译为实际列名，未命中映射的字段一律跳过并记 `logger.warn`

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