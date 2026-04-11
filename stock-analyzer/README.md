# 股票分析系统

基于 Vue3 + TypeScript + NestJS + PostgreSQL 的股票分析平台。

## 功能特性

- 📈 **股票列表**：查看全市场 A 股，支持搜索和分页
- 🔍 **高级筛选**：按技术指标（MA/MACD/KDJ/RSI/布林带）筛选股票
- 📊 **K 线图**：支持日/周/月线，显示均线和成交量
- ⭐ **自选股**：自定义分组管理关注股票
- 🧪 **策略回测**：双均线策略回测，显示收益率、最大回撤等指标
- 🔄 **定时更新**：每日收盘后自动同步数据

## 技术栈

- **前端**：Vue 3 + TypeScript + Pinia + Element Plus + ECharts
- **后端**：NestJS + TypeScript + TypeORM
- **数据库**：PostgreSQL
- **数据源**：Tushare Pro

## 快速开始

### 1. 克隆项目并安装依赖

```bash
cd stock-analyzer
pnpm install
```

### 2. 配置环境变量

创建 `apps/server/.env`：

```env
TUSHARE_TOKEN=你的tushare_token
DB_HOST=localhost
DB_PORT=5432
DB_USER=stockuser
DB_PASS=stockpass
DB_NAME=stockdb
DATA_START_DATE=20200101
UPDATE_TIME=20:00
UPDATE_DAYS=1
```

### 3. 启动数据库

```bash
pnpm db:start
```

### 4. 启动开发服务器

```bash
pnpm dev
```

访问 http://localhost:5173

## 项目结构

```
stock-analyzer/
├── apps/
│   ├── server/          # NestJS 后端
│   │   ├── src/
│   │   │   ├── stocks/      # 股票模块
│   │   │   ├── indicators/  # 技术指标模块
│   │   │   ├── watchlists/  # 自选股模块
│   │   │   ├── backtest/    # 回测模块
│   │   │   └── data-sync/   # 数据同步
│   │   └── ...
│   └── web/             # Vue3 前端
│       ├── src/
│       │   ├── views/       # 页面
│       │   ├── components/  # 组件
│       │   └── api/         # API 接口
│       └── ...
└── docker-compose.yml   # 数据库配置
```

## API 接口

### 股票相关
- `GET /stocks` - 股票列表
- `GET /stocks/search?keyword=xxx` - 搜索股票
- `GET /stocks/filter` - 高级筛选
- `GET /stocks/:tsCode` - 股票详情
- `GET /stocks/:tsCode/prices` - K线数据
- `GET /stocks/:tsCode/indicators` - 技术指标

### 自选股
- `GET /watchlists` - 分组列表
- `POST /watchlists` - 创建分组
- `POST /watchlists/:id/items` - 添加股票
- `DELETE /watchlists/:id/items/:itemId` - 删除股票

### 回测
- `POST /backtest/run` - 执行回测

## 定时任务

- 每日 15:30 自动同步股票列表和日线数据
- 同步完成后自动计算技术指标

## License

MIT
