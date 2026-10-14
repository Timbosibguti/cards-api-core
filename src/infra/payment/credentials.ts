import type { AppConfig, ProvidersConfig, ProviderAuthConfig } from '../../config/env.js';

export type PaymentProvider = 'adscards' | 'ecards' | 'multicards' | 'stellarcards';

export interface PaymentAuthHeaders {
  baseUrl: string;
  headers: Record<string, string>;
}

export interface GetAuthOptions {
  /** Путь запроса; для stellarcards по path выбирается Token (карты) или Bearer (transactions). */
  path?: string;
}

export interface PaymentCredentialsService {
  /**
   * Вернуть baseUrl и набор заголовков авторизации для конкретного провайдера.
   * Для stellarcards: path, содержащий /v1/transactions, — Bearer; иначе — Token (карты).
   */
  getAuth(bank: PaymentProvider, options?: GetAuthOptions): Promise<PaymentAuthHeaders>;
}

let instance: PaymentCredentialsService | null = null;

function pickProviderConfig(providers: ProvidersConfig, bank: PaymentProvider): ProviderAuthConfig | undefined {
  return providers[bank];
}

function buildHeaders(config: ProviderAuthConfig, path?: string): Record<string, string> {
  const headers: Record<string, string> = {};

  const isStellarcardsTransactions =
    config.tokenForCards != null && path != null && path.includes('/v1/transactions');

  if (config.tokenForCards != null && !isStellarcardsTransactions) {
    headers.Authorization = `Token ${config.tokenForCards}`;
    return headers;
  }
  if (isStellarcardsTransactions && config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
    return headers;
  }

  if (config.authMode === 'basic') {
    if (config.username && config.password) {
      const token = Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64');
      headers.Authorization = `Basic ${token}`;
    }
  } else if (config.authMode === 'bearer') {
    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
  } else if (config.authMode === 'apiKeyHeader') {
    if (config.apiKey && config.apiKeyHeader) {
      headers[config.apiKeyHeader] = config.apiKey;
    }
  }

  if (config.extraApiKeyHeader && config.extraApiKey) {
    headers[config.extraApiKeyHeader] = config.extraApiKey;
  }

  return headers;
}

function createPaymentCredentialsService(appConfig: AppConfig): PaymentCredentialsService {
  const providers = appConfig.providers;

  return {
    async getAuth(bank: PaymentProvider, options?: GetAuthOptions): Promise<PaymentAuthHeaders> {
      const provider = pickProviderConfig(providers, bank);
      if (!provider || !provider.baseUrl) {
        throw new Error(`No provider auth config for bank "${bank}"`);
      }

      const headers = buildHeaders(provider, options?.path);

      return {
        baseUrl: provider.baseUrl.replace(/\/+$/, ''),
        headers,
      };
    },
  };
}

export function getPaymentCredentialsService(config: AppConfig): PaymentCredentialsService {
  if (!instance) {
    instance = createPaymentCredentialsService(config);
  }
  return instance;
}

export function resetPaymentCredentialsService(): void {
  instance = null;
}

