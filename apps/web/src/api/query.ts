export function appendQueryParam(qs: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null || value === '') return
  qs.set(key, String(value))
}
