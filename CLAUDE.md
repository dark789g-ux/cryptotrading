## 项目
crtptotrading:加密量化策略

## 背景
- 开发环境：windows11
- 编码为 GBK

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

## NOT DO
- 原生 SQL 数组参数强转须与列类型匹配：`character varying` 列用 `::text[]`，`uuid` 列用 `::uuid[]`（如 `watchlist_items.watchlist_id` 是 `uuid`，误用 `::text[]` 会 500）
- 500 报错：开 TypeORM `logging: ['error','warn']` 并 `logger.error(err.stack)`，禁静态分析猜
- 关闭 `synchronize`
- TypeORM：`andWhere` 等字符串里禁 `'[]'::jsonb`（误绑 `:jsonb`），用 `CAST('[]' AS jsonb)`
- 禁同表 `leftJoin` 再 `getManyAndCount`+`orderBy`（0.3 空 metadata）
- 动态 SQL 构建**禁止**直接将前端字段名拼入 SQL（如 `i.${field}`）；必须经过字段名映射表翻译为实际列名，未命中映射的字段一律跳过并记 `logger.warn`

## DO
- 单文件不超过 500 行，模块化拆分
- Modal 组件优先复用 `@/components/common/AppModal.vue`，避免直接使用 `n-modal`
- Modal 按钮控制权单一归属：使用 AppModal 时，操作按钮统一放在 `#actions` slot，子组件内部禁止自带"保存/取消"按钮，避免双重按钮问题
- **条件/表达式构建器的设计原则**：凡是涉及"比较"的 UI（条件筛选、策略规则、阈值配置等），比较目标必须同时支持**字段引用**（指标/属性）和**常量值**（用户直接输入数值）两种类型，由用户自行选择，禁止硬编码为单一类型
- **动态字段映射规范**：新增支持用户选字段的查询模块时，必须：① 建立 `FIELD_COL_MAP`（前端字段名 → `表别名.列名`）；② 跳过未知字段时记 `logger.warn`；③ 针对有前提约束的操作符（如上穿/下穿仅限单表指标），在映射表层面校验字段所属表，不满足则 warn + skip；④ 前端操作符列表须同步反映约束（`disabled`），不能仅靠后端防御
- **修改文件结构性区域后必须立即回读**：凡涉及 import 块、模块顶层声明的编辑，操作完成后须立即读取文件头部验证顺序正确，不得依赖 linter 代替人工确认

## 时间规范
- DB 时间列一律 `timestamptz`，禁 `timestamp`（无 TZ 列遇 JS Date 会按 Node 本地 TZ 落库，与 UTC 错位）。
- 入库一律传 JS `Date`（UTC 瞬时）；字符串入参 `'YYYY-MM-DD HH:MM:SS'` 视为 UTC 墙钟，`new Date(s.replace(' ','T')+'Z')`。
- 出参一律 UTC 墙钟字符串：`getUTCxxx` 拼装，禁 `toLocaleString`/`toISOString().slice`。
- 裸 SQL 比对 `timestamptz` 列：`col = $n::timestamptz`，禁 `AT TIME ZONE`、禁 `::timestamp` 中转。
- 跨进程/容器假设 Node TZ 不可控，绝不用 `getHours/getMonth` 等本地方法落库或入 SQL。