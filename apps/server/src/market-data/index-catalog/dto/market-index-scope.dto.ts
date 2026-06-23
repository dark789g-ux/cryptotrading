/**
 * 大盘宽基范围管理 DTO。
 *
 * 路由前缀 market-index-scope（全局 /api）：
 * - GET  /api/market-index-scope/discover  发现候选（@AdminOnly）
 * - GET  /api/market-index-scope           当前范围
 * - POST /api/market-index-scope/add       加入范围（@AdminOnly）
 * - POST /api/market-index-scope/remove    移出范围（@AdminOnly）
 */

/** POST /add 入参。 */
export class AddToScopeDto {
  /** TS 指数代码，如 '000300.SH'。 */
  tsCode!: string;
  /** 指数简称。 */
  name!: string;
}

/** POST /remove 入参。 */
export class RemoveFromScopeDto {
  /** TS 指数代码。 */
  tsCode!: string;
}
