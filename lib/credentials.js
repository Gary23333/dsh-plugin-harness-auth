/**
 * 刷新凭证的持久化。
 *
 * 实测结论（DSH 0.1.5-rc.2，见 docs/acceptance/phase-0.md）：`dsh-credentials-local` 把
 * `ctx.credentials.set` 写入的值以明文 YAML 存进 `~/.dsh/.credentials.yaml`（仅文件权限保护）。
 * 因此：
 *   - 30 天有效的刷新凭证**不经**该存储，改放系统钥匙串；
 *   - 15 分钟有效的访问令牌只能经 `ctx.credentials.set` 交给 DSH，会短暂明文落盘，
 *     这是该版本的已知限制，不能宣称"完全不落盘"。
 *
 * 钥匙串条目内容是 base64url(JSON)：刷新凭证 + 当前访问令牌到期时间，
 * 让同机多个 DSH 进程能在互斥锁内判断"别人是否刚刷新过"，避免同一刷新凭证被重复使用而触发重用吊销。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
export const KEYCHAIN_SERVICE = 'harness-platform-refresh';
/** 令牌与编码结果都只含 base64url 字符，可安全拼进 `security -i` 的命令行而不需要转义。 */
const SAFE_SECRET = /^[A-Za-z0-9_-]+$/;
const SAFE_ACCOUNT = /^[A-Za-z0-9._:@/-]+$/;
function run(file, args, stdin) {
    return new Promise((resolve, reject) => {
        const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
        child.stdin.end(stdin ?? '');
    });
}
/** macOS：`security` 命令。写入走 `security -i` 的标准输入，密钥不出现在进程参数里。 */
export class MacKeychainStore {
    kind = 'macos-keychain';
    async get(account) {
        assertAccount(account);
        const result = await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w']);
        if (result.code === 0)
            return result.stdout.trim() || null;
        // 44 = errSecItemNotFound
        if (result.code === 44)
            return null;
        throw new Error(`钥匙串读取失败（security 退出码 ${result.code}）`);
    }
    async set(account, secret) {
        assertAccount(account);
        if (!SAFE_SECRET.test(secret))
            throw new Error('钥匙串写入拒绝：内容含非 base64url 字符');
        const command = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w ${secret}\n`;
        const result = await run('security', ['-i'], command);
        if (result.code !== 0)
            throw new Error(`钥匙串写入失败（security 退出码 ${result.code}）`);
    }
    async delete(account) {
        assertAccount(account);
        const result = await run('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account]);
        if (result.code !== 0 && result.code !== 44) {
            throw new Error(`钥匙串删除失败（security 退出码 ${result.code}）`);
        }
    }
}
/** Linux：libsecret 的 `secret-tool`（密钥走标准输入）。本期未在 Linux 实测。 */
export class SecretToolStore {
    kind = 'libsecret';
    async get(account) {
        assertAccount(account);
        const result = await run('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', account]);
        if (result.code === 0 && result.stdout.trim())
            return result.stdout.trim();
        return null;
    }
    async set(account, secret) {
        assertAccount(account);
        const result = await run('secret-tool', ['store', '--label=Harness platform refresh', 'service', KEYCHAIN_SERVICE, 'account', account], secret);
        if (result.code !== 0)
            throw new Error(`secret-tool 写入失败（退出码 ${result.code}）`);
    }
    async delete(account) {
        assertAccount(account);
        await run('secret-tool', ['clear', 'service', KEYCHAIN_SERVICE, 'account', account]);
    }
}
function assertAccount(account) {
    if (!SAFE_ACCOUNT.test(account))
        throw new Error('钥匙串账户名含非法字符');
}
/**
 * 选择系统钥匙串实现。Windows 以及缺少钥匙串的环境直接报错，**不会**悄悄降级为明文文件。
 */
export function createSystemSecretStore(platform = process.platform) {
    if (platform === 'darwin')
        return new MacKeychainStore();
    if (platform === 'linux')
        return new SecretToolStore();
    throw new Error(`当前平台 ${platform} 暂无系统钥匙串实现，拒绝把刷新凭证明文落盘`);
}
export function encodeStored(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
export function decodeStored(encoded) {
    try {
        const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (typeof parsed.refreshToken !== 'string' || parsed.refreshToken.length === 0)
            return null;
        if (typeof parsed.accessExpiresAt !== 'number' || typeof parsed.accessIssuedAt !== 'number')
            return null;
        return {
            refreshToken: parsed.refreshToken,
            accessIssuedAt: parsed.accessIssuedAt,
            accessExpiresAt: parsed.accessExpiresAt,
        };
    }
    catch {
        return null;
    }
}
/** 钥匙串账户名：平台地址（去掉协议与结尾斜杠），同一台机器上多个平台互不覆盖。 */
export function accountFor(platformBaseUrl) {
    return platformBaseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}
/**
 * 跨进程互斥：用 mkdir 的原子性做锁。持有超过 staleMs 视为崩溃遗留，强制回收。
 * 返回释放函数。
 */
export async function acquireLock(name, options = {}) {
    const { staleMs = 15_000, waitMs = 20_000, pollMs = 100 } = options;
    const dir = options.dir ?? join(tmpdir() || homedir(), `harness-auth-${createHash('sha256').update(name).digest('hex').slice(0, 16)}.lock`);
    const deadline = Date.now() + waitMs;
    for (;;) {
        try {
            await mkdir(dir, { mode: 0o700 });
            return async () => {
                await rm(dir, { recursive: true, force: true });
            };
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            try {
                const info = await stat(dir);
                if (Date.now() - info.mtimeMs > staleMs) {
                    await rm(dir, { recursive: true, force: true });
                    continue;
                }
            }
            catch {
                continue;
            }
            if (Date.now() > deadline)
                throw new Error('等待刷新凭证互斥锁超时');
            await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
    }
}
//# sourceMappingURL=credentials.js.map