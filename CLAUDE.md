## 项目
crtptotrading:加密量化策略

## 背景
- 开发环境：windows11

## 硬约束
- 所有源代码文件使用 UTF-8 编码
- 涉及文件 I/O 操作时，始终显式指定 encoding='utf-8'
- HTML 模板必须包含 <meta charset="UTF-8">
- 数据库连接字符串使用 utf8mb4
- 对象键名使用英文（避免 Windows GBK 终端下中文裸键名解析错误）
- 不要自己测试，用户来测试

## 技术栈
- **前端**：Vue 3 + TypeScript + Vite + Naive UI + Vue Router（apps/web）
- **后端**：NestJS 10 + TypeScript + TypeORM（apps/server）
- **数据库**：PostgreSQL（通过 TypeORM 管理，Docker 本地启动）
- **存储 / AI**：腾讯云 COS + OpenAI API
- **包管理**：pnpm workspaces（monorepo）
- **部署**：Docker Compose（`docker-compose.prod.yml`）

## 常用命令
- 开发：`pnpm run dev`
- 构建：`pnpm run build`
- 查询数据库：`docker exec crypto-postgres psql -U cryptouser -d cryptodb -c ...`

## NOT DO
- 禁 `any`，改用 `unknown` + 类型收窄
- 错误必须反馈用户，不得静默
- 禁用 `git log` / `git diff` 查历史
- 禁在 PowerShell 用 `&&`
- 原生 SQL ID 参数用 `::text[]`（ID 列均为 `character varying`），禁 `::uuid[]`
- 500 报错：开 TypeORM `logging: ['error','warn']` 并 `logger.error(err.stack)`，禁静态分析猜
- 关闭 `synchronize`
- 禁 `arr[i]||{}` 再读属性（会成 `{}`）
- 禁猜 naive-ui 是否导出某类型（用本地联合或查声明）
- TypeORM：`andWhere` 等字符串里禁 `'[]'::jsonb`（误绑 `:jsonb`），用 `CAST('[]' AS jsonb)`
- 禁同表 `leftJoin` 再 `getManyAndCount`+`orderBy`（0.3 空 metadata）

## DO
- 动手前用 `AskUserQuestion` 确认真实需求
- 优先用 `Naive UI` 组件，禁止自建
- 表头排序走后端接口，禁止前端排序
- 用 `中文` 思考与回答
- 安装前端包：`cd apps/web && pnpm add ...`（在 bash 中执行）
- 单文件不超过 500 行，模块化拆分
- 大改后类型自检：`apps/server` 执行 `pnpm exec tsc --noEmit`；`apps/web` 执行 `pnpm exec vue-tsc --noEmit`（勿新增报错）
- 编辑文件用 StrReplace / Write，禁止 PowerShell 文本处理

## 时间规范
- DB 时间列一律 `timestamptz`，禁 `timestamp`（无 TZ 列遇 JS Date 会按 Node 本地 TZ 落库，与 UTC 错位）。
- 入库一律传 JS `Date`（UTC 瞬时）；字符串入参 `'YYYY-MM-DD HH:MM:SS'` 视为 UTC 墙钟，`new Date(s.replace(' ','T')+'Z')`。
- 出参一律 UTC 墙钟字符串：`getUTCxxx` 拼装，禁 `toLocaleString`/`toISOString().slice`。
- 裸 SQL 比对 `timestamptz` 列：`col = $n::timestamptz`，禁 `AT TIME ZONE`、禁 `::timestamp` 中转。
- 跨进程/容器假设 Node TZ 不可控，绝不用 `getHours/getMonth` 等本地方法落库或入 SQL。

## 表格开发规范
- 分页 / 表头排序 / 筛选：全后端；筛与排序基于全量数据。
- 默认勿行点；交互放 `操作` 列。
- 排序：`n-data-table` 内置。
- 远程：未点表头时列 `sortOrder` 恒 false（无假高亮）；请求可仍带默认 `sortBy`/`sortOrder`。
- `explicitSort`：辨默认与点击（同默认同列同向亦显式须亮）。清序或重置筛 → 默认且 `explicitSort=false`；仅筛不改。`runId` 缓存须含 `explicitSort`。
- 无 CSV；分页默认 10。