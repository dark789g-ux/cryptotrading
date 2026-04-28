<template>
  <n-card class="settings-card" title="用户管理" :bordered="false">
    <n-tabs type="line" animated>
      <n-tab-pane name="users" tab="用户">
        <div class="toolbar">
          <n-button type="primary" @click="showCreate = true">新建用户</n-button>
          <n-button :loading="loadingUsers" @click="loadUsers">刷新</n-button>
        </div>

        <n-spin v-if="loadingUsers" />
        <div v-else class="entity-list">
          <div v-for="item in users" :key="item.id" class="entity-row">
            <div class="entity-main">
              <strong>{{ item.displayName }}</strong>
              <span>{{ item.email }}</span>
            </div>
            <n-tag :type="item.role === 'admin' ? 'warning' : 'default'" size="small">
              {{ item.role === 'admin' ? '管理员' : '普通用户' }}
            </n-tag>
            <n-switch
              :value="item.isActive"
              :disabled="item.id === auth.user.value?.id"
              @update:value="(value) => updateUserActive(item, value)"
            />
            <n-button size="small" @click="openReset(item)">重置密码</n-button>
          </div>
        </div>
      </n-tab-pane>

      <n-tab-pane name="invitations" tab="邀请">
        <div class="toolbar">
          <n-button type="primary" @click="showInvite = true">创建邀请</n-button>
          <n-button :loading="loadingInvitations" @click="loadInvitations">刷新</n-button>
        </div>

        <n-spin v-if="loadingInvitations" />
        <div v-else class="entity-list">
          <div v-for="item in invitations" :key="item.id" class="entity-row invitation-row">
            <div class="entity-main">
              <strong>{{ item.email }}</strong>
              <span>{{ formatInvitationStatus(item) }}</span>
              <code v-if="item.inviteUrl || item.token">{{ item.inviteUrl || buildInviteUrl(item.token) }}</code>
            </div>
            <n-tag :type="item.role === 'admin' ? 'warning' : 'default'" size="small">
              {{ item.role === 'admin' ? '管理员' : '普通用户' }}
            </n-tag>
            <n-button size="small" :disabled="!!item.acceptedAt || !!item.revokedAt" @click="revokeInvitation(item.id)">
              撤销
            </n-button>
          </div>
        </div>
      </n-tab-pane>
    </n-tabs>

    <n-modal v-model:show="showCreate" preset="dialog" title="新建用户" :show-icon="false" style="width: 460px">
      <n-form label-placement="top">
        <n-form-item label="邮箱"><n-input v-model:value="createForm.email" /></n-form-item>
        <n-form-item label="显示名称"><n-input v-model:value="createForm.displayName" /></n-form-item>
        <n-form-item label="密码"><n-input v-model:value="createForm.password" type="password" /></n-form-item>
        <n-form-item label="角色">
          <n-select v-model:value="createForm.role" :options="roleOptions" />
        </n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showCreate = false">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="createUser">创建</n-button>
      </template>
    </n-modal>

    <n-modal v-model:show="showInvite" preset="dialog" title="创建邀请" :show-icon="false" style="width: 420px">
      <n-form label-placement="top">
        <n-form-item label="邮箱"><n-input v-model:value="inviteForm.email" /></n-form-item>
        <n-form-item label="角色">
          <n-select v-model:value="inviteForm.role" :options="roleOptions" />
        </n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showInvite = false">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="createInvitation">创建</n-button>
      </template>
    </n-modal>

    <n-modal v-model:show="showReset" preset="dialog" title="重置密码" :show-icon="false" style="width: 420px">
      <n-form label-placement="top">
        <n-form-item label="新密码"><n-input v-model:value="resetPassword" type="password" /></n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showReset = false">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="submitReset">保存</n-button>
      </template>
    </n-modal>
  </n-card>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import {
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  NSpin,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
  useMessage,
} from 'naive-ui'
import { usersApi, type InvitationListItem, type UserListItem } from '../../composables/usersApi'
import { useAuth } from '../../composables/useAuth'
import type { UserRole } from '../../composables/authApi'

const message = useMessage()
const auth = useAuth()

const users = ref<UserListItem[]>([])
const invitations = ref<InvitationListItem[]>([])
const loadingUsers = ref(false)
const loadingInvitations = ref(false)
const submitting = ref(false)
const showCreate = ref(false)
const showInvite = ref(false)
const showReset = ref(false)
const resetTarget = ref<UserListItem | null>(null)
const resetPassword = ref('')

const roleOptions = [
  { label: '普通用户', value: 'user' },
  { label: '管理员', value: 'admin' },
]

const createForm = reactive({
  email: '',
  displayName: '',
  password: '',
  role: 'user' as UserRole,
})

const inviteForm = reactive({
  email: '',
  role: 'user' as UserRole,
})

function buildInviteUrl(token?: string) {
  return token ? `${window.location.origin}/invitations/${token}` : ''
}

function formatInvitationStatus(item: InvitationListItem) {
  if (item.acceptedAt) return '已接受'
  if (item.revokedAt) return '已撤销'
  return `有效期至 ${item.expiresAt}`
}

async function loadUsers() {
  loadingUsers.value = true
  try {
    users.value = await usersApi.list()
  } catch (err) {
    message.error(err instanceof Error ? err.message : '加载用户失败')
  } finally {
    loadingUsers.value = false
  }
}

async function loadInvitations() {
  loadingInvitations.value = true
  try {
    invitations.value = await usersApi.listInvitations()
  } catch (err) {
    message.error(err instanceof Error ? err.message : '加载邀请失败')
  } finally {
    loadingInvitations.value = false
  }
}

async function createUser() {
  if (!createForm.email.trim() || !createForm.displayName.trim() || createForm.password.length < 8) {
    message.warning('请填写邮箱、名称和至少 8 位密码')
    return
  }
  submitting.value = true
  try {
    await usersApi.create({ ...createForm, email: createForm.email.trim(), displayName: createForm.displayName.trim() })
    showCreate.value = false
    createForm.email = ''
    createForm.displayName = ''
    createForm.password = ''
    await loadUsers()
    message.success('用户已创建')
  } catch (err) {
    message.error(err instanceof Error ? err.message : '创建失败')
  } finally {
    submitting.value = false
  }
}

async function updateUserActive(item: UserListItem, isActive: boolean) {
  try {
    await usersApi.update(item.id, { isActive })
    item.isActive = isActive
    message.success(isActive ? '用户已启用' : '用户已禁用')
  } catch (err) {
    message.error(err instanceof Error ? err.message : '更新失败')
  }
}

function openReset(item: UserListItem) {
  resetTarget.value = item
  resetPassword.value = ''
  showReset.value = true
}

async function submitReset() {
  if (!resetTarget.value || resetPassword.value.length < 8) {
    message.warning('新密码至少 8 位')
    return
  }
  submitting.value = true
  try {
    await usersApi.resetPassword(resetTarget.value.id, { password: resetPassword.value })
    showReset.value = false
    message.success('密码已重置')
  } catch (err) {
    message.error(err instanceof Error ? err.message : '重置失败')
  } finally {
    submitting.value = false
  }
}

async function createInvitation() {
  if (!inviteForm.email.trim()) {
    message.warning('请输入邮箱')
    return
  }
  submitting.value = true
  try {
    const created = await usersApi.createInvitation({ email: inviteForm.email.trim(), role: inviteForm.role })
    showInvite.value = false
    inviteForm.email = ''
    invitations.value = [{ ...created.invitation, token: created.token }, ...invitations.value]
    message.success('邀请已创建')
  } catch (err) {
    message.error(err instanceof Error ? err.message : '创建邀请失败')
  } finally {
    submitting.value = false
  }
}

async function revokeInvitation(id: string) {
  try {
    await usersApi.revokeInvitation(id)
    await loadInvitations()
    message.success('邀请已撤销')
  } catch (err) {
    message.error(err instanceof Error ? err.message : '撤销失败')
  }
}

onMounted(() => {
  loadUsers()
  loadInvitations()
})
</script>

<style scoped>
.toolbar {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-bottom: 14px;
}

.entity-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.entity-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
}

.invitation-row {
  grid-template-columns: minmax(0, 1fr) auto auto;
}

.entity-main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.entity-main span,
.entity-main code {
  overflow: hidden;
  color: var(--color-text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
