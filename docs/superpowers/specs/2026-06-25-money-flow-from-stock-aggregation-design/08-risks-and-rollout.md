# 08 风险与上线

## 8.1 主要风险

### 1. 口径变化导致历史数据不可比

**风险**：`money_flow_market` 从东方财富口径切到同花顺个股加总，历史序列断裂。用户如果对比改造前后的大盘资金流向，会发现数值和走势不一致。

**缓解**：
- 在 spec 和前端明确标注「数据来源：同花顺个股聚合」。
- 保留旧 `money_flow_market` 历史数据至少 3 个月，不删除。
- 提供一段并行期，新旧数据同时存在，便于用户观察差异。

### 2. `index_weight` 版本链与真实成分调整不同步

**风险**：`index_weight` 是月度数据，月中指数成分调整时，我们用旧版本聚合，导致宽基指数资金流和真实成分有偏差。

**缓解**：
- 在 spec 中声明「月度成分近似」。
- 每月初优先同步上月 `index_weight`。
- 对差异敏感的宽基指数，可手动触发 `syncForMonth` 刷新。

### 3. `a_share_symbols.industry` 移除影响未知消费方

**风险**：SubAgent 已排查主要消费方，但可能有脚本/工具/第三方未覆盖到。

**缓解**：
- 移除前列出所有 `.industry` 引用，逐个确认。
- 先加新字段、后删旧字段，给用户缓冲期。
- 回滚脚本 ready。

### 4. 聚合性能瓶颈

**风险**：全量历史回填时，`money_flow_stocks` 数据量大，5 条聚合 SQL 慢。

**缓解**：
- 按日期分批聚合。
- 5 个维度并行。
- 为 `money_flow_stocks(trade_date, ts_code)` 确保索引。
- 历史回填脚本支持断点续跑。

### 5. 前端列设置/筛选方案兼容

**风险**：用户已保存的列偏好/筛选方案中可能包含旧 `industry` 字段，改造后解析失败。

**缓解**：
- 后端对未知列 key 做兼容（跳过 + warn）。
- 前端加载旧偏好时，自动把 `industry` 映射到 `swIndustryL3Name`。
- 提供「恢复默认列设置」入口。

## 8.2 回滚策略

| 阶段 | 回滚动作 |
|---|---|
| 迁移后、代码部署前 | 执行反向 migration |
| 代码部署后、回填前 | 回滚代码，执行反向 migration |
| 回填后 | 保留 schema，清空回填数据；若保留旧同步逻辑，可切回旧接口 |
| 上线稳定后 | 删除旧 `industry` 列和相关旧代码 |

## 8.3 Feature Flag 建议

为降低风险，建议引入临时 feature flag，**控制 `MoneyFlowSyncService.startSync()` 是否走新聚合逻辑**：

```typescript
// apps/server/src/market-data/money-flow/money-flow-sync.service.ts
const USE_AGGREGATED_MONEY_FLOW =
  process.env.USE_AGGREGATED_MONEY_FLOW !== 'false'; // 默认 true（上线稳定后删除）
```

实现方式：

1. **环境变量开关**：`USE_AGGREGATED_MONEY_FLOW=false` 时，`startSync()` 仍走旧逻辑（同时拉 4 个接口）。
2. **代码路径隔离**：在 `startSync()` 入口处分支：
   - `true`：调用 `IndexWeightSyncService.syncIfNeeded()` → `syncStocks()` → `aggregateAllDimensions()`。
   - `false`：调用旧的 `syncStocks()` / `syncIndustries()` / `syncSectors()` / `syncMarket()`。
3. **新旧接口调用共存**：旧 `moneyflow_ind_ths` / `moneyflow_cnt_ths` / `moneyflow_mkt_dc` 调用代码**不删除**，仅在新逻辑分支中不执行；稳定 2 周后再删除。

回退操作：

```bash
# 切回旧同步逻辑
$env:USE_AGGREGATED_MONEY_FLOW="false"
# 重启后端服务
```

> 注：即使 flag=false，`a_share_symbols` 的 `industry` 列已被删除、申万字段已新增，因此前端代码不可回退到旧列；如有需要，回滚需同时执行反向 migration 并回滚前端代码。

## 8.4 上线检查清单

- [ ] 5 个 migration 在测试环境跑通
- [ ] `a_share_symbols` 申万字段回填完成，非空率符合预期
- [ ] `index_weight` 当前月版本同步完成
- [ ] 一键同步 Step 2 真机跑通，无 failed
- [ ] 聚合表数据一致性校验通过（大盘 = 个股之和，抽样行业/指数一致）
- [ ] A 股指数面板资金流列正常展示/排序
- [ ] A 股个股面板三级行业筛选正常
- [ ] `/money-flow` 路由 404
- [ ] 复盘日报生成正常
- [ ] 后端单测 / 前端单测 / `pnpm build` 全绿
- [ ] 生产部署并重启后端服务

## 8.5 后续优化方向

1. **加权聚合**：当前等权，未来可按 `index_weight.weight` 做加权。
2. **AMV 扩展**：把成交额聚合也纳入宽基指数维度（用户本次明确不做）。
3. **Schema 简化**：未来可删除 `money_flow_industries` / `sectors` 中不可推导字段（`pct_change` / `net_buy` / `net_sell`），保持模型纯净。
4. **日级 `index_weight`**：若 Tushare 未来提供日级成分接口，版本链可直接支持。
