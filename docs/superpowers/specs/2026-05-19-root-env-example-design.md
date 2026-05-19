# 根目录 .env.example 与环境变量单源化（Design）

- **日期**：2026-05-19
- **作者**：renmaoyuan（设计 / Claude Opus 4.7 执行）
- **范围**：monorepo 全局
- **目标**：让 cryptotrading 全部环境变量在仓库根唯一定义并被 Node 端与 Python 端共同读取

---

## 1. 背景

当前仓库环境变量分散在 `apps/server/.env(.example)`（NestJS / @nestjs/config）与 `apps/quant-pipeline/.env.example`（Python / pydantic-settings）两处。代码盘点共 **33 个变量**，仅 `TUSHARE_TOKEN` 共用，其余互不相交。子项目模板缺漏严重：`PG_DSN` / `ARTIFACT_DIR` / `LOG_DIR` / `WORKER_*` 从未在任何 `.env.example` 中露出，新开发者只能翻源码补齐。

## 2. 目标与非目标

**目标**：

1. 在仓库根创建 **唯一** `.env.example`，覆盖全部 33 个变量，分域注释；
2. 实际运行时 NestJS server 与 Python quant-pipeline **都** 读取仓库根 `.env`；
3. 旧的子目录 `.env.example` 删除；旧的 `apps/server/.env` 内容迁移到根 `.env` 后删除；
4. `.gitignore` 显式收口根 `.env`，不留歧义。

**非目标**：

- 不引入新的 secret manager / Vault；
- 不改变任何变量的语义、默认值或 NestJS ConfigService 的取值代码；
- 不重写 `apps/server/migrations/*.ps1` 里硬编码的 `crypto-postgres` 容器名（独立议题）；
- 不引入前端 `VITE_*` 变量（目前前端无自定义 env）。

## 3. 关键事实（实施前已核实）

- **NestJS 配置加载**：全局 `ConfigModule.forRoot({ isGlobal: true })`，未显式 envFilePath（[app.module.ts:76](apps/server/src/app.module.ts:76)）
- **main.ts 读 env 时机**：`TRUST_PROXY` / `CORS_ORIGIN` / `SERVER_PORT` 均在 `NestFactory.create()` 之后（[main.ts:8,12,29](apps/server/src/main.ts:8)）
- **Python 加载**：pydantic-settings + `env_file=".env"`（相对 cwd）（[settings.py:14-22](apps/quant-pipeline/src/quant_pipeline/config/settings.py:14)）
- **.gitignore 现状**：第 21 行 `apps/server/.env`；第 164 行通配 `.env`
- **后端构建产物**：`apps/server/dist/main.js`，与 `src/main.ts` 同样向上三级到仓库根

## 4. 文件变更总览

```text
[新增]  /.env.example
[新增]  /.env                           （本地由开发者从 .env.example 拷贝，不入库）

[改]    /.gitignore
[改]    apps/server/src/main.ts
[改]    apps/server/src/app.module.ts
[改]    apps/quant-pipeline/src/quant_pipeline/config/settings.py
[改]    CLAUDE.md                       （"环境" 段落补一句）
[改]    README.md                       （准备工作段落，如已有 .env 步骤则替换路径）

[删]    apps/server/.env                （内容已迁到根 .env）
[删]    apps/server/.env.example
[删]    apps/quant-pipeline/.env.example
```

## 5. 根 `.env.example` 内容设计

按域分 8 节，每个变量一行注释。`[REQ]` 表示启动必填（来自 `ConfigService.getOrThrow`），未标注即可选。

```text
# ═══════════════════════════════════════════════════════════════════
# cryptotrading 环境变量模板
# 用法：cp .env.example .env，按需填入实际值后再启动服务
# ───────────────────────────────────────────────────────────────────
# 加载策略：
#   - Node/NestJS 后端（apps/server）：main.ts 与 ConfigModule 均显式从仓库根 .env 加载
#   - Python quant-pipeline：pydantic-settings 通过绝对路径锁定仓库根 .env
# 标记说明：
#   [REQ] = 必填，未设置启动报错
#   其余皆有默认值，可不填
# ═══════════════════════════════════════════════════════════════════

# ─── [1] PostgreSQL 数据库连接 ────────────────────────────────────
# server 走 DB_*（拼成 TypeORM dataSourceOptions），quant-pipeline 走 PG_DSN（SQLAlchemy URL）
# 两套指向同一个 DB；改 DB 时务必同步两侧
DB_HOST=localhost
DB_PORT=5432
DB_USER=cryptouser
DB_PASS=cryptopass
DB_NAME=cryptodb
PG_DSN=postgresql+psycopg2://cryptouser:cryptopass@localhost:5432/cryptodb

# ─── [2] 服务网络 ────────────────────────────────────────────────
SERVER_PORT=3000
NODE_ENV=development
TRUST_PROXY=loopback
# 逗号分隔多个 origin；留空时回落到 localhost:5173 / 127.0.0.1:5173
CORS_ORIGIN=http://localhost:5173,http://127.0.0.1:5173

# ─── [3] 第三方数据源 API ─────────────────────────────────────────
TUSHARE_TOKEN=<YOUR_TUSHARE_TOKEN>   # [REQ]
TUSHARE_MIN_INTERVAL_MS=200
TUSHARE_MAX_INTERVAL_MS=5000
TUSHARE_CONCURRENCY=5
BINANCE_BASE_URL=https://api.binance.com

# ─── [4] LLM（每日复盘） ─────────────────────────────────────────
# 注：以下 4 项被 DailyReviewModule 用 ConfigService.getOrThrow 强制读取，
# 但仅在 DailyReviewModule 被装载时才触发。当前 AppModule 默认装载该模块，
# 故对所有开发者均视为 [REQ]。如本地仅做行情/回测、不调用复盘接口，
# 可填占位字符串绕过启动期校验（不会触发实际 LLM 调用）。
LLM_API_KEY=<YOUR_LLM_API_KEY>       # [REQ]
LLM_BASE_URL=<YOUR_LLM_BASE_URL>     # [REQ]  例如 https://api.deepseek.com
LLM_PROVIDER=deepseek                # [REQ]  枚举：deepseek | mimo
LLM_MODEL=deepseek-chat              # [REQ]

# ─── [5] 新闻搜索（可选，二者至少配一个否则降级为不联网） ──────────
TAVILY_API_KEY=
SERPER_API_KEY=

# ─── [6] 每日复盘管道 ─────────────────────────────────────────────
DAILY_REVIEW_TOOL_BUDGET=8
DAILY_REVIEW_TOOL_TIMEOUT_MS=15000
DAILY_REVIEW_INVESTIGATOR_TIMEOUT_MS=300000
DAILY_REVIEW_OVERNIGHT_ENABLED=true

# ─── [7] 认证密钥 ────────────────────────────────────────────────
# SSE token 签名密钥按 QUANT_SSE_TOKEN_SECRET → QUANT_SSE_SECRET → JWT_SECRET 顺序兜底
# 首次配置：仅给 QUANT_SSE_TOKEN_SECRET 填一个随机 32B 十六进制串即可，
# 另两项保留空字符串；只要兜底链上至少有一个非空就能启动
# 生成命令（PowerShell）：
#   -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
QUANT_SSE_TOKEN_SECRET=<RANDOM_32B_HEX>
QUANT_SSE_SECRET=
JWT_SECRET=

# ─── [8] Quant Pipeline（Python） ────────────────────────────────
# 产物与日志目录走 POSIX 风格相对路径；相对的是 quant-pipeline 进程 cwd
ARTIFACT_DIR=./artifacts
LOG_DIR=./logs
WORKER_POLL_INTERVAL_SECONDS=2.0
WORKER_HEARTBEAT_INTERVAL_SECONDS=30.0
WORKER_REAPER_INTERVAL_SECONDS=60.0
```

## 6. NestJS 加载机制改动

### 6.1 main.ts 顶部新增 dotenv 主动加载

main.ts 顶部用 6.2 节抽出的常量做 dotenv 主动加载（代码见 6.2 节统一示例）。

**为何不依赖 ConfigModule 即可**：当前 main.ts 在 `NestFactory.create()` 之后才读 `process.env`，ConfigModule 已加载完成，逻辑可工作。但若未来在 create 之前加 logger / proxy 配置，ConfigModule 尚未执行。`dotenv.config` 幂等，主动加载是低成本兜底。

**path 验证**：`__dirname` 在 dev 态 (`apps/server/src`) 和构建后 (`apps/server/dist`) 都是 `apps/server` 下一级，`../../../.env` 均指向仓库根。main.ts 与 app.module.ts 同处 `src/`，**三级 `../../../` 一致，无需分支**。

### 6.2 app.module.ts 的 ConfigModule.forRoot 显式 envFilePath

`app.module.ts` 与 `main.ts` 同处 `apps/server/src/`，`__dirname` 完全相同（开发态都是 `apps/server/src`，构建后都是 `apps/server/dist`），到仓库根**均为 3 级 `../../../`**。**6.1 与 6.2 的层级数一致**。

为避免两处字面常量漂移，统一抽到 `apps/server/src/env-file-path.ts`：

```typescript
// apps/server/src/env-file-path.ts
import * as path from 'path';

// __dirname 在 src/main.ts、src/app.module.ts、以及构建产物
// dist/main.js、dist/app.module.js 中均位于 apps/server 下一级，
// 故统一向上三级到仓库根：
//   apps/server/{src|dist} → apps/server → apps → 仓库根
export const REPO_ENV_PATH = path.resolve(__dirname, '../../../.env');
```

```typescript
// apps/server/src/app.module.ts
import { REPO_ENV_PATH } from './env-file-path';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: REPO_ENV_PATH,
    }),
    // ……
  ],
})
```

```typescript
// apps/server/src/main.ts ── 6.1 节的 dotenv 加载改为复用常量
import * as dotenv from 'dotenv';
import { REPO_ENV_PATH } from './env-file-path';
dotenv.config({ path: REPO_ENV_PATH });

import { NestFactory } from '@nestjs/core';
// ……
```

### 6.3 dotenv 与 @nestjs/config 双加载的兼容性

main.ts 顶部 dotenv 与 ConfigModule.forRoot 内部 dotenv 会先后执行两次。dotenv 默认 `override: false`，先写入的 key 不会被覆盖，两次加载**幂等无副作用**。未来若想让 dotenv 成为唯一来源，可加 `ignoreEnvFile: true`。

依赖：`apps/server/package.json` 已含 `"dotenv": "^16.4.0"`，无需 `pnpm add`。

## 7. Python quant-pipeline 加载机制改动

```python
# apps/quant-pipeline/src/quant_pipeline/config/settings.py
from __future__ import annotations
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# settings.py → config → quant_pipeline → src → quant-pipeline → apps → 仓库根
# = parents[5]
_REPO_ROOT = Path(__file__).resolve().parents[5]
_REPO_ENV = _REPO_ROOT / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_REPO_ENV),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )
    # ……字段保持不变
```

**层级验证步骤**（实施时跑一次确认）：

```powershell
python -c "from pathlib import Path; p = Path('apps/quant-pipeline/src/quant_pipeline/config/settings.py').resolve(); print(p.parents[5])"
# 期望输出：C:\codes\cryptotrading
```

## 8. .gitignore 变更

```diff
 # 环境变量
-apps/server/.env
+/.env
+# 注：第 164 行通配 `.env` 已覆盖任意目录；这里 `/.env` 是显式说明仓库根有 .env
```

`apps/server/.env` 这一行删掉，因为该文件本身即将被删除。

## 9. 迁移步骤（开发者本地一次性）

```text
1. 将本地 apps/server/.env 内容复制到仓库根 .env，补齐 quant-pipeline 用到的 PG_DSN 等新分节变量
2. git rm apps/server/.env.example apps/quant-pipeline/.env.example
3. 删除本地 apps/server/.env、apps/quant-pipeline/.env（如有）
4. pnpm --filter @cryptotrading/server build 通过
5. pnpm dev 启动，server :3000 正常，TypeORM 连上 DB
6. python -c "from quant_pipeline.config.settings import get_settings; print(get_settings().pg_dsn)" 输出根 .env 的值
```

## 10. 测试 / 验证清单

```text
[ ] 根 .env.example 含 33 个变量、8 节，UTF-8 无 BOM
[ ] cp .env.example .env，pnpm dev 后端启动成功
[ ] TypeORM 连接 DB 成功（启动日志确认）
[ ] /api/health 响应 200
[ ] pytest apps/quant-pipeline/tests/unit/ 通过
[ ] python -c "from quant_pipeline.config.settings import get_settings; print(get_settings().pg_dsn)" 输出根 .env 中的值
[ ] git status：根 .env 被忽略；apps/server/.env 已 git rm
[ ] 仓库内（排除本 spec 与 git 历史）grep "apps/server/\.env" 无残留
```

## 11. 风险与回滚

| 风险 | 缓解 |
|---|---|
| `__dirname` 被打包方式改写 | 当前 NestJS 走 tsc → commonjs，行为稳定；切 ESM/bundler 时需重评 |
| 开发者拷贝 .env 时漏变量 | 模板集中注释；启动期 `getOrThrow` 立即报缺失 |
| Python `parents[5]` 算错 | 实施按第 7 节先 print 确认再写死 |
| 遗忘的脚本仍读 `apps/server/.env` | 第 10 节 grep 兜底，发现单独修 |

**回滚**：单 commit；revert 即恢复。

## 12. 实施任务拆分（供 dispatching-parallel-agents 参考）

按**互不相交的文件域**切 3 个独立任务，可完全并行：

- **Task A —— Node 后端运行时改造**
  - 文件：`apps/server/src/env-file-path.ts`（新增）、`apps/server/src/main.ts`、`apps/server/src/app.module.ts`
  - 验证：`pnpm --filter @cryptotrading/server build` 通过

- **Task B —— Python quant-pipeline 运行时改造**
  - 文件：`apps/quant-pipeline/src/quant_pipeline/config/settings.py`
  - 验证：先跑层级 print，再 `pytest apps/quant-pipeline/tests/unit/`

- **Task C —— 根模板与 gitignore / 文档 / 旧文件清理**
  - 文件：`/.env.example`（新增）、`/.gitignore`、`CLAUDE.md`、`README.md`、删除 `apps/server/.env.example` 与 `apps/quant-pipeline/.env.example`
  - 验证：`git status` 与 spec 第 10 节中可静态检查的项
  - 注意：`CLAUDE.md` 与 `README.md` 是高频编辑热点文件，Task C 开始前先 `git pull` 同步主干，完成后尽快合入避免冲突堆积

A / B / C 互不写同一文件；汇合后由主会话执行联合验证（第 10 节完整 checklist）。

### 12.1 实施顺序约束

A / B / C 可并行，但**联合验证前**必须满足以下顺序：

1. **先**删除本地 `apps/server/.env`（开发者本地动作，非代码改动），**再**启动新版后端，避免 NestJS 启动时被旧文件混淆——尽管 ConfigModule 已显式 envFilePath，dotenv 早期可能尚未污染 process.env，但旧文件本身可能仍被其它脚本（如某些 ts-node 直跑场景）按 cwd 解析。
2. 根 `.env` 先从 `.env.example` 拷贝并填入 `apps/server/.env` 原有值；缺漏的 quant-pipeline 变量（`PG_DSN` 等）按默认值补齐。
3. 三任务全部合入主干 → 跑第 10 节验证清单 → 通过后才视为完成。
