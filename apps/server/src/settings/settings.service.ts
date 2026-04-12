import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SymbolEntity } from '../entities/symbol.entity';
import { AppConfigEntity } from '../entities/app-config.entity';

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(SymbolEntity)
    private readonly symbolRepo: Repository<SymbolEntity>,
    @InjectRepository(AppConfigEntity)
    private readonly configRepo: Repository<AppConfigEntity>,
  ) {}

  /** 获取所有被排除的标的 */
  async getExcludedSymbols(): Promise<string[]> {
    const symbols = await this.symbolRepo.find({ where: { isExcluded: true } });
    return symbols.map((s) => s.symbol);
  }

  /** 设置排除标的列表（全量替换） */
  async setExcludedSymbols(symbols: string[]): Promise<{ ok: boolean }> {
    await this.symbolRepo.update({}, { isExcluded: false });
    if (symbols.length) {
      for (const sym of symbols) {
        await this.symbolRepo.update({ symbol: sym }, { isExcluded: true });
      }
    }
    return { ok: true };
  }

  /** 获取 app_config 中的某个键 */
  async getConfig(key: string): Promise<unknown> {
    const row = await this.configRepo.findOneBy({ key });
    return row?.value ?? null;
  }

  /** 设置 app_config 中的某个键 */
  async setConfig(key: string, value: unknown): Promise<{ ok: boolean }> {
    await this.configRepo.upsert({ key, value: value as any }, ['key']);
    return { ok: true };
  }

  /** 获取全部 app_config */
  async getAllConfigs(): Promise<Record<string, unknown>> {
    const rows = await this.configRepo.find();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
}
