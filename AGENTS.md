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

## DO
- 动手前用 `AskUserQuestion` 确认真实需求
- 优先用 `Naive UI` 组件，禁止自建
- 表头排序走后端接口，禁止前端排序
- 用 `中文` 思考与回答
- 安装前端包：`cd apps/web && pnpm add ...`（在 bash 中执行）
- 单文件不超过 500 行，模块化拆分
- 编辑文件用 StrReplace / Write，禁止 PowerShell 文本处理

## 表格开发规范
- 表格必须支持分页、表头排序、筛选，且全部走后端接口
- 筛选、排序必须基于全量数据
- 除非用户明确要求，否则不要设计行点击交互；统一在 `操作` 列放按钮
- 排序使用 `n-data-table` 内置能力