-- Exhaustive exit sweep on the V10 entry (kdj_j<-5 AND ma5>ma60) within Q2.
-- Subset each B-family anchor (plain kdj_j<0 entry x one exit) by V10 entry + Q2.
-- V10 signals subset of kdj_j<0 signals, exit per-trade independent => bit-exact to a real V10 x exit_K run.
-- E7_KDJ>90 must reproduce n=28873 (built-in reconciliation vs real run 14ecdbdf).
WITH runs(run_id, ex) AS (VALUES
  ('991d271d-1a9b-4084-98da-381eb91f598c','E1_trail_mhINF'),
  ('d08256cf-2287-447a-95da-b1b5f1d550b4','E2_trail_mh10'),
  ('d3ecb4b8-f0f9-480b-bb97-e08a1d37f08b','E3_trail_mh20'),
  ('4c46c171-28a5-4392-b8c3-04031608ab1f','E4_fixed5'),
  ('102e7304-a498-48ba-bab2-b7d7c52e0432','E5_fixed10'),
  ('a1df5d54-6c4d-4e90-a738-b09f56c0259c','E6_fixed20'),
  ('89d71a21-bd62-44cb-bd4a-7c3152ef2d32','E7_KDJ>90'),
  ('ba29f8f8-ab01-4ee5-90a8-11afb86255b1','E8_break_bbi'),
  ('3ef59aea-3296-4dc4-bc5c-2bc91a76b82f','E9_oamv_macd<0')
),
base AS (
  SELECT r.ex, tr.ret, left(tr.signal_date,4) AS yr
  FROM signal_test_trade tr
  JOIN runs r ON r.run_id::uuid = tr.run_id
  JOIN raw.daily_indicator di ON di.ts_code=tr.ts_code AND di.trade_date=tr.signal_date
  JOIN oamv_daily o ON o.trade_date=tr.signal_date
  WHERE di.kdj_j < -5 AND di.ma5 > di.ma60
    AND o.amv_dif > 0 AND o.amv_macd < 0
),
yr AS (
  SELECT ex, yr, count(*) n,
    round(avg((ret>0)::int)::numeric
      - (1-avg((ret>0)::int)::numeric)/nullif((avg(ret) FILTER(WHERE ret>0))/abs(avg(ret) FILTER(WHERE ret<=0)),0),4) kelly
  FROM base GROUP BY ex, yr
)
-- Part A: overall ranking + discipline summary (deep-loss-year count, worst year)
SELECT b.ex,
  count(*) n,
  round(avg((ret>0)::int)::numeric,3) win,
  round((avg(ret) FILTER(WHERE ret>0))/abs(avg(ret) FILTER(WHERE ret<=0)),2) pf,
  round(avg((ret>0)::int)::numeric
    - (1-avg((ret>0)::int)::numeric)/((avg(ret) FILTER(WHERE ret>0))/abs(avg(ret) FILTER(WHERE ret<=0))),4) kelly_all,
  round(avg(ret)::numeric,5) avgret,
  (SELECT count(*) FROM yr WHERE yr.ex=b.ex AND yr.kelly < -0.05) AS deep_loss_yrs,
  (SELECT round(min(yr.kelly),4) FROM yr WHERE yr.ex=b.ex) AS worst_yr_kelly
FROM base b GROUP BY b.ex
ORDER BY deep_loss_yrs ASC, kelly_all DESC;
