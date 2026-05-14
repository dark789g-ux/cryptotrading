-- 一次性 seed：2026-05 本周宏观/政策事件
-- 关联：MacroCalendarService.fetchToday(tradeDate)，查询 [tradeDate-1, tradeDate+3]
-- 字段规范：
--   event_date  YYYY-MM-DD（不是 A 股 YYYYMMDD）
--   event_time  HH:MM:SS or NULL（全天）
--   category    monetary | fiscal | data | corporate
--   importance  low | mid | high   (low 默认会被前端过滤掉)
--
-- 执行：
-- docker exec -i crypto-postgres psql -U cryptouser -d cryptodb < apps/server/src/migration/seed-macro-events-2026-05.sql

INSERT INTO macro_events (event_date, event_time, title, category, importance, detail, source_url) VALUES
  -- ============ 本周（2026-05-11 ~ 2026-05-17） ============
  ('2026-05-12', '09:30:00', '中国 4 月社融数据公布',           'data',      'high',
   '关注新增人民币贷款、M2、社融存量同比；4 月历来是社融季节性高点的回落月份。', NULL),

  ('2026-05-13', NULL,       '工信部半导体新政发布',             'fiscal',    'high',
   '覆盖设备/材料/封测全链条；与大基金三期协同。',                              NULL),

  ('2026-05-13', NULL,       '国家能源局算电协同试点方案细则',    'fiscal',    'high',
   '把 AI 算力中心电力配套纳入新型电力系统建设范畴。',                          NULL),

  ('2026-05-14', '20:30:00', '美国 4 月 CPI 公布',               'data',      'high',
   '影响美联储 7 月降息预期；当前 CME 隐含降息概率 75%。',                      NULL),

  ('2026-05-15', '15:00:00', '央行 5 月 MLF 操作',               'monetary',  'mid',
   '关注操作量是否超额续作。',                                                   NULL),

  -- ============ 下周前两个交易日（用于 upcomingEvents） ============
  ('2026-05-18', NULL,       'LPR 报价（1Y/5Y）',                'monetary',  'high',
   '5 月 LPR 报价。',                                                            NULL),

  ('2026-05-19', '21:30:00', '美联储官员讲话（FOMC 票委）',       'monetary',  'mid',
   '若措辞偏鹰可能推迟 7 月降息预期。',                                          NULL);

-- 验证
SELECT event_date, event_time, importance, title FROM macro_events
 WHERE event_date BETWEEN '2026-05-11' AND '2026-05-19'
 ORDER BY event_date, event_time NULLS LAST;
