import { hostname } from 'node:os';
import { createSystemSecretStore } from './credentials.js';
import { PLATFORM_API_KEY_ENV, buildProviderConfig } from './provider-config.js';
import { TokenManager } from './token-manager.js';
const POSIX_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
function createSink(ctx, envName) {
    if (!POSIX_IDENTIFIER.test(envName)) {
        throw new Error(`apiKeyEnv 必须是 POSIX 标识符：${envName}`);
    }
    const ref = envName;
    return {
        set: (token) => ctx.credentials.set(ref, token),
        clear: () => ctx.credentials.unset(ref),
        current: async () => (await ctx.credentials.resolve(ref))?.value,
    };
}
export function applyPlugin(ctx, config = {}, deps = {}) {
    const say = (message) => ctx.logger?.info?.(`[harness-auth] ${message}`);
    const platformBaseUrl = config.platformBaseUrl ?? process.env.HARNESS_PLATFORM_URL;
    if (!platformBaseUrl) {
        ctx.logger?.warn?.('[harness-auth] 未配置 platformBaseUrl（或 HARNESS_PLATFORM_URL），认证插件不工作');
        return undefined;
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
            const text = `请在浏览器打开 ${challenge.verificationUrl} ，登录后输入设备码 ${challenge.userCode} 以授权本设备` +
                `（${Math.floor(challenge.expiresInSeconds / 60)} 分钟内有效）`;
            say(text);
            process.stderr.write(`[harness-auth] ${text}\n`);
        },
    });
    // 卸载释放：实测 ctx.on('dispose') 在 DSH 0.1.5-rc.2 不会触发，必须用 ctx.effect 的清理函数。
    ctx.effect?.(() => {
        manager.start();
        return () => manager.stop();
    });
    if (!ctx.effect)
        manager.start();
    // 首个模型请求要等令牌就绪，否则会以 MISSING_CREDENTIAL 失败。
    const waitMs = (config.loginWaitSeconds ?? 600) * 1000;
    ctx.on('agent/pre-step', async (payload, next) => {
        const state = await Promise.race([
            manager.whenReady(),
            new Promise((resolve) => {
                const timer = setTimeout(() => resolve('timeout'), waitMs);
                timer.unref?.();
                payload.signal.addEventListener('abort', () => resolve('timeout'), { once: true });
            }),
        ]);
        if (state !== 'ready')
            say(`访问令牌未就绪（${state}），模型请求预计会因缺少凭证失败`);
        return next();
    });
    return manager;
}
export default {
    name: '@harness/dsh-plugin-auth',
    inject: ['credentials'],
    apply(ctx, config) {
        applyPlugin(ctx, config ?? {});
    },
};
export { buildProviderConfig, PLATFORM_API_KEY_ENV };
export { TokenManager } from './token-manager.js';
export { createSystemSecretStore, MacKeychainStore, SecretToolStore } from './credentials.js';
//# sourceMappingURL=index.js.map