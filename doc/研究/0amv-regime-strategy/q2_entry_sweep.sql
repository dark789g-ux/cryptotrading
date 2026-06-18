-- Q2 entry-condition sweep on B-exit7 anchor (kdj_j<0 entry + KDJ>90 exit, run 89d71a21)
-- intersect Q2 (oamv_dif>0 AND oamv_macd<0), join raw.daily_indicator at signal_date,
-- subset by tighter entry filters, recompute kelly. Offline subsetting = same valid method as regime slicing.
WITH base AS (
  SELECT tr.ret, left(tr.signal_date,4) AS yr,
         di.kdj_j, di.macd, di.ma5, di.ma60, di.ma240,
         di.brick_xg, di.risk_reward_ratio
  FROM signal_test_trade tr
  JOIN raw.daily_indicator di ON di.ts_code=tr.ts_code AND di.trade_date=tr.signal_date
  JOIN oamv_daily o ON o.trade_date=tr.signal_date
  WHERE tr.run_id='89d71a21-bd62-44cb-bd4a-7c3152ef2d32'
    AND o.amv_dif>0 AND o.amv_macd<0
),
m AS (
  SELECT lbl, n, win, pf,
    round(win - (1-win)/nullif(pf,0), 4) AS kelly, avgret
  FROM (
    SELECT 'V00_J<0_base' lbl, count(*) n,
      round(avg((ret>0)::int)::numeric,3) win,
      round((avg(ret) FILTER (WHERE ret>0))/abs(avg(ret) FILTER (WHERE ret<=0)),2) pf,
      round(avg(ret)::numeric,5) avgret FROM base
    UNION ALL SELECT 'V01_J<-5', count(*),
      round(avg((ret>0)::int)::numeric,3),
      round((avg(ret) FILTER (WHERE ret>0))/abs(avg(ret) FILTER (WHERE ret<=0)),2),
      round(avg(ret)::numeric,5) FROM base WHERE kdj_j<-5
    UNION ALL SELECT 'V02_J<-10', count(*),
      round(avg((ret>0)::int)::numeric,3),
      round((avg(ret) FILTER (WHERE ret>0))/abs(avg(ret) FILTER (WHERE ret<=0)),2),
      round(avg(ret)::numeric,5) FROM base WHERE kdj_j<-10
    UNION ALL SELECT 'V03_J<-15', count(*),
      round(avg((ret>0)::int)::numeric,3),
      round((avg(ret) FILTER (WHERE ret>0))/abs(avg(ret) FILTER (WHERE ret<=0)),2),
      round(avg(ret)::numeric,5) FROM base WHERE kdj_j<-15
    UNION ALL SELECT 'V04_stockMACD>0', count(*),
      round(avg((ret>0)::int)::numeric,3),
      round((avg(ret) FILTER (WHERE ret>0))/abs(avg(ret) FILTER (WHERE ret<=0)),2),
      round(avg(ret)::numeric,5) FROM base WHERE macd>0
    UNION ALL SELECT 'V05_ma5>ma60', count(*),
      round(avg((ret>0)::int)::numeric,3),
      round((avg(ret) FILTER (WHERE ret>0))/abs(avg(ret) FILTER (WHERE ret<=0)),2),
      round(avg(ret)::numeric,5) FROM base WHERE ma5>ma60
    UNION ALL SELECT 'V06_ma60>ma240', count(*),
      round(avg((ret>0)::int)::numeric,3),
      round((avg(ret) FILTER (WHERE ret>0))/abs(avg(ret) FILTER (WHERE ret<=0)),2),
      round(avg(ret)::numeric,5) FROM base WHERE ma60>ma240
    UNION ALL SELECT 'V07_brick_xg>=1', count(*),
      round(avg((ret>0)::int)::numeric,3),
      round((avg(ret) FILTER (WHERE ret>0))/abs(avg(ret) FILTER (WHERE ret<=0)),2),
      round(avg(ret)::numeric,5) FROM base WHERE brick_xg = true
    UNION ALL SELECT 'V08_rrr>2', count(*),
      round(avg((ret>0)::int)::numeric,3),
      round((avg(ret) FILTER (WHERE ret>0))/abs(avg(ret) FILTER (WHERE ret<=0)),2),
      round(avg(ret)::numeric,5) FROM base WHERE risk_reward_ratio>2
    UNION ALL SELECT 'V09_J<-5&macd>0', count(*),
      round(avg((ret>0)::int)::numeric,3),
      round((avg(ret) FILTER (WHERE ret>0))/abs(avg(ret) FILTER (WHERE ret<=0)),2),
      round(avg(ret)::numeric,5) FROM base WHERE kdj_j<-5 AND macd>0
    UNION ALL SELECT 'V10_J<-5&ma5>ma60', count(*),
      round(avg((ret>0)::int)::numeric,3),
      round((avg(ret) FILTER (WHERE ret>0))/abs(avg(ret) FILTER (WHERE ret<=0)),2),
      round(avg(ret)::numeric,5) FROM base WHERE kdj_j<-5 AND ma5>ma60
    UNION ALL SELECT 'V11_J<-5&ma60>ma240', count(*),
      round(avg((ret>0)::int)::numeric,3),
      round((avg(ret) FILTER (WHERE ret>0))/abs(avg(ret) FILTER (WHERE ret<=0)),2),
      round(avg(ret)::numeric,5) FROM base WHERE kdj_j<-5 AND ma60>ma240
    UNION ALL SELECT 'V12_J<-5&macd>0&ma60>ma240', count(*),
      round(avg((ret>0)::int)::numeric,3),
      round((avg(ret) FILTER (WHERE ret>0))/abs(avg(ret) FILTER (WHERE ret<=0)),2),
      round(avg(ret)::numeric,5) FROM base WHERE kdj_j<-5 AND macd>0 AND ma60>ma240
  ) s
)
SELECT lbl, n, win, pf, kelly, avgret FROM m ORDER BY kelly DESC NULLS LAST;
