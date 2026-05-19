# CryptoTrading

量化交易回测系统。支持加密货币（币安）与 A 股（Tushare），覆盖 K 线采集、资金流向监测、策略回测与 Web 可视化。

---

## 技术栈

| 层次 | 技术 |
|------|------|
| 后端 | NestJS 10 + TypeScript + TypeORM + PostgreSQL |
| 前端 | Vue 3 + TypeScript + Vite + Naive UI + ECharts + Pinia |
| 包管理 | pnpm monorepo（含 `packages/shared-types` 共享类型包） |
| 数据源 | 币安公开 REST API / Tushare Pro API |

---

## 目录结构

```
.
├── apps/
│   ├── server/          # NestJS 后端（:3000）
│   └── web/             # Vue 3 前端（:5173）
├── packages/
│   └── shared-types/    # 前后端共享 TypeScript 类型
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

### 2. 拷贝环境变量模板

```bash
cp .env.example .env   # 按需填入 TUSHARE_TOKEN 等敏感项
```

### 3. 启动数据库

```bash
pnpm db:start   # 启动 PostgreSQL Docker 容器
```

> 容器配置了 `restart: unless-stopped`，Docker Desktop 启动后会自动启动数据库，无需手动执行。

**可视化数据库**：推荐 [DBeaver](https://dbeaver.io/)，连接参数：
- Host: `localhost:5432`
- User: `cryptouser` / Password: `cryptopass`
- Database: `cryptodb`

### 4. 启动开发服务

```bash
pnpm dev        # 后端 :3000 + 前端 :5173 并行启动
```

访问 [http://localhost:5173](http://localhost:5173)

### 5. 导入旧 CSV 数据（可选）

```bash
pnpm migrate:csv   # 将 cache/ 中的旧 CSV K 线导入 PostgreSQL
```

---

## 页面说明

| 路径 | 页面 | 功能 |
|------|------|------|
| `/backtest` | 回测 | 策略 CRUD、执行回测、实时进度（SSE）、结果抽屉 |
| `/symbols` | 标的 | 加密货币 + A 股双标签页，关键字 + 指标条件筛选、分页排序、K 线图 |
| `/sync` | 同步 | 多数据源同步中心：加密货币 K 线、A 股日线、资金流向，实时进度推送（SSE） |
| `/watchlists` | 自选列表 | 标的分组管理，支持从指数导入成分股 |
| `/money-flow` | 资金流向 | 大盘 / 行业 / 板块 / 个股资金流向监测，趋势图表与 KPI 卡片 |
| `/strategy-conditions` | 条件扫描 | 策略条件组管理，批量扫描标的命中情况 |
| `/tools` | 工具 | 凯利公式模拟器（蒙特卡洛模拟 + 参数优化） |
| `/settings` | 设置 | 账户安全、用户管理、排除标的、同步默认配置 |
| `/login` | 登录 | 用户登录 |
| `/bootstrap` | 初始化 | 首次启动创建管理员账户 |
| `/invitations/:token` | 邀请注册 | 通过邀请链接注册新用户 |

---

## 数据源

### 币安（加密货币）

- 标的与 K 线数据通过币安公开 REST API 拉取
- 支持周期：`1h`、`4h`、`1d`
- 对应后端模块：`SyncModule`、`SymbolsModule`、`KlinesModule`

### Tushare（A 股）

- A 股标的、日线行情、技术指标、前复权因子通过 Tushare Pro API 拉取
- 支持全量 / 增量同步模式
- 指标在服务端计算（MA、MACD、KDJ 等）
- 需要配置 `TUSHARE_TOKEN` 环境变量
- 对应后端模块：`ASharesModule`

### Tushare（资金流向）

- 大盘资金流向（东方财富）、行业 / 板块 / 个股资金流向（同花顺）
- 按交易日逐日查询，支持日期范围同步
- 对应后端模块：`MoneyFlowModule`

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

## 后端模块

| 模块 | 路径 | 职责 |
|------|------|------|
| AuthModule | `/api/auth` | 会话认证、密码哈希、全局守卫 |
| UsersModule | `/api/users` | 用户管理、邀请码 |
| SymbolsModule | `/api/symbols` | 加密货币标的查询 |
| KlinesModule | `/api/klines` | K 线数据只读查询 |
| SyncModule | `/api/sync` | 加密货币 K 线同步编排 |
| ASharesModule | `/api/a-shares` | A 股数据同步、指标计算、筛选查询 |
| MoneyFlowModule | `/api/money-flow` | 资金流向数据查询与同步 |
| StrategiesModule | `/api/strategies` | 策略 CRUD |
| BacktestModule | `/api/backtest` | 回测执行与结果查询 |
| WatchlistsModule | `/api/watchlists` | 自选列表管理 |
| SymbolPresetsModule | `/api/symbol-presets` | 标的预配置 |
| StrategyConditionsModule | `/api/strategy-conditions` | 条件组扫描 |
| SettingsModule | `/api/settings` | 全局参数配置 |
| PreferencesModule | `/api/preferences` | 用户偏好存储 |

---

## 生产部署

```bash
pnpm build      # 前后端全量构建
pnpm prod:up    # 启动生产三容器（nginx + server + postgres）
```
