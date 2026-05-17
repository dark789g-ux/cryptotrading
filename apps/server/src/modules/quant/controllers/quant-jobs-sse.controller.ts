// SSE endpoint - AuthGuard global exception, uses SseTokenGuard instead
//
// CLAUDE.md 规定 AuthGuard 已通过 APP_GUARD 全局注册，controller 不得再加 @UseGuards(AuthGuard)。
// 但浏览器原生 EventSource 不携带 cookie 以外的鉴权 header，无法走全局 AuthGuard，
// 因此本 controller 是「全局 AuthGuard」的合法例外：
//   1) 用 @Public() 显式跳过全局 AuthGuard（不会触发 SessionService 校验）
//   2) 用 @UseGuards(SseTokenGuard) 接管鉴权，校验 query 上的短期 token
// 见 03-nestjs-vue.md §1 SSE 鉴权方案 + guards/sse-token.guard.ts 顶注。

import { Controller, Param, Sse, UseGuards } from '@nestjs/common';
import { Observable, interval } from 'rxjs';
import { map, startWith, switchMap, takeWhile } from 'rxjs/operators';
import { Public } from '../../../auth/decorators/public.decorator';
import { SseTokenGuard } from '../guards/sse-token.guard';
import { QuantJobsService } from '../services/quant-jobs.service';

interface ProgressMessage {
  data: {
    job_id: string;
    status: string;
    progress: number;
    stage: string | null;
    heartbeat_at: string | null;
  };
}

const TERMINAL_STATUSES = new Set(['success', 'failed', 'blocked', 'cancelled']);
const POLL_INTERVAL_MS = 1000;

/**
 * `/quant/jobs/:id/stream?token=...` SSE 流接口。
 *
 * M2 阶段实现：每秒 SELECT 一次当前 ml.jobs.{status, progress, stage, heartbeat_at}，
 *              通过 SSE 推给客户端；遇终态后自动断流。
 * M4 升级：替换为 PG LISTEN/NOTIFY ml_job_progress，常驻一条 LISTEN 连接广播给所有订阅者
 *          （见 03-nestjs-vue.md §1「进度推送方案」）。
 *
 * 鉴权链路：
 *   客户端先 POST /quant/jobs/:id/sse-token（受全局 AuthGuard，需登录）拿到 token，
 *   再 new EventSource(`/quant/jobs/:id/stream?token=...`)，本 controller 用 SseTokenGuard 校验。
 */
@Controller('quant/jobs')
export class QuantJobsSseController {
  constructor(private readonly svc: QuantJobsService) {}

  @Public() // 跳过全局 AuthGuard；下面 SseTokenGuard 接管鉴权
  @UseGuards(SseTokenGuard)
  @Sse(':id/stream')
  stream(@Param('id') id: string): Observable<ProgressMessage> {
    return interval(POLL_INTERVAL_MS).pipe(
      startWith(0),
      switchMap(async () => this.svc.findOne(id)),
      // 终态时把最后一条推完（inclusive）就结束订阅，让浏览器 EventSource 收到 close
      takeWhile((row) => !TERMINAL_STATUSES.has(row.status), true),
      map((row) => ({
        data: {
          job_id: row.id,
          status: row.status,
          progress: row.progress,
          stage: row.stage,
          heartbeat_at: row.heartbeatAt ? formatUtcWallClock(row.heartbeatAt) : null,
        },
      })),
    );
  }
}

function formatUtcWallClock(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
}
