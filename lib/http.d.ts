/**
 * 平台 HTTP 调用：只做 JSON POST，错误统一成 PlatformHttpError。
 * 错误体遵循平台统一信封 `{ code, message, request_id, retryable }`。
 */
export declare class PlatformHttpError extends Error {
    readonly status: number;
    readonly code: string | undefined;
    constructor(status: number, code: string | undefined, message: string);
    /** 4xx（除 408/429）表示凭证本身无效，重试无意义；网络错误、5xx、429 才值得重试。 */
    get terminal(): boolean;
}
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export declare function postJson(fetchFn: FetchLike, baseUrl: string, path: string, body: unknown, signal?: AbortSignal): Promise<unknown>;
