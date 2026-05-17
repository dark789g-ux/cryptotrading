#!/usr/bin/env node
/**
 * check-quant-vue-line-count.mjs 配套小单测。
 *
 * 不依赖 vitest，使用 node 内置 child_process + fs。运行：
 *   node apps/web/scripts/check-quant-vue-line-count.test.mjs
 *
 * 思路：脚本 ROOTS 是硬编码的 apps/web/src/{views,components}/quant；
 * 用例临时往 `src/components/quant/__line_count_fixture__/`（gitignored 兜底见末尾说明）
 * 投放 600 行 / 200 行 fixture，验证 exit 行为，然后无论成败都清理。
 *
 * 用例：
 *   1. 600 行 fixture 注入 → 期望 exit 1
 *   2. 仅 200 行 fixture → 期望 exit 0
 *
 * 注：fixture 目录在测试期短暂存在；run 完即删。若 CI 中途崩溃残留，因为 .vue 是
 * 合法 Vue，不影响构建（仅一个 200 / 600 行 div 块）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(__dirname, '..')
const SCRIPT = path.resolve(__dirname, 'check-quant-vue-line-count.mjs')

const FIXTURE_DIR = path.join(webRoot, 'src', 'components', 'quant', '__line_count_fixture__')

function makeFixture(filename, lineCount) {
  if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true })
  const lines = ['<template>']
  for (let i = 0; i < lineCount - 2; i++) {
    lines.push(`  <div data-i="${i}">filler line ${i}</div>`)
  }
  lines.push('</template>')
  writeFileSync(path.join(FIXTURE_DIR, filename), lines.join('\n'), { encoding: 'utf-8' })
}

function cleanup() {
  if (existsSync(FIXTURE_DIR)) {
    rmSync(FIXTURE_DIR, { recursive: true, force: true })
  }
}

function runScript() {
  return spawnSync('node', [SCRIPT], { encoding: 'utf-8' })
}

function assert(cond, msg) {
  if (!cond) {
    cleanup()
    console.error(`[FAIL] ${msg}`)
    process.exit(1)
  }
  console.log(`[OK] ${msg}`)
}

function main() {
  cleanup() // 清掉旧残留
  try {
    // 用例 1：600 行 fixture → exit 1
    makeFixture('OversizedFixture.vue', 600)
    const r1 = runScript()
    assert(r1.status === 1, `600-line fixture should produce exit code 1 (got ${r1.status})`)
    assert(
      /OversizedFixture\.vue/.test(`${r1.stdout || ''}${r1.stderr || ''}`),
      'output should mention OversizedFixture.vue',
    )
    cleanup()

    // 用例 2：仅 200 行 fixture → exit 0
    makeFixture('SmallFixture.vue', 200)
    const r2 = runScript()
    assert(r2.status === 0, `200-line fixture alone should pass with exit 0 (got ${r2.status})`)
    cleanup()

    console.log('\n[check-quant-vue-line-count.test] All tests passed.')
  } finally {
    cleanup()
  }
}

main()
