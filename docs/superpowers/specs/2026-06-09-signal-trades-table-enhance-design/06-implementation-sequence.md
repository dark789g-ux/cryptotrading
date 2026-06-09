# 06 · 实现顺序、文件归属与整体验证

← [05](./05-frontend-kline-detail-modal.md) ｜ [index](./index.md)

## 依赖图

```text
契约先行 ── F3(API/store 签名)        ┐
            F0(formatters util,纯函数) ┤
            B1(a-shares 后端)          ┼─ 并行 ─► F1(K线 Modal,依赖 B1+F3+F0) ┐
            B2(trades 后端)            ┘         F2(trades 面板,依赖 B2+F3+F0+F1)┼► 整体 e2e
                                                                                  ┘
```

- **第一波（可并行，零文件交叠）**：F3、F0、B1、B2。
  - F0 只新建 `signalStatsFormatters.ts`（把 `SignalStatsResult.vue` 的纯函数逻辑**复制**为模块级导出；**不改** `SignalStatsResult.vue`，改文件留给 F2，避免写冲突）。
- **第二波（依赖第一波契约）**：F1（依赖 B1+F3+F0）、F2（依赖 B2+F3+F0+F1）。
- **收尾**：F2 内接线 `SignalStatsResult.vue`（删旧逻辑、引面板）+ `SignalTradeKlineModal`；整体 e2e。

## 任务切分（供 subagent-driven-development，文件域互斥）

| 任务 | 文件域 | 依赖 | 子文档 |
|------|--------|------|--------|
| **T-F3** | `api/modules/market/aShares.ts`、`api/modules/strategy/signalStats.ts`、`stores/signalStats.ts` | — | [03](./03-frontend-api-store-contracts.md) |
| **T-F0** | `components/strategy/signalStatsFormatters.ts`（新，纯函数；不改 SignalStatsResult.vue） | — | [04](./04-frontend-trades-panel.md#组件拆分) |
| **T-B1** | `market-data/a-shares/a-shares.{service,controller}.ts` + spec | — | [01](./01-backend-a-shares-kline-window.md) |
| **T-B2** | `strategy-conditions/signal-stats/{service,controller,module}.ts`、`dto/list-trades-query.dto.ts`、`migrations/20260609_signal_test_trade_run_ret_index.{sql,ps1}` + spec | — | [02](./02-backend-trades-sort-filter.md) |
| **T-F1** | `components/strategy/SignalTradeKlineModal.vue` | T-B1, T-F3, T-F0 | [05](./05-frontend-kline-detail-modal.md) |
| **T-F2** | `components/strategy/SignalTradesPanel.vue`、`components/strategy/signalTradeColumns.ts`、`views/strategy/SignalStatsResult.vue`（删除清单见 [04](./04-frontend-trades-panel.md#signalstatsresultvue-删除清单)） | T-B2, T-F3, T-F0, T-F1 | [04](./04-frontend-trades-panel.md) |

> 文件域互斥：`signalStatsFormatters.ts` 由 T-F0 独占新建（第一波），F1/F2 只读 import；`SignalStatsResult.vue` 仅 T-F2 改写；T-F2 引用的 `SignalTradeKlineModal` 由 T-F1 先产出。让 **T-F2 最后做接线** 即无写冲突。**不使用 git worktree 隔离**（brainstorming 规范）。

## 全局约束（实现期必守）

- **编码**：源文件 UTF-8；文件 I/O 显式 `encoding='utf-8'`；对象键名英文（PowerShell GBK）。
- **后端无热加载**：`nest start` 无 `--watch`，改后端代码后**重启后端进程**再验证，否则撞 404 / 旧行为假象。
- **TypeORM 双注册**：T-B2 给 `signal-stats.module.ts` 的 `forFeature` 补 `AShareSymbolEntity`；根 entities 已含，grep 确认。
- **动态 SQL**：排序字段经 `SORT_COLUMN_MAP` 白名单翻译，禁裸拼（database-sql 规范）。
- **datetime**：YYYYMMDD↔Date 必插分隔符 + `Z`；K 线标记对齐 key 用 `fmtTradeDate` 转 `YYYY-MM-DD` 后字面相等比对。
- **前端**：type-check **不等于** SFC 编译，合并前必跑 `vite build`；改 import 块后回读文件头确认顺序；`AppModal` 统一复用，按钮放 `#actions`（本 Modal 无按钮）。
- **单文件 ≤500 行**：F2 抽出面板/列工厂后核对两侧行数。

## 整体验证（端到端）

后端（重启进程后）：

```bash
pnpm --filter @cryptotrading/server build
pnpm --filter @cryptotrading/server exec jest signal-stats
pnpm --filter @cryptotrading/server exec jest a-shares
# migration
powershell apps/server/migrations/20260609_signal_test_trade_run_ret_index.ps1
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d signal_test_trade"   # 见 idx_..._run_ret
```

前端：

```bash
pnpm --filter @cryptotrading/web type-check
pnpm --filter @cryptotrading/web build
pnpm --filter @cryptotrading/web lint:quant-lines    # 不应回退
```

真机 e2e（browser-driving）——以「信号前向统计」一个已完成 run 为对象：

1. 逐笔明细：各可排序列升/降序正确；ret 并列翻页不串（分页确定性）。
2. 四类筛选：代码模糊、出场原因、收益率区间（**填 3 等于 3%**）、持仓区间；组合筛选。
3. 分页：切每页条数回到第 1 页；总数 `共 N 条` 正确。
4. 名称列：显示中文名；未知/缺名 → `—`。
5. 详情 Modal：选**历史**交易 → K 线落在交易窗口；`B`/`S` 与表格日期/价位对齐；最大化自适应；换一笔无残留；首开 canvas 正常。
6. 大样本回归：长区间 run（参 memory 中 20230101~20260531 全市场用例）下分页/排序/筛选不卡死、无栈溢出。

## 提交建议（分层 commit，feedback_layered_commits）

按子系统分多个语义 commit，例：

- `feat(a-shares): 日K接口支持日期区间窗口`（B1）
- `feat(signal-stats): trades 服务端排序/筛选 + 标的名称注入`（B2，含 migration）
- `feat(signal-stats): trades API/store 契约扩排序筛选参数`（F3）
- `feat(signal-stats): 逐笔明细详情 K线 Modal`（F1）
- `feat(signal-stats): 逐笔明细筛选栏/排序/分页面板`（F2，含接线）

## 完成后

- 端到端通过后，按 finishing-a-development-branch 决定合并方式。
- 更新 memory `project_signal_forward_stats`：追加本次「逐笔明细表增强（排序/筛选/名称/详情K线）」。
