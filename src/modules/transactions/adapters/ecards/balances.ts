import { getConfig } from '../../../../config/index.js';
import {
  getDatabaseService,
  recordDirectProviderHttpIncident,
  recordAdapterPollingCycleError,
} from '../../../../infra/index.js';
import { logger } from '../../../../infra/logger.js';
import { acquirePollingLease } from '../../../../infra/pollingLease.js';
import type { AdapterPollerHandle } from '../types.js';

const ECARDS_USER_BASE = 'https://ecardsnew.cab/api/modern';
const SIGN_IN_URL = `${ECARDS_USER_BASE}/user/v1/guest/auth/sign-in`;
const REFRESH_URL = `${ECARDS_USER_BASE}/user/v1/guest/auth/refresh`;
const ACCOUNTS_URL = `${ECARDS_USER_BASE}/account/v1/user/account`;

const POLL_INTERVAL_MS = 60_000;

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

interface AccountItem {
  id: number;
  updatedAt: string;
  ownerId?: number;
  currency: string;
  name: string;
  balance: string;
  product?: { binNumber?: string | null } | null;
}

interface AccountsResponse {
  data?: { content?: AccountItem[] };
}

interface AuthResponse {
  data?: { accessToken?: string; refreshToken?: string };
}

let tokens: AuthTokens | null = null;

async function signIn(): Promise<AuthTokens | null> {
  const config = getConfig();
  const prov = config.providers.ecards;
  const email = prov?.username;
  const password = prov?.password;
  if (!email || !password) {
    logger.warn('EcardsBalances: ECARDS_USERNAME / ECARDS_PASSWORD not set, skipping balance polling');
    return null;
  }

  const operation = 'balances/guest/auth/sign-in';

  let res: Response;
  try {
    res = await fetch(SIGN_IN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    await recordDirectProviderHttpIncident(config, {
      source: 'ecards_balances_fetch',
      kind: 'psp_network_error',
      bank: 'ecards',
      operation,
      error: err,
    });
    return null;
  }

  const text = await res.text();
  let json: AuthResponse = {};
  try {
    json = text ? (JSON.parse(text) as AuthResponse) : {};
  } catch (parseErr) {
    const err = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
    await recordDirectProviderHttpIncident(config, {
      source: 'ecards_balances_fetch',
      kind: 'psp_response_parse_error',
      bank: 'ecards',
      operation,
      http_status: res.status,
      error: err,
      detail: { response_body_snippet: text.slice(0, 2000) },
    });
    return null;
  }

  if (json.data?.accessToken && json.data.refreshToken) {
    return { accessToken: json.data.accessToken, refreshToken: json.data.refreshToken };
  }

  if (!res.ok) {
    await recordDirectProviderHttpIncident(config, {
      source: 'ecards_balances_fetch',
      kind: 'psp_http_error',
      bank: 'ecards',
      operation,
      http_status: res.status,
      error: new Error('EcardsBalances: sign-in failed'),
      detail: { response_body_snippet: text.slice(0, 2000) },
    });
  } else {
    await recordDirectProviderHttpIncident(config, {
      source: 'ecards_balances_fetch',
      kind: 'psp_response_invalid',
      bank: 'ecards',
      operation,
      http_status: res.status,
      error: new Error('EcardsBalances: sign-in missing tokens in response'),
      detail: { response_body_snippet: text.slice(0, 2000) },
    });
  }
  logger.error('EcardsBalances: sign-in failed', { status: res.status });
  return null;
}

async function refreshAuth(current: AuthTokens): Promise<AuthTokens | null> {
  const config = getConfig();
  const operation = 'balances/guest/auth/refresh';

  let res: Response;
  try {
    res = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: current.accessToken, refreshToken: current.refreshToken }),
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    await recordDirectProviderHttpIncident(config, {
      source: 'ecards_balances_fetch',
      kind: 'psp_network_error',
      bank: 'ecards',
      operation,
      error: err,
    });
    return null;
  }

  const text = await res.text();
  let json: AuthResponse = {};
  try {
    json = text ? (JSON.parse(text) as AuthResponse) : {};
  } catch (parseErr) {
    const err = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
    await recordDirectProviderHttpIncident(config, {
      source: 'ecards_balances_fetch',
      kind: 'psp_response_parse_error',
      bank: 'ecards',
      operation,
      http_status: res.status,
      error: err,
      detail: { response_body_snippet: text.slice(0, 2000) },
    });
    return null;
  }

  if (json.data?.accessToken && json.data.refreshToken) {
    return { accessToken: json.data.accessToken, refreshToken: json.data.refreshToken };
  }

  if (!res.ok) {
    await recordDirectProviderHttpIncident(config, {
      source: 'ecards_balances_fetch',
      kind: 'psp_http_error',
      bank: 'ecards',
      operation,
      http_status: res.status,
      error: new Error('EcardsBalances: refresh failed'),
      detail: { response_body_snippet: text.slice(0, 2000) },
    });
  } else {
    await recordDirectProviderHttpIncident(config, {
      source: 'ecards_balances_fetch',
      kind: 'psp_response_invalid',
      bank: 'ecards',
      operation,
      http_status: res.status,
      error: new Error('EcardsBalances: refresh missing tokens in response'),
      detail: { response_body_snippet: text.slice(0, 2000) },
    });
  }
  return null;
}

async function ensureAuth(): Promise<string | null> {
  if (!tokens) {
    tokens = await signIn();
    return tokens?.accessToken ?? null;
  }
  return tokens.accessToken;
}

async function fetchAccounts(retry = true): Promise<AccountItem[]> {
  const config = getConfig();
  const accessToken = await ensureAuth();
  if (!accessToken) return [];

  const url = `${ACCOUNTS_URL}?limit=100&sortBy=providerInternalIsBasic&sortDirection=asc&filterIsArchived=false`;
  const operation = 'balances/user/account';

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    await recordDirectProviderHttpIncident(config, {
      source: 'ecards_balances_fetch',
      kind: 'psp_network_error',
      bank: 'ecards',
      operation,
      error: err,
    });
    return [];
  }

  if (!res.ok && retry && tokens) {
    void res.text().catch(() => undefined);
    const refreshed = await refreshAuth(tokens);
    if (refreshed) {
      tokens = refreshed;
      return fetchAccounts(false);
    }
    tokens = await signIn();
    return fetchAccounts(false);
  }

  const text = await res.text();

  if (!res.ok) {
    logger.error('EcardsBalances: failed to fetch accounts', { status: res.status });
    await recordDirectProviderHttpIncident(config, {
      source: 'ecards_balances_fetch',
      kind: 'psp_http_error',
      bank: 'ecards',
      operation,
      http_status: res.status,
      error: new Error(`EcardsBalances: accounts HTTP ${res.status}`),
      detail: { response_body_snippet: text.slice(0, 2000) },
    });
    return [];
  }

  let json: AccountsResponse = {};
  try {
    json = text ? (JSON.parse(text) as AccountsResponse) : {};
  } catch (parseErr) {
    const err = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
    await recordDirectProviderHttpIncident(config, {
      source: 'ecards_balances_fetch',
      kind: 'psp_response_parse_error',
      bank: 'ecards',
      operation,
      http_status: res.status,
      error: err,
      detail: { response_body_snippet: text.slice(0, 2000) },
    });
    return [];
  }

  return json.data?.content ?? [];
}

function parseBalance(raw: string | number | null | undefined): number {
  if (raw == null) return 0;
  const s = String(raw).replace(/\s/g, '').trim();
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function buildName(item: AccountItem): string {
  let name = item.name ?? '';
  const bin = item.product?.binNumber;
  if (bin) {
    name += ` БИН ${bin.replace(/ \*{4} \*{4}/g, '')}`;
  }
  return name;
}

export async function startEcardsBalancePolling(): Promise<AdapterPollerHandle> {
  const config = getConfig();
  if (!config.providers.ecards?.username || !config.providers.ecards?.password) {
    logger.info('EcardsBalances: credentials not configured, balance polling disabled');
    return { async stop() {} };
  }

  const db = getDatabaseService(config);
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        const hasLease = await acquirePollingLease(db, 'ecards.balances', 60);
        if (!hasLease) {
          await new Promise((r) => setTimeout(r, 5_000));
          continue;
        }

        const accounts = await fetchAccounts();
        if (accounts.length === 0) {
          logger.debug('EcardsBalances: no accounts returned');
        }

        for (const item of accounts) {
          if (stopped) break;
          const name = buildName(item);
          const balance = parseBalance(item.balance);
          const updatedAt = item.updatedAt ? new Date(item.updatedAt) : new Date();

          await db.withTransaction('main', async (client) => {
            await client.query(
              `INSERT INTO public.bankcards_balances (bank, ext_id, name, currency, balance, updated_at)
               VALUES ('ecards', $1, $2, $3, $4, $5)
               ON CONFLICT (bank, ext_id) DO UPDATE SET
                 name       = EXCLUDED.name,
                 balance    = EXCLUDED.balance,
                 currency   = EXCLUDED.currency,
                 updated_at = EXCLUDED.updated_at`,
              [item.id, name, item.currency ?? null, balance, updatedAt],
            );
          });
        }

        logger.info('EcardsBalances: cycle complete', { count: accounts.length });
      } catch (err) {
        logger.warn('EcardsBalances: polling error', err as Error);
        await recordAdapterPollingCycleError(config, 'ecards', 'ecards.balances', err);
      }

      if (!stopped) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }
  };

  void loop();

  return {
    async stop() {
      stopped = true;
    },
  };
}
