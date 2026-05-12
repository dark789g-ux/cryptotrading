<template>
  <div class="viewer" :class="{ live }">
    <aside v-if="!live" class="toc">
      <h4>目录</h4>
      <ul>
        <li v-for="h in headings" :key="h.id">
          <a :href="`#${h.id}`">{{ h.text }}</a>
        </li>
      </ul>
    </aside>
    <article v-if="renderOk" class="content" v-html="html" />
    <!-- live 模式下 Markdown 可能含半截 code fence/表格，渲染失败回退到 pre -->
    <pre v-else class="content fallback">{{ props.md }}</pre>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import MarkdownIt from 'markdown-it'

const props = defineProps<{ md: string; live?: boolean }>()
const md = new MarkdownIt({ html: false, linkify: true })

// renderOk + html 一起 computed：渲染失败时 renderOk=false 触发 <pre> 回退。
// 非 live 模式按旧行为：失败时直接抛（不应该发生，因为内容已完整入库）。
const renderState = computed(() => {
  try {
    return { ok: true, html: md.render(props.md ?? '') }
  } catch (err) {
    if (!props.live) throw err
    return { ok: false, html: '' }
  }
})
const renderOk = computed(() => renderState.value.ok)
const html = computed(() => renderState.value.html)

const headings = computed(() => {
  const out: { id: string; text: string }[] = []
  for (const line of (props.md ?? '').split('\n')) {
    const m = /^##\s+(.+)/.exec(line)
    if (m) {
      const text = m[1].trim()
      out.push({ id: text.replace(/\s+/g, '-'), text })
    }
  }
  return out
})
</script>

<style scoped>
.viewer { display: grid; grid-template-columns: 200px 1fr; gap: 24px; }
.viewer.live { grid-template-columns: 1fr; }
.toc { position: sticky; top: 16px; align-self: start; }
.toc h4 { font-size: 13px; color: var(--color-text-muted); margin-bottom: 8px; }
.toc ul { list-style: none; padding: 0; margin: 0; }
.toc li { margin-bottom: 6px; }
.toc a { font-size: 13px; color: var(--color-text-muted); text-decoration: none; }
.toc a:hover { color: var(--color-primary); }
.content :deep(h2) { margin-top: 32px; }
.content :deep(p) { line-height: 1.8; }
.content :deep(table) { border-collapse: collapse; width: 100%; }
.content :deep(th), .content :deep(td) { border: 1px solid var(--color-border); padding: 6px 12px; }
.content.fallback {
  white-space: pre-wrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text-muted);
  background: var(--color-surface-elevated, #1e2028);
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
}
</style>
