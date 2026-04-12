# AGENTS.md — cryptotrading

> **L1（始终加载）**：全局定位与规范。编写代码前先读对应子目录的 AGENTS.md（L2），按需读取源文件（L3）。

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
| `backtest/` | [AGENTS.md](backtest/AGENTS.md) | 旧版 Python 回测库（仅供参考） |
| `test/` | [AGENTS.md](test/AGENTS.md) | 研究笔记，非自动化测试 |
| `cache/` | — | 旧版 CSV 缓存（可通过 `pnpm migrate:csv` 导入 DB） |
| `prd/` | — | 产品需求文档 |

---

## 全局规范

### 语言与风格
- 项目语言：TypeScript（后端 NestJS，前端 Vue 3）；旧 Python 代码只读不改
- 变量/函数：camelCase；数据库列名：snake_case（TypeORM `@Column({ name: 'snake_case' })`）
- 不写多余注释；逻辑不自明时才注释
- 不加推测性抽象、不加未被需求覆盖的功能

### 后端约定
- 新模块按 `module/service/controller` 三件套组织，在 `AppModule` 导入
- API 路径前缀统一加 `/api`（main.ts `setGlobalPrefix`）
- SSE 响应用 `Subject<SseEvent>` + NestJS `@Sse` 装饰器
- TypeORM 开发环境 `synchronize: true`；生产环境关闭，手写迁移
- 批量写入用 `upsert`（冲突列作为 `conflictPaths`）

### 前端约定
- API 调用集中在 `composables/useApi.ts`，不在组件内直接 fetch
- SSE 统一用 `composables/useSSE.ts`（fetch streaming，支持 POST body）
- 样式用 Naive UI 组件 + `glassmorphism.css` CSS 变量；不引入新 UI 库

### Git 约定
- commit message 用中文或英文均可，一行说清楚做了什么
- 不提交 `apps/server/.env`

---

## 常用命令速查

```bash
pnpm dev              # 后端 :3000 + 前端 :5173 并行启动
pnpm db:start         # 启动 PostgreSQL Docker 容器
pnpm migrate:csv      # 从 cache/ 导入旧 CSV 数据到 DB
pnpm build            # 前后端全量构建
pnpm prod:up          # 生产三容器启动（nginx + server + postgres）
```
