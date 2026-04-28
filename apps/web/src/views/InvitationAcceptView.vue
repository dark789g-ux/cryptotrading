<template>
  <main class="auth-page">
    <section class="auth-panel">
      <div class="auth-heading">
        <img class="auth-logo" :src="logoUrl" alt="logo" />
        <div>
          <h1>接受邀请</h1>
          <p>{{ subtitle }}</p>
        </div>
      </div>

      <n-spin v-if="loading" />
      <n-result v-else-if="loadError" status="error" title="邀请不可用" :description="loadError" />
      <n-form v-else label-placement="top" @submit.prevent>
        <n-form-item label="邮箱">
          <n-input :value="invitation?.email" disabled />
        </n-form-item>
        <n-form-item label="显示名称">
          <n-input v-model:value="form.displayName" placeholder="你的名称" autocomplete="name" />
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
        <n-checkbox v-model:checked="form.rememberMe" class="remember">记住我</n-checkbox>
        <n-button type="primary" block size="large" :loading="submitting" @click="submit">
          接受并登录
        </n-button>
      </n-form>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NCheckbox, NForm, NFormItem, NInput, NResult, NSpin, useMessage } from 'naive-ui'
import { authApi, type InvitationInfo } from '../composables/authApi'
import { useAuth } from '../composables/useAuth'
import logoUrl from '@/assets/favicon.svg?url'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const auth = useAuth()

const loading = ref(true)
const submitting = ref(false)
const loadError = ref('')
const invitation = ref<InvitationInfo | null>(null)
const form = reactive({
  displayName: '',
  password: '',
  rememberMe: true,
})

const token = computed(() => String(route.params.token ?? ''))
const subtitle = computed(() =>
  invitation.value ? `${invitation.value.email} 的账号设置` : '设置账号后进入系统',
)

async function loadInvitation() {
  loading.value = true
  loadError.value = ''
  try {
    invitation.value = await authApi.getInvitation(token.value)
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : '邀请链接无效或已过期'
  } finally {
    loading.value = false
  }
}

async function submit() {
  if (!form.displayName.trim() || form.password.length < 8) {
    message.warning('请填写名称和至少 8 位密码')
    return
  }
  submitting.value = true
  try {
    const payload = await authApi.acceptInvitation(token.value, {
      displayName: form.displayName.trim(),
      password: form.password,
      rememberMe: form.rememberMe,
    })
    auth.applyAuthenticatedUser(payload.user)
    router.replace('/backtest')
  } catch (err) {
    message.error(err instanceof Error ? err.message : '接受邀请失败')
  } finally {
    submitting.value = false
  }
}

onMounted(loadInvitation)
</script>

<style scoped>
@import './auth-view.css';

.remember {
  margin-bottom: 18px;
}
</style>
