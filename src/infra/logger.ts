import winston from 'winston';
import { SeqTransport } from '@datalust/winston-seq';

const LOG_PREFIX = '[HUB] ';

type SeqConfig = {
  enabled: boolean;
  serverUrl: string;
  apiKey?: string;
};

function buildSeqConfig(): SeqConfig {
  const enabledEnv = process.env.SEQ_ENABLED ?? '';
  const enabled = enabledEnv === '1' || enabledEnv.toLowerCase() === 'true';

  return {
    enabled,
    serverUrl: process.env.SEQ_SERVER_URL ?? '',
    apiKey: process.env.SEQ_API_KEY,
  };
}

const seqConfig = buildSeqConfig();

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
        return `[${level}] ${timestamp} - ${message}${metaStr ? ' ' + metaStr : ''}`;
      }),
    ),
  }),
];

if (seqConfig.enabled && seqConfig.serverUrl) {
  // Логируем один раз, что Seq-транспорт включён (для отладки "ничего не приходит в Seq").
  console.log(
    '[HUB] Seq logging enabled',
    JSON.stringify({ serverUrl: seqConfig.serverUrl }, null, 2),
  );
  transports.push(
    new SeqTransport({
      serverUrl: seqConfig.serverUrl,
      apiKey: seqConfig.apiKey || undefined,
      onError: (err: Error) => {
        // Не роняем приложение при ошибках отправки логов
        console.error('[Logger] Failed to send log to Seq:', err.message);
      },
      handleExceptions: true,
      handleRejections: true,
    }),
  );
}

const winstonLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports,
});

export const logger = {
  info: (message: string, meta?: unknown) => {
    winstonLogger.info(LOG_PREFIX + message, meta);
  },
  warn: (message: string, meta?: unknown) => {
    winstonLogger.warn(LOG_PREFIX + message, meta);
  },
  debug: (message: string, meta?: unknown) => {
    winstonLogger.debug(LOG_PREFIX + message, meta);
  },
  error: (message: string, error?: unknown) => {
    if (error instanceof Error) {
      winstonLogger.error(LOG_PREFIX + message, {
        error: error.message,
        stack: error.stack,
        name: error.name,
      });
    } else if (error) {
      winstonLogger.error(LOG_PREFIX + message, error);
    } else {
      winstonLogger.error(LOG_PREFIX + message);
    }
  },
};

