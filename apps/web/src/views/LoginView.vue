<template>
  <main class="auth-page">
    <section class="auth-panel">
      <div class="auth-heading">
        <img class="auth-logo" :src="logoUrl" alt="logo" />
        <div>
          <h1>登录 CryptoTrading</h1>
          <p>进入你的量化策略工作区</p>
        </div>
      </div>

      <n-form label-placement="top" @submit.prevent>
        <n-form-item label="邮箱">
          <n-input v-model:value="form.email" placeholder="name@example.com" autocomplete="email" />
        </n-form-item>
        <n-form-item label="密码">
          <n-input
            v-model:value="form.password"
            type="password"
            show-password-on="click"
            placeholder="请输入密码"
            autocomplete="current-password"
            @keyup.enter="submit"
          />
        </n-form-item>
        <div class="auth-row">
          <n-checkbox v-model:checked="form.rememberMe">记住我</n-checkbox>
        </div>
        <n-button type="primary" block size="large" :loading="submitting" @click="submit">
          登录
        </n-button>
      </n-form>
    </section>
  </main>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NCheckbox, NForm, NFormItem, NInput, useMessage } from 'naive-ui'
import { useAuth } from '../composables/useAuth'
import logoUrl from '@/assets/favicon.svg?url'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const auth = useAuth()

const submitting = ref(false)
const form = reactive({
  email: '',
  password: '',
  rememberMe: true,
})

function getRedirect() {
  const redirect = route.query.redirect
  return typeof redirect === 'string' && redirect.startsWith('/') ? redirect : '/backtest'
}

async function submit() {
  if (!form.email.trim() || !form.password) {
    message.warning('请输入邮箱和密码')
    return
  }
  submitting.value = true
  try {
    await auth.login({
      email: form.email.trim(),
      password: form.password,
      rememberMe: form.rememberMe,
    })
    router.replace(getRedirect())
  } catch {
    message.error('账号或密码不正确')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
@import './auth-view.css';

.auth-row {
  display: flex;
  justify-content: space-between;
  margin: 0 0 18px;
}
</style>
