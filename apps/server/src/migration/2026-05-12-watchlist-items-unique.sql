-- 2026-05-12 watchlist_items 唯一约束迁移
--
-- 用途：
--   1. 清理存量 watchlist_items 中 (watchlist_id, symbol) 重复行（按 id::text 字典序保留最小 id 的那一行）；
--   2. 建立唯一索引 uq_watchlist_items_watchlist_symbol，配合应用层的 ON CONFLICT DO NOTHING
--      支撑 POST /watchlists/upsert-by-name 等"按名 upsert"语义。
--
-- 执行方式（PowerShell）：
--   docker cp apps\server\src\migration\2026-05-12-watchlist-items-unique.sql crypto-postgres:/tmp/uq.sql
--   docker exec crypto-postgres psql -U cryptouser -d cryptodb -f /tmp/uq.sql
--
-- 备注：
--   watchlist_items.id 是 uuid，没有大小语义；用 id::text > id::text 的字典序去保留任意一行即可，
--   重要的是稳定（同一对重复行每次执行删除的目标一致）。

BEGIN;

-- 1. 去重存量重复行
DELETE FROM watchlist_items a
USING watchlist_items b
WHERE a.watchlist_id = b.watchlist_id
  AND a.symbol = b.symbol
  AND a.id::text > b.id::text;

-- 2. 建唯一索引（IF NOT EXISTS 让脚本可重入）
CREATE UNIQUE INDEX IF NOT EXISTS uq_watchlist_items_watchlist_symbol
  ON watchlist_items (watchlist_id, symbol);

COMMIT;
