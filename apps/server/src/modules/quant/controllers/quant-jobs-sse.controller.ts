// SSE endpoint - AuthGuard global exception, uses SseTokenGuard instead
//
// CLAUDE.md 规定 AuthGuard 已通过 APP_GUARD 全局注册，controller 不得再加 @UseGuards(AuthGuard)。
// 但浏览器原生 EventSource 不携带 cookie 以外的鉴权 header，无法走全局 AuthGuard，
// 因此本 controller 是「全局 AuthGuard」的合法例外：
//   1) 用 @Public() 显式跳过全局 AuthGuard（不会触发 SessionService 校验）
//   2) 用 @UseGuards(SseTokenGuard) 接管鉴权，校验 query 上的短期 token
// 见 03-nestjs-vue.md §1 SSE 鉴权方案 + guards/sse-token.guard.ts 顶注。

import { Controller, ForbiddenException, Logger, Param, Req, Sse, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Observable } from 'rxjs';
import { Repository } from 'typeorm';
import { Public } from '../../../auth/decorators/public.decorator';
import { UserEntity } from '../../../users/entities/user.entity';
import { SseTokenGuard } from '../guards/sse-token.guard';
import { QuantJobsService } from '../services/quant-jobs.service';
import { PgListenService, type MlJobProgressEvent } from '../realtime/pg-listen.service';

export interface SseMessageEvent {
  /** SSE event 类型（默认 'message'；终态时用 'complete'） */
  type?: string;
  data: unknown;
}

const TERMINAL_STATUSES = new Set<string>(['success', 'failed', 'blocked', 'cancelled']);

/**
 * `/quant/jobs/:id/stream?token=...` SSE 流接口（M4 真实实现）。
 *
 * 行为合同（来自 00-index.md §3 / 03-nestjs-vue.md §1）：
 *   1. 建立连接的瞬间先 `SELECT progress FROM ml.jobs WHERE id=:id` 推一条「快照」事件，
 *      避免 LISTEN 注册之前的进度被错过
 *   2. 之后订阅 PgListenService 的广播 Subject，filter `job_id === path.id` 后转发为 SSE event
 *   3. 终态（success / failed / blocked / cancelled）→ 发一条 `complete` event 后关闭流
 *   4. 客户端主动断开（unsubscribe）时自动取消订阅，防止泄漏
 *
 * 鉴权链路：客户端先 POST /quant/jobs/:id/sse-token（受全局 AuthGuard）拿 token，
 *   再 `new EventSource('/quant/jobs/:id/stream?token=...')`；本 controller 用
 *   SseTokenGuard 校验 token，path.id 必须等于 token.job_id。
 */
@Controller('quant/jobs')
export class QuantJobsSseController {
  private readonly logger = new Logger(QuantJobsSseController.name);

  constructor(
    private readonly jobs: QuantJobsService,
    private readonly pgListen: PgListenService,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
  ) {}

  @Public() // 跳过全局 AuthGuard；下面 SseTokenGuard 接管鉴权
  @UseGuards(SseTokenGuard)
  @Sse(':id/stream')
  stream(
    @Param('id') id: string,
    @Req()
    req:
      | {
          on?: (ev: string, cb: () => void) => void;
          sseTokenPayload?: { job_id: string; user_id: string };
        }
      | undefined,
  ): Observable<SseMessageEvent> {
    // 二次校验：SseTokenGuard 已校验 token 签名 + job_id 对齐，
    // 但 token 颁发时该 user 是 admin、之后可能被降级（`UPDATE users SET role='user'`）。
    // 在 Observable 内首次异步查 DB 拿当前 role，非 admin 则 subscriber.error 关流。
    // 不在 token 内编码 role，避免 stale 角色被复用。
    // （spec 03-backend.md「SSE 守卫」节，refactor 2026-05-23 由 env 白名单改为 users.role）
    const tokenUserId = req?.sseTokenPayload?.user_id;
    if (!tokenUserId) {
      this.logger.warn(
        `sse_stream_reject reason=token_missing_user_id job_id=${id}`,
      );
      throw new ForbiddenException('需要管理员权限');
    }
    return new Observable<SseMessageEvent>((subscriber) => {
      let closed = false;
      const safeNext = (msg: SseMessageEvent) => {
        if (!closed) subscriber.next(msg);
      };
      const safeComplete = () => {
        if (closed) return;
        closed = true;
        try {
          subscriber.complete();
        } catch {
          // ignore
        }
      };

      // 0) admin 二次校验：DB 查 users.role；非 admin 直接 subscriber.error 关流。
      //    放在 Observable 内是为了避免在 stream() 同步路径上做 await；
      //    EventSource 客户端收到 error 后会自动 disconnect。
      // 1) 快照：admin 校验通过后立即 SELECT 一次当前 progress 推给客户端
      //    findOne 抛错（NotFoundException）会通过 subscriber.error 透传给客户端关闭流
      this.users
        .findOne({ where: { id: tokenUserId }, select: { id: true, role: true } })
        .then((user) => {
          if (closed) return null;
          if (!user || user.role !== 'admin') {
            this.logger.warn(
              `sse_stream_reject reason=user_not_admin job_id=${id} token_user_id=${tokenUserId}`,
            );
            subscriber.error(new ForbiddenException('需要管理员权限'));
            return null;
          }
          return this.jobs.findOne(id);
        })
        .then((row) => {
          if (closed || !row) return;
          safeNext(this.toMessage(row));
          if (TERMINAL_STATUSES.has(row.status)) {
            // 已经终态：再补一条 complete 后关流，订阅 PG 也无意义
            safeNext({ type: 'complete', data: { job_id: row.id, status: row.status } });
            safeComplete();
          }
        })
        .catch((err) => {
          if (closed) return;
          this.logger.warn(
            `sse_snapshot_failed job_id=${id} err=${(err as Error)?.message ?? err}`,
          );
          subscriber.error(err);
        });

      // 2) 订阅 PgListenService Subject，只转发当前 job_id 的事件
      const sub = this.pgListen.events$().subscribe({
        next: async (evt: MlJobProgressEvent) => {
          if (evt.job_id !== id) return;
          // NOTIFY 只带 progress / stage；status 不在 payload 内
          // 需要重新 SELECT 一次拿 status 来判断终态
          // 但 NOTIFY 高频时频繁 SELECT 不划算 → 只在 progress=100 或 stage 暗示
          // 终态时回查一次；否则直接转发 progress/stage 即可（spec 行为合同 ②）
          if (closed) return;
          if (evt.progress >= 100) {
            try {
              const row = await this.jobs.findOne(id);
              if (closed) return;
              safeNext(this.toMessage(row));
              if (TERMINAL_STATUSES.has(row.status)) {
                safeNext({
                  type: 'complete',
                  data: { job_id: row.id, status: row.status },
                });
                safeComplete();
              }
            } catch (err) {
              this.logger.warn(
                `sse_terminal_recheck_failed job_id=${id} err=${(err as Error)?.message ?? err}`,
              );
            }
            return;
          }
          // 非终态：直接转发 NOTIFY payload（spec 行为合同 ②）
          safeNext({
            data: {
              job_id: evt.job_id,
              progress: evt.progress,
              stage: evt.stage,
            },
          });
        },
        error: (err) => {
          this.logger.warn(
            `sse_subject_error job_id=${id} err=${(err as Error)?.message ?? err}`,
          );
          if (!closed) subscriber.error(err);
        },
      });

      // 3) 客户端断开（http req close）时取消订阅，防止泄漏
      const onClientClose = () => {
        if (closed) return;
        sub.unsubscribe();
        safeComplete();
      };
      try {
        req?.on?.('close', onClientClose);
      } catch {
        // ignore：测试场景下 req 可能没有 on
      }

      // teardown：Observable 退订（终态 complete 或 client close 后 RxJS 会调用）
      return () => {
        closed = true;
        try {
          sub.unsubscribe();
        } catch {
          // ignore
        }
      };
    });
  }

  /** ml.jobs 行 → SSE message（与 M2 polling 占位字段保持兼容） */
  private toMessage(row: {
    id: string;
    status: string;
    progress: number;
    stage: string | null;
    heartbeatAt: Date | null;
  }): SseMessageEvent {
    return {
      data: {
        job_id: row.id,
        status: row.status,
        progress: row.progress,
        stage: row.stage,
        heartbeat_at: row.heartbeatAt ? formatUtcWallClock(row.heartbeatAt) : null,
      },
    };
  }
}

function formatUtcWallClock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
}
