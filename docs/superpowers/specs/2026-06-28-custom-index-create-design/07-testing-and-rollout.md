# 测试与交付

## 分阶段交付（同一 spec，按 wave 合并 PR）

| Wave | 内容 | 验收 |
|------|------|------|
| W1 | DB migration + entities + CRUD API + preview-weights + catalog members | Postman 创建 → 列表 `status=pending`；无 worker 时保持 pending |
| W2 | Python worker quotes + indicators | job 成功，K 线有点位 |
| W3 | 前端 tab + Modal + CustomPanel | 端到端创建 → 看 K 线 |
| W4 | money_flow + AMV + 列设置 + 成分跳转 | 与同花顺面板体验对齐 |
| W5 | 编辑 + 版本链重算 + SSE | 改成分后曲线连续 |

---

## 单元测试

### 后端

| 文件 | 覆盖 |
|------|------|
| `custom-index.service.spec.ts` | CRUD、user 隔离、权重校验 |
| `custom-index-weight-version.spec.ts` | 版本切换 expire_date 逻辑 |

### Python

| 文件 | 覆盖 |
|------|------|
| `test_weight_resolver.py` | PIT 查询边界 |
| `test_price_index.py` | 等权 2 成分手工验算 |
| `test_chain_link.py` | 版本切换日指数连续 |

### 前端

| 文件 | 覆盖 |
|------|------|
| `useCreateCustomIndexWizard.spec.ts` | 步骤校验、权重总和 |
| `customIndexColumns.spec.ts` | 列渲染 |

---

## 集成测试场景

1. **Happy path**：2 成分等权，base_date=20240102，创建 → ready → K 线 365 天有数据
2. **float_mv 加权**：3 成分，权重与 daily_basic 手工核对
3. **custom 权重**：50/50，校验失败 60/50 → 400
4. **编辑版本链**：T 日改成分，effective_date=T+1，指数无跳空（chain link）
5. **user 隔离**：用户 A 不可 GET 用户 B 的指数
6. **并发**：computing 时 PATCH → 409
7. **failed 重试**：模拟 worker 失败后 recompute 成功

---

## Migration 脚本

```text
apps/server/src/migration/20260628100000-create-custom-index.sql
apps/server/src/migration/20260628100000-create-custom-index.ps1
```

PS1 内置 `docker exec crypto-postgres psql ... -f /path`

同步更新：

- `ml.jobs.run_type` 约束（若有 enum）
- `doc/db/quick-guide/` 可选新增「自定义指数状态查库」

---

## 性能预期

| 场景 | 目标 |
|------|------|
| 50 成分 × 5 年日线 | job < 120s |
| 500 成分 × 10 年 | job < 600s；progress SSE 可见 |

成分 OHLCV 批量 SQL 读取，避免 per-day per-stock 查询。

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| ml.jobs AdminOnly | 经 custom-index service 间接创建 |
| K 线 Modal Teleport 挂载 | 沿用 `ASharesIndexKlineModal` 现有 LazyTeleport 注释约束 |
| 全收益分红缺失 | 当日按价格指数口径 + job warning（见 `./03-index-computation.md#total-return-fallback`） |
| 指数 tab 文件行数 | 向导拆 `create-custom-index/` 子目录，单文件 ≤500 行 |

---

## 文档更新（实现后）

- `CLAUDE.md` 架构总览增加 `custom-index/` 模块一行
- `doc/db/index.md` 增加 custom_index 表索引
- **不**修改本 spec 目录（设计快照）
