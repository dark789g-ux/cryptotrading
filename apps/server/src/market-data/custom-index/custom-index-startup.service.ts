import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class CustomIndexStartupService implements OnModuleInit {
  private readonly logger = new Logger(CustomIndexStartupService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    const rows = await this.dataSource.query<{ id: string }[]>(
      `
        UPDATE custom_index_definitions
        SET status = 'failed',
            last_error = 'interrupted',
            compute_stage = NULL
        WHERE status = 'computing'
        RETURNING id
      `,
    );
    if (rows.length > 0) {
      this.logger.log(
        `custom_index startup: marked ${rows.length} interrupted computing definition(s) as failed`,
      );
    }
  }
}
