# @harness/dsh-plugin-auth

DSH 平台认证插件（Task 9.4，DSH 0.1.5-rc.2 首测、0.2.2-rc.3 适配实测，见 `docs/acceptance/phase-0.md` 与 `docs/acceptance/phase-1-dsh-022.md`）。

## 安装（DSH 插件页 / CLI，二选一）

本插件内建了全部团队配置（平台地址、`harness` provider、`work`/`cheap` 模型、默认模型、关遥测、
关会话标题计费），装完即用，无需再写任何配置：

- **DSH 桌面 / Web 界面**：插件页 → 添加插件 → 粘贴仓库地址
  `https://github.com/Gary23333/dsh-plugin-harness-auth` → 安装。
- **命令行**：`dsh plugin --profile <profile> add github:Gary23333/dsh-plugin-harness-auth`

首次使用：`dsh --profile <profile>` 跑第一条任务时，终端（或日志）会打印验证地址与 8 位设备码，
浏览器登录平台后打开该地址输入设备码批准即可；之后令牌自动刷新。

换平台地址时在 profile 的 `cordis.patch.yml` 里按 id 覆盖（见下文「配置」）。
命令行安装器（含备份/回退/团队凭证隔离，平台 `/install/` 下发）仍是可选的进阶方式。

做三件事：

1. **设备授权登录**：没有刷新凭证时调用 `POST /auth/device/start`，把验证地址与设备码打印到日志与 stderr，
   按平台给的间隔轮询 `/auth/device/poll`，成员在浏览器批准后拿到访问令牌（15 分钟）与刷新凭证（30 天）。
2. **令牌写入与刷新**：访问令牌通过 `ctx.credentials.set` 写到 provider 的 `apiKeyEnv`
   （默认 `HARNESS_PLATFORM_TOKEN`），DSH 在下一次请求生效，无需重启；在访问令牌生命周期的 80% 处
   调用 `/auth/refresh` 轮换刷新凭证。
3. **首个模型请求前等待令牌就绪**：监听 `agent/pre-step`，令牌未就绪时等待（默认最长 600 秒），避免首个请求以
   `MISSING_CREDENTIAL` 失败。

## 凭证存放（不要假装已满足）

| 凭证 | 位置 | 说明 |
| --- | --- | --- |
| 刷新凭证（30 天） | **系统钥匙串**（macOS `security`、Linux `secret-tool`） | 不经过 DSH 凭证存储；Windows 暂无实现，会直接报错而不是降级为明文 |
| 访问令牌（15 分钟） | DSH 凭证存储（`dsh-credentials-local`，**明文 YAML，权限 0600**） | DSH 0.1.5-rc.2 / 0.2.2-rc.3 都没有钥匙串实现，`ctx.credentials.set` 只能落盘；该文件对运行 DSH 的同一系统用户（含 agent 的工具进程）可读 |

## 并发与轮换安全

刷新凭证轮换后旧值立即作废，平台对重用会吊销整条设备凭证链。因此：

- 先把新刷新凭证写入钥匙串，再把新访问令牌交给 DSH；钥匙串写入失败时保留在进程内，不会回退发出旧值；
- 同机多个 DSH 进程共用一个钥匙串条目，刷新在跨进程互斥锁内进行；别的进程刚刷新过且 DSH 里已有它写入的令牌时，直接沿用；
- 4xx（凭证无效、被吊销、账号停用）清除本地凭证并回到设备授权；网络错误与 5xx 按 5s→5min 退避重试，不清除凭证。

## 配置

```yaml
# <DSH_HOME>/profiles/<name>/cordis.patch.yml
- id: harness-auth
  config:
    platformBaseUrl: https://43-134-117-172.nip.io   # 或环境变量 HARNESS_PLATFORM_URL
    deviceName: my-laptop                              # 缺省为主机名
    # apiKeyEnv: HARNESS_PLATFORM_TOKEN               # 必须与 provider 的 apiKeyEnv 一致
    # refreshRatio: 0.8
    # autoLogin: true
    # loginWaitSeconds: 600
- id: llm-pi-ai
  config:
    providers:
      harness:
        apiKeyEnv: HARNESS_PLATFORM_TOKEN
        api: openai-completions
        baseURL: https://43-134-117-172.nip.io/v1
        models:
          - { id: work, name: work, contextWindow: 200000, maxTokens: 8192, input: [text] }
          - { id: cheap, name: cheap, contextWindow: 200000, maxTokens: 8192, input: [text] }
```

注意：启动环境里若已导出 `HARNESS_PLATFORM_TOKEN`，DSH 把它视为只读来源，`ctx.credentials.set` 会被拒绝。

## 实测得到的 DSH 约束

- 插件不能依赖 DSH 包导入：`credentialRef` 只是带品牌的字符串，直接按字符串断言；
- 需要 `ctx.credentials` 时必须声明 `inject: ['credentials']`，否则 Cordis 报 `cannot get property "credentials" without inject`；
- **`ctx.on('dispose')` 在 DSH 0.1.5-rc.2 不会触发**（0.2.2-rc.3 未复测该事件，仍用 `ctx.effect(() => cleanup)`）；
- 安装：`dsh plugin --profile <name> add <本包路径 | github:Gary23333/dsh-plugin-harness-auth>`
  （会把 `@harness/dsh-plugin-auth` 加入 profile 的 bundles，并应用本包自带的 bundle patch）。

进阶安装（备份/回退/团队凭证隔离）：`packages/dsh-installer`（平台 `/install/` 下发）。
未实现：设置页、Windows 凭据存储。
