/**
 * 平台 HTTP 调用：只做 JSON POST，错误统一成 PlatformHttpError。
 * 错误体遵循平台统一信封 `{ code, message, request_id, retryable }`。
 */
export class PlatformHttpError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(status: number, code: string | undefined, message: string) {
    super(message)
    this.name = 'PlatformHttpError'
    this.status = status
    this.code = code
  }

  /** 4xx（除 408/429）表示凭证本身无效，重试无意义；网络错误、5xx、429 才值得重试。 */
  get terminal(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export async function postJson(
  fetchFn: FetchLike,
  baseUrl: string,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchFn(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  if (!response.ok) {
    const envelope = (parsed ?? {}) as { code?: unknown; message?: unknown }
    throw new PlatformHttpError(
      response.status,
      typeof envelope.code === 'string' ? envelope.code : undefined,
      typeof envelope.message === 'string' ? envelope.message : `HTTP ${response.status}`,
    )
  }
  return parsed
}
