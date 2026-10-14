import type { AppConfig } from '../../config/index.js';
import { getDatabaseService } from '../DatabaseService.js';
import { recordIncident } from '../incidents/recordIncident.js';
import { getPaymentCredentialsService, type PaymentProvider } from './credentials.js';
import { logger } from '../logger.js';

type PaymentHttpThrownError = Error & {
  httpStatus?: number;
  responseBodySnippet?: string;
};

async function recordPaymentHttpFailure(
  config: AppConfig,
  params: {
    bank: PaymentProvider;
    method: string;
    path: string;
    correlationId?: string;
    timeoutMs: number;
    error: PaymentHttpThrownError;
  },
): Promise<void> {
  const { bank, method, path, correlationId, timeoutMs, error } = params;
  const httpStatus = error.httpStatus;
  const isTimeout =
    error.name === 'AbortError' || error.message.includes('hard timeout after');
  const kind = httpStatus != null ? 'psp_http_error' : isTimeout ? 'psp_request_timeout' : 'psp_request_failed';
  const severity =
    httpStatus != null && httpStatus >= 400 && httpStatus < 500 ? 'warning' : 'error';
  const summary = `${bank} ${method} ${path}: ${error.message}`.slice(0, 1000);

  try {
    const db = getDatabaseService(config);
    const client = await db.getClient('main');
    try {
      await recordIncident(client, {
        source: 'payment_http_client',
        kind,
        severity,
        summary,
        detail: {
          bank,
          method,
          path,
          http_status: httpStatus ?? null,
          error_name: error.name,
          error_message: error.message,
          correlation_id: correlationId ?? null,
          timeout_ms: timeoutMs,
          response_body_snippet: error.responseBodySnippet ?? null,
        },
        correlation_id: correlationId ?? null,
      });
    } finally {
      client.release();
    }
  } catch (recordErr) {
    logger.error('PaymentHttpClient: recordIncident failed', recordErr as Error);
  }
}

export interface PaymentRequestOptions {
  bank: PaymentProvider;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** Если задан, подставляется вместо baseUrl провайдера (для эндпоинтов вроде simple-api с token в URL). */
  baseUrlOverride?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  correlationId?: string;
  timeoutMs?: number;
}

export interface PaymentHttpClient {
  request<T = unknown>(options: PaymentRequestOptions): Promise<T>;
}

let instance: PaymentHttpClient | null = null;

function buildUrl(baseUrl: string, path: string, query?: PaymentRequestOptions['query']): string {
  const url = new URL(path.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function createPaymentHttpClient(config: AppConfig): PaymentHttpClient {
  const credentials = getPaymentCredentialsService(config);

  return {
    async request<T = unknown>(options: PaymentRequestOptions): Promise<T> {
      console.log('request', options);
      const { bank, method, path, baseUrlOverride, query, body, headers, correlationId } = options;
      // В dev-окружении агрессивнее завершаем зависшие запросы (5 секунд), в остальных — 15 секунд.
      const timeoutMs =
        options.timeoutMs ??
        (process.env.NODE_ENV === 'development' ? 5_000 : 15_000);

      try {
        const auth = await credentials.getAuth(bank, { path });
        console.log('auth', auth);
        const base = (baseUrlOverride ?? auth.baseUrl).replace(/\/+$/, '');
        const url = buildUrl(base, path, query);
        console.log('url', url);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        console.log('controller', controller);
        const finalHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          ...auth.headers,
          ...(headers ?? {}),
        };
        console.log('finalHeaders', finalHeaders);
        if (correlationId) {
          finalHeaders['X-Correlation-Id'] = correlationId;
        }

        const init: RequestInit = {
          method,
          headers: finalHeaders,
          signal: controller.signal,
        };

        if (body !== undefined && body !== null) {
          init.body = typeof body === 'string' ? body : JSON.stringify(body);
        }

        try {
          logger.debug(`PaymentHttpClient request ${method} ${url}`, {
            bank,
            timeoutMs,
          });

          // Упрощённый curl для воспроизведения запроса (dev only).
          if (process.env.NODE_ENV === 'development') {
            const headerParts = Object.entries(finalHeaders).map(
              ([k, v]) => `-H ${JSON.stringify(`${k}: ${v}`)}`,
            );
            const bodyFlag =
              body !== undefined && body !== null
                ? ` -d ${JSON.stringify(
                    typeof body === 'string' ? body : JSON.stringify(body),
                  )}`
                : '';
            const curlCmd = `curl -v -X ${method} ${headerParts.join(
              ' ',
            )} ${JSON.stringify(url)}${bodyFlag}`;
            // eslint-disable-next-line no-console
            console.log('[HUB] Reproduce with:', curlCmd);
          }

          const fetchPromise = fetch(url, init);
          // Дополнительный жёсткий таймаут поверх AbortController, на случай,
          // если fetch по какой‑то причине не реагирует на signal.
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(
              () =>
                reject(
                  new Error(
                    `PaymentHttpClient hard timeout after ${timeoutMs}ms for ${bank} ${path}`,
                  ),
                ),
              timeoutMs,
            );
          });

          const res = (await Promise.race([
            fetchPromise,
            timeoutPromise,
          ])) as Response;
          const text = await res.text();
          const ok = res.ok;

          let parsed: unknown = text;
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch (err) {
              logger.error('PaymentHttpClient JSON parse error', err as Error);
            }
          }

          if (!ok) {
            logger.error(`PaymentHttpClient HTTP error ${res.status} for ${url}`, {
              bank,
              status: res.status,
              body: text,
            });
            const maxBodyInMessage = 2_000;
            const trimmed =
              text.length > maxBodyInMessage ? `${text.slice(0, maxBodyInMessage)}…` : text;
            const detail = trimmed.length > 0 ? ` | body: ${trimmed}` : '';
            const httpErr = new Error(
              `HTTP ${res.status} from ${bank} for ${path}${detail}`,
            ) as PaymentHttpThrownError;
            httpErr.httpStatus = res.status;
            httpErr.responseBodySnippet = trimmed.length > 0 ? trimmed : undefined;
            throw httpErr;
          }

          return parsed as T;
        } finally {
          clearTimeout(timeout);
        }
      } catch (err) {
        const e = err as PaymentHttpThrownError;
        if (e.name === 'AbortError') {
          logger.error(
            `PaymentHttpClient timeout after ${timeoutMs}ms for ${bank} ${path}`,
            e,
          );
        } else {
          const hint =
            e.message === 'fetch failed'
              ? ' (в локальном запуске часто значит: URL недоступен — проверьте STELLARCARDS_BASE_URL / ADSCARDS_BASE_URL и т.п.)'
              : '';
          logger.warn(`PaymentHttpClient request error for ${bank} ${path}${hint}`, {
            error: e.message,
            name: e.name,
            cause: e.cause != null ? String(e.cause) : undefined,
          });
        }
        await recordPaymentHttpFailure(config, {
          bank,
          method,
          path,
          correlationId,
          timeoutMs,
          error: e,
        });
        throw err;
      }
    },
  };
}

export function getPaymentHttpClient(config: AppConfig): PaymentHttpClient {
  if (!instance) {
    instance = createPaymentHttpClient(config);
  }
  return instance;
}

export function resetPaymentHttpClient(): void {
  instance = null;
}

