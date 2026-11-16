/**
 * 设备授权客户端：对应平台 /auth/device/start、/auth/device/poll、/auth/refresh。
 * 不依赖 @harness/shared，避免插件被打进 DSH 后还要解析工作区包。
 */
import { type FetchLike } from './http.js';
export interface DeviceLoginChallenge {
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    expiresInSeconds: number;
    intervalSeconds: number;
}
export interface TokenGrant {
    accessToken: string;
    refreshToken: string;
    expiresInSeconds: number;
}
export type PollOutcome = {
    status: 'pending';
} | {
    status: 'denied';
} | {
    status: 'expired';
} | ({
    status: 'approved';
} & TokenGrant);
export declare function startDeviceLogin(fetchFn: FetchLike, platformBaseUrl: string, deviceName: string, signal?: AbortSignal): Promise<DeviceLoginChallenge>;
export declare function pollDeviceLogin(fetchFn: FetchLike, platformBaseUrl: string, deviceCode: string, signal?: AbortSignal): Promise<PollOutcome>;
/** 刷新凭证轮换：旧刷新凭证立即作废，必须先持久化新值再丢弃旧值。 */
export declare function refreshTokens(fetchFn: FetchLike, platformBaseUrl: string, refreshToken: string, signal?: AbortSignal): Promise<TokenGrant>;
