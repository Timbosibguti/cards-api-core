import type { FastifyInstance } from 'fastify';
import { createHash, randomInt } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { getDatabaseService, enqueueOutgoingNotification } from '../../infra/index.js';
import { getConfig } from '../../config/index.js';
import { createCorrelationId } from '../../infra/correlation/index.js';
import { logger } from '../../infra/logger.js';
import { getCurrentUserByProfileName } from '../../infra/farmDb.js';

function stableJson(value: unknown): string {
  // Упрощённая стабильная сериализация для дедупа.
  // Если упорядочивание ключей критично — можно заменить на библиотеку глубокого сортирования.
  try {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return JSON.stringify(value);
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return JSON.stringify(sorted);
  } catch {
    return JSON.stringify(value);
  }
}

function extractSummary(body: any): string {
  const accountId = body?.accountId ?? '';
  const profileName = body?.profile_name ?? '';
  const version = body?.version ?? '';
  const currencyCode = body?.currencyCode ?? '';
  const created_at = body?.created_at ?? null;
  const today = body?.stats?.today ?? {};
  const cost = today?.cost ?? null;
  const costUsd = today?.costUsd ?? null;
  const clicks = today?.clicks ?? null;
  const impressions = today?.impressions ?? null;
  const ctrPct = today?.ctrPct ?? null;

  const lines: string[] = [];
  lines.push('Google Ads account report');
  if (profileName) lines.push(`profile_name: ${profileName}`);
  if (accountId) lines.push(`accountId: ${accountId}`);
  if (version) lines.push(`version: ${version}`);
  if (currencyCode) lines.push(`currencyCode: ${currencyCode}`);
  if (cost !== null) lines.push(`today.cost: ${cost}`);
  if (costUsd !== null) lines.push(`today.costUsd: ${costUsd}`);
  if (clicks !== null) lines.push(`today.clicks: ${clicks}`);
  if (impressions !== null) lines.push(`today.impressions: ${impressions}`);
  if (ctrPct !== null) lines.push(`today.ctrPct: ${ctrPct}`);
  if (created_at !== null) lines.push(`created_at: ${created_at}`);

  // budget / moderation опциональны
  if (body?.budget?.text) lines.push(`budget: ${String(body.budget.text)}`);
  if (body?.moderation?.summary) lines.push(`moderation: ${String(body.moderation.summary)}`);

  return lines.join('\n') + '\n' + JSON.stringify(body);
}

interface GoogleAccountPostBody {
  accountId?: string;
  profile_name?: string;
  created_at?: string;
  version?: string;
  [key: string]: unknown;
}

interface GoogleAccountSetBody {
  account_id?: string;
  profile_name?: string;
}

const GOOGLE_ACCOUNT_HUB_DOMAINS = [
  'muggtech.digital',
  'againstcoreco.digital',
  'peckishspace.digital',
  'konomihuworks.digital',
  'geminicore.digital',
  'wrimplebase.digital',
  'calcsparhub.digital',
  'kreistagcloud.digital',
  'capmanworks.digital',
  'jellifylayerio.digital',
] as const;

async function buildGoogleAccountScript(profileName?: string, profileId?: string): Promise<string> {
  const scriptPath = await resolveGoogleAccountScriptPath();
  const source = await readFile(scriptPath, 'utf8');
  const createdAt = new Date().toISOString();
  const profileNameValue = typeof profileName === 'string' ? profileName : '';
  const profileIdValue = typeof profileId === 'string' ? profileId : '';
  const randomDomain = GOOGLE_ACCOUNT_HUB_DOMAINS[randomInt(0, GOOGLE_ACCOUNT_HUB_DOMAINS.length)];
  const hubUrl = `https://${randomDomain}/`;

  const globalsPreamble =
    `var global_profile_name = ${JSON.stringify(profileNameValue)};\n` +
    `var global_profile_id = ${JSON.stringify(profileIdValue)};\n`;

  let patchedSource = globalsPreamble + source;
  const beforeCreatedAtPatch = patchedSource;
  patchedSource = patchedSource.replace(/created_at:\s*''/, `created_at: '${createdAt}'`);
  if (patchedSource === beforeCreatedAtPatch) {
    throw new Error('created_at placeholder not found in google-account-index.js');
  }
  patchedSource = patchedSource.replace(
    /var\s+hubUrl\s*=\s*['"][^'"]*['"]\s*;/,
    `var hubUrl = ${JSON.stringify(hubUrl)};`,
  );
  // Backward compatibility: старые версии шаблона использовали profile_name: ''.
  patchedSource = patchedSource.replace(/profile_name:\s*''/, 'profile_name: global_profile_name');
  const seed = randomInt(1, 2_147_483_647);
  const obfuscated = JavaScriptObfuscator.obfuscate(patchedSource, {
    seed,
    compact: true,
    simplify: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.2,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'mangled-shuffled',
    numbersToExpressions: true,
    splitStrings: true,
    splitStringsChunkLength: 6,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 0.7,
    stringArrayEncoding: ['base64'],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 2,
    stringArrayWrappersType: 'variable',
    stringArrayThreshold: 0.8,
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
  });

  return obfuscated.getObfuscatedCode();
}

async function resolveGoogleAccountScriptPath(): Promise<string> {
  const routeDir = dirname(fileURLToPath(import.meta.url));
  // Docker runtime: /app/dist/api/routes/google.js -> /app/google-account-index.js
  const dockerBuildPath = resolve(routeDir, '../../../google-account-index.js');
  try {
    await access(dockerBuildPath);
    return dockerBuildPath;
  } catch {
    // Local tsx runtime: /app/src/api/routes/google.ts -> /app/google-account-index.js
  }

  const localDevPath = resolve(routeDir, '../../../../google-account-index.js');
  try {
    await access(localDevPath);
    return localDevPath;
  } catch {
    throw new Error(`google-account-index.js not found at expected paths: ${dockerBuildPath}, ${localDevPath}`);
  }
}

export async function registerGoogleRoutes(server: FastifyInstance): Promise<void> {
  server.get<{
    Querystring: {
      profile_name?: string;
    };
  }>('/google/account', async (request, reply) => {
    logger.warn('[GOOGLE_ACCOUNT] GET /google/account, profile_name: ' + (request.query?.profile_name ?? ''));

    try {
      const profileName = request.query?.profile_name;
      let profileId: string | undefined;
      if (typeof profileName === 'string' && profileName.trim().length > 0) {
        const db = getDatabaseService(getConfig());
        profileId = await db.withTransaction('farm', async (farmClient) => {
          const row = await farmClient.query<{ id: string | number }>(
            `SELECT id FROM tbl_profiles WHERE name = $1 LIMIT 1`,
            [profileName.trim()],
          );
          const id = row.rows[0]?.id;
          return id != null ? String(id) : undefined;
        });
      }
      const script = await buildGoogleAccountScript(profileName, profileId);
      return reply
        .header('content-type', 'application/javascript; charset=utf-8')
        .send(script);
    } catch (err) {
      logger.error('GET /google/account script build failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return reply.code(500).send({ ok: false, error: 'script build failed' });
    }
  });

  server.post<{
    Body: unknown;
  }>('/google/account', async (request, reply) => {
    const body = request.body;
    const profileNameForLog =
      body && typeof body === 'object' && 'profile_name' in body && typeof body.profile_name === 'string'
        ? body.profile_name
        : '';
    logger.warn('[GOOGLE_ACCOUNT] POST /google/account, profile_name: ' + profileNameForLog, { body });

    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ ok: false, error: 'JSON body is required' });
    }

    const config = getConfig();
    const db = getDatabaseService(config);
    const correlationId = createCorrelationId();
    const payload = body as GoogleAccountPostBody;
    const profileName = typeof payload.profile_name === 'string' ? payload.profile_name.trim() : '';
    const accountId = typeof payload.accountId === 'string' ? payload.accountId.trim() : '';
    const createdAt = typeof payload.created_at === 'string' ? payload.created_at.trim() : '';
    const version = typeof payload.version === 'string' ? payload.version.trim() : '';

    const message = extractSummary(body);
    const hash = createHash('sha256').update(stableJson(body), 'utf8').digest('hex');
    const dedupKey = `google:account:${hash}`;
    let firstInstallMessage: string | null = null;
    let firstInstallFinanceMessage: string | null = null;
    let firstInstallOwnerEmail: string | null = null;

    await db.withTransaction('main', async (client) => {
      const accountIdForLog = accountId || null;
      const profileNameForLog = profileName || null;
      await client.query(
        `INSERT INTO public.google_account_logs (created_at, account_id, profile_name, payload)
         VALUES (NOW(), $1, $2, $3::jsonb)`,
        [accountIdForLog, profileNameForLog, JSON.stringify(body)],
      );
    });
    
    try {
      if (profileName && accountId) {
        const firstInstallResult = await db.withTransaction('farm', async (farmClient) => {
          const currentProfile = await farmClient.query<{ account_id: string | null }>(
            `SELECT account_id FROM tbl_profiles WHERE name = $1 LIMIT 1`,
            [profileName],
          );

          if (currentProfile.rowCount === 0) {
            logger.warn('POST /google/account profile not found in farm_ext.tbl_profiles', { profile_name: profileName });
            return { firstInstall: false, ownerEmail: null as string | null };
          }

          const previousAccountId = currentProfile.rows[0]?.account_id ?? null;
          await farmClient.query(`UPDATE tbl_profiles SET account_id = $1, script_version = $2 WHERE name = $3`, [accountId, version, profileName]);

          const isFirstInstall = !previousAccountId;
          if (!isFirstInstall) {
            return { firstInstall: false, ownerEmail: null as string | null };
          }

          const owner = await getCurrentUserByProfileName(farmClient, profileName);
          return { firstInstall: true, ownerEmail: owner?.email ?? null };
        });

        if (firstInstallResult.firstInstall) {
          const installText = `Google-скрипт версии ${version || 'unknown'} от ${createdAt || 'unknown'} установлен на ${profileName} для ${accountId}`;
          const ownerEmail = firstInstallResult.ownerEmail || 'owner-not-found';
          firstInstallMessage = installText;
          firstInstallFinanceMessage = `${installText}\nВладелец профиля: ${ownerEmail}`;
          firstInstallOwnerEmail = firstInstallResult.ownerEmail ?? null;
        }
      }

      await db.withTransaction('main', async (client) => {
        await enqueueOutgoingNotification(client, {
          channel: 'slack:#finance-otp',
          recipient: null,
          payload: { message },
          dedupKey,
          correlationId,
        });

        if (firstInstallMessage) {
          if (firstInstallOwnerEmail) {
            await enqueueOutgoingNotification(client, {
              channel: 'slack:dm',
              recipient: firstInstallOwnerEmail,
              payload: { message: firstInstallMessage },
              dedupKey: `google:account:installed:dm:${profileName}:${accountId}`,
              correlationId,
            });
          } else {
            logger.warn('POST /google/account first install: owner email not found for DM', {
              profile_name: profileName,
              account_id: accountId,
            });
          }

          await enqueueOutgoingNotification(client, {
            channel: 'slack:#finance-otp',
            recipient: null,
            payload: { message: firstInstallFinanceMessage },
            dedupKey: `google:account:installed:finance:${profileName}:${accountId}`,
            correlationId,
          });
        }
      });
    } catch (err) {
      logger.error('POST /google/account enqueue failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return reply.code(200).send({ ok: false, error: 'enqueue failed' });
    }

    return reply.code(202).send({ ok: true });
  });

  server.post<{
    Body: GoogleAccountSetBody;
  }>('/google/account/set', async (request, reply) => {
    const body = request.body ?? {};
    const profileName = typeof body.profile_name === 'string' ? body.profile_name.trim() : '';
    const accountId = typeof body.account_id === 'string' ? body.account_id.trim() : '';

    logger.warn('[GOOGLE_ACCOUNT] POST /google/account/set', {
      profile_name: profileName,
      account_id: accountId,
    });

    if (!profileName) {
      return reply.code(400).send({ ok: false, error: 'profile_name is required' });
    }
    if (!accountId) {
      return reply.code(400).send({ ok: false, error: 'account_id is required' });
    }
    if (!/^\d{3}-\d{3}-\d{4}$/.test(accountId)) {
      return reply.code(400).send({ ok: false, error: 'account_id must match XXX-XXX-XXXX' });
    }

    const db = getDatabaseService(getConfig());

    try {
      await db.withTransaction('farm', async (farmClient) => {
        await farmClient.query<{ account_id: string | null }>(
          `UPDATE tbl_profiles
           SET account_id = $1
           WHERE account_id IS NULL
             AND name = $2
           RETURNING account_id`,
          [accountId, profileName],
        );
      });
      return reply.code(200).send({ ok: true, updated: true, profile_name: profileName, account_id: accountId });
    } catch (err) {
      logger.error('POST /google/account/set failed', {
        error: err instanceof Error ? err.message : String(err),
        profile_name: profileName,
        account_id: accountId,
      });
      return reply.code(500).send({ ok: false, error: 'internal_error' });
    }
  });
}

