<template>
  <div class="viewer">
    <aside class="toc">
      <h4>目录</h4>
      <ul>
        <li v-for="h in headings" :key="h.id">
          <a :href="`#${h.id}`">{{ h.text }}</a>
        </li>
      </ul>
    </aside>
    <article class="content" v-html="html" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import MarkdownIt from 'markdown-it'

const props = defineProps<{ md: string }>()
const md = new MarkdownIt({ html: false, linkify: true })
const html = computed(() => md.render(props.md))
const headings = computed(() => {
  const out: { id: string; text: string }[] = []
  for (const line of props.md.split('\n')) {
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
</style>
