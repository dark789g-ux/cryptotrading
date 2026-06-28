// SSE endpoint - AuthGuard global exception, uses CustomIndexSseGuard instead

import { Controller, Logger, Param, Req, Sse, UseGuards } from '@nestjs/common';
import { Observable } from 'rxjs';
import { Public } from '../../auth/decorators/public.decorator';
import { CustomIndexSseGuard } from './custom-index-sse.guard';
import { CustomIndexService } from './custom-index.service';

export interface CustomIndexSseMessageEvent {
  type?: string;
  data: unknown;
}

const TERMINAL_JOB_STATUSES = new Set(['success', 'failed', 'blocked', 'cancelled']);
const TERMINAL_INDEX_STATUSES = new Set(['ready', 'failed']);

@Controller('custom-indices')
export class CustomIndexSseController {
  private readonly logger = new Logger(CustomIndexSseController.name);

  constructor(private readonly service: CustomIndexService) {}

  /**
   * GET /api/custom-indices/:id/stream?token=
   *
   * token 由 POST sse-token 颁发（payload.job_id = latest ml.jobs.id）；
   * 建连时校验 token.user_id 与 definition 归属一致（见 issueSseToken）。
   */
  @Public()
  @UseGuards(CustomIndexSseGuard)
  @Sse(':id/stream')
  stream(
    @Param('id') customIndexId: string,
    @Req()
    req:
      | {
          on?: (ev: string, cb: () => void) => void;
          sseTokenPayload?: { job_id: string; user_id: string };
        }
      | undefined,
  ): Observable<CustomIndexSseMessageEvent> {
    const tokenUserId = req?.sseTokenPayload?.user_id;
    const jobId = req?.sseTokenPayload?.job_id;
    if (!tokenUserId || !jobId) {
      throw new Error('SSE token 无效');
    }

    return new Observable<CustomIndexSseMessageEvent>((subscriber) => {
      let closed = false;
      const safeNext = (msg: CustomIndexSseMessageEvent) => {
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

      this.service
        .getComputeSnapshot(tokenUserId, customIndexId)
        .then((snap) => {
          if (closed) return;
          if (snap.job_id !== jobId) {
            subscriber.error(new Error('SSE token job_id 与指数 latest_job 不匹配'));
            return;
          }
          safeNext({ data: snap });
          if (TERMINAL_INDEX_STATUSES.has(snap.status)) {
            safeNext({ type: 'complete', data: snap });
            safeComplete();
          }
        })
        .catch((err) => {
          if (!closed) subscriber.error(err);
        });

      const pgListen = this.service.getPgListen();
      const sub = pgListen.events$().subscribe({
        next: async (evt) => {
          if (evt.job_id !== jobId || closed) return;
          try {
            const snap = await this.service.getComputeSnapshot(tokenUserId, customIndexId);
            safeNext({ data: snap });
            const job = await this.service.findJob(jobId);
            if (
              TERMINAL_JOB_STATUSES.has(job.status) ||
              TERMINAL_INDEX_STATUSES.has(snap.status)
            ) {
              safeNext({ type: 'complete', data: snap });
              safeComplete();
            }
          } catch (err) {
            this.logger.warn(
              `custom_index_sse_recheck_failed id=${customIndexId} err=${(err as Error)?.message ?? err}`,
            );
          }
        },
        error: (err) => {
          if (!closed) subscriber.error(err);
        },
      });

      const onClientClose = () => {
        if (closed) return;
        sub.unsubscribe();
        safeComplete();
      };
      try {
        req?.on?.('close', onClientClose);
      } catch {
        // ignore
      }

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
}
