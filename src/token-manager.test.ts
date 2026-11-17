import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  accountFor,
  decodeStored,
  encodeStored,
  type SecretStore,
  type StoredCredentials,
} from './credentials.js'
import { TokenManager, type TokenSink } from './token-manager.js'

const BASE = 'https://platform.test'
const ACCOUNT = accountFor(BASE)
const TTL_S = 900

class MemoryStore implements SecretStore {
  readonly kind = 'memory'
  data = new Map<string, string>()
  async get(account: string) {
    return this.data.get(account) ?? null
  }
  async set(account: string, secret: string) {
    this.data.set(account, secret)
  }
  async delete(account: string) {
    this.data.delete(account)
  }
}

class MemorySink implements TokenSink {
  token: string | undefined
  history: string[] = []
  async set(token: string) {
    this.token = token
    this.history.push(token)
  }
  async clear() {
    this.token = undefined
  }
  async current() {
    return this.token
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

interface Harness {
  manager: TokenManager
  store: MemoryStore
  sink: MemorySink
  calls: Array<{ path: string; body: Record<string, unknown> }>
  logs: string[]
  announced: string[]
}

function build(
  handler: (path: string, body: Record<string, unknown>, n: number) => Response | Promise<Response>,
  extra: Partial<ConstructorParameters<typeof TokenManager>[0]> = {},
  store = new MemoryStore(),
): Harness {
  const calls: Harness['calls'] = []
  const logs: string[] = []
  const announced: string[] = []
  const sink = new MemorySink()
  const counts = new Map<string, number>()
  const manager = new TokenManager({
    platformBaseUrl: BASE,
    deviceName: 'test-device',
    store,
    sink,
    log: (m) => logs.push(m),
    announce: (c) => announced.push(c.userCode),
    lock: async () => async () => undefined,
    retryDelaysMs: [1_000, 2_000],
    fetch: async (input, init) => {
      const path = new URL(input).pathname
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      calls.push({ path, body })
      const n = (counts.get(path) ?? 0) + 1
      counts.set(path, n)
      return handler(path, body, n)
    },
    ...extra,
  })
  return { manager, store, sink, calls, logs, announced }
}

function seed(store: MemoryStore, refreshToken: string, issuedAt: number, ttlS = TTL_S): void {
  const stored: StoredCredentials = {
    refreshToken,
    accessIssuedAt: issuedAt,
    accessExpiresAt: issuedAt + ttlS * 1000,
  }
  store.data.set(ACCOUNT, encodeStored(stored))
}

const grant = (n: number) => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  expires_in_seconds: TTL_S,
  token_type: 'Bearer',
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('stored credential codec', () => {
  it('编码结果是 base64url，可往返，坏数据返回 null', () => {
    const value = { refreshToken: 'abc_DEF-123', accessIssuedAt: 1, accessExpiresAt: 2 }
    const encoded = encodeStored(value)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeStored(encoded)).toEqual(value)
    expect(decodeStored('not-json')).toBeNull()
    expect(decodeStored(Buffer.from('{"refreshToken":"x"}').toString('base64url'))).toBeNull()
  })
})

describe('TokenManager 设备授权登录', () => {
  it('start → poll(pending→approved)：宣告设备码，刷新凭证先入钥匙串，访问令牌交给 DSH', async () => {
    const h = build((path, _body, n) => {
      if (path === '/auth/device/start') {
        return json(200, {
          device_code: 'dev-1',
          user_code: 'ABCD-1234',
          verification_uri: `${BASE}/device`,
          expires_in_seconds: 600,
          interval_seconds: 5,
        })
      }
      if (path === '/auth/device/poll') return n === 1 ? json(200, { status: 'pending' }) : json(200, { status: 'approved', ...grant(1) })
      return json(404, {})
    })
    h.manager.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.sink.token).toBeUndefined()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await h.manager.whenReady()).toBe('ready')
    expect(h.announced).toEqual(['ABCD-1234'])
    expect(h.sink.token).toBe('access-1')
    expect(decodeStored(h.store.data.get(ACCOUNT)!)?.refreshToken).toBe('refresh-1')
    // 请求体不含任何令牌明文以外的信息：start 只带设备名
    expect(h.calls[0]).toEqual({ path: '/auth/device/start', body: { device_name: 'test-device' } })
    h.manager.stop()
  })

  it('指定 keychainAccount 时不读别的 profile 的刷新凭证，各自独立登录', async () => {
    const store = new MemoryStore()
    seed(store, 'refresh-of-member-a', Date.now())
    const h = build(
      (path, _body, n) => {
        if (path === '/auth/device/start') {
          return json(200, { device_code: 'dev-b', user_code: 'BBBB-0002', verification_uri: `${BASE}/device`, expires_in_seconds: 600, interval_seconds: 5 })
        }
        if (path === '/auth/device/poll') return n === 1 ? json(200, { status: 'pending' }) : json(200, { status: 'approved', ...grant(9) })
        return json(404, {})
      },
      { keychainAccount: 'platform.test:profile-bbbb' },
      store,
    )
    h.manager.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await h.manager.whenReady()).toBe('ready')
    // 没有拿 A 的刷新凭证去刷新，而是走了自己的设备授权
    expect(h.calls.some((c) => c.path === '/auth/refresh')).toBe(false)
    expect(h.announced).toEqual(['BBBB-0002'])
    expect(decodeStored(store.data.get('platform.test:profile-bbbb')!)?.refreshToken).toBe('refresh-9')
    expect(decodeStored(store.data.get(ACCOUNT)!)?.refreshToken).toBe('refresh-of-member-a')
  })

  it('用户拒绝授权 → unavailable，不写任何凭证', async () => {
    const h = build((path) => {
      if (path === '/auth/device/start') {
        return json(200, { device_code: 'd', user_code: 'U', verification_uri: `${BASE}/device`, expires_in_seconds: 600, interval_seconds: 1 })
      }
      return json(200, { status: 'denied' })
    })
    h.manager.start()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await h.manager.whenReady()).toBe('unavailable')
    expect(h.store.data.size).toBe(0)
    expect(h.sink.token).toBeUndefined()
  })
})

describe('TokenManager 刷新', () => {
  it('启动时用钥匙串里的刷新凭证换新令牌；在 80% 生命周期处再次刷新并轮换', async () => {
    const h = build((path, body, n) => {
      expect(path).toBe('/auth/refresh')
      return json(200, grant(n))
    })
    seed(h.store, 'refresh-0', Date.now() - 10 * 60_000)
    h.manager.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(await h.manager.whenReady()).toBe('ready')
    expect(h.calls[0]?.body).toEqual({ refresh_token: 'refresh-0' })
    expect(h.sink.token).toBe('access-1')

    // 900s * 0.8 = 720s：719s 时还不该刷新，721s 时刷新
    await vi.advanceTimersByTimeAsync(719_000)
    expect(h.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]?.body).toEqual({ refresh_token: 'refresh-1' })
    expect(h.sink.token).toBe('access-2')
    expect(decodeStored(h.store.data.get(ACCOUNT)!)?.refreshToken).toBe('refresh-2')
    h.manager.stop()
  })

  it('网络/5xx 失败：保留刷新凭证并退避重试，恢复后成功', async () => {
    const h = build((_path, _body, n) => (n < 3 ? json(503, { code: 'UPSTREAM_ERROR', message: 'down' }) : json(200, grant(1))))
    seed(h.store, 'refresh-0', Date.now() - 800_000)
    h.manager.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sink.token).toBeUndefined()
    expect(decodeStored(h.store.data.get(ACCOUNT)!)?.refreshToken).toBe('refresh-0')
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await h.manager.whenReady()).toBe('ready')
    expect(h.calls).toHaveLength(3)
    h.manager.stop()
  })

  it('401（账号停用/凭证重用被吊销）：清除钥匙串与访问令牌，不再重试；关闭自动登录则 unavailable', async () => {
    const h = build(() => json(401, { code: 'UNAUTHENTICATED', message: '账号不可用' }), { autoLogin: false })
    seed(h.store, 'refresh-0', Date.now() - 800_000)
    await h.sink.set('stale-access')
    h.manager.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(await h.manager.whenReady()).toBe('unavailable')
    expect(h.store.data.size).toBe(0)
    expect(h.sink.token).toBeUndefined()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.calls).toHaveLength(1)
  })

  it('另一个进程刚轮换过且 DSH 里已有它写入的令牌：沿用，不消耗一次轮换', async () => {
    const h = build(() => json(500, {}))
    seed(h.store, 'refresh-by-other', Date.now() - 60_000)
    await h.sink.set('access-by-other')
    h.manager.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(await h.manager.whenReady()).toBe('ready')
    expect(h.calls).toHaveLength(0)
    expect(h.sink.token).toBe('access-by-other')
    h.manager.stop()
  })

  it('钥匙串写入失败：刷新凭证仍保留在进程内，下一次刷新用新值而不是已作废的旧值', async () => {
    class BrokenStore extends MemoryStore {
      override async set(): Promise<void> {
        throw new Error('keychain locked')
      }
    }
    const store = new BrokenStore()
    seed(store, 'refresh-0', Date.now() - 800_000)
    const h = build((_p, _b, n) => json(200, grant(n)), {}, store)
    h.manager.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(await h.manager.whenReady()).toBe('ready')
    expect(h.logs.some((l) => l.includes('仅保留在本进程内'))).toBe(true)
    await vi.advanceTimersByTimeAsync(721_000)
    // 钥匙串里仍是已作废的 refresh-0，必须以进程内的 refresh-1 为准。
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]?.body).toEqual({ refresh_token: 'refresh-1' })
    h.manager.stop()
  })

  it('stop() 取消定时器，之后不再发请求', async () => {
    const h = build((_p, _b, n) => json(200, grant(n)))
    seed(h.store, 'refresh-0', Date.now() - 800_000)
    h.manager.start()
    await vi.advanceTimersByTimeAsync(0)
    h.manager.stop()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(h.calls).toHaveLength(1)
  })
})
