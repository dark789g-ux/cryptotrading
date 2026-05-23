# 05 · 数据流与缓存失效

← 回到 [index.md](./index.md)

## 端到端数据流

```text
PATCH 写入流程（实时生效于 DB）：

  ┌──────────────┐  PATCH /quant/factors/:id/:v
  │ Vue 编辑弹窗 │ ───────────────────────────────▶┐
  └──────────────┘                                  ▼
                                          ┌──────────────────┐
                                          │ FactorsController│
                                          │  AdminGuard      │
                                          │  → service       │
                                          └────────┬─────────┘
                                                   ▼
                                          ┌──────────────────┐
                                          │ FactorsService   │
                                          │  updated_at=NOW  │
                                          │  updated_by=uid  │
                                          └────────┬─────────┘
                                                   ▼
                                          ┌──────────────────┐
                                          │ factors.         │
                                          │ factor_          │
                                          │ definitions      │
                                          └──────────────────┘

                                          response: { item }
                                                   ▼
                                          前端原地刷新该行


train_e2e job 读取流程（下次启动生效）：

  ┌──────────────┐  POST /quant/jobs
  │ TrainTrigger │ ───────────────────────────────▶┐
  │ Modal        │                                  ▼
  └──────────────┘                          ┌──────────────────┐
                                            │ NestJS jobs ctrl │
                                            │  → 入队 ml.jobs  │
                                            └────────┬─────────┘
                                                     ▼
                                            worker 取 pending job
                                                     ▼
                                            ┌──────────────────┐
                                            │ train_e2e_runner │
                                            │  启动期：         │
                                            │  registry.       │
                                            │  reload_from_db()│ ← 关键
                                            └────────┬─────────┘
                                                     ▼
                                            build features
                                            (跳过 enabled=false)
                                                     ▼
                                            labels → train
```

## 两层缓存策略

### NestJS 侧：不缓存

- 读量小（16 行 × 偶尔查），TypeORM 直连 DB 足够
- 避免缓存与编辑后的实时刷新打架（"我刚改了为什么页面没变"）
- PATCH 后响应直接返回 DB 当前值，前端拿到的就是最新

### quant-pipeline 侧：per-job 缓存

- 每个 train_e2e job 启动时 `registry.reload_from_db()` 拉一次全表进进程内缓存
- job 跑完缓存随进程结束自然释放
- **不**做长驻进程级缓存——worker 可能同时跑多个 job，进程级缓存会让"上一个 job 锁定的元数据"污染下一个

## 多 job 并发场景

admin 改了 DB 后，正在跑或排队的 job 各按下表生效：

| job 状态                          | 元数据来源                  |
|-----------------------------------|----------------------------|
| 正在运行（reload_from_db 已调用） | **旧值**（缓存已在进程内）  |
| pending（尚未被 worker 取走）     | **新值**（取走时再 reload） |
| 编辑后才提交的新 job              | **新值**                    |

**含义**：

- 不会出现"半截 job 用了新旧混合值"——每个 job 进程入口的 `reload_from_db` 是原子的时间切片
- 想让所有 pending job 都用新值 → 自然成立（worker 取走时才 reload）
- 想让 running job 立刻用新值 → 唯一方法是 cancel 后重新提交

## 并发编辑

- 当前 16 行 × 1-2 个 admin，乐观并发（后写胜出）即可
- **不**做乐观锁（`If-Match: <updated_at>`），YAGNI
- 极端情况两个 admin 同时改同一行：后保存者覆盖前者，`updated_at/by` 反映最后一次

## 回滚预案

| 误操作 | 恢复路径 |
|--------|---------|
| 误关键因子 | 重新打开 enabled，下次 train_e2e 自动生效 |
| 误改 pit_window_days | 改回；已跑的 model_run 标记 invalid（手动 SQL DELETE） |
| 误改 category | 改回；同上 |
| DB 表数据丢失 | 重跑初始 migration（硬编码 INSERT 16 行默认值，详见 [01-db-schema.md](./01-db-schema.md#初始化-migration方案-a硬编码-insert)） |
| Python 代码已删类属性但 DB 未灌数据 | worker 启动 `FactorMetaMissing` fail-fast；先跑 migration 再跑 worker |

**关键安全性质**：`model_runs` 表是不变量（一次 train_e2e 跑完写一行），不会回写其他表；任何回滚操作不会引发连锁数据破坏。

## 边界情况

- **DB `users.role` 是唯一权威**（refactor 2026-05-23）：加/调 admin 走 SQL `UPDATE users SET role='admin' WHERE id='<uuid>'`，无需重启 server。
- **全表无 admin 用户**：任何已登录用户访问 `/quant/*` 都 403；前端菜单隐藏。等价于「关闭量化模块」。运维需保证至少一个 `role='admin'` 用户存在。
- **同一 user 同时持多个 session**：is_admin 在每个 session 的 `/api/auth/me` 响应中通过 `user.role` 实时反映；session 续期会重新 `toAuthUser(UserEntity)` 拉一次 DB role，无长期 stale 风险。
- **admin 被降级时正在持有的 SSE 短期 token**：SSE 流接口在 Observable 内异步查 DB `users.role`，非 admin 立即 `subscriber.error(Forbidden)` 关流；非 SSE 接口下次请求会被 AdminGuard 拒绝（因为下次请求时 session 重新填充的 `req.user.role` 已变）。
- **`users.role` 修改是否影响正在跑的 train_e2e job**：不影响——role 只用于 NestJS 鉴权，与 quant-pipeline 进程无关。
