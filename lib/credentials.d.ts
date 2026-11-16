export interface StoredCredentials {
    refreshToken: string;
    /** 当前访问令牌的签发与到期时间（epoch 毫秒），用于按生命周期的 80% 推算刷新时点。 */
    accessIssuedAt: number;
    accessExpiresAt: number;
}
export interface SecretStore {
    readonly kind: string;
    get(account: string): Promise<string | null>;
    set(account: string, secret: string): Promise<void>;
    delete(account: string): Promise<void>;
}
export declare const KEYCHAIN_SERVICE = "harness-platform-refresh";
/** macOS：`security` 命令。写入走 `security -i` 的标准输入，密钥不出现在进程参数里。 */
export declare class MacKeychainStore implements SecretStore {
    readonly kind = "macos-keychain";
    get(account: string): Promise<string | null>;
    set(account: string, secret: string): Promise<void>;
    delete(account: string): Promise<void>;
}
/** Linux：libsecret 的 `secret-tool`（密钥走标准输入）。本期未在 Linux 实测。 */
export declare class SecretToolStore implements SecretStore {
    readonly kind = "libsecret";
    get(account: string): Promise<string | null>;
    set(account: string, secret: string): Promise<void>;
    delete(account: string): Promise<void>;
}
/**
 * 选择系统钥匙串实现。Windows 以及缺少钥匙串的环境直接报错，**不会**悄悄降级为明文文件。
 */
export declare function createSystemSecretStore(platform?: NodeJS.Platform): SecretStore;
export declare function encodeStored(value: StoredCredentials): string;
export declare function decodeStored(encoded: string): StoredCredentials | null;
/** 钥匙串账户名：平台地址（去掉协议与结尾斜杠），同一台机器上多个平台互不覆盖。 */
export declare function accountFor(platformBaseUrl: string): string;
/**
 * 跨进程互斥：用 mkdir 的原子性做锁。持有超过 staleMs 视为崩溃遗留，强制回收。
 * 返回释放函数。
 */
export declare function acquireLock(name: string, options?: {
    staleMs?: number;
    waitMs?: number;
    pollMs?: number;
    dir?: string;
}): Promise<() => Promise<void>>;
