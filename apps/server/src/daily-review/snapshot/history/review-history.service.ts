import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DailyReviewEntity } from '../../../entities/daily-review/daily-review.entity';
import type { PreviousReview, PreviousReviewSummary } from './history.types';

/**
 * ReviewHistoryService
 *
 * 提供「上一交易日已完成的复盘」回查能力：
 * - readPrevious(offsetDays)：read_previous_review 工具背后的实现（§ 5.1）
 * - previousSummary(offsetDays)：给 Stage0 snapshot.previousReviewSummary 的摘要（§ 3）
 *
 * 关键约束（CLAUDE.md）：
 * - tradeDate 一律 Tushare 标准 YYYYMMDD 字符串，禁止 `new Date(tradeDate)`
 * - evidencePack 列在 T1 同期添加，本服务必须容错（未 migrate 时不报错）
 */
@Injectable()
export class ReviewHistoryService {
  private readonly logger = new Logger(ReviewHistoryService.name);

  /** fallback 提取时的最大字符数（spec § 5.1 实现要点） */
  private static readonly FALLBACK_MAX_CHARS = 800;
  /** previousSummary 摘要最大字符数 */
  private static readonly SUMMARY_MAX_CHARS = 300;

  constructor(
    @InjectRepository(DailyReviewEntity)
    private readonly repo: Repository<DailyReviewEntity>,
  ) {}

  /**
   * offsetDays=1 → 最近一次 status='completed' 的复盘
   * offsetDays=2 → 倒数第二次，以此类推
   *
   * 未命中返回 null（不抛异常）；offsetDays < 1 视为 1。
   */
  async readPrevious(offsetDays: number): Promise<PreviousReview | null> {
    const offset = Math.max(0, Math.floor(offsetDays) - 1);

    const row = await this.repo
      .createQueryBuilder('r')
      .where('r.status = :status', { status: 'completed' })
      .orderBy('r.tradeDate', 'DESC')
      .skip(offset)
      .take(1)
      .getOne();

    if (!row) return null;

    const articleMd = row.articleMd ?? '';
    const nextDayJudgment = this.extractNextDayJudgment(articleMd);

    // T1 migration 之前 evidencePack 列尚未存在，容错读取
    const evidencePack =
      ((row as unknown as { evidencePack?: object | null }).evidencePack ?? null);

    return {
      tradeDate: row.tradeDate,
      nextDayJudgment,
      evidencePack,
    };
  }

  /**
   * 给 Stage0 snapshot.previousReviewSummary 用的轻量摘要：
   * 只回传 tradeDate + nextDayJudgment 的前 300 字。
   */
  async previousSummary(offsetDays: number): Promise<PreviousReviewSummary | null> {
    const prev = await this.readPrevious(offsetDays);
    if (!prev) return null;

    const excerpt = this.truncate(prev.nextDayJudgment, ReviewHistoryService.SUMMARY_MAX_CHARS);
    return {
      tradeDate: prev.tradeDate,
      nextDayJudgmentExcerpt: excerpt,
    };
  }

  /**
   * 从 articleMd 中提取「对下一交易日的核心判断」小节。
   *
   * 规则（spec § 5.1）：
   * 1) 优先匹配「## 一、先给结论」段内的「对下一交易日的核心判断」三级/小节标题，取到下一同级或同段结束
   * 2) 找不到锚点时 fallback：取 `## 一、` 与 `## 二、` 之间的整段，截前 800 字
   * 3) 仍无法定位时回传空串（调用方自行处理）
   */
  private extractNextDayJudgment(articleMd: string): string {
    if (!articleMd) return '';

    // 1) 先定位「## 一、」段。一级条目可能写作「## 一、先给结论」「## 一、结论」等
    const sectionOneMatch = articleMd.match(/##\s*一[、,，.][^\n]*\n([\s\S]*?)(?=\n##\s|$)/);
    const sectionOneBody = sectionOneMatch ? sectionOneMatch[1] : '';

    // 2) 在第一段内找「对下一交易日的核心判断」小节锚点（### 或 **加粗** 或独立行）
    //    锚点关键字宽松匹配：含「下一交易日」+「判断」即可
    if (sectionOneBody) {
      const anchorRegex =
        /(?:###+\s*|\*\*\s*|^|\n)([^\n]*下一交易日[^\n]*判断[^\n]*)\n([\s\S]*?)(?=\n###+\s|\n\*\*[^*\n]+\*\*\s*\n|\n##\s|$)/;
      const m = sectionOneBody.match(anchorRegex);
      if (m && m[2]) {
        const body = this.cleanMarkdown(m[2]);
        if (body) return body;
      }
    }

    // 3) Fallback：取 `## 一、` 与 `## 二、` 之间整段，截前 800 字
    const fallbackMatch = articleMd.match(/##\s*一[、,，.][\s\S]*?(?=##\s*二[、,，.]|$)/);
    if (fallbackMatch) {
      return this.truncate(this.cleanMarkdown(fallbackMatch[0]), ReviewHistoryService.FALLBACK_MAX_CHARS);
    }

    return '';
  }

  private cleanMarkdown(text: string): string {
    return text
      .replace(/^\s+|\s+$/g, '')
      .replace(/\n{3,}/g, '\n\n');
  }

  private truncate(text: string, max: number): string {
    if (!text) return '';
    return text.length > max ? text.slice(0, max) : text;
  }
}
