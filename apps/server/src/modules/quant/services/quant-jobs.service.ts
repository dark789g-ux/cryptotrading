import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MlJobEntity } from '../../../entities/ml/ml-job.entity';
import type { ValidatedCreateJob } from '../dto/create-job.dto';
import type { ValidatedJobQuery } from '../dto/job-query.dto';
import type { SseTokenResponse } from '../dto/sse-token.dto';
import { SseTokenService } from './sse-token.service';
import { LabelsService } from '../labels/labels.service';

/**
 * 列表接口的 job 摘要形态：在 entity 字段之上额外暴露 `warnings_count`，
 * 并**不**回传 warnings 明细（避免列表数据爆炸）。
 *
 * 详情接口 (`findOne`) 仍返回完整 entity（含 warnings 明细），见 spec §4.1.5。
 */
export interface JobListItem extends Omit<MlJobEntity, 'warnings'> {
  warnings_count: number;
}

function toJobListItem(row: MlJobEntity): JobListItem {
  const { warnings, ...rest } = row;
  // entity 在 DB 列设了 default '[]'::jsonb，但读取过去的行（未来从 prod 拉回的快照）
  // 仍可能拿到 null，这里防御一下，count=0。
  const count = Array.isArray(warnings) ? warnings.length : 0;
  return { ...(rest as Omit<MlJobEntity, 'warnings'>), warnings_count: count };
}

/**
 * 动态过滤字段 → 实际 SQL 列名映射（CLAUDE.md 硬约束）。
 *
 * - key：前端 / DTO 传入的过滤字段名（snake_case）
 * - value：QueryBuilder 内的 `alias.column_name`
 *
 * 未命中本表的字段一律 `logger.warn` + skip，禁止把外部字段名直接拼进 SQL。
 */
export const JOBS_FIELD_COL_MAP: Readonly<Record<string, string>> = Object.freeze({
  status: 'j.status',
  run_type: 'j.run_type',
  created_by: 'j.created_by',
  parent_job_id: 'j.parent_job_id',
  // created_at 走 `>= / <=` 区间过滤，本任务不暴露 range 筛选，列出做将来扩展锚点
  created_at: 'j.created_at',
});

/**
 * 把外部字段名翻译为 SQL 列；未命中返回 null（调用方应记 warn 并 skip）。
 *
 * 拆出独立函数便于单测覆盖「FIELD_COL_MAP 未命中」分支。
 */
export function resolveJobsFilterColumn(field: string): string | null {
  const col = JOBS_FIELD_COL_MAP[field];
  return col ?? null;
}

const TERMINAL_STATUSES = new Set<string>(['success', 'failed', 'blocked', 'cancelled']);

@Injectable()
export class QuantJobsService {
  private readonly logger = new Logger(QuantJobsService.name);

  constructor(
    @InjectRepository(MlJobEntity)
    private readonly jobsRepo: Repository<MlJobEntity>,
    private readonly sseTokens: SseTokenService,
    private readonly labels: LabelsService,
  ) {}

  /**
   * 创建一条 pending job。worker 通过 `FOR UPDATE SKIP LOCKED` 拾取。
   *
   * params 走 jsonb 列；CLAUDE.md 禁止裸 `'[]'::jsonb`，但本字段 TypeORM 会把对象序列化为 jsonb，
   * 默认值 `'{}'::jsonb` 已在 entity 处声明。
   *
   * 训练类 run_type 展开 labelRef（spec 03-backend.md §expandForTraining）：
   *   - 调 LabelsService.expandForTraining(id, version)
   *   - 把 base_type/base_params/classify_mode/classify_params 明文 + label_id/label_version 透传
   *     写进 ml.jobs.params
   *   - label 不存在 / enabled=false → fail-fast 抛 400（禁止静默回退默认）
   */
  async create(dto: ValidatedCreateJob, createdBy: string | null): Promise<MlJobEntity> {
    // body 中显式传入的 created_by 仅供 cron / 内部脚本使用；controller 调用时 createdBy
    // 已用当前 user.id 覆盖。这里以参数优先于 dto.createdBy。
    const finalCreatedBy = createdBy ?? dto.createdBy ?? null;

    // 展开 labelRef（训练类 run_type 时 dto.labelRef 已由 validateCreateJob 保证非空）
    let finalParams = { ...dto.params };
    if (dto.labelRef) {
      const expanded = await this.labels.expandForTraining(
        dto.labelRef.labelId,
        dto.labelRef.labelVersion,
      );
      // 展开字段放在 dto.params **之后**覆盖，防止前端误传同名字段绕过后端展开。
      // 语义：expandForTraining 的权威结果不可被请求体中的 params 静默覆盖。
      finalParams = {
        ...dto.params,
        base_type: expanded.base_type,
        base_params: expanded.base_params,
        classify_mode: expanded.classify_mode,
        classify_params: expanded.classify_params,
        label_id: expanded.label_id,
        label_version: expanded.label_version,
      };
    }

    const entity = this.jobsRepo.create({
      runType: dto.runType,
      params: finalParams,
      priority: dto.priority,
      maxAttempts: dto.maxAttempts,
      status: 'pending',
      progress: 0,
      attempts: 0,
      cancelRequested: false,
      parentJobId: dto.parentJobId ?? null,
      createdBy: finalCreatedBy,
    });
    return this.jobsRepo.save(entity);
  }

  async findOne(id: string): Promise<MlJobEntity> {
    const row = await this.jobsRepo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException(`job ${id} 不存在`);
    }
    return row;
  }

  async list(dto: ValidatedJobQuery): Promise<{
    items: JobListItem[];
    total: number;
    page: number;
    page_size: number;
  }> {
    const qb = this.jobsRepo.createQueryBuilder('j');

    // 动态字段过滤：经 FIELD_COL_MAP 翻译，未命中字段 warn + skip
    const candidateFilters: Array<{ field: string; value: unknown }> = [
      { field: 'status', value: dto.status },
      { field: 'run_type', value: dto.runType },
    ];
    for (const f of candidateFilters) {
      if (f.value === undefined || f.value === null) continue;
      const col = resolveJobsFilterColumn(f.field);
      if (!col) {
        this.logger.warn(`list_jobs_filter_skip field=${f.field} (not in FIELD_COL_MAP)`);
        continue;
      }
      qb.andWhere(`${col} = :${f.field}`, { [f.field]: f.value });
    }

    qb.orderBy('j.created_at', 'DESC')
      .skip((dto.page - 1) * dto.pageSize)
      .take(dto.pageSize);

    const [items, total] = await qb.getManyAndCount();
    return {
      // 列表只暴露 warnings_count，不回传明细——明细由详情接口 findOne 提供
      items: items.map(toJobListItem),
      total,
      page: dto.page,
      page_size: dto.pageSize,
    };
  }

  /**
   * 标记 cancel_requested=true；worker 在下一次心跳 / 阶段切换时读到后中止。
   *
   * 仅对 pending / running 状态生效：
   * - 已终态（success / failed / blocked / cancelled）的 job 直接返回当前状态，不视为错误
   * - 不存在的 job 抛 404
   */
  async cancel(id: string): Promise<MlJobEntity> {
    const row = await this.findOne(id);
    if (TERMINAL_STATUSES.has(row.status)) {
      // 终态不可改：返回原行让前端 UI 自行刷新
      return row;
    }
    await this.jobsRepo.update({ id }, { cancelRequested: true });
    return this.findOne(id);
  }

  /**
   * 颁发一个 5 分钟有效的 SSE token。
   *
   * - 仅校验 job 存在；不校验 user 是否「拥有」该 job（项目目前没有 per-job ACL，所有登录用户均可订阅）
   * - token 签发 / 密钥读取细节由 SseTokenService 负责
   * - 返回值除 token 外携带 expires_at（UTC 墙钟）便于前端展示
   */
  async issueSseToken(jobId: string, currentUserId: string): Promise<SseTokenResponse> {
    await this.findOne(jobId); // 顺便确认 job 存在；不存在抛 404
    const issued = this.sseTokens.issueToken(jobId, currentUserId);
    return {
      token: issued.token,
      expires_at: formatUtcWallClock(issued.expiresAt),
      job_id: jobId,
    };
  }
}

/**
 * 把 Date 格式化为 UTC 墙钟字符串 `YYYY-MM-DD HH:mm:ssZ`。
 *
 * CLAUDE.md 时间规范：出参一律 UTC 墙钟字符串，禁 toLocaleString / toISOString().slice。
 */
function formatUtcWallClock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
}
