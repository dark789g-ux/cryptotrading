<template>
  <main class="auth-page">
    <section class="auth-panel">
      <div class="auth-heading">
        <img class="auth-logo" :src="logoUrl" alt="logo" />
        <div>
          <h1>初始化管理员</h1>
          <p>创建系统的第一个管理员账号</p>
        </div>
      </div>

      <n-form label-placement="top" @submit.prevent>
        <n-form-item label="显示名称">
          <n-input v-model:value="form.displayName" placeholder="管理员" autocomplete="name" />
        </n-form-item>
        <n-form-item label="邮箱">
          <n-input v-model:value="form.email" placeholder="admin@example.com" autocomplete="email" />
        </n-form-item>
        <n-form-item label="密码">
          <n-input
            v-model:value="form.password"
            type="password"
            show-password-on="click"
            placeholder="至少 8 位"
            autocomplete="new-password"
            @keyup.enter="submit"
          />
        </n-form-item>
        <n-button type="primary" block size="large" :loading="submitting" @click="submit">
          创建并登录
        </n-button>
      </n-form>
    </section>
  </main>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NForm, NFormItem, NInput, useMessage } from 'naive-ui'
import { useAuth } from '../composables/useAuth'
import logoUrl from '@/assets/favicon.svg?url'

const router = useRouter()
const message = useMessage()
const auth = useAuth()

const submitting = ref(false)
const form = reactive({
  displayName: '',
  email: '',
  password: '',
  rememberMe: true,
})

async function submit() {
  if (!form.displayName.trim() || !form.email.trim() || form.password.length < 8) {
    message.warning('请填写名称、邮箱和至少 8 位密码')
    return
  }
  submitting.value = true
  try {
    await auth.bootstrap({
      displayName: form.displayName.trim(),
      email: form.email.trim(),
      password: form.password,
      rememberMe: true,
    })
    router.replace('/backtest')
  } catch (err) {
    message.error(err instanceof Error ? err.message : '初始化失败')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
@import './auth-view.css';
</style>
