-- =====================================================================
-- 20260705000001-regime-config-v3.sql
--
-- Regime 配置 v3：将旧配置（基于 marketIndex 与 idx_ 前缀字段）
-- 迁移为分桶条件结构（type / target / field）。
-- 同时清空 regime_daily_pick 历史数据（结构与旧象限不兼容）。
-- =====================================================================

UPDATE regime_strategy_config
SET config = jsonb_build_object(
  'quadrants', COALESCE((
    SELECT jsonb_agg(
      CASE
        WHEN (q.value->>'action') = 'trade' THEN
          jsonb_set(
            jsonb_set(
              jsonb_set(
                jsonb_set(q.value, '{match}', migrated_match),
                '{positionRatio}', COALESCE(q.value->>'positionRatio', '0.25')::jsonb
              ),
              '{maxPositions}', COALESCE(q.value->>'maxPositions', '5')::jsonb
            ),
            '{entryConditions}', COALESCE(q.value->'entryConditions', '[]'::jsonb)
          )
        ELSE
          jsonb_set(q.value, '{match}', migrated_match)
      END
    )
    FROM jsonb_array_elements(config->'quadrants') AS q
    CROSS JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'type', 'index',
          'target', config->>'marketIndex',
          'field', regexp_replace(c.value->>'field', '^idx_', ''),
          'operator', c.value->>'operator',
          'value', c.value->'value',
          'compareField', CASE WHEN c.value->>'compareField' IS NOT NULL THEN regexp_replace(c.value->>'compareField', '^idx_', '') END,
          'compareMode', COALESCE(c.value->>'compareMode', 'value')
        )
      ) FILTER (WHERE c.value->>'field' LIKE 'idx_%'), '[]'::jsonb) AS migrated_match
      FROM jsonb_array_elements(q.value->'match') AS c
      WHERE c.value->>'field' LIKE 'idx_%'
    ) AS sub
  ), '[]'::jsonb)
)
WHERE config ? 'quadrants';

UPDATE regime_strategy_config
SET config = jsonb_set(
  config,
  '{quadrants}',
  COALESCE((
    SELECT jsonb_agg(q.value)
    FROM jsonb_array_elements(config->'quadrants') AS q
    WHERE jsonb_array_length(COALESCE(q.value->'match', '[]'::jsonb)) > 0
  ), '[]'::jsonb)
)
WHERE config ? 'quadrants';

TRUNCATE TABLE regime_daily_pick;
