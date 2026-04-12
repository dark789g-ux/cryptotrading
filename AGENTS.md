# AGENTS.md — cryptotrading

> **L1（始终加载）**：全局定位与规范。编写代码前先读对应子目录的 AGENTS.md（L2），按需读取源文件（L3）。
> 最后更新：2026-04-13（本轮更新）

---

## 项目定位

基于币安 USDT 现货行情的本地回测平台：**K 线采集 → PostgreSQL 存储 → 策略回测 → Web 可视化**。

- **后端**：NestJS + TypeScript + TypeORM + PostgreSQL（`apps/server/`）
- **前端**：Vue 3 + TypeScript + Vite + Naive UI（`apps/web/`）
- **包管理**：pnpm monorepo

---

## 目录索引

| 路径 | L2 文档 | 说明 |
|------|---------|------|
| `apps/server/` | [AGENTS.md](apps/server/AGENTS.md) | NestJS 后端、回测引擎、数据同步 |
| `apps/web/` | [AGENTS.md](apps/web/AGENTS.md) | Vue 3 前端、SSE composables、页面 |
| `test/` | [AGENTS.md](test/AGENTS.md) | 研究笔记，非自动化测试 |
| `cache/` | — | 旧版 CSV 缓存（可通过 `pnpm migrate:csv` 导入 DB） |
| `prd/` | — | 产品需求文档 |

---

## 全局规范

### 语言与风格
- 项目语言：TypeScript（后端 NestJS，前端 Vue 3）
- 变量/函数：camelCase；数据库列名：snake_case（TypeORM `@Column({ name: 'snake_case' })`）
- 不写多余注释；逻辑不自明时才注释
- 不加推测性抽象、不加未被需求覆盖的功能

### 后端约定
- **AI 编程时**：`apps/server/package.json` 的 `dev` 脚本用 `nest start`（不带 `--watch`），避免批量改文件触发频繁重启；日常调试可改回 `--watch`
- **开发阶段禁止 `nest build`**：直接重启 `nest start` 即可，build 是生产步骤
- 新模块按 `module/service/controller` 三件套组织，在 `AppModule` 导入
- API 路径前缀统一加 `/api`（main.ts `setGlobalPrefix`）
- SSE 响应用 `Subject<SseEvent>` + NestJS `@Sse` 装饰器
- TypeORM 开发环境 `synchronize: true`；生产环境关闭，手写迁移
- 批量写入用 `upsert`（冲突列作为 `conflictPaths`）

### 前端约定
- API 调用集中在 `composables/useApi.ts`，不在组件内直接 fetch
- SSE 统一用 `composables/useSSE.ts`（fetch streaming，支持 POST body）
- **设计系统**：Ember Studio 暖色大地色调（赤陶土 `#C2410C` + 琥珀 `#F59E0B`），仅浅色模式 [→ 详见](doc/ember-studio-design-system.md)
- 样式用 Naive UI 组件 + `glassmorphism.css` 中的 `--ember-*` CSS 变量；新代码用 `--ember-*` 而非旧 `--glass-*`
- Naive UI 主题覆盖配置 `GlobalThemeOverrides` 时需查类型定义确认属性是否存在 [→ 详见](doc/naive-ui-theme-override-types.md)
- Naive UI **未配置自动导入**，模板中每个 `n-xxx` 组件必须手动 import [→ 详见](doc/naive-ui-manual-import.md)
- 字体：Playfair Display（标题）+ Source Sans 3（正文）+ Fira Code（代码），通过 Google Fonts 加载
- `useTheme` composable 仅导出 `echartsTheme`，无深色模式相关 API

### Git 约定
- commit message 用中文或英文均可，一行说清楚做了什么
- 不提交 `apps/server/.env`

---

## 环境约定

- **Docker**：必须用 `docker compose`（空格，v2），不能用 `docker-compose`（连字符，v1）[→ 详见](doc/docker-compose-v2.md)
- **Docker Desktop**：需要 v4.68.0+，旧版（v4.19.0）有引擎通信 bug [→ 详见](doc/docker-desktop-bad-response.md)
- **PostgreSQL**：只跑在 Docker 容器里（`pnpm db:start`），后端/前端直接在本机跑 Node.js
- **Vite**：已配置 `server.open: true`，`pnpm dev` 自动打开浏览器

---

## 踩坑记录

- **Docker Bad response**：v4.19.0 引擎通信失败，升级到 v4.68.0+ 解决 [→ 详见](doc/docker-desktop-bad-response.md)
- **CSV close_time 解析**：`close_time` 是毫秒时间戳字符串，需 `new Date(Number(r.close_time))` [→ 详见](doc/csv-closetime-parse.md)
- **docker compose v2**：Windows 新环境无 `docker-compose` 命令，package.json 中必须用空格写法 [→ 详见](doc/docker-compose-v2.md)
- **Naive UI 组件未注册**：新建 Vue 组件时忘记 import Naive UI 组件，运行时报 `Failed to resolve component` [→ 详见](doc/naive-ui-manual-import.md)
- **symbols/query DTO 字段名**：前端字段 `search/pageSize/sortKey+sortOrder` 与后端 `q/page_size/sort:{field,asc}` 不一致致 500，返回值取 `items` 不取 `data` [→ 详见](doc/symbols-query-dto-mismatch.md)
- **keep-alive 匹配失败**：`<script setup>` 组件未显式声明 `name` 时 `keep-alive include` 不生效，必须加 `defineOptions({ name: 'XxxView' })` [→ 详见](doc/keep-alive-component-name.md)
- **symbols/query 返回空指标列**：`querySymbols` 仅在 `fields` 非空时才 SELECT 指标列，前端不传 `fields` 导致所有字段缺失；修复：固定 SELECT 默认列，排序映射改为 camelCase [→ 详见](doc/symbols-query-missing-fields.md)
- **Naive UI 主题覆盖属性不存在**：`Input.borderColor`、`Modal.borderRadius` 等直觉属性在类型定义中不存在，需通过 `common` 层或查看 `.d.ts` 确认 [→ 详见](doc/naive-ui-theme-override-types.md)
- **Edit 工具编辑中文产生乱码**：替换含中文的行时边界可能切断 UTF-8 多字节字符，产生 `��` 乱码；编辑后必须检查结果 [→ 详见](doc/edit-tool-cjk-mojibake.md)
