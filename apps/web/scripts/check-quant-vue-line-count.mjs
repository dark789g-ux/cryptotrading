#!/usr/bin/env node
/**
 * Vue 单文件 ≤ 500 行 CI 校验脚本（spec 04-error-quality-testing.md / m4-monitoring-frontend-v2.md §交付物9）。
 *
 * 扫描范围：
 *   - apps/web/src/views/quant/**\/*.vue
 *   - apps/web/src/components/quant/**\/*.vue
 *
 * 任一文件 > 500 行 → exit 1 + 打印超标文件清单（含行数）。
 *
 * 用法：
 *   node apps/web/scripts/check-quant-vue-line-count.mjs
 *   # 或：pnpm --filter @cryptotrading/web lint:quant-lines
 *
 * 接入建议（README）：
 *   - 单仓库 pre-commit：在 husky/pre-commit 中追加 `pnpm --filter @cryptotrading/web lint:quant-lines`
 *   - CI：放在 lint 流水线靠前位置，避免大文件先进 type-check 才被拦
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_LINES = 500

// 脚本位于 apps/web/scripts/；webRoot = 上级
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(__dirname, '..')
const ROOTS = [
  path.join(webRoot, 'src', 'views', 'quant'),
  path.join(webRoot, 'src', 'components', 'quant'),
]

/**
 * 递归收集目录下所有 .vue 文件（绝对路径）。
 * 容忍目录不存在（M3 初期 components/quant 子目录可能尚未出现）。
 */
async function collectVueFiles(dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw err
  }
  const out = []
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      const nested = await collectVueFiles(full)
      out.push(...nested)
    } else if (ent.isFile() && ent.name.endsWith('.vue')) {
      out.push(full)
    }
  }
  return out
}

/**
 * 统计文件行数：按 LF / CRLF 拆分；空文件视为 0 行。
 * 与 `wc -l` 行为略有差异（wc 计换行符数量），但用于「单文件 ≤ 500」目的等价。
 */
async function countLines(file) {
  const buf = await fs.readFile(file, 'utf8')
  if (buf.length === 0) return 0
  // 统一 CRLF → LF，再按 \n split
  const normalized = buf.replace(/\r\n/g, '\n')
  return normalized.split('\n').length
}

async function main() {
  const allFiles = []
  for (const r of ROOTS) {
    const files = await collectVueFiles(r)
    allFiles.push(...files)
  }

  if (allFiles.length === 0) {
    console.warn(`[check-quant-vue-line-count] 未发现 .vue 文件；ROOTS=${ROOTS.join(', ')}`)
    return
  }

  const results = []
  for (const f of allFiles) {
    const lines = await countLines(f)
    results.push({ file: f, lines })
  }

  // 按行数倒序输出，便于一眼看到接近阈值的文件
  results.sort((a, b) => b.lines - a.lines)

  const violations = results.filter(r => r.lines > MAX_LINES)

  console.log(`[check-quant-vue-line-count] 扫描 ${results.length} 个 .vue 文件（阈值 ${MAX_LINES} 行）`)
  for (const r of results) {
    const flag = r.lines > MAX_LINES ? 'FAIL' : 'OK  '
    const rel = path.relative(webRoot, r.file).replace(/\\/g, '/')
    console.log(`  ${flag}  ${String(r.lines).padStart(4, ' ')}  ${rel}`)
  }

  if (violations.length > 0) {
    console.error(`\n[check-quant-vue-line-count] FAIL：${violations.length} 个文件超过 ${MAX_LINES} 行：`)
    for (const v of violations) {
      const rel = path.relative(webRoot, v.file).replace(/\\/g, '/')
      console.error(`  - ${rel}（${v.lines} 行）`)
    }
    console.error(`\n建议：将 view 拆为子组件（参考 QuantRunDetailView 的拆分模式）。`)
    process.exit(1)
  }

  console.log(`[check-quant-vue-line-count] PASS：全部 ≤ ${MAX_LINES} 行`)
}

main().catch((err) => {
  console.error('[check-quant-vue-line-count] 脚本异常：', err)
  process.exit(2)
})
