/**
 * Загрузка и парсинг переменных окружения.
 * Единственное место, где допустимо чтение process.env.
 * Остальные модули используют config из config/index.ts.
 */

function getEnvOptional(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`Env ${key} must be a number, got: ${raw}`);
  return n;
}

export function getEnvBool(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  return raw === '1' || raw.toLowerCase() === 'true' || raw === 'yes';
}

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  schema?: string;
}

export interface FarmDatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  schema: string;
}

export interface MqttConfig {
  brokerHost: string;
  brokerPort: number;
  brokerUser: string;
  brokerPassword: string;
  clientIdPrefix: string;
  /** Префикс физических MQTT‑топиков (например, v2/). */
  topicPrefix: string;
  /** Топики по умолчанию (sequoia/otp, sequoia/transaction и т.д.) без префикса. */
  defaultTopics: string[];
}

export interface SlackConfig {
  /** Базовый URL slack-app (например https://slack-app-main.groscloud.com). */
  appUrl: string;
  /** API-ключ для заголовка Api-Key (SLACK_APP_API_KEY или SLACK_API_KEY). */
  apiKey: string;
  /** @deprecated Используйте apiKey. Оставлено для обратной совместимости с SLACK_API_KEY. */
  apiToken: string;
  defaultChannels: {
    farmOtp?: string;
    financeOtp?: string;
  };
  /**
   * Пуско-наладка: все сообщения Slack отправлять в этот канал (имя без #, например dev-hub),
   * с префиксом [DM: email] или [#канал] — откуда бы сообщение ни шло.
   * Переменная: SLACK_ALL_TO_CHANNEL (например SLACK_ALL_TO_CHANNEL=dev-hub).
   */
  allToChannel?: string;
}

/** API-ключ для роутов api/queue/* и api/balances/* (та же проверка, что в mqtt_otp_transactions_service). */
export interface QueueApiConfig {
  /** Заголовок Api-Key должен совпадать с этим значением. */
  apiKey: string;
  /** Ключ для шифрования login/password в bank_accounts (опционально). */
  encryptionKey?: string;
}

/** Basic Auth для api/balances/* (опционально; если не задан — только Api-Key и JWT). */
export interface BasicAuthConfig {
  user: string;
  password: string;
}

export interface UnlinkDeadConfig {
  defaultDays: number;
  stellarcardsDays: number;
  billingBins: string[];
}

export interface ProcessingRuntimeConfig {
  stuckIncomingTimeoutMinutes: number;
  stuckOutboxTimeoutMinutes: number;
  stuckOutgoingTimeoutMinutes: number;
  incomingMaxProcessingAttempts: number;
  outboxMaxProcessingAttempts: number;
  outgoingMaxAttempts: number;
  /** Окно поллинга транзакций платёжных систем в часах (скользящее). */
  transactionsPollingWindowHours: number;
}

export type PaymentAuthMode = 'basic' | 'bearer' | 'apiKeyHeader';

export interface ProviderAuthConfig {
  /** Базовый URL API платёжной системы (https://...). */
  baseUrl: string;
  /** Режим авторизации. */
  authMode: PaymentAuthMode;
  /** Имя заголовка для apiKey (по умолчанию Authorization). */
  apiKeyHeader?: string;
  /** Значение apiKey или токена. */
  apiKey?: string;
  /** Basic auth: логин. */
  username?: string;
  /** Basic auth: пароль. */
  password?: string;
  /** Stellarcards: Token для карт (Authorization: Token {token}); для /v1/transactions используется apiKey как Bearer. */
  tokenForCards?: string;
  /** Stellarcards: URL прокси для получения реквизитов карты (GET .../api/card/:id/detail). */
  detailProxyUrl?: string;
  /** AdsCards: токен для тела запроса (body.auth_token), например POST /cards/list. */
  authTokenForBody?: string;
  /** Доп. заголовок (например Api-Key) для провайдеров с двумя способами авторизации. */
  extraApiKeyHeader?: string;
  /** Значение для extraApiKeyHeader. */
  extraApiKey?: string;
}

export interface ProvidersConfig {
  /** AdsCards (bank = adscards). */
  adscards?: ProviderAuthConfig;
  /** eCards (bank = ecards). */
  ecards?: ProviderAuthConfig;
  /** Multicards (bank = multicards). */
  multicards?: ProviderAuthConfig;
  /** StellarCards (bank = stellarcards). */
  stellarcards?: ProviderAuthConfig;
}

/** Dev simulation: инъекция событий через dev_inbox_events (processor_hub_dev_simulation_spec.md). В production всегда false. */
export interface DevSimulationConfig {
  enabled: boolean;
}

export interface AppConfig {
  nodeEnv: string;
  httpPort: number;
  database: DatabaseConfig;
  farmDatabase: FarmDatabaseConfig;
  /** Опциональная sync/HR БД (finance1_ext и др.). */
  syncDatabase?: DatabaseConfig;
  mqtt: MqttConfig;
  slack: SlackConfig;
  /** Dev simulation: включено только при DEV_SIMULATION_ENABLED=true и не в production. */
  devSimulation: DevSimulationConfig;
  /** api/queue/* и api/balances/*: авторизация и шифрование credentials (совместимость с mqtt_otp). */
  queueApi: QueueApiConfig;
  /** Basic Auth для api/balances/* (опционально). */
  basicAuth?: BasicAuthConfig;
  /** sync-fibery: проверка отдела по profileId (api/cards/* farm access). */
  syncFibery?: { baseUrl: string };
  unlinkDead: UnlinkDeadConfig;
  processingRuntime: ProcessingRuntimeConfig;
  providers: ProvidersConfig;
}

/**
 * Собирает конфиг из process.env. Вызывается один раз при старте.
 * При отсутствии обязательных переменных — throw (fail-fast).
 */
export function loadConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const httpPort = getEnvNumber('HTTP_PORT', 3000);

  const database: DatabaseConfig = {
    host: getEnvOptional('DB_HOST', 'localhost'),
    port: getEnvNumber('DB_PORT', 5432),
    user: getEnvOptional('DB_USER', 'postgres'),
    password: getEnvOptional('DB_PASSWORD', ''),
    database: getEnvOptional('DB_NAME', 'finance'),
    schema: process.env.DB_SCHEMA,
  };

  const farmDatabase: FarmDatabaseConfig = {
    host: getEnvOptional('FARM_DB_HOST', 'localhost'),
    port: getEnvNumber('FARM_DB_PORT', 5432),
    user: getEnvOptional('FARM_DB_USER', 'postgres'),
    password: getEnvOptional('FARM_DB_PASSWORD', ''),
    database: getEnvOptional('FARM_DB_NAME', 'farm'),
    schema: getEnvOptional('FARM_DB_SCHEMA', 'farm_ext'),
  };

  // Опциональная sync/HR БД: если не заданы переменные, поле остаётся undefined.
  const hasSyncConfig = Boolean(process.env.SYNC_DB_NAME || process.env.SYNC_DB_HOST);

  const syncDatabase: DatabaseConfig | undefined = hasSyncConfig
    ? {
        host: getEnvOptional('SYNC_DB_HOST', database.host),
        port: getEnvNumber('SYNC_DB_PORT', database.port),
        user: getEnvOptional('SYNC_DB_USER', database.user),
        password: getEnvOptional('SYNC_DB_PASSWORD', database.password),
        database: getEnvOptional('SYNC_DB_NAME', database.database),
        schema: process.env.SYNC_DB_SCHEMA,
      }
    : undefined;

  const mqtt: MqttConfig = {
    brokerHost: getEnvOptional('BROKER_HOST', 'localhost'),
    brokerPort: getEnvNumber('BROKER_PORT', 1883),
    brokerUser: getEnvOptional('BROKER_USER', ''),
    brokerPassword: getEnvOptional('BROKER_PASSWORD', ''),
    clientIdPrefix: getEnvOptional('MQTT_CLIENT_ID_PREFIX', 'processor-hub'),
    topicPrefix: getEnvOptional('MQTT_TOPIC_PREFIX', 'v2/'),
    defaultTopics: ['sequoia/otp', 'sequoia/transaction', 'sequoia/cards', 'sequoia/card', 'sequoia/audit'],
  };

  const slackAllTo = (process.env.SLACK_ALL_TO_CHANNEL ?? '').trim();
  const slack: SlackConfig = {
    appUrl: getEnvOptional('SLACK_APP_URL', ''),
    apiKey: getEnvOptional('SLACK_APP_API_KEY', process.env.SLACK_API_KEY ?? ''),
    apiToken: getEnvOptional('SLACK_API_KEY', ''),
    defaultChannels: {
      farmOtp: process.env.SLACK_CHANNEL_FARM_OTP,
      financeOtp: process.env.SLACK_CHANNEL_FINANCE_OTP,
    },
    ...(slackAllTo ? { allToChannel: slackAllTo } : {}),
  };

  const queueApiKey = (process.env.QUEUE_API_KEY ?? '').trim();
  if (nodeEnv === 'production' && !queueApiKey) {
    throw new Error(
      'QUEUE_API_KEY must be set explicitly in production. Set the env var and do not commit it.',
    );
  }
  const queueApi: QueueApiConfig = {
    apiKey: queueApiKey,
    encryptionKey: process.env.ENCRYPTION_KEY ?? undefined,
  };

  const basicAuth: BasicAuthConfig | undefined =
    process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS
      ? { user: process.env.BASIC_AUTH_USER, password: process.env.BASIC_AUTH_PASS }
      : undefined;

  const syncFibery =
    process.env.SYNC_FIBERY_BASE_URL != null
      ? { baseUrl: process.env.SYNC_FIBERY_BASE_URL }
      : undefined;

  const unlinkDead: UnlinkDeadConfig = {
    defaultDays: getEnvNumber('UNLINK_DEAD_DEFAULT_DAYS', 7),
    stellarcardsDays: getEnvNumber('UNLINK_DEAD_STELLARCARDS_DAYS', 30),
    billingBins: (process.env.UNLINK_DEAD_BILLING_BINS ?? '').split(',').filter(Boolean),
  };

  const devSimulation: DevSimulationConfig = {
    enabled: nodeEnv !== 'production' && getEnvBool('DEV_SIMULATION_ENABLED', false),
  };

  const processingRuntime: ProcessingRuntimeConfig = {
    stuckIncomingTimeoutMinutes: getEnvNumber('STUCK_INCOMING_TIMEOUT_MINUTES', 15),
    stuckOutboxTimeoutMinutes: getEnvNumber('STUCK_OUTBOX_TIMEOUT_MINUTES', 15),
    stuckOutgoingTimeoutMinutes: getEnvNumber('STUCK_OUTGOING_TIMEOUT_MINUTES', 5),
    incomingMaxProcessingAttempts: getEnvNumber('INCOMING_MAX_PROCESSING_ATTEMPTS', 3),
    outboxMaxProcessingAttempts: getEnvNumber('OUTBOX_MAX_PROCESSING_ATTEMPTS', 3),
    outgoingMaxAttempts: getEnvNumber('OUTGOING_MAX_ATTEMPTS', 8),
    transactionsPollingWindowHours: getEnvNumber('TRANSACTIONS_POLLING_WINDOW_HOURS', 24),
  };

  const providers: ProvidersConfig = {
    adscards: process.env.ADSCARD_API_URL || process.env.ADSCARDS_BASE_URL
      ? {
          baseUrl: getEnvOptional('ADSCARD_API_URL', '') || getEnvOptional('ADSCARDS_BASE_URL', ''),
          authMode: (process.env.ADSCARDS_AUTH_MODE as PaymentAuthMode) || 'bearer',
          apiKeyHeader: process.env.ADSCARDS_API_KEY_HEADER || 'Authorization',
          apiKey:
            process.env.ADSCARD_BEARER_TOKEN ??
            process.env.ADSCARDS_API_KEY,
          username: process.env.ADSCARDS_USERNAME,
          password: process.env.ADSCARDS_PASSWORD,
          authTokenForBody:
            process.env.ADSCARD_AUTH_TOKEN ?? undefined,
          extraApiKeyHeader: process.env.ADSCARD_API_KEY ? 'Api-Key' : undefined,
          extraApiKey: process.env.ADSCARD_API_KEY ?? undefined,
        }
      : undefined,
    ecards: process.env.ECARDS_BASE_URL
      ? {
          baseUrl: getEnvOptional('ECARDS_BASE_URL', ''),
          authMode: (process.env.ECARDS_AUTH_MODE as PaymentAuthMode) || 'apiKeyHeader',
          apiKeyHeader: process.env.ECARDS_API_KEY_HEADER || 'Authorization',
          apiKey: process.env.ECARDS_API_KEY,
          username: process.env.ECARDS_USERNAME,
          password: process.env.ECARDS_PASSWORD,
        }
      : undefined,
  multicards: process.env.MULTICARDS_BASE_URL
      ? {
          baseUrl: getEnvOptional('MULTICARDS_BASE_URL', ''),
          // Для Multicards основная авторизация — через логин/пароль и x-auth-token от /v1/auth/login.
          // apiKeyHeader/apiKey оставляем опциональными (на будущее), но по умолчанию пустыми.
          authMode: (process.env.MULTICARDS_AUTH_MODE as PaymentAuthMode) || 'apiKeyHeader',
          apiKeyHeader: process.env.MULTICARDS_API_KEY_HEADER || 'Authorization',
          apiKey: process.env.MULTICARDS_API_KEY,
          // В старом сервисе используется MULTICARDS_EMAIL/MULTICARDS_PASSWORD.
          // Если MULTICARDS_USERNAME не задан, подставляем MULTICARDS_EMAIL для совместимости.
          username: process.env.MULTICARDS_USERNAME || process.env.MULTICARDS_EMAIL,
          password: process.env.MULTICARDS_PASSWORD,
        }
      : undefined,
    stellarcards: process.env.STELLARCARDS_BASE_URL
      ? {
          baseUrl: getEnvOptional('STELLARCARDS_BASE_URL', ''),
          authMode: (process.env.STELLARCARDS_AUTH_MODE as PaymentAuthMode) || 'apiKeyHeader',
          apiKeyHeader: process.env.STELLARCARDS_API_KEY_HEADER || 'Authorization',
          apiKey: process.env.STELLARCARDS_BEARER ?? process.env.STELLARCARDS_API_KEY,
          username: process.env.STELLARCARDS_USERNAME,
          password: process.env.STELLARCARDS_PASSWORD,
          tokenForCards: process.env.STELLARCARDS_TOKEN,
          detailProxyUrl: process.env.STELLARCARDS_DETAIL_PROXY_URL
            ? getEnvOptional('STELLARCARDS_DETAIL_PROXY_URL', '')
            : undefined,
        }
      : undefined,
  };

  return {
    nodeEnv,
    httpPort,
    database,
    farmDatabase,
    syncDatabase,
    mqtt,
    slack,
    devSimulation,
    queueApi,
    basicAuth,
    syncFibery,
    unlinkDead,
    processingRuntime,
    providers,
  };
}
