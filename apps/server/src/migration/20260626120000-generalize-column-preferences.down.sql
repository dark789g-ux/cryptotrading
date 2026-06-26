-- 回滚本次迁移插入的行（日期版本化前缀，避免与未来迁移冲突）
-- 用户后续通过新接口新建的 columns:* 行（id 为 newId，非 colmig 前缀）不受影响。
-- ⚠️ 警告：若用户在迁移后已通过 PUT /preferences/columns/:tableId 更新过这些行
--   （UPDATE 命中同一行、id 仍为 colmig:20260626 前缀），回滚会连同这些更新一并删除。
DELETE FROM user_preferences WHERE id LIKE 'colmig:20260626:%';
