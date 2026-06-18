-- Q2 entry-variant BY-YEAR kelly (the decisive overfitting check). Deployment line: every year >= -0.05.
WITH base AS (
  SELECT tr.ret, left(tr.signal_date,4) AS yr,
         di.kdj_j, di.macd, di.ma5, di.ma60, di.ma240
  FROM signal_test_trade tr
  JOIN raw.daily_indicator di ON di.ts_code=tr.ts_code AND di.trade_date=tr.signal_date
  JOIN oamv_daily o ON o.trade_date=tr.signal_date
  WHERE tr.run_id='89d71a21-bd62-44cb-bd4a-7c3152ef2d32'
    AND o.amv_dif>0 AND o.amv_macd<0
),
g AS (
  SELECT v, yr, count(*) n,
    round(avg((ret>0)::int)::numeric,3) win,
    round((avg(ret) FILTER (WHERE ret>0))/abs(avg(ret) FILTER (WHERE ret<=0)),2) pf,
    round(avg(ret)::numeric,5) avgret
  FROM (
    SELECT 'A_V00_J<0_base'  v, yr, ret FROM base
    UNION ALL SELECT 'B_V05_ma5>ma60',      yr, ret FROM base WHERE ma5>ma60
    UNION ALL SELECT 'C_V10_J<-5&ma5>ma60', yr, ret FROM base WHERE kdj_j<-5 AND ma5>ma60
    UNION ALL SELECT 'D_V11_J<-5&ma60>ma240', yr, ret FROM base WHERE kdj_j<-5 AND ma60>ma240
    UNION ALL SELECT 'E_V02_J<-10',          yr, ret FROM base WHERE kdj_j<-10
  ) u GROUP BY v, yr
)
SELECT v, yr, n, win, pf,
  round(win-(1-win)/nullif(pf,0),4) AS kelly, avgret,
  CASE WHEN round(win-(1-win)/nullif(pf,0),4) < -0.05 THEN '<<DEEP LOSS' ELSE '' END AS flag
FROM g ORDER BY v, yr;
