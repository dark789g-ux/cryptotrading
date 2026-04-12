/**
 * 冷却期管理 — 精确翻译自 backtest/cooldown.py
 */

/**
 * 为指定交易对设置冷却期。
 * exit_ts 格式: "YYYY-MM-DD HH:MM:SS"
 */
export function setCooldown(
  cooldownUntil: Map<string, string>,
  symbol: string,
  exitTs: string,
  cooldownHours: number,
): void {
  const exitMs = new Date(exitTs.replace(' ', 'T') + 'Z').getTime();
  const cooldownMs = cooldownHours * 3600 * 1000;
  const cooldownTime = new Date(exitMs + cooldownMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = cooldownTime.getUTCFullYear();
  const mo = pad(cooldownTime.getUTCMonth() + 1);
  const d = pad(cooldownTime.getUTCDate());
  const h = pad(cooldownTime.getUTCHours());
  const mi = pad(cooldownTime.getUTCMinutes());
  const s = pad(cooldownTime.getUTCSeconds());
  cooldownUntil.set(symbol, `${y}-${mo}-${d} ${h}:${mi}:${s}`);
}
