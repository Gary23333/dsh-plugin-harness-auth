/**
 * 令牌生命周期：设备授权登录 → 访问令牌写入 DSH → 到期前 80% 刷新（刷新凭证轮换）。
 *
 * 约束：
 * - 刷新凭证轮换后旧值立即作废，所以**先持久化新值，再使用新访问令牌**；
 * - 同机多个进程共用一个钥匙串条目，刷新在跨进程互斥锁内进行，避免同一刷新凭证被两次使用；
 * - 4xx（凭证无效/被吊销/账号停用）清除本地凭证，不重试；网络错误与 5xx 退避重试，不清除凭证。
 */
import {
  acquireLock,
  accountFor,
  decodeStored,
  encodeStored,
  type SecretStore,
  type StoredCredentials,
} from './credentials.js'
import { PlatformHttpError, type FetchLike } from './http.js'
import {
  pollDeviceLogin,
  refreshTokens,
  startDeviceLogin,
  type DeviceLoginChallenge,
  type TokenGrant,
} from './login.js'

/** 把访问令牌交给 DSH（`ctx.credentials.set/unset/resolve` 的薄封装）。 */
export interface TokenSink {
  set(token: string): Promise<void>
  clear(): Promise<void>
  current(): Promise<string | undefined>
}

export interface TokenManagerOptions {
  platformBaseUrl: string
  deviceName: string
  fetch: FetchLike
  store: SecretStore
  sink: TokenSink
  log: (message: string) => void
  announce: (challenge: DeviceLoginChallenge) => void
  now?: () => number
  /** 在访问令牌生命周期的这个比例处刷新，默认 0.8。 */
  refreshRatio?: number
  /** 没有可用刷新凭证时是否自动发起设备授权，默认 true。 */
  autoLogin?: boolean
  /** 距到期还剩多少毫秒以上就直接沿用别的进程刚刷新的令牌，默认 3 分钟。 */
  adoptMinRemainingMs?: number
  retryDelaysMs?: number[]
  lock?: (name: string) => Promise<() => Promise<void>>
}

export type ReadyState = 'ready' | 'unavailable'

const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000]

export class TokenManager {
  private readonly account: string
  private readonly now: () => number
  private readonly ratio: number
  private readonly autoLogin: boolean
  private readonly adoptMinRemainingMs: number
  private readonly retryDelays: number[]
  private readonly lock: (name: string) => Promise<() => Promise<void>>
  private readonly abort = new AbortController()
  private timer: NodeJS.Timeout | undefined
  private stopped = false
  private failures = 0
  private settled: ReadyState | undefined
  private resolveReady!: (state: ReadyState) => void
  private readonly readyPromise: Promise<ReadyState>
  /** 钥匙串不可写时的进程内兜底：轮换后的刷新凭证至少在本进程内不能丢。 */
  private memory: StoredCredentials | undefined
  private starting: Promise<void> | undefined

  constructor(private readonly options: TokenManagerOptions) {
    this.account = accountFor(options.platformBaseUrl)
    this.now = options.now ?? Date.now
    this.ratio = options.refreshRatio ?? 0.8
    this.autoLogin = options.autoLogin ?? true
    this.adoptMinRemainingMs = options.adoptMinRemainingMs ?? 180_000
    this.retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    this.lock = options.lock ?? ((name) => acquireLock(name))
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve
    })
  }

  /** 启动：有刷新凭证就刷新，没有就设备授权登录。不抛错，结果通过 whenReady 与日志体现。 */
  start(): void {
    if (this.starting) return
    this.starting = this.bootstrap().catch((error) => {
      this.options.log(`认证初始化失败：${describe(error)}`)
      this.settle('unavailable')
    })
  }

  /** 首个访问令牌就绪（ready）或确定拿不到（unavailable）。 */
  whenReady(): Promise<ReadyState> {
    return this.readyPromise
  }

  stop(): void {
    this.stopped = true
    this.abort.abort()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.settle('unavailable')
  }

  private settle(state: ReadyState): void {
    if (this.settled) return
    this.settled = state
    this.resolveReady(state)
  }

  private async bootstrap(): Promise<void> {
    const stored = await this.readStored()
    if (stored) {
      await this.refreshCycle()
    } else if (this.autoLogin) {
      await this.login()
    } else {
      this.options.log('未登录，且已关闭自动登录')
      this.settle('unavailable')
    }
  }

  private async readStored(): Promise<StoredCredentials | undefined> {
    let raw: string | null = null
    try {
      raw = await this.options.store.get(this.account)
    } catch (error) {
      this.options.log(`读取系统钥匙串失败：${describe(error)}`)
    }
    const decoded = raw ? decodeStored(raw) : null
    // 进程内的轮换结果更新时（钥匙串写入失败过）以进程内为准，否则会把已作废的旧刷新凭证再发出去。
    if (this.memory && (!decoded || this.memory.accessIssuedAt > decoded.accessIssuedAt)) return this.memory
    return decoded ?? undefined
  }

  /** 持久化顺序：先写钥匙串（旧刷新凭证已作废，新值不能丢），再交付访问令牌。 */
  private async apply(grant: TokenGrant): Promise<void> {
    const issuedAt = this.now()
    const stored: StoredCredentials = {
      refreshToken: grant.refreshToken,
      accessIssuedAt: issuedAt,
      accessExpiresAt: issuedAt + grant.expiresInSeconds * 1000,
    }
    this.memory = stored
    try {
      await this.options.store.set(this.account, encodeStored(stored))
    } catch (error) {
      this.options.log(`刷新凭证未能写入系统钥匙串，仅保留在本进程内：${describe(error)}`)
    }
    await this.options.sink.set(grant.accessToken)
    this.failures = 0
    this.schedule(stored)
    this.settle('ready')
  }

  private schedule(stored: StoredCredentials): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    const lifetime = Math.max(stored.accessExpiresAt - stored.accessIssuedAt, 1_000)
    const delay = Math.max(stored.accessIssuedAt + lifetime * this.ratio - this.now(), 1_000)
    this.timer = setTimeout(() => {
      void this.refreshCycle()
    }, delay)
    this.timer.unref?.()
  }

  private scheduleRetry(): void {
    if (this.stopped) return
    const delay = this.retryDelays[Math.min(this.failures, this.retryDelays.length - 1)] ?? 60_000
    this.failures += 1
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.refreshCycle()
    }, delay)
    this.timer.unref?.()
  }

  private async refreshCycle(): Promise<void> {
    if (this.stopped) return
    let release: (() => Promise<void>) | undefined
    try {
      release = await this.lock(this.account)
    } catch (error) {
      this.options.log(`获取刷新互斥锁失败：${describe(error)}`)
      this.scheduleRetry()
      return
    }
    try {
      await this.refreshLocked()
    } finally {
      await release().catch(() => undefined)
    }
  }

  private async refreshLocked(): Promise<void> {
    const stored = await this.readStored()
    if (!stored) {
      await this.onCredentialsLost('本地没有刷新凭证')
      return
    }

    // 另一个进程刚刚轮换过：沿用它写入 DSH 的访问令牌，不再消耗一次轮换。
    const remaining = stored.accessExpiresAt - this.now()
    if (remaining > this.adoptMinRemainingMs && (await this.options.sink.current())) {
      this.memory = stored
      this.schedule(stored)
      this.settle('ready')
      return
    }

    try {
      const grant = await refreshTokens(
        this.options.fetch,
        this.options.platformBaseUrl,
        stored.refreshToken,
        this.abort.signal,
      )
      await this.apply(grant)
    } catch (error) {
      if (this.stopped) return
      if (error instanceof PlatformHttpError && error.terminal) {
        await this.onCredentialsLost(`刷新被平台拒绝（${error.code ?? error.status}）`)
        return
      }
      this.options.log(`刷新暂时失败，将退避重试：${describe(error)}`)
      this.scheduleRetry()
    }
  }

  /** 凭证确认失效：清掉本地一切，必要时回到设备授权。 */
  private async onCredentialsLost(reason: string): Promise<void> {
    this.options.log(`${reason}，清除本地凭证`)
    this.memory = undefined
    await this.options.store.delete(this.account).catch((error) => {
      this.options.log(`清除钥匙串条目失败：${describe(error)}`)
    })
    await this.options.sink.clear().catch(() => undefined)
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.autoLogin && !this.stopped) {
      await this.login()
    } else {
      this.settle('unavailable')
    }
  }

  private async login(): Promise<void> {
    try {
      const challenge = await startDeviceLogin(
        this.options.fetch,
        this.options.platformBaseUrl,
        this.options.deviceName,
        this.abort.signal,
      )
      this.options.announce(challenge)
      const deadline = this.now() + challenge.expiresInSeconds * 1000
      while (!this.stopped && this.now() < deadline) {
        await sleep(challenge.intervalSeconds * 1000, this.abort.signal)
        let outcome
        try {
          outcome = await pollDeviceLogin(
            this.options.fetch,
            this.options.platformBaseUrl,
            challenge.deviceCode,
            this.abort.signal,
          )
        } catch (error) {
          if (error instanceof PlatformHttpError && error.terminal) throw error
          this.options.log(`轮询暂时失败：${describe(error)}`)
          continue
        }
        if (outcome.status === 'pending') continue
        if (outcome.status === 'approved') {
          await this.apply(outcome)
          this.options.log('设备授权成功')
          return
        }
        this.options.log(outcome.status === 'denied' ? '设备授权被拒绝' : '设备授权已过期')
        this.settle('unavailable')
        return
      }
      if (!this.stopped) this.options.log('设备授权等待超时')
    } catch (error) {
      if (!this.stopped) this.options.log(`设备授权失败：${describe(error)}`)
    }
    this.settle('unavailable')
  }
}

function describe(error: unknown): string {
  if (error instanceof PlatformHttpError) return `${error.code ?? error.status}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}
