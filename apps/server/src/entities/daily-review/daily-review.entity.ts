import {
  Column, CreateDateColumn, Entity, Index,
  PrimaryGeneratedColumn, Unique, UpdateDateColumn,
} from 'typeorm';
import type { StageTiming } from '../../daily-review/daily-review.types';

export type DailyReviewStatus = 'pending' | 'fetching' | 'generating' | 'completed' | 'failed';

@Entity('daily_review')
@Unique(['tradeDate'])
export class DailyReviewEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'trade_date', type: 'varchar', length: 8 })
  tradeDate: string;

  @Index()
  @Column({ type: 'varchar', length: 16 })
  status: DailyReviewStatus;

  @Column({ type: 'jsonb', nullable: true })
  snapshot: unknown | null;

  @Column({ name: 'article_md', type: 'text', nullable: true })
  articleMd: string | null;

  @Column({ name: 'reasoning_content', type: 'text', nullable: true })
  reasoningContent: string | null;

  @Column({ name: 'llm_model', type: 'varchar', length: 64, nullable: true })
  llmModel: string | null;

  @Column({ name: 'token_usage', type: 'jsonb', nullable: true })
  tokenUsage: { prompt: number; completion: number; reasoning: number; total: number } | null;

  @Column({ name: 'stage_timings', type: 'jsonb', nullable: true })
  stageTimings: StageTiming[] | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ name: 'created_by_id', type: 'uuid' })
  createdById: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
