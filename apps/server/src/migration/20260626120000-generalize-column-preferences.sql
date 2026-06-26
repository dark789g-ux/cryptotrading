-- 迁移前置核对（执行前建议先跑）：
--   docker exec crypto-postgres psql -U cryptouser -d cryptodb -c \
--     "SELECT user_id, jsonb_typeof(value->'aShares') FROM user_preferences WHERE key='symbols_view_columns' LIMIT 5;"
-- 若出现 array（极老数据），需增加数组分支；若全为 object 则本脚本可直接执行。

-- 把 symbols_view_columns 单行大 JSON 的 5 个 scope 拆成 per-table 行 columns:<scope>
-- 幂等：确定性 id（colmig:20260626:<user_id>:<scope>）+ ON CONFLICT (user_id,key) DO NOTHING
-- 旧行保留不删，作回滚兜底
INSERT INTO user_preferences (id, user_id, key, value, updated_at)
SELECT
  'colmig:20260626:' || up.user_id || ':' || s.scope,
  up.user_id,
  'columns:' || s.scope,
  up.value -> s.scope,
  now()
FROM user_preferences up
CROSS JOIN (VALUES ('crypto'),('aShares'),('usStocks'),('aSharesIndex'),('aSharesIndexSw')) AS s(scope)
WHERE up.key = 'symbols_view_columns'
  AND up.value ? s.scope
  AND jsonb_typeof(up.value -> s.scope) = 'object'
ON CONFLICT (user_id, key) DO NOTHING;
