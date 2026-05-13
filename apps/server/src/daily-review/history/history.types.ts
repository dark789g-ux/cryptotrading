/**
 * ReviewHistoryService 公共类型
 *
 * 对应 spec doc/specs/2026-05-13-tool-calling-daily-review-design.md
 * 中 § 5.1 read_previous_review 工具与 § 3 Stage0 previousReviewSummary 的返回结构。
 */

/**
 * read_previous_review 工具返回的完整结构
 * - tradeDate：A 股交易日，Tushare 标准 YYYYMMDD 字符串
 * - nextDayJudgment：从已生成的复盘文章中提取的「对下一交易日的核心判断」文本
 * - evidencePack：T1 阶段在 daily_review 表新增的 evidencePack 列；
 *   迁移尚未落库时为 null（不抛错，仅降级）
 */
export interface PreviousReview {
  tradeDate: string;
  nextDayJudgment: string;
  evidencePack: object | null;
}

/**
 * snapshot.previousReviewSummary 字段：仅给 Stage0 snapshot 用的轻量摘要
 */
export interface PreviousReviewSummary {
  tradeDate: string;
  nextDayJudgmentExcerpt: string;
}
