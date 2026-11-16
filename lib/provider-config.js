export const PLATFORM_API_KEY_ENV = 'HARNESS_PLATFORM_TOKEN';
export function buildProviderConfig(platformBaseUrl) {
    return {
        baseUrl: `${platformBaseUrl.replace(/\/$/, '')}/v1`,
        apiKeyEnvVar: PLATFORM_API_KEY_ENV,
        models: { strong: 'work', cheap: 'cheap' },
    };
}
//# sourceMappingURL=provider-config.js.map