import { type SecretStore } from './credentials.js';
import type { FetchLike } from './http.js';
import { PLATFORM_API_KEY_ENV, buildProviderConfig } from './provider-config.js';
import { TokenManager } from './token-manager.js';
/**
 * DSH 插件上下文里本插件用到的最小子集。
 *
 * 插件不依赖任何 DSH 包导入（避免版本耦合）：`credentialRef` 在 DSH 里只是带品牌的字符串
 * （POSIX 标识符），这里直接按字符串断言；类型只描述实际调用到的方法，字段名来自
 * DSH 0.1.5-rc.2 的 `ctx.credentials` 契约（set / unset / resolve）。
 */
type CredentialRefLike = string & {
    readonly __brand?: 'CredentialRef';
};
export interface DshCredentialsApi {
    set(ref: CredentialRefLike, value: string): Promise<void>;
    unset(ref: CredentialRefLike): Promise<void>;
    resolve(ref: CredentialRefLike): Promise<{
        value: string;
        source?: string;
    } | undefined>;
}
type PreStepListener = (payload: {
    signal: AbortSignal;
}, next: () => Promise<unknown>) => Promise<unknown>;
export interface DshPluginContext {
    credentials: DshCredentialsApi;
    effect?: (execute: () => void | (() => void)) => unknown;
    on(event: 'agent/pre-step', listener: PreStepListener): unknown;
    logger?: {
        info?: (message: string) => void;
        warn?: (message: string) => void;
    };
}
export interface AuthPluginConfig {
    /** 平台根地址，例如 https://43-134-117-172.nip.io；缺省读环境变量 HARNESS_PLATFORM_URL。 */
    platformBaseUrl?: string;
    /** 设备显示名，缺省为主机名。 */
    deviceName?: string;
    /** 访问令牌写入的凭证引用，必须与 provider 的 apiKeyEnv 一致，默认 HARNESS_PLATFORM_TOKEN。 */
    apiKeyEnv?: string;
    /** 在访问令牌生命周期的这个比例处刷新，默认 0.8。 */
    refreshRatio?: number;
    /** 没有刷新凭证时自动发起设备授权，默认 true。 */
    autoLogin?: boolean;
    /** 首个模型请求最多等待登录/刷新多少秒，默认 600（与设备码有效期一致）。 */
    loginWaitSeconds?: number;
}
export interface PluginDeps {
    store?: SecretStore;
    fetch?: FetchLike;
}
export declare function applyPlugin(ctx: DshPluginContext, config?: AuthPluginConfig, deps?: PluginDeps): TokenManager | undefined;
declare const _default: {
    name: string;
    inject: string[];
    apply(ctx: DshPluginContext, config?: AuthPluginConfig): void;
};
export default _default;
export { buildProviderConfig, PLATFORM_API_KEY_ENV };
export { TokenManager } from './token-manager.js';
export { createSystemSecretStore, MacKeychainStore, SecretToolStore } from './credentials.js';
