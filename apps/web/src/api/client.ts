export const API_BASE = '/api'

export class ApiError extends Error {
  status: number
  body: unknown

  constructor(status: number, message: string, body: unknown = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

type ApiRequestInit = RequestInit & {
  skipAuthRedirect?: boolean
}

function isMutatingMethod(method: string) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())
}

function emitUnauthorized(status: number) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('api:unauthorized', { detail: { status } }))
}

async function readResponseBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '')
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function getErrorMessage(status: number, body: unknown) {
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message?: unknown }).message
    if (Array.isArray(message)) return message.join('；')
    if (typeof message === 'string' && message.trim()) return message
  }
  if (typeof body === 'string' && body.trim()) return body
  if (status === 401) return '登录已过期，请重新登录'
  if (status === 403) return '没有权限执行此操作'
  return `HTTP ${status}`
}

export async function request<T>(url: string, options: ApiRequestInit = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const headers = new Headers(options.headers)

  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (isMutatingMethod(method)) {
    headers.set('X-Requested-With', 'XMLHttpRequest')
  }

  const res = await fetch(url, {
    ...options,
    method,
    headers,
    credentials: options.credentials ?? 'same-origin',
  })

  const body = await readResponseBody(res)
  if (!res.ok) {
    if (res.status === 401 && !options.skipAuthRedirect) emitUnauthorized(res.status)
    throw new ApiError(res.status, getErrorMessage(res.status, body), body)
  }
  return body as T
}

export function post<T>(url: string, body?: unknown, options: ApiRequestInit = {}): Promise<T> {
  return request<T>(url, {
    ...options,
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

export function put<T>(url: string, body?: unknown, options: ApiRequestInit = {}): Promise<T> {
  return request<T>(url, {
    ...options,
    method: 'PUT',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

export function patch<T>(url: string, body?: unknown, options: ApiRequestInit = {}): Promise<T> {
  return request<T>(url, {
    ...options,
    method: 'PATCH',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

export function del<T>(url: string, options: ApiRequestInit = {}): Promise<T> {
  return request<T>(url, { ...options, method: 'DELETE' })
}
