# 07 · 实施序列与任务拆分

← 回到 [index.md](./index.md)

## 实施批次（按独立文件域切分，便于并行、不用 worktree）

```text
批次 0（串行·前置，单 agent）
   Alembic revision 链摸底 → 必要时 stamp 对齐
   → migration 建 factors.label_definitions 表 + 4 条种子标签（值落源头核对）
   → docker exec 验证 SQL 确认 4 行
   ▼ 表就位，后续才能跑通端到端

批次 1（三域并行，文件域互不相交）
   域A Python pipeline  labels/classify/training/worker        ── 完全独立
   域B 后端 NestJS      实体/CRUD/expandForTraining/DTO/module  ── 依赖批次0的表
   域C 前端 Vue         管理页/Modal/buildParams/api/路由        ── 按 03/04 API 契约先行
   ▼
批次 2（串行·集成验证，单 agent）
   端到端联调：前端选种子标签 → 后端展开 → Python 训练跑通
   + 复用验证测试（同 feature_set 两个 ε，labels/features 不重算）
   ⚠ 重启 server + Python worker（后端无 watch、worker 常驻，不重启撞旧行为）
```

## 文件域不相交检查（避免并行 agent 互相覆盖）

```text
域A 仅碰 apps/quant-pipeline/src/quant_pipeline/{labels,training,worker}/** + tests
域B 仅碰 apps/server/src/{entities/ml,modules/quant}/** + app.module.ts
域C 仅碰 apps/web/src/{views/quant,components/quant,api/modules}/** + router/菜单
批次0 仅碰 apps/quant-pipeline/.../db/migrations/versions/**
```

唯一交叠点 `app.module.ts`（域B 内部）— 由域B 单 agent 负责，无跨域冲突。
API 契约（端点 + DTO 形状）已在 [03-backend.md](./03-backend.md) / [04-frontend.md](./04-frontend.md)
定死，域B/域C 按契约并行开发，批次 2 联调。

## 分层 commit（按子系统）

提交切成语义清晰的多个 commit：

```text
1. feat(quant-pipeline): label_definitions migration + 种子标签
2. feat(quant-pipeline): 分类后移 — fwd_ret 统一 / classify.py / base_scheme_codec
3. feat(server): 标签定义 CRUD + 建 job 时展开命名标签
4. feat(web): 标签库管理页 + 训练入口改用命名标签
```

## 上线后验证清单

```text
□ alembic current == head（drift 已消除）
□ docker exec 查 factors.label_definitions 4 条种子行，参数与 05 表逐一吻合
□ /quant/labels 页面真机打开不白屏，CRUD 正常
□ 训练入口下拉列出 4 条种子标签 + 自建标签
□ 选 next_day_band05 训练跑通；改 ε 新建标签再训练，确认未重算 labels/features
□ ml.model_runs.hyperparams 含 label_id + label_version
□ 老 dir3_band / fwd_5d_ret 的历史 model_run / feature_set 仍可查、未受影响
```

## 关键风险与回滚

- **Alembic drift 处理失误** → 撞"已存在"或链分叉。缓解：批次 0 严格走 5 步前置；
  migration 可 `downgrade` 删表回滚（种子随表删除）
- **`base_scheme_codec` legacy 回归不严** → 老 feature_set 哈希漂移变孤儿。缓解：
  固定输入→固定哈希回归断言（见 [06](./06-validation-and-testing.md#测试矩阵)）
- **既存 fwd scheme 碰撞**：现状 h=3/5/10 混存于 `'fwd_5d_ret'`（PK 不含 horizon），新
  codec 让 h≠5 用独立串修复碰撞，但历史以 `'fwd_5d_ret'` 存过的 h=3/10 feature_set 会变
  孤儿。缓解：实施时确认库中是否有 h≠5 历史 fwd 数据，需要则重算；h=5（主流）不受影响
- **前端 SFC 编译错 type-check 查不出** → 路由白屏。缓解：合并前必跑 vite build + 真机点开
- **实体漏双注册** → 运行时 500。缓解：[03](./03-backend.md) 已硬性标注，批次 2 启动后立即冒烟
