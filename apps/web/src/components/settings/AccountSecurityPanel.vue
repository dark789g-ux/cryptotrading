<template>
  <n-card class="settings-card" title="账号安全" :bordered="false">
    <n-descriptions :column="1" bordered class="account-info">
      <n-descriptions-item label="当前用户">{{ auth.user.value?.displayName || '-' }}</n-descriptions-item>
      <n-descriptions-item label="邮箱">{{ auth.user.value?.email || '-' }}</n-descriptions-item>
      <n-descriptions-item label="角色">{{ auth.isAdmin.value ? '管理员' : '普通用户' }}</n-descriptions-item>
    </n-descriptions>

    <n-form label-placement="top" class="password-form">
      <n-form-item label="当前密码">
        <n-input v-model:value="form.currentPassword" type="password" show-password-on="click" />
      </n-form-item>
      <n-form-item label="新密码">
        <n-input v-model:value="form.newPassword" type="password" show-password-on="click" />
      </n-form-item>
      <n-button type="primary" :loading="saving" @click="submit">修改密码</n-button>
    </n-form>
  </n-card>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  NButton,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NForm,
  NFormItem,
  NInput,
  useMessage,
} from 'naive-ui'
import { useAuth } from '../../composables/useAuth'

const auth = useAuth()
const router = useRouter()
const message = useMessage()
const saving = ref(false)
const form = reactive({
  currentPassword: '',
  newPassword: '',
})

async function submit() {
  if (!form.currentPassword || form.newPassword.length < 8) {
    message.warning('请输入当前密码和至少 8 位新密码')
    return
  }
  saving.value = true
  try {
    await auth.changePassword(form.currentPassword, form.newPassword)
    form.currentPassword = ''
    form.newPassword = ''
    message.success('密码已更新，请重新登录')
    await auth.logout()
    router.replace({ name: 'login' })
  } catch (err) {
    message.error(err instanceof Error ? err.message : '修改失败')
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.account-info {
  margin-bottom: 18px;
}

.password-form {
  max-width: 420px;
}
</style>
