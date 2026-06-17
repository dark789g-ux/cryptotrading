# 07 测试与验证

[← index](./index.md)

## 分层单测

### Python（pytest，`apps/quant-pipeline`）

1. **write_start 窗口**（[04](./04-warmup-endcap-fetch.md)）：
   - `sync_us_daily_for_ticker(..., write_start=recent)`：断言 upsert 的行 `trade_date` 均 ≥ write_start；且这些行的 ma240/dif/dea 与「同一抓取窗口、write_start=fetch_start 全量写」对应日期**逐位相等**（证明 warmup 在全序列上算、切片不改值）。
   - 同理覆盖 `sync_us_index_for_symbol`、AMV 写入窗口。
   - 默认 `write_start=None` → 行为与改动前完全一致（回归保护现有 CLI/单 job us_sync）。
2. **end-cap helper**：mock `now_et` 在「今日盘中（< 16:05 ET）」→ `cap_to_last_closed_session` 返回今日前一交易日；mock 收盘后 → 含今日。双保险：抓取返回含今日在长 bar 时被丢弃。DST 边界各取一例（夏令时/冬令时各一天）。
3. **编排器** `run_us_one_click_sync`：
   - 三步顺序调用（mock 三个 `run_us_*` 返回 outcome）、result_payload 三步 status 推进、rowsWritten/errors 映射正确。
   - 某步抛异常 → 该步 failed、记 error、**继续后两步**（失败不中断）。
   - `check_cancel_requested` 在 step2 前为 true → 抛 JobCancelled、result_payload 标 cancelled + 未完成步 skipped。
   - 子调用一律 `job_id=None`（不污染总进度）。
4. **dispatcher 路由**：`_ROUTES['us_one_click_sync']` 存在；未知 run_type 仍 failed（现有测试不回归）。
5. **alembic**：升级后约束含 `us_one_click_sync`（17 值），downgrade 还原 16 值；`down_revision == '20260616_0002'`。

### NestJS（jest，`apps/server`）

1. `UsStocksService.oneClickSync`：合法 dateRange → `create({runType:'us_one_click_sync', params:{date_range:'start:end'}, ...})`、透传 createdBy、返回 jobId；**dateRange 缺失/非二元组/非 YYYYMMDD/start>end → 400 且不派 job**。
2. `create-job.dto`：`ALLOWED_RUN_TYPES` 接受 `us_one_click_sync`、拒绝未知值。
3. controller：`@AdminOnly()` 生效（非 admin 拒）。

### 前端（vitest，`apps/web`）

1. `usOneClickSync` store：result_payload（含 3 步 + logs）→ steps/totalPercent/logs/summary getter 映射；`resultPayload={}`/缺失 → 兜底 3 步 pending；终态停轮询。
2. `useUsOneClickSync`：`canStart` 随 dateRange 两端齐全翻真；`start()` 经 `toYYYYMMDD` 提交（本地 TZ，非 UTC）。
3. `OneClickSyncPanel`：传 `title/subtitle` 渲染对应文案；传美股 controller 渲染美股步骤 label（`US_STEP_LABELS`）。A 股默认（不传 title）仍渲染原文（回归）。

## 门禁（合并前必跑）

```text
pnpm --filter @cryptotrading/server build
pnpm --filter @cryptotrading/server exec jest <相关 spec>
pnpm --filter @cryptotrading/web type-check
pnpm --filter @cryptotrading/web build          ← vite SFC 编译，必跑（type-check 查不出 SFC 编译错）
pnpm --filter @cryptotrading/web test
cd apps/quant-pipeline && <pytest 相关用例>
```

迁移：alembic `current` 对齐 `20260616_0002` 后 upgrade；或跑 NestJS `.ps1` 镜像。**改 NestJS 代码后必须重启后端**（`nest start` 无 watch），否则新接口 404 / 旧行为。

## 真机 e2e（browser-driving）

1. 进 /sync → 见「A股 / 美股」两 Tab；A 股 Tab 内容/行为与改造前一致（回归）。
2. 美股 Tab：选一个**近期窗口**（如近 10 天）→「开始同步」：
   - 步骤表三步依次 pending→running→success；总进度 0→100；实时日志有行；结束 summary 显示三步 + 写入行数。
   - **切走再切回 / 刷新页面**：进度不归零、恢复轮询（验恢复）。
   - 运行中「取消」→ 步间停下、summary 标已取消。
3. **数据层铁证**（headless 截不到副图时以数据为准，[美股指数 AMV 教训]）：
   - `GET /api/quant/jobs/:id` 的 resultPayload.steps 三步 success、rowsWritten > 0。
   - 直查 DB：所选窗口内 AMD/.NDX 收盘价对拍 Yahoo **宽窗口 settled**（非 narrow，避末尾 bar 闪烁，[reference_us_sync_intraday_partial_bar]）；**确认无「今日在长日」行**写入（约束A）；窗口外更早历史行 `updated_at` 未变（约束B 只写所选窗口）。
4. 验完恢复：若 e2e 改了用户偏好/留下脏数据，复原（[e2e 写了持久化状态验完恢复] 规范）。

## 风险与回归点

- **A 股零回归**：OneClickSyncPanel 参数化默认值必须等于现有硬编码文案；controller 接口标注不改返回结构。
- **现有单 job us_sync 零回归**：`write_start` 默认 None = 旧行为；现有 Symbols 页同步按钮不动。
- **run_type 四处一致**：漏 DB CHECK → 派 job 500（[新 run_type 必补 DB CHECK 约束] 坑）。
- **result_payload 膨胀**：logs 截断 ≤ 200 条。
