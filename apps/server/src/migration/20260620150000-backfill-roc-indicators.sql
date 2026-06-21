-- A 股 ROC（roc10/20/60）分批回填：按 ts_code 前两位分桶，每桶独立窗口函数 + UPDATE。
-- 为何分批：一次性全表 PARTITION BY（564 万行、5706 标的）超时；
-- 分桶后每桶只对自身子集排序（每桶 < 1800 标的），实测秒级完成。
-- 口径与 calcIndicators 一致：(qfq_close - N日前qfq_close)/N日前qfq_close*100，
-- 不足 N+1 根或 prev=0 → NULL。幂等可重复执行。

DO $$
DECLARE
  pfx TEXT;
  prefixes TEXT[] := ARRAY['00', '30', '60', '68', '90'];
BEGIN
  FOREACH pfx SLICE 0 IN ARRAY prefixes LOOP
    RAISE NOTICE '[roc-backfill] bucket %', pfx;
    WITH windowed AS (
      SELECT
        ts_code, trade_date, qfq_close,
        ROW_NUMBER() OVER (PARTITION BY ts_code ORDER BY trade_date ASC) AS rn,
        LAG(qfq_close, 10) OVER (PARTITION BY ts_code ORDER BY trade_date ASC) AS p10,
        LAG(qfq_close, 20) OVER (PARTITION BY ts_code ORDER BY trade_date ASC) AS p20,
        LAG(qfq_close, 60) OVER (PARTITION BY ts_code ORDER BY trade_date ASC) AS p60
      FROM raw.daily_quote
      WHERE qfq_close IS NOT NULL
        AND ts_code LIKE pfx || '%'
    ),
    roc AS (
      SELECT ts_code, trade_date,
        CASE WHEN rn <= 10 OR p10 IS NULL OR p10 = 0 THEN NULL
             ELSE ((qfq_close - p10) / p10 * 100)::double precision END AS roc10,
        CASE WHEN rn <= 20 OR p20 IS NULL OR p20 = 0 THEN NULL
             ELSE ((qfq_close - p20) / p20 * 100)::double precision END AS roc20,
        CASE WHEN rn <= 60 OR p60 IS NULL OR p60 = 0 THEN NULL
             ELSE ((qfq_close - p60) / p60 * 100)::double precision END AS roc60
      FROM windowed
    )
    UPDATE raw.daily_indicator i
    SET roc10 = r.roc10, roc20 = r.roc20, roc60 = r.roc60, updated_at = now()
    FROM roc r
    WHERE i.ts_code = r.ts_code AND i.trade_date = r.trade_date;
    RAISE NOTICE '[roc-backfill] bucket % done', pfx;
  END LOOP;
  RAISE NOTICE '[roc-backfill] ALL DONE';
END $$;
