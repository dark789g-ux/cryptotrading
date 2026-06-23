# 05 · 噪声规则 + 验证 + 风险 + SDD 拆分

## 5.1 噪声规则明细（即时算，预标不强制）

「发现候选」时对每个 `index_basic` 候选即时算 `noise_tag`（基于 name + exp_date）：

| 规则 | 标签 | 处置 |
|------|------|------|
| `exp_date` 非空 | ⚠ 已退市 | 「隐藏疑似噪声」默认隐藏 |
| name 含 `USD`/`HKD`/`港股`/`美股`/`三板`/`东盟`/`中韩` | ⚠ 跨境/外币/新三板 | 默认隐藏 |
| name 含 `收益`/`R`/`净收益` | ⚠ 收益版（非价格版） | 默认隐藏 |
| 多挂牌（如 `000300.SH` vs `399300.SZ`） | 🔁 重复 | 标「重复」保留主挂牌（.SH 优先），不隐藏 |
| 上证小盘/中盘、国证/巨潮系列 | ℹ 中小盘 | 仅提醒，不隐藏（合法规模指数） |

- 规则只标注提醒，**用户仍可勾选任何候选**（最终范围由人定，符合"收敛集人工定稿"）
- 规则实现为纯函数 `classifyNoise(candidate): NoiseTag[]`，可单测
- 初始 8 行均为各自主挂牌（.SH/.SZ 主板），噪声规则不误标（多挂牌去重时初始行不会被标重复）

## 5.2 验证标准

**范围管理**：
- `GET /api/market-index-scope/discover` 返回 ~158 候选，`noise_tag` 标注正确（抽样：退市/跨境/收益版/重复各 ≥1）
- `POST /add` 后 `GET /`（范围）含该 tsCode；`POST /remove` 后不含；刷新持久
- 「隐藏疑似噪声」开关：默认隐藏退市/跨境/收益版，关闭后看全量

**同步**：
- `MarketIndexSyncService` 读动态范围（grep 确认不再引用 `MARKET_INDEX_LIST`）
- 范围内每个 tsCode 都能拉到 `index_daily` 全史行情（抽样核对）
- 空范围兜底：清空 `type='M'` 后同步返回空 + warn（不伪装成功）

**前端大盘 Tab**：展示动态清单（与范围一致，增删后刷新生效）

**门禁**：
- 后端 jest 全绿（含 scope service + classifyNoise 单测）
- 前端 type-check + `vite build` + `lint:quant-lines`
- `market-index-list.ts` 删除后无残留引用

## 5.3 风险与对策

| 风险 | 对策 |
|------|------|
| `index_basic` category 参数凭转述写错 | `tushare-sync-dev` skill 查文档（[02 §2.1](./02-backend.md)） |
| `MARKET_INDEX_LIST` 有遗漏消费方 | 删前 grep 全仓确认无残留引用 |
| `syncCatalog` 未来扩到 M 会覆盖范围 | 安全论证基于现状（[01 §1.2](./01-data-model.md)）；若未来 syncCatalog 扩 M，需重新评估——在 catalog sync 代码加注释标注「type='M' 由 market-index-scope 管理，勿纳入 syncCatalog」 |
| 真机 e2e 改范围留脚印 | 验完恢复初始 8 个（[04 §4.6](./04-frontend-scope-page.md)） |

## 5.4 SDD 任务拆分（独立文件域）

| 任务 | 文件域（互不相交） | 依赖 |
|------|-------------------|------|
| **T1 scope service** | `market-data/index-catalog/market-index-scope.service.ts`、`market-index-scope.controller.ts`、`index-catalog.module.ts`（注册）、`classifyNoise.ts`（纯函数） | 无 |
| **T2 sync + query 改造** | `market-data/ths-index-daily/market-index-sync.service.ts`（读 catalog）、`market-data/index-catalog/index-catalog-query.service.ts`（queryMarket 改读 catalog）、`index-catalog-query.service.spec.ts`（重写 mock）、删除 `market-index-list.ts` | 无（直接读 catalog repo） |
| **T3 前端管理页面** | `views/sync/MarketIndexScopePanel.vue`、`components/sync/MarketIndex*.vue`、`api/marketIndexScope.ts` | T1（API） |
| **T4 one-click 并入** ⚠️共享 | `one-click-sync/*`、`components/sync/oneClickSync.types.ts`、`views/sync/SyncView.vue` | T2 + 申万 T2 |

**并行度**：T1 ∥ T2（文件域不交：T1 在 `index-catalog/market-index-scope.*`，T2 在 `market-index-sync.service.ts` + 删 `market-index-list.ts`）；T3 依赖 T1；**T4 串行**（与申万 one-click 共享 `one-click-sync/`，单 agent 一次加 sw+market 两 step）。

## 5.5 实施顺序建议

1. **T1 ∥ T2**（scope service ‖ sync 改造）并行
2. **T3**（前端管理页面，依赖 T1 API）
3. **T4**（one-click 并入，含申万 sw step）串行收尾
4. 真机 e2e：发现候选 → 勾选 → 同步 → 大盘 Tab 动态展示 → 恢复初始 8 个

## 5.6 交接 prompt 处置

本 spec 实现合入后，`prompts/improve-market-index-sync.md` 移入 `prompts/archive/`（或删除）。
