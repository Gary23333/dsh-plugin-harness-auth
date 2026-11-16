/**
 * 令牌生命周期：设备授权登录 → 访问令牌写入 DSH → 到期前 80% 刷新（刷新凭证轮换）。
 *
 * 约束：
 * - 刷新凭证轮换后旧值立即作废，所以**先持久化新值，再使用新访问令牌**；
 * - 同机多个进程共用一个钥匙串条目，刷新在跨进程互斥锁内进行，避免同一刷新凭证被两次使用；
 * - 4xx（凭证无效/被吊销/账号停用）清除本地凭证，不重试；网络错误与 5xx 退避重试，不清除凭证。
 */
import { type SecretStore } from './credentials.js';
import { type FetchLike } from './http.js';
import { type DeviceLoginChallenge } from './login.js';
/** 把访问令牌交给 DSH（`ctx.credentials.set/unset/resolve` 的薄封装）。 */
export interface TokenSink {
    set(token: string): Promise<void>;
    clear(): Promise<void>;
    current(): Promise<string | undefined>;
}
export interface TokenManagerOptions {
    platformBaseUrl: string;
    deviceName: string;
    fetch: FetchLike;
    store: SecretStore;
    sink: TokenSink;
    log: (message: string) => void;
    announce: (challenge: DeviceLoginChallenge) => void;
    now?: () => number;
    /** 在访问令牌生命周期的这个比例处刷新，默认 0.8。 */
    refreshRatio?: number;
    /** 没有可用刷新凭证时是否自动发起设备授权，默认 true。 */
    autoLogin?: boolean;
    /** 距到期还剩多少毫秒以上就直接沿用别的进程刚刷新的令牌，默认 3 分钟。 */
    adoptMinRemainingMs?: number;
    retryDelaysMs?: number[];
    lock?: (name: string) => Promise<() => Promise<void>>;
}
export type ReadyState = 'ready' | 'unavailable';
export declare class TokenManager {
    private readonly options;
    private readonly account;
    private readonly now;
    private readonly ratio;
    private readonly autoLogin;
    private readonly adoptMinRemainingMs;
    private readonly retryDelays;
    private readonly lock;
    private readonly abort;
    private timer;
    private stopped;
    private failures;
    private settled;
    private resolveReady;
    private readonly readyPromise;
    /** 钥匙串不可写时的进程内兜底：轮换后的刷新凭证至少在本进程内不能丢。 */
    private memory;
    private starting;
    constructor(options: TokenManagerOptions);
    /** 启动：有刷新凭证就刷新，没有就设备授权登录。不抛错，结果通过 whenReady 与日志体现。 */
    start(): void;
    /** 首个访问令牌就绪（ready）或确定拿不到（unavailable）。 */
    whenReady(): Promise<ReadyState>;
    stop(): void;
    private settle;
    private bootstrap;
    private readStored;
    /** 持久化顺序：先写钥匙串（旧刷新凭证已作废，新值不能丢），再交付访问令牌。 */
    private apply;
    private schedule;
    private scheduleRetry;
    private refreshCycle;
    private refreshLocked;
    /** 凭证确认失效：清掉本地一切，必要时回到设备授权。 */
    private onCredentialsLost;
    private login;
}
