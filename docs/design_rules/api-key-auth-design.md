# API Key 认证设计规范

Machine-to-Machine（M2M）API Key 认证模块的设计规则。对标 LLM / GitHub PAT 风格，让外部 Agent / 脚本无需浏览器登录态即可调用本系统接口（含策略回测）。

---

## 1. 架构定位：API Key 是 session 的 fallback，不是平行系统

**规则**：API Key 与 session cookie 是**同一个 AuthGuard 内的两条串联认证路径**，不是两套独立守卫。session 在前、API Key 仅在 session 失败时作为 fallback 触发。

**为什么**：两条路径最终都注入完全相同的 `request.user: CurrentUser`，**所有现有业务接口零改动**自动获得 API Key 支持。若做成两套守卫，会导致 `@CurrentUser()` 行为分裂、业务层要感知认证来源。

**认证流程**（`apps/server/src/auth/auth.guard.ts`）：

```
HTTP 请求
   │
   ▼
AuthGuard.canActivate
   │
   ├── @Public() ─────────────────────── 放行
   │
   ├── ① cookie ct_session → validateToken
   │       成功 → user, authType='session'
   │
   └── ② (仅 ① 失败) Authorization: Bearer <key>
           前缀必须是 ct_live_ → validateKey
           成功 → user, authType='apikey'

   任一路径成功 → request.user = { ...user, authType }
   全失败 → 401「未登录或 API Key 无效」

   @AdminOnly() 检查（保持原样）
```

**禁**：在业务 Controller 里加 `@UseGuards(ApiKeyGuard)` 之类的新守卫——API Key 支持是全局默认能力，不需要逐接口声明。

---

## 2. API Key 格式：可识别前缀 + 不存原文

**格式**：

```
ct_live_<8 位可识别前缀><43 位随机串>
   │       │              │
   │       │              └─ generateToken() = randomBytes(32).base64url
   │       │                 SHA-256 hash 后入库（hashToken），明文永不落库
   │       └─ key_prefix 字段：完整 key 的前 16 字符明文，仅供 UI 列表展示识别
   └─ 固定前缀，标识「cryptotrading 生产 key」，便于日志 grep / 日志识别
```

**规则**：
- **明文 key 仅在创建时返回一次**（`POST /api/api-keys` 的 `plaintextKey` 字段），之后任何接口（list / revoke / 进度 / 回测结果）都不再返回明文。
- 校验走 `hashToken(rawKey)` 全量 SHA-256 → 与库内 `key_hash` 精确等值匹配。PostgreSQL text 等值比较由数据库内核完成，不受应用层时序攻击影响。
- **禁**把 `key_prefix` 当作安全凭证使用——它只是展示用辨识标识，4-8 个字符熵不足以认证。

**复用现有工具**（`apps/server/src/auth/shared/auth.utils.ts`）：`generateToken()` + `hashToken()`，与 session token 共用同一套密码学。**禁**为 API Key 另造加密栈（如 bcrypt / scrypt——API Key 校验是高频操作，scrypt 太重）。

---

## 3. 数据模型

**表**：`api_keys`（`apps/server/src/migration/20260717_create_api_keys.sql`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `user_id` | varchar(36) | FK → `users(id) ON DELETE CASCADE` |
| `name` | varchar(100) | 用户起的名字，如 "Agent-回测" |
| `key_hash` | text | SHA-256(完整 key) hex |
| `key_prefix` | varchar(16) | 展示用前缀明文 |
| `last_used_at` | timestamptz | 最后使用时间，60s 节流更新 |
| `expires_at` | timestamptz | 可选过期时间（当前 UI 未开放配置，留字段） |
| `revoked_at` | timestamptz | 撤销时间（软删除） |
| `created_at` / `updated_at` | timestamptz | |

**索引**：
- `idx_api_keys_user_id (user_id)` — 列表查询
- `idx_api_keys_key_hash (key_hash) WHERE revoked_at IS NULL` — **部分索引**，校验查询只扫活 key

**规则**：
- 字段命名沿用 snake_case + timestamptz 规范（与 `auth_sessions` / `user_invitations` 一致）。
- `ON DELETE CASCADE`：删用户连带清 key，防孤儿。
- 软删除（`revoked_at`）而非物理删除——保留审计痕迹。
- `CHECK (revoked_at IS NULL OR expires_at IS NULL OR revoked_at <= expires_at)`：防撤销时间晚于过期时间的逻辑错乱。

**判据**：新增强凭证类表一律带 `WHERE revoked_at IS NULL` 的部分索引——活凭证查询是高频路径，已撤销的不该进索引扫描。

---

## 4. 接口契约

**管理接口**（全部需要 **session 登录**，拒绝 API Key 自身认证，见 §5）：

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| GET | `/api/api-keys` | - | `ApiKeyView[]`（脱敏，无明文） |
| POST | `/api/api-keys` | `{ name: string }` | `{ id, name, keyPrefix, plaintextKey, createdAt }` ← 明文**仅此一次** |
| DELETE | `/api/api-keys/:id` | - | `{ ok: true }`（软删除） |

**业务接口**（全部接受 API Key 认证，零改动）：所有原需 session 的接口自动支持 `Authorization: Bearer ct_live_xxx`。

**Agent 接入示例**（以回测为例）：

```bash
# 1. 在前端 http://localhost:5173/api-keys 创建 key，复制 ct_live_xxx

# 2. 触发回测（异步，立即返回）
curl -X POST http://localhost:3000/api/backtest/start/<strategyId> \
  -H "Authorization: Bearer ct_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"symbols":[]}'

# 3. 轮询进度（30 秒内，完成后拿 runId）
curl -H "Authorization: Bearer ct_live_xxx" \
  http://localhost:3000/api/backtest/progress/<strategyId>

# 4. 取结果
curl -H "Authorization: Bearer ct_live_xxx" \
  http://localhost:3000/api/backtest/run/<runId>
```

**两个 Agent 必须处理的坑**（这些是回测接口自身的异步语义，非 API Key 特有）：
1. **进度数据 done/error 后 30 秒自动清理**——拿到 `runId` 立即存，别等完事再回来查进度。
2. **同一用户同一策略并发阻塞**——返回 `{ ok: false, message: '该策略的回测任务已在运行中' }`，Agent 要轮询等当前一次跑完再启下一次。

---

## 5. 安全约束：管理接口拒绝 API Key 自身认证

**规则**：`api-keys` Controller 的三个接口（list / create / revoke）**必须拒绝 API Key 认证**，只接受 session。实现方式：AuthGuard 注入 `request.user.authType`，Controller 入口校验。

**为什么**：防止 Agent 拿到一个 key 后自循环创建更多 key（提权风险）。Session 用户不受影响。

**实现**（`apps/server/src/api-keys/api-keys.controller.ts`）：

```typescript
function assertSessionAuth(req: RequestWithUser): void {
  const user = req.user as CurrentUserWithAuthType | undefined;
  if (!user) throw new UnauthorizedException('未登录');           // null 防御
  if (user.authType === 'apikey') throw new UnauthorizedException('管理 API Key 需要会话登录');
}
```

**判据**：任何「创建 / 撤销凭证」类接口都默认拒绝「用同类凭证自身」认证——这是凭证自管理的基本安全红线。新增强凭证模块（如未来的 OAuth token、Service Account）应沿用此模式。

**userId 隔离**：`listKeys(userId)` / `createKey(userId, name)` / `revokeKey(userId, id)` 全部按 `user.id` 过滤，用户只能管理自己的 key。越权访问返回 404（而非 403，避免探测存在性）。

---

## 6. 性能：`last_used_at` 节流更新

**规则**：每次 API Key 校验成功后异步更新 `last_used_at`，但 **60 秒内只更新一次**（节流），且 fire-and-forget（不 await、失败静默）。

**为什么**：`last_used_at` 仅供 UI 展示「最后使用时间」做审计，不是强一致数据。若每次请求都写库，高频 Agent 调用会成为写瓶颈。

**实现**（`apps/server/src/api-keys/api-keys.service.ts:validateKey`）：

```typescript
// 60s 节流（参照 session 的 last_seen_at 逻辑）
const now = Date.now();
const lastMs = key.lastUsedAt ? key.lastUsedAt.getTime() : 0;
if (now - lastMs >= 60_000) {
  void this.repo.update(key.id, { lastUsedAt: new Date(now) }).catch(() => {});
}
```

**判据**：审计类时间戳的更新一律走「节流 + fire-and-forget」，不阻塞主路径、不抛错。

---

## 7. 扩展点（本期未做，预留）

| 扩展 | 现状 | 升级路径 |
|---|---|---|
| **Scope 细粒度权限** | 无 scope，key 等同创建者 session | 未来加 `scopes jsonb` 字段 + AuthGuard 内 scope 检查，无需改表结构以外的迁移（仅加列） |
| **Key 过期时间** | `expires_at` 字段已留，UI 未开放配置 | 前端创建对话框加日期选择器，service 已支持过期校验 |
| **Key 使用限额** | 无 | 加 `use_count` + `use_limit` 字段，validateKey 内递增并检查 |
| **IP 白名单** | 无 | 加 `allowed_ips jsonb`，validateKey 内比对 `request.ip` |

**规则**：本期所有「未来可能要」的字段（`expires_at`、可扩展的 scopes）都在初次迁移就建好，**避免后续加列迁移**——但未启用的功能不写业务逻辑，保持当前路径最简。

---

## 8. 检查清单（新增 / 修改强凭证模块时逐条过）

- [ ] 凭证明文是否仅创建时返回一次？list / 详情接口是否绝不返回明文？
- [ ] 凭证是否走 `hashToken()` SHA-256 等值匹配，而非应用层 byte-by-byte 比较？
- [ ] 是否复用 `generateToken()` / `hashToken()`，未另造加密栈？
- [ ] 「创建 / 撤销凭证」接口是否拒绝用同类凭证自身认证（`assertSessionAuth` 模式）？
- [ ] userId 隔离是否覆盖 list / create / revoke 全部方法？
- [ ] 软删除字段（`revoked_at`）是否有 `WHERE revoked_at IS NULL` 部分索引？
- [ ] 审计时间戳（`last_used_at`）是否 60s 节流 + fire-and-forget？
- [ ] 是否走全局 AuthGuard fallback 分支，而非新造守卫？
- [ ] 迁移 SQL 是否幂等（`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`）？
- [ ] 未来扩展字段（过期、scope 等）是否在初次迁移就预留？
