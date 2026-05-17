import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, type ClientConfig } from 'pg';
import { Subject } from 'rxjs';

/**
 * PG LISTEN/NOTIFY 桥接服务：维护一条独立、长生命周期的 PG 连接专门
 * `LISTEN ml_job_progress`，把收到的 NOTIFY payload 通过 RxJS Subject 广播给
 * 所有 SSE 订阅者。
 *
 * 设计依据：
 * - doc/specs/2026-05-17-quant-model-training/00-index.md §3 通信契约
 * - doc/specs/2026-05-17-quant-model-training/03-nestjs-vue.md §1 进度推送方案
 * - doc/specs/2026-05-17-quant-model-training/05-risks.md §7 PG LISTEN 注意事项
 *
 * 关键约束（硬性）：
 *   1. **独立长连接**：用 `pg` 原生 Client 单独建一条连接，绝不复用 TypeORM 连接池
 *      （池连接会被借出/归还，无法稳定持有 LISTEN）。
 *   2. **NOTIFY payload schema 严格校验**：必须含 `job_id` (uuid)、`progress`
 *      (int 0..100)、`stage` (string)；schema 不符直接 drop + logger.warn。
 *   3. **payload 长度 ≤ 1KB**：PG NOTIFY 上限 8KB，本 spec 进一步收紧到 1KB；
 *      超长 drop + logger.warn。
 *   4. **重连指数退避**：5s → 10s → 20s → 40s → 60s（max），重连成功后立即重新
 *      `LISTEN ml_job_progress`。
 */

export const ML_JOB_PROGRESS_CHANNEL = 'ml_job_progress';
export const PG_LISTEN_PAYLOAD_MAX_BYTES = 1024; // 1KB
export const PG_LISTEN_BACKOFF_SCHEDULE_MS: readonly number[] = [
  5_000,
  10_000,
  20_000,
  40_000,
  60_000,
];

/** NOTIFY payload schema（00-index §3 通信契约固定字段，禁止扩展任意字段） */
export interface MlJobProgressEvent {
  job_id: string;
  progress: number;
  stage: string;
}

/** 简化的 UUID 校验：8-4-4-4-12 hex；不强制 RFC4122 variant/version */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 注入 pg.Client 工厂便于单测替换；默认用 `new Client(config)`。 */
export type PgClientFactory = (config: ClientConfig) => Client;

@Injectable()
export class PgListenService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PgListenService.name);
  private readonly subject = new Subject<MlJobProgressEvent>();

  /** 当前活跃的 pg.Client 实例；停服 / 重连时会先置 null */
  private client: Client | null = null;
  /** 服务是否处于停机状态；设为 true 后不再触发重连 */
  private stopped = false;
  /** 当前重连退避序号（0..backoffSchedule.length-1） */
  private backoffIndex = 0;
  /** 重连定时器句柄，便于 onModuleDestroy 取消 */
  private reconnectTimer: NodeJS.Timeout | null = null;

  private readonly clientFactory: PgClientFactory;

  constructor(private readonly config: ConfigService) {
    this.clientFactory = (cfg) => new Client(cfg);
  }

  // ------ 测试钩子（不导出到外部使用） ------------------------------------

  /** 注入自定义 client 工厂（仅供单测） */
  public _setClientFactory(factory: PgClientFactory): void {
    (this as unknown as { clientFactory: PgClientFactory }).clientFactory = factory;
  }

  /** 拿当前 backoff index（仅供单测断言） */
  public _getBackoffIndex(): number {
    return this.backoffIndex;
  }

  /** 强制触发一次连接周期（仅供单测） */
  public async _connectOnce(): Promise<void> {
    await this.connect();
  }

  /** 强制触发一次重连调度（仅供单测） */
  public _scheduleReconnectForTest(): void {
    this.scheduleReconnect('test');
  }

  // ------ 公共 API -------------------------------------------------------

  /** 订阅 ml_job_progress 事件 Subject；调用方负责 unsubscribe。 */
  events$() {
    return this.subject.asObservable();
  }

  // ------ NestJS 生命周期 -------------------------------------------------

  async onModuleInit(): Promise<void> {
    this.stopped = false;
    await this.connect().catch((err) => {
      // 启动期连接失败不阻塞应用启动；走重连流程
      this.logger.warn(
        `pg_listen_init_failed err=${(err as Error)?.message ?? err}; 走重连流程`,
      );
      this.scheduleReconnect('init_failed');
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try {
        await this.client.end();
      } catch (err) {
        this.logger.warn(
          `pg_listen_close_failed err=${(err as Error)?.message ?? err}`,
        );
      }
      this.client = null;
    }
    this.subject.complete();
  }

  // ------ 连接 / 重连 -----------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopped) return;

    const cfg: ClientConfig = {
      host: this.config.get<string>('DB_HOST', 'localhost'),
      port: this.config.get<number>('DB_PORT', 5432),
      user: this.config.get<string>('DB_USER', 'cryptouser'),
      password: this.config.get<string>('DB_PASS', 'cryptopass'),
      database: this.config.get<string>('DB_NAME', 'cryptodb'),
      application_name: 'nestjs-pg-listen-ml-job-progress',
    };

    const client = this.clientFactory(cfg);

    // pg client 的 error 是 stream 错误（如对端断连）；触发重连
    client.on('error', (err: Error) => {
      this.logger.warn(`pg_listen_error err=${err?.message ?? err}`);
      this.handleConnectionLost('client_error');
    });

    // 当对端关闭连接时 pg.Client 会 emit 'end'
    client.on('end', () => {
      if (!this.stopped) {
        this.logger.warn('pg_listen_end remote closed');
        this.handleConnectionLost('client_end');
      }
    });

    client.on('notification', (msg: { channel?: string; payload?: string }) => {
      if (!msg || msg.channel !== ML_JOB_PROGRESS_CHANNEL) return;
      this.handleNotification(msg.payload ?? '');
    });

    await client.connect();
    await client.query(`LISTEN ${ML_JOB_PROGRESS_CHANNEL}`);

    this.client = client;
    this.backoffIndex = 0;
    this.logger.log(
      `pg_listen_ready channel=${ML_JOB_PROGRESS_CHANNEL} host=${cfg.host} db=${cfg.database}`,
    );
  }

  private handleConnectionLost(reason: string): void {
    // 先释放当前 client 引用，避免重复触发
    const old = this.client;
    this.client = null;
    if (old) {
      try {
        old.removeAllListeners();
      } catch {
        // ignore
      }
    }
    this.scheduleReconnect(reason);
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return; // 已经安排了下一次

    const delay = PG_LISTEN_BACKOFF_SCHEDULE_MS[
      Math.min(this.backoffIndex, PG_LISTEN_BACKOFF_SCHEDULE_MS.length - 1)
    ];
    this.backoffIndex = Math.min(
      this.backoffIndex + 1,
      PG_LISTEN_BACKOFF_SCHEDULE_MS.length - 1,
    );
    this.logger.warn(
      `pg_listen_reconnect_schedule reason=${reason} delay_ms=${delay} next_backoff_index=${this.backoffIndex}`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        this.logger.warn(
          `pg_listen_reconnect_failed err=${(err as Error)?.message ?? err}`,
        );
        this.scheduleReconnect('reconnect_failed');
      });
    }, delay);
  }

  // ------ payload 校验 ---------------------------------------------------

  private handleNotification(rawPayload: string): void {
    // 1) 长度上限
    const byteLen = Buffer.byteLength(rawPayload, 'utf8');
    if (byteLen > PG_LISTEN_PAYLOAD_MAX_BYTES) {
      this.logger.warn(
        `pg_listen_drop reason=payload_too_large bytes=${byteLen} max=${PG_LISTEN_PAYLOAD_MAX_BYTES}`,
      );
      return;
    }

    // 2) JSON 解析
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawPayload);
    } catch {
      this.logger.warn(
        `pg_listen_drop reason=invalid_json snippet=${rawPayload.slice(0, 120)}`,
      );
      return;
    }

    // 3) schema 校验
    const event = this.validatePayload(parsed);
    if (!event) {
      return; // validatePayload 已 logger.warn
    }

    this.subject.next(event);
  }

  /**
   * 严格校验 payload 形如 `{ job_id, progress, stage }`；不符返回 null + warn。
   * 拆为独立函数便于单测覆盖每条 reject 分支。
   */
  private validatePayload(parsed: unknown): MlJobProgressEvent | null {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.logger.warn('pg_listen_drop reason=payload_not_object');
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const jobId = obj.job_id;
    const progress = obj.progress;
    const stage = obj.stage;

    if (typeof jobId !== 'string' || !UUID_RE.test(jobId)) {
      this.logger.warn(`pg_listen_drop reason=invalid_job_id job_id=${String(jobId).slice(0, 80)}`);
      return null;
    }
    if (
      typeof progress !== 'number' ||
      !Number.isInteger(progress) ||
      progress < 0 ||
      progress > 100
    ) {
      this.logger.warn(`pg_listen_drop reason=invalid_progress progress=${String(progress)}`);
      return null;
    }
    if (typeof stage !== 'string' || stage.length === 0) {
      this.logger.warn(`pg_listen_drop reason=invalid_stage stage=${String(stage).slice(0, 80)}`);
      return null;
    }
    return { job_id: jobId, progress, stage };
  }
}
