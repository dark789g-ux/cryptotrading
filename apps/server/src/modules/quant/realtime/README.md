# `modules/quant/realtime/` — SSE 实时进度链路（M4 Part M）

本目录承载 NestJS 侧的"训练 job 实时进度推送"链路。Python worker 与浏览器 EventSource 之间**不走 HTTP/不走 WS/不引消息队列**，全部经 PG `LISTEN/NOTIFY` 中转。

## 组件清单

| 文件 | 角色 |
|---|---|
| `pg-listen.service.ts` | 维护一条独立长生命周期的 `pg.Client`，专门 `LISTEN ml_job_progress`，把 NOTIFY payload 经 RxJS Subject 广播到所有订阅者 |
| `sse-token.util.ts` | HMAC-SHA256 签名/验签 `{job_id, user_id, exp}`（M2 已建） |
| `../services/sse-token.service.ts` | 颁发 5 分钟短期 token（M2 已建） |
| `../guards/sse-token.guard.ts` | `?token=...` 校验 + path.id 与 token.job_id 比对（M2 已建） |
| `../controllers/quant-jobs-sse.controller.ts` | `GET /quant/jobs/:id/stream?token=...` SSE 流（M4 真实实现） |

## 通信契约（来自 `00-index.md` §3）

```
Python worker  ──UPDATE ml.jobs.progress──┐
                                          │
                                          └─NOTIFY ml_job_progress, '{...}'──►PG
                                                                                │
                                                                                ▼
                                                  NestJS LISTEN（独立长连接）
                                                                                │
                                          ┌─────────────────────────────────────┘
                                          ▼
                                Subject.next(MlJobProgressEvent)
                                          │
                  ┌───────────────────────┴────────────────────────┐
                  ▼                                                ▼
        SSE 订阅者 A（job=X）                             SSE 订阅者 B（job=Y）
        controller filter job_id===X                    controller filter job_id===Y
```

**NOTIFY payload schema（固定，禁止扩展任意字段）**：

```json
{ "job_id": "<uuid>", "progress": 0..100, "stage": "<str>" }
```

- 长度 ≤ 1KB（`PG_LISTEN_PAYLOAD_MAX_BYTES`）
- 不允许携带日志正文 / 错误堆栈 / SHAP 数组（schema 校验会 drop + `logger.warn`）

## 重连策略

`PG_LISTEN_BACKOFF_SCHEDULE_MS = [5_000, 10_000, 20_000, 40_000, 60_000]`：

1. `pg.Client` 在 `error` / `end` 事件触发时进入 `handleConnectionLost`
2. 首次断连等待 5s 重连；连续失败按指数退避升档，至 60s 封顶
3. 重连成功后 `backoffIndex` 立即重置为 0，并重新 `LISTEN ml_job_progress`
4. `onModuleDestroy` 后不再触发重连

## SSE 行为合同（来自 `00-index.md` §3 + `03-nestjs-vue.md` §1）

1. 建连瞬间先 `SELECT progress FROM ml.jobs WHERE id=:id` 推一条"快照"事件，避免 LISTEN 注册之前的进度被错过
2. 之后订阅 `PgListenService.events$()`，filter `job_id === path.id` 后转发为 SSE event
3. 终态（`success` / `failed` / `blocked` / `cancelled`）→ 发一条 `type: 'complete'` 的 event 后关闭流
4. 客户端断开（HTTP `req.close`）时取消 Subject 订阅，防止泄漏

## SSE 鉴权（CLAUDE.md「AuthGuard 全局注册」的合法例外）

浏览器原生 `EventSource` 不携带自定义 header，无法走全局 `AuthGuard`。方案：

1. 客户端先用常规 HTTP（受全局 AuthGuard 保护）调 `POST /quant/jobs/:id/sse-token` 拿一个 5 分钟有效的短期 token
2. 再 `new EventSource('/quant/jobs/:id/stream?token=...')` 建连
3. SSE controller 用 `@Public()` 跳过全局 AuthGuard，转由 `@UseGuards(SseTokenGuard)` 接管：校验 token 签名/过期/path.id 与 token.job_id 一致

## 手动验证步骤

### 1. 启动 NestJS 与 Python worker

```powershell
docker compose up -d postgres
pnpm --filter @cryptotrading/server dev
# 另一终端
cd quant-pipeline ; uv run python -m quant_pipeline.worker
```

### 2. 创建一个 job 并取 SSE token

> 假设 cookie 已通过登录拿到（项目用 session cookie，不是 JWT）。这里用 `Invoke-RestMethod` 维持 session。

```powershell
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

# 登录（具体接口/字段以本项目 auth controller 为准）
Invoke-RestMethod -Uri 'http://localhost:3000/auth/login' -Method Post -ContentType 'application/json' `
  -Body '{"email":"<your-email>","password":"<your-pass>"}' -WebSession $session | Out-Null

# 创建 job（noop 作为示例）
$job = Invoke-RestMethod -Uri 'http://localhost:3000/quant/jobs' -Method Post -ContentType 'application/json' `
  -Body '{"run_type":"noop","params":{}}' -WebSession $session
$jobId = $job.id

# 取 SSE token
$tok = Invoke-RestMethod -Uri "http://localhost:3000/quant/jobs/$jobId/sse-token" -Method Post -WebSession $session
$token = $tok.token
"Job: $jobId"
"Token: $token"
"Stream URL: http://localhost:3000/quant/jobs/$jobId/stream?token=$token"
```

### 3. curl 直接订阅 SSE 流

```bash
# 用上一步打印的 URL
curl -N "http://localhost:3000/quant/jobs/<JOB_ID>/stream?token=<TOKEN>"
```

期望看到：

```
data: {"job_id":"<JOB_ID>","status":"running","progress":0,"stage":null,"heartbeat_at":null}

data: {"job_id":"<JOB_ID>","progress":12,"stage":"sync"}

data: {"job_id":"<JOB_ID>","progress":42,"stage":"training"}

event: complete
data: {"job_id":"<JOB_ID>","status":"success"}
```

（第一行是快照，后续是 LISTEN/NOTIFY 转发；终态时 `event: complete` 后流关闭。）

### 4. 浏览器 EventSource 验证

在浏览器 DevTools Console（已登录的同源页面）执行：

```js
const r = await fetch('/quant/jobs/<JOB_ID>/sse-token', { method: 'POST', credentials: 'include' });
const { token } = await r.json();
const es = new EventSource(`/quant/jobs/<JOB_ID>/stream?token=${token}`);
es.onmessage = (e) => console.log('progress', JSON.parse(e.data));
es.addEventListener('complete', (e) => {
  console.log('done', JSON.parse(e.data));
  es.close();
});
```

### 5. 手工触发 NOTIFY（无 worker 时也能联调）

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "NOTIFY ml_job_progress, '{\"job_id\":\"<JOB_ID>\",\"progress\":50,\"stage\":\"manual-test\"}'"
```

SSE 客户端应立即收到一条事件。

### 6. 重连演练

```powershell
# 模拟连接断开（强杀 PG 侧的 LISTEN 连接）
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='nestjs-pg-listen-ml-job-progress'"
```

预期日志：

```
WARN  PgListenService  pg_listen_error err=...
WARN  PgListenService  pg_listen_reconnect_schedule reason=client_error delay_ms=5000 next_backoff_index=1
LOG   PgListenService  pg_listen_ready channel=ml_job_progress ...
```

## 已知限制 / TODO

- payload schema 不携带 `status`，因此 progress=100 时 controller 需要回查一次 `ml.jobs.status` 来确认终态（spec 行为合同 ③）；这是合规取舍，避免把 status 塞进 NOTIFY 突破 1KB 上限
- 单 NestJS 实例假设（本地 Windows + Docker），多实例水平扩展时每个实例各自 LISTEN，无需额外协调
