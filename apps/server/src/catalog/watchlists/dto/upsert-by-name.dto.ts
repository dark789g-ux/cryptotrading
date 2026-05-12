/**
 * 按 (userId, name) upsert 自选股列表的入参 DTO。
 *
 * 注意：项目未注册全局 ValidationPipe 且未安装 class-validator，
 * 校验在 service 内部以显式 throw BadRequestException 完成（与同模块其它端点一致）。
 */
export class UpsertByNameDto {
  /** 自选列表名称（用作 (userId, name) 上的唯一键） */
  name!: string;

  /** 待加入的标的代码列表（按原序去重，已在列表内的会跳过） */
  symbols!: string[];
}

export interface UpsertByNameResult {
  watchlistId: string;
  name: string;
  /** 该 watchlist 是否在本次调用中新建 */
  created: boolean;
  /** 实际新增到 watchlist_items 的条数 */
  added: number;
  /** 去重后仍在列表内被跳过的条数（不含入参重复压缩） */
  skipped: number;
}
