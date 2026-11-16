/**
 * 平台 provider 配置骨架：把 DSH 的模型入口指向平台 /v1，使用稳定别名。
 * 实际写入 profile 配置与安装器逻辑由 Task 9 完成。
 */
export interface ProviderConfig {
  baseUrl: string
  apiKeyEnvVar: string
  models: { strong: string; cheap: string }
}

export const PLATFORM_API_KEY_ENV = 'HARNESS_PLATFORM_TOKEN'

export function buildProviderConfig(platformBaseUrl: string): ProviderConfig {
  return {
    baseUrl: `${platformBaseUrl.replace(/\/$/, '')}/v1`,
    apiKeyEnvVar: PLATFORM_API_KEY_ENV,
    models: { strong: 'work', cheap: 'cheap' },
  }
}
