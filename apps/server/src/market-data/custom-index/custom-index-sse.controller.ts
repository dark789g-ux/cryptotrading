// SSE endpoint - AuthGuard global exception, uses CustomIndexSseGuard instead

import {
  Controller,
  ForbiddenException,
  Logger,
  Param,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Public } from '../../auth/decorators/public.decorator';
import { CustomIndexSseGuard } from './custom-index-sse.guard';
import { CustomIndexService } from './custom-index.service';

export interface CustomIndexSseMessageEvent {
  type?: string;
  data: unknown;
}

const TERMINAL_INDEX_STATUSES = new Set(['ready', 'failed']);
const POLL_INTERVAL_MS = 1000;

@Controller('custom-indices')
export class CustomIndexSseController {
  private readonly logger = new Logger(CustomIndexSseController.name);

  constructor(private readonly service: CustomIndexService) {}

  /**
   * GET /api/custom-indices/:id/stream?token=
   *
   * token 由 POST sse-token 颁发（payload.custom_index_id）；
   * 建连后 1s 轮询 custom_index_definitions 推送进度。
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
          sseTokenPayload?: { custom_index_id: string; user_id: string };
        }
      | undefined,
  ): Observable<CustomIndexSseMessageEvent> {
    const tokenUserId = req?.sseTokenPayload?.user_id;
    const tokenIndexId = req?.sseTokenPayload?.custom_index_id;
    if (!tokenUserId || !tokenIndexId) {
      throw new Error('SSE token 无效');
    }
    if (tokenIndexId !== customIndexId) {
      throw new ForbiddenException('SSE token custom_index_id 与 path :id 不匹配');
    }

    return new Observable<CustomIndexSseMessageEvent>((subscriber) => {
      let closed = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;

      const safeNext = (msg: CustomIndexSseMessageEvent) => {
        if (!closed) subscriber.next(msg);
      };
      const safeComplete = () => {
        if (closed) return;
        closed = true;
        if (pollTimer !== undefined) {
          clearInterval(pollTimer);
          pollTimer = undefined;
        }
        try {
          subscriber.complete();
        } catch {
          // ignore
        }
      };

      const pushSnapshot = async () => {
        if (closed) return;
        try {
          const snap = await this.service.getComputeSnapshot(tokenUserId, customIndexId);
          safeNext({ data: snap });
          if (TERMINAL_INDEX_STATUSES.has(snap.status)) {
            safeNext({ type: 'complete', data: snap });
            safeComplete();
          }
        } catch (err) {
          if (!closed) {
            this.logger.warn(
              `custom_index_sse_poll_failed id=${customIndexId} err=${(err as Error)?.message ?? err}`,
            );
          }
        }
      };

      void pushSnapshot();
      pollTimer = setInterval(() => {
        void pushSnapshot();
      }, POLL_INTERVAL_MS);

      const onClientClose = () => {
        safeComplete();
      };
      try {
        req?.on?.('close', onClientClose);
      } catch {
        // ignore
      }

      return () => {
        closed = true;
        if (pollTimer !== undefined) {
          clearInterval(pollTimer);
        }
      };
    });
  }
}
