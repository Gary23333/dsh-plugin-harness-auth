/**
 * 设备授权客户端：对应平台 /auth/device/start、/auth/device/poll、/auth/refresh。
 * 不依赖 @harness/shared，避免插件被打进 DSH 后还要解析工作区包。
 */
import { PlatformHttpError, postJson, type FetchLike } from './http.js'

export interface DeviceLoginChallenge {
  deviceCode: string
  userCode: string
  verificationUrl: string
  expiresInSeconds: number
  intervalSeconds: number
}

export interface TokenGrant {
  accessToken: string
  refreshToken: string
  expiresInSeconds: number
}

export type PollOutcome =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'expired' }
  | ({ status: 'approved' } & TokenGrant)

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PlatformHttpError(502, undefined, `平台响应缺少字段 ${field}`)
  }
  return value
}

function num(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new PlatformHttpError(502, undefined, `平台响应字段 ${field} 无效`)
  }
  return value
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export async function startDeviceLogin(
  fetchFn: FetchLike,
  platformBaseUrl: string,
  deviceName: string,
  signal?: AbortSignal,
): Promise<DeviceLoginChallenge> {
  const body = record(
    await postJson(fetchFn, platformBaseUrl, '/auth/device/start', { device_name: deviceName }, signal),
  )
  return {
    deviceCode: str(body.device_code, 'device_code'),
    userCode: str(body.user_code, 'user_code'),
    verificationUrl: str(body.verification_uri, 'verification_uri'),
    expiresInSeconds: num(body.expires_in_seconds, 'expires_in_seconds'),
    intervalSeconds: num(body.interval_seconds, 'interval_seconds'),
  }
}

function toGrant(body: Record<string, unknown>): TokenGrant {
  return {
    accessToken: str(body.access_token, 'access_token'),
    refreshToken: str(body.refresh_token, 'refresh_token'),
    expiresInSeconds: num(body.expires_in_seconds, 'expires_in_seconds'),
  }
}

export async function pollDeviceLogin(
  fetchFn: FetchLike,
  platformBaseUrl: string,
  deviceCode: string,
  signal?: AbortSignal,
): Promise<PollOutcome> {
  const body = record(
    await postJson(fetchFn, platformBaseUrl, '/auth/device/poll', { device_code: deviceCode }, signal),
  )
  switch (body.status) {
    case 'pending':
    case 'denied':
    case 'expired':
      return { status: body.status }
    case 'approved':
      return { status: 'approved', ...toGrant(body) }
    default:
      throw new PlatformHttpError(502, undefined, '平台返回了未知的授权状态')
  }
}

/** 刷新凭证轮换：旧刷新凭证立即作废，必须先持久化新值再丢弃旧值。 */
export async function refreshTokens(
  fetchFn: FetchLike,
  platformBaseUrl: string,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<TokenGrant> {
  const body = record(
    await postJson(fetchFn, platformBaseUrl, '/auth/refresh', { refresh_token: refreshToken }, signal),
  )
  return toGrant(body)
}
