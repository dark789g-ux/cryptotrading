/**
 * 向下截断到 0.01（跨语言逐位一致，与 Python `math.floor(x*100)/100` 给出相同结果）。
 *
 * 统一先 `x*100`、`Math.floor`、再 `/100`；**不要**用字符串截断。
 * 例：floor2(9.99)=9.99；floor2(10.4895)=10.48；floor2(10.567×0.999)=10.55。
 */
export function floor2(x: number): number {
  return Math.floor(x * 100) / 100;
}
