import { computed, ref } from 'vue'
import type { Router } from 'vue-router'
import { ApiError } from './apiClient'
import { authApi, type AuthResponse, type AuthUser, type BootstrapBody, type LoginBody } from './authApi'

const user = ref<AuthUser | null>(null)
const ready = ref(false)
const loading = ref(false)
const bootstrapRequired = ref(false)
const authVersion = ref(0)

let ensurePromise: Promise<void> | null = null
let navigationInitialized = false

function unwrapUser(payload: AuthResponse | AuthUser): AuthUser {
  if ('user' in payload) return payload.user
  return payload
}

function setCurrentUser(nextUser: AuthUser | null) {
  const previousId = user.value?.id ?? null
  user.value = nextUser
  if ((nextUser?.id ?? null) !== previousId) authVersion.value += 1
}

async function loadBootstrapStatus() {
  const status = await authApi.getBootstrapStatus()
  bootstrapRequired.value = !status.initialized
}

async function refreshMe() {
  try {
    const payload = await authApi.me()
    setCurrentUser(unwrapUser(payload))
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setCurrentUser(null)
      return
    }
    throw err
  }
}

export function useAuth() {
  const isAdmin = computed(() => user.value?.role === 'admin')

  async function ensureLoaded(force = false) {
    if (ready.value && !force) return
    if (ensurePromise && !force) return ensurePromise

    ensurePromise = (async () => {
      loading.value = true
      try {
        await loadBootstrapStatus()
        if (bootstrapRequired.value) {
          setCurrentUser(null)
        } else {
          await refreshMe()
        }
        ready.value = true
      } finally {
        loading.value = false
        ensurePromise = null
      }
    })()

    return ensurePromise
  }

  async function login(body: LoginBody) {
    const payload = await authApi.login(body)
    bootstrapRequired.value = false
    ready.value = true
    setCurrentUser(payload.user)
  }

  async function bootstrap(body: BootstrapBody) {
    const payload = await authApi.bootstrap(body)
    bootstrapRequired.value = false
    ready.value = true
    setCurrentUser(payload.user)
  }

  function applyAuthenticatedUser(nextUser: AuthUser) {
    bootstrapRequired.value = false
    ready.value = true
    setCurrentUser(nextUser)
  }

  async function logout() {
    try {
      await authApi.logout()
    } catch {
      // 本地退出优先，服务端清理失败也不阻塞回登录页。
    } finally {
      setCurrentUser(null)
      ready.value = true
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('auth:logout'))
    }
  }

  async function changePassword(currentPassword: string, newPassword: string) {
    await authApi.changePassword({ currentPassword, newPassword })
  }

  function clearAfterUnauthorized() {
    setCurrentUser(null)
    ready.value = true
  }

  return {
    user,
    ready,
    loading,
    bootstrapRequired,
    authVersion,
    isAdmin,
    ensureLoaded,
    refreshMe,
    login,
    bootstrap,
    applyAuthenticatedUser,
    logout,
    changePassword,
    clearAfterUnauthorized,
  }
}

export function initAuthNavigation(router: Router) {
  if (navigationInitialized || typeof window === 'undefined') return
  navigationInitialized = true

  window.addEventListener('api:unauthorized', () => {
    const auth = useAuth()
    auth.clearAfterUnauthorized()
    const current = router.currentRoute.value
    if (current.meta.authPage) return
    router.push({ path: '/login', query: { redirect: current.fullPath } })
  })
}
