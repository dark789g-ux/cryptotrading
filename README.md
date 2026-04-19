# CryptoTrading

币安 USDT 现货量化交易回测系统。K 线采集 → PostgreSQL 存储 → 策略回测 → Web 可视化。

---

## 技术栈

| 层次 | 技术 |
|------|------|
| 后端 | NestJS + TypeScript + TypeORM + PostgreSQL |
| 前端 | Vue 3 + TypeScript + Vite + Naive UI |
| 包管理 | pnpm monorepo |
| 数据源 | 币安公开 REST API |

---

## 目录结构

```
.
├── apps/
│   ├── server/          # NestJS 后端（:3000）
│   └── web/             # Vue 3 前端（:5173）
├── cache/               # 旧版 CSV K 线缓存（可通过 pnpm migrate:csv 导入 DB）
├── data/                # 运行时配置（策略、同步偏好）
├── doc/                 # 技术文档
├── prd/                 # 产品需求文档
├── test/                # 研究笔记
├── docker-compose.yml          # 开发环境（PostgreSQL）
├── docker-compose.prod.yml     # 生产环境（nginx + server + postgres）
└── nginx.conf           # 生产前端代理配置
```

---

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 启动数据库

```bash
pnpm db:start   # 启动 PostgreSQL Docker 容器
```

> 容器配置了 `restart: unless-stopped`，Docker Desktop 启动后会自动启动数据库，无需手动执行。

**可视化数据库**：推荐 [DBeaver](https://dbeaver.io/)，连接参数：
- Host: `localhost:5432`
- User: `cryptouser` / Password: `cryptopass`
- Database: `cryptodb`

### 3. 启动开发服务

```bash
pnpm dev        # 后端 :3000 + 前端 :5173 并行启动
```

访问 [http://localhost:5173](http://localhost:5173)

### 4. 导入旧 CSV 数据（可选）

```bash
pnpm migrate:csv   # 将 cache/ 中的旧 CSV K 线导入 PostgreSQL
```

---

## 页面说明

| 路径 | 页面 | 功能 |
|------|------|------|
| `/backtest` | 回测 | 策略 CRUD、执行回测、实时进度（SSE）、结果抽屉 |
| `/symbols` | 标的 | 关键字 + 指标条件筛选、分页排序、K 线图 |
| `/sync` | 同步 | 多标的多周期 K 线同步、实时进度推送（SSE） |
| `/watchlists` | 自选列表 | 标的分组管理 |
| `/settings` | 设置 | 全局参数配置 |

---

## 回测策略

默认策略入场条件：

```
close > MA60
AND MA30 > MA60 > MA120
AND close > MA240
AND KDJ.J < 10
→ 下一根 K 线开盘买入
```

- **仓位**：最多 2 个仓位，每仓 45%；两仓均阶段止盈后允许开第 3 仓
- **止盈**：当根最高价突破近期高点时卖出一半
- **止损**：近期低价止损 / 第 3 周期后收盘低于成本 / 第 5 周期后 MACD 未上升 / MACD 方向变化浮动止损

---

## 生产部署

```bash
pnpm build      # 前后端全量构建
pnpm prod:up    # 启动生产三容器（nginx + server + postgres）
```
