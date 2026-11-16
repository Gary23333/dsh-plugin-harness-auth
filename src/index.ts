import { hostname } from 'node:os'
import { createSystemSecretStore, type SecretStore } from './credentials.js'
import type { FetchLike } from './http.js'
import { PLATFORM_API_KEY_ENV, buildProviderConfig } from './provider-config.js'
import { TokenManager, type TokenSink } from './token-manager.js'

/**
 * DSH 插件上下文里本插件用到的最小子集。
 *
 * 插件不依赖任何 DSH 包导入（避免版本耦合）：`credentialRef` 在 DSH 里只是带品牌的字符串
 * （POSIX 标识符），这里直接按字符串断言；类型只描述实际调用到的方法，字段名来自
 * DSH 0.1.5-rc.2 的 `ctx.credentials` 契约（set / unset / resolve）。
 */
type CredentialRefLike = string & { readonly __brand?: 'CredentialRef' }

export interface DshCredentialsApi {
  set(ref: CredentialRefLike, value: string): Promise<void>
  unset(ref: CredentialRefLike): Promise<void>
  resolve(ref: CredentialRefLike): Promise<{ value: string; source?: string } | undefined>
}

type PreStepListener = (payload: { signal: AbortSignal }, next: () => Promise<unknown>) => Promise<unknown>

export interface DshPluginContext {
  credentials: DshCredentialsApi
  effect?: (execute: () => void | (() => void)) => unknown
  on(event: 'agent/pre-step', listener: PreStepListener): unknown
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
}

export interface AuthPluginConfig {
  /** 平台根地址，例如 https://43-134-117-172.nip.io；缺省读环境变量 HARNESS_PLATFORM_URL。 */
  platformBaseUrl?: string
  /** 设备显示名，缺省为主机名。 */
  deviceName?: string
  /** 访问令牌写入的凭证引用，必须与 provider 的 apiKeyEnv 一致，默认 HARNESS_PLATFORM_TOKEN。 */
  apiKeyEnv?: string
  /** 在访问令牌生命周期的这个比例处刷新，默认 0.8。 */
  refreshRatio?: number
  /** 没有刷新凭证时自动发起设备授权，默认 true。 */
  autoLogin?: boolean
  /** 首个模型请求最多等待登录/刷新多少秒，默认 600（与设备码有效期一致）。 */
  loginWaitSeconds?: number
}

export interface PluginDeps {
  store?: SecretStore
  fetch?: FetchLike
}

const POSIX_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function createSink(ctx: DshPluginContext, envName: string): TokenSink {
  if (!POSIX_IDENTIFIER.test(envName)) {
    throw new Error(`apiKeyEnv 必须是 POSIX 标识符：${envName}`)
  }
  const ref = envName as CredentialRefLike
  return {
    set: (token) => ctx.credentials.set(ref, token),
    clear: () => ctx.credentials.unset(ref),
    current: async () => (await ctx.credentials.resolve(ref))?.value,
  }
}

export function applyPlugin(
  ctx: DshPluginContext,
  config: AuthPluginConfig = {},
  deps: PluginDeps = {},
): TokenManager | undefined {
  const say = (message: string): void => ctx.logger?.info?.(`[harness-auth] ${message}`)
  const platformBaseUrl = config.platformBaseUrl ?? process.env.HARNESS_PLATFORM_URL
  if (!platformBaseUrl) {
    ctx.logger?.warn?.('[harness-auth] 未配置 platformBaseUrl（或 HARNESS_PLATFORM_URL），认证插件不工作')
    return undefined
  }

  const manager = new TokenManager({
    platformBaseUrl,
    deviceName: config.deviceName ?? `${hostname()} (dsh)`,
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    store: deps.store ?? createSystemSecretStore(),
    sink: createSink(ctx, config.apiKeyEnv ?? PLATFORM_API_KEY_ENV),
    log: say,
    ...(config.refreshRatio !== undefined ? { refreshRatio: config.refreshRatio } : {}),
    ...(config.autoLogin !== undefined ? { autoLogin: config.autoLogin } : {}),
    announce: (challenge) => {
      // 用户必须看到设备码：日志可能被 UI 吞掉，所以同时写 stderr。
      const text =
        `请在浏览器打开 ${challenge.verificationUrl} ，登录后输入设备码 ${challenge.userCode} 以授权本设备` +
        `（${Math.floor(challenge.expiresInSeconds / 60)} 分钟内有效）`
      say(text)
      process.stderr.write(`[harness-auth] ${text}\n`)
    },
  })

  // 卸载释放：实测 ctx.on('dispose') 在 DSH 0.1.5-rc.2 不会触发，必须用 ctx.effect 的清理函数。
  ctx.effect?.(() => {
    manager.start()
    return () => manager.stop()
  })
  if (!ctx.effect) manager.start()

  // 首个模型请求要等令牌就绪，否则会以 MISSING_CREDENTIAL 失败。
  const waitMs = (config.loginWaitSeconds ?? 600) * 1000
  ctx.on('agent/pre-step', async (payload, next) => {
    const state = await Promise.race([
      manager.whenReady(),
      new Promise<'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), waitMs)
        timer.unref?.()
        payload.signal.addEventListener('abort', () => resolve('timeout'), { once: true })
      }),
    ])
    if (state !== 'ready') say(`访问令牌未就绪（${state}），模型请求预计会因缺少凭证失败`)
    return next()
  })

  return manager
}

export default {
  name: '@harness/dsh-plugin-auth',
  inject: ['credentials'],
  apply(ctx: DshPluginContext, config?: AuthPluginConfig): void {
    applyPlugin(ctx, config ?? {})
  },
}

export { buildProviderConfig, PLATFORM_API_KEY_ENV }
export { TokenManager } from './token-manager.js'
export { createSystemSecretStore, MacKeychainStore, SecretToolStore } from './credentials.js'
