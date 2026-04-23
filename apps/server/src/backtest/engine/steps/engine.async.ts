export function yieldToEventLoop(): Promise<void> {
  // setTimeout(0) 确保事件循环经过 poll 阶段（HTTP I/O），setImmediate 不行
  return new Promise((resolve) => setTimeout(resolve, 0));
}
