DO $$
DECLARE
  admin_id character varying;
BEGIN
  SELECT id INTO admin_id
  FROM users
  WHERE role = 'admin'
  ORDER BY created_at ASC, id ASC
  LIMIT 1;

  IF admin_id IS NULL THEN
    RAISE EXCEPTION 'Cannot finalize auth workspace migration: no admin user exists';
  END IF;

  UPDATE strategies SET user_id = admin_id WHERE user_id IS NULL;
  UPDATE backtest_runs SET user_id = admin_id WHERE user_id IS NULL;
  UPDATE watchlists SET user_id = admin_id WHERE user_id IS NULL;
  UPDATE symbol_presets SET user_id = admin_id WHERE user_id IS NULL;
  UPDATE a_share_filter_presets SET user_id = admin_id WHERE user_id IS NULL;
END $$;

DO $$
DECLARE
  duplicate_count integer;
BEGIN
  SELECT count(*) INTO duplicate_count
  FROM (
    SELECT user_id, name
    FROM watchlists
    GROUP BY user_id, name
    HAVING count(*) > 1
  ) duplicates;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION 'Cannot add uq_watchlists_user_name: duplicate watchlist names exist per user';
  END IF;

  SELECT count(*) INTO duplicate_count
  FROM (
    SELECT user_id, name
    FROM symbol_presets
    GROUP BY user_id, name
    HAVING count(*) > 1
  ) duplicates;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION 'Cannot add uq_symbol_presets_user_name: duplicate symbol preset names exist per user';
  END IF;

  SELECT count(*) INTO duplicate_count
  FROM (
    SELECT user_id, name
    FROM a_share_filter_presets
    GROUP BY user_id, name
    HAVING count(*) > 1
  ) duplicates;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION 'Cannot add uq_a_share_filter_presets_user_name: duplicate filter preset names exist per user';
  END IF;

  SELECT count(*) INTO duplicate_count
  FROM (
    SELECT watchlist_id, symbol
    FROM watchlist_items
    GROUP BY watchlist_id, symbol
    HAVING count(*) > 1
  ) duplicates;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION 'Cannot add uq_watchlist_items_watchlist_symbol: duplicate watchlist symbols exist';
  END IF;

  SELECT count(*) INTO duplicate_count
  FROM (
    SELECT preset_id, symbol
    FROM symbol_preset_items
    GROUP BY preset_id, symbol
    HAVING count(*) > 1
  ) duplicates;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION 'Cannot add uq_symbol_preset_items_preset_symbol: duplicate preset symbols exist';
  END IF;
END $$;

DO $$
DECLARE
  constraint_record record;
BEGIN
  FOR constraint_record IN
    SELECT tc.table_name, tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_schema = tc.constraint_schema
      AND kcu.constraint_name = tc.constraint_name
      AND kcu.table_name = tc.table_name
    WHERE tc.constraint_schema = 'public'
      AND tc.constraint_type = 'UNIQUE'
      AND tc.table_name IN ('symbol_presets', 'a_share_filter_presets')
    GROUP BY tc.table_name, tc.constraint_name
    HAVING array_agg(kcu.column_name::text ORDER BY kcu.ordinal_position) = ARRAY['name']
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', constraint_record.table_name, constraint_record.constraint_name);
  END LOOP;
END $$;

ALTER TABLE strategies ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE backtest_runs ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE watchlists ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE symbol_presets ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE a_share_filter_presets ALTER COLUMN user_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_strategies_user') THEN
    ALTER TABLE strategies
      ADD CONSTRAINT fk_strategies_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_backtest_runs_user') THEN
    ALTER TABLE backtest_runs
      ADD CONSTRAINT fk_backtest_runs_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_watchlists_user') THEN
    ALTER TABLE watchlists
      ADD CONSTRAINT fk_watchlists_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_symbol_presets_user') THEN
    ALTER TABLE symbol_presets
      ADD CONSTRAINT fk_symbol_presets_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_a_share_filter_presets_user') THEN
    ALTER TABLE a_share_filter_presets
      ADD CONSTRAINT fk_a_share_filter_presets_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;

ALTER TABLE strategies VALIDATE CONSTRAINT fk_strategies_user;
ALTER TABLE backtest_runs VALIDATE CONSTRAINT fk_backtest_runs_user;
ALTER TABLE watchlists VALIDATE CONSTRAINT fk_watchlists_user;
ALTER TABLE symbol_presets VALIDATE CONSTRAINT fk_symbol_presets_user;
ALTER TABLE a_share_filter_presets VALIDATE CONSTRAINT fk_a_share_filter_presets_user;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_watchlists_user_name') THEN
    ALTER TABLE watchlists ADD CONSTRAINT uq_watchlists_user_name UNIQUE (user_id, name);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_symbol_presets_user_name') THEN
    ALTER TABLE symbol_presets ADD CONSTRAINT uq_symbol_presets_user_name UNIQUE (user_id, name);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_a_share_filter_presets_user_name') THEN
    ALTER TABLE a_share_filter_presets ADD CONSTRAINT uq_a_share_filter_presets_user_name UNIQUE (user_id, name);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_watchlist_items_watchlist_symbol') THEN
    ALTER TABLE watchlist_items ADD CONSTRAINT uq_watchlist_items_watchlist_symbol UNIQUE (watchlist_id, symbol);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_symbol_preset_items_preset_symbol') THEN
    ALTER TABLE symbol_preset_items ADD CONSTRAINT uq_symbol_preset_items_preset_symbol UNIQUE (preset_id, symbol);
  END IF;
END $$;
