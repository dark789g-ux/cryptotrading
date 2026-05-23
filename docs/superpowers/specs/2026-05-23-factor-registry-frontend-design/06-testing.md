# 06 · 测试策略

← 回到 [index.md](./index.md)

## 1. quant-pipeline (pytest)

```text
tests/unit/factors/test_registry_db_load.py
  - test_load_from_db_populates_meta_cache
      一次加载 16 个因子，缓存键齐
  - test_reload_from_db_refreshes_cache
      先改 DB 再 reload，新值替换旧值
  - test_missing_meta_raises_factor_meta_missing
      类已注册但 DB 无行 → 启动 raise FactorMetaMissing (fail-fast)
  - test_disabled_factor_excluded_from_list_active
      enabled=false 不出现在 list_active 输出
  - test_feature_set_id_changes_on_enabled_toggle
      启停后 SHA256 哈希变化 → 新 feature_set_id

tests/unit/factors/test_factor_compute_unchanged.py
  - 参数化跑通现有 16 个因子的 compute，确认 refactor 没改计算
  - 对比 refactor 前后输出 dataframe 的 hash，断言逐字节一致
  - 16 个因子清单参见 02-pipeline-refactor.md 影响文件段

tests/unit/worker/test_train_e2e_uses_active_factors.py
  - mock DB，禁用某因子，跑 train_e2e_runner
  - 断言生成的 feature_matrix 列集合不含被禁用的 factor_id
  - 断言 reload_from_db 在 runner 入口被调用一次
```

## 2. NestJS (Jest)

```text
apps/server/src/modules/quant/factors/__tests__/
  factors.service.spec.ts
    - listFactors 过滤 enabled / category 生效
    - updateFactor 写入 updated_at = NOW、updated_by = req.user.id
    - updateFactor 未传字段保持原值（partial update 正确性）
    - findOne 不存在 → NotFoundException

  factors.controller.spec.ts
    - PATCH 校验 DTO：
        pit_window_days 边界 (1..400)
        category enum
        description max length
    - 未登录 → 401（全局 AuthGuard）
    - 已登录但 user.role !== 'admin' → 403（AdminGuard）
    - admin → 200

apps/server/src/auth/__tests__/admin.guard.spec.ts
  - isAdminUser: role=admin → true；role=user / 缺失 / null → false；
                 大小写敏感（仅严格小写 'admin'）
  - AdminGuard.canActivate:
      req.user.role === 'admin' → 放行
      req.user.role === 'user' → ForbiddenException
      req.user 缺失（兜底）→ ForbiddenException
      req.user.role 缺失 → ForbiddenException
```

## 3. 前端 (Vitest)

```text
apps/web/src/components/quant/__tests__/
  FactorTable.spec.ts
    - 渲染 16 行，启停 switch 显示正确状态
    - 点 switch → 弹 popconfirm；confirm 后调 quantApi.updateFactor mock；
      取消不调
    - 失败时回滚 UI 状态
    - 顶部统计 "启用 X / Y" 正确反映 props

  FactorEditModal.spec.ts
    - formula / data_source 字段渲染为只读（无 input element 或 readonly 属性）
    - description / pit_window_days 必填校验
    - pit_window_days 边界（0 → disable 保存按钮）
    - 保存按钮点击调 quantApi.updateFactor mock，传值正确
    - 改 pit_window_days 时显示警告 banner

apps/web/src/views/quant/__tests__/
  QuantFactorsView.spec.ts
    - mount 时调 listFactors + listFactorCategories
    - 筛选区改值 → 重新调 listFactors（带 query）
    - onActivated 重新拉取（keep-alive 场景）
    - 路由守卫：非 admin 跳转 forbidden
```

## 4. 端到端手动校验

清单（部署后跑一遍）：

- [ ] 登录 admin → 进 /quant/factors → 改 momentum_20d 的 pit_window_days
- [ ] 触发 train_e2e job → worker 日志看到 `reload_from_db` 并使用新窗口值
- [ ] 禁用 amihud_illiq_20d → 触发 train_e2e → 新 feature_set_id 哈希变化（与上次不同）→ feature_matrix 列不含 amihud_illiq_20d
- [ ] 非 admin 用户访问 /quant/* → 全部 302/403
- [ ] 非 admin 用户的顶部菜单看不到「量化」入口
- [ ] DB 无 `role='admin'` 用户 → 任何人访问 /quant/* 都 403
- [ ] `/api/auth/me` 响应包含 `is_admin: true/false`

## 5. 测试数据

- pytest fixture: `factor_definitions_seed` 灌 16 行测试数据（与 migration INSERT 内容一致），各 spec 用 transaction rollback 隔离
- jest fixture: 同上，但走 TypeORM seed
- vitest: 全部走 MSW mock，不真连后端

## 6. CI Gate

- `pnpm --filter @cryptotrading/server build` 全绿
- `pnpm --filter @cryptotrading/server exec jest factors` 全绿
- `pnpm --filter @cryptotrading/web type-check` 全绿
- `pnpm --filter @cryptotrading/web test` 全绿
- `pnpm --filter @cryptotrading/web lint:quant-lines` 全绿（500 行约束）
- quant-pipeline `pytest tests/unit/factors tests/unit/worker` 全绿
