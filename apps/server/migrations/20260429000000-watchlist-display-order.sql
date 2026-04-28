-- 给 watchlists 表添加 display_order
ALTER TABLE watchlists ADD COLUMN display_order INT NOT NULL DEFAULT 0;

-- 给 watchlist_items 表添加 display_order
ALTER TABLE watchlist_items ADD COLUMN display_order INT NOT NULL DEFAULT 0;

-- 初始化现有 watchlists 的 display_order（按 created_at 升序）
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) - 1 AS rn
  FROM watchlists
)
UPDATE watchlists w
SET display_order = o.rn
FROM ordered o
WHERE w.id = o.id;

-- 初始化现有 watchlist_items 的 display_order（按 created_at 升序，每个列表内独立）
WITH ordered AS (
  SELECT id, watchlist_id,
    ROW_NUMBER() OVER (PARTITION BY watchlist_id ORDER BY created_at ASC) - 1 AS rn
  FROM watchlist_items
)
UPDATE watchlist_items wi
SET display_order = o.rn
FROM ordered o
WHERE wi.id = o.id;
