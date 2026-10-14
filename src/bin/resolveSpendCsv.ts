import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { parse } from 'csv-parse/sync';
import { getConfig } from '../config/index.js';
import { getDatabaseService } from '../infra/index.js';
import { getCurrentUserByProfileName } from '../infra/farmDb.js';

dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

interface CsvRowContext {
  header: string[];
  rows: string[][];
  processedAtIdx: number;
  cardGuidIdx: number;
}

interface OwnerResolution {
  buyer: string | null;
  profileName: string | null;
  source: 'bank_cards_history' | 'bank_cards' | 'bank_cards_shown' | 'not_found';
}

function normalizeDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function parseIsoDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function escapeCsvValue(value: string): string {
  if (value.includes('"') || value.includes(',') || value.includes('\n') || value.includes('\r')) {
    const withDoubles = value.replace(/"/g, '""');
    return `"${withDoubles}"`;
  }
  return value;
}

async function resolveOwnerByCardAndTime(
  mainClient: PoolClient,
  farmClient: PoolClient,
  bank: string,
  cardNumber: string,
  occurredAt: Date,
): Promise<OwnerResolution> {
  const digits = normalizeDigits(cardNumber);
  if (!digits || digits.length < 4) {
    return { buyer: null, profileName: null, source: 'not_found' };
  }

  // 1) bank_cards_history: владельца на момент транзакции
  if (digits.length >= 12) {
    const hist = await mainClient.query<{
      buyer_email: string | null;
      profile_name: string | null;
      is_buying: boolean | null;
      valid_from: Date;
      valid_to: Date | null;
    }>(
      `SELECT buyer_email, profile_name, is_buying, valid_from, valid_to
       FROM public.bank_cards_history
       WHERE card_number = $1::bigint
         AND valid_from <= $2::timestamptz
         AND (valid_to IS NULL OR valid_to > $2::timestamptz)
       ORDER BY valid_from DESC
       LIMIT 5`,
      [digits, occurredAt.toISOString()],
    );
    for (const row of hist.rows) {
      if (row.buyer_email) {
        return { buyer: row.buyer_email, profileName: row.profile_name ?? null, source: 'bank_cards_history' };
      }
    }
  }

  // 2) bank_cards: по полному PAN
  if (digits.length >= 12) {
    const exact = await mainClient.query<{ buyer: string | null; profile_name: string | null }>(
      `SELECT buyer, profile_name
       FROM public.bank_cards
       WHERE bank = $1 AND card_number = $2::bigint
       ORDER BY created_at DESC NULLS LAST
       LIMIT 1`,
      [bank, digits],
    );
    if (exact.rows[0]) {
      return {
        buyer: exact.rows[0].buyer ?? null,
        profileName: exact.rows[0].profile_name ?? null,
        source: 'bank_cards',
      };
    }
  }

  // 3) bank_cards_shown: владелец через profile_name
  if (digits.length >= 12) {
    const shown = await mainClient.query<{ email: string | null; profile_name: string | null; created_at: Date }>(
      `SELECT email, profile_name, created_at
       FROM public.bank_cards_shown
       WHERE card_number = $1::bigint
         AND created_at <= $2::timestamptz
       ORDER BY created_at DESC
       LIMIT 20`,
      [digits, occurredAt.toISOString()],
    );

    for (const row of shown.rows) {
      const profileName = row.profile_name ? String(row.profile_name).trim() : '';
      if (!profileName) continue;
      const current = await getCurrentUserByProfileName(farmClient, profileName);
      if (current?.email) {
        return { buyer: current.email, profileName, source: 'bank_cards_shown' };
      }
    }
  }

  return { buyer: null, profileName: null, source: 'not_found' };
}

async function loadCsv(filePath: string): Promise<CsvRowContext> {
  const raw = await fs.readFile(filePath, 'utf8');
  const records = parse(raw, {
    columns: false,
    skip_empty_lines: true,
  }) as string[][];

  if (records.length === 0) {
    throw new Error('CSV file is empty');
  }

  const header = records[0];
  const processedAtIdx = header.indexOf('processed_at_utc');
  const cardGuidIdx = header.indexOf('card_guid');

  if (processedAtIdx === -1) {
    throw new Error('Header must contain processed_at_utc column');
  }
  if (cardGuidIdx === -1) {
    throw new Error('Header must contain card_guid column');
  }

  const rows = records.slice(1);
  return { header, rows, processedAtIdx, cardGuidIdx };
}

async function resolveBuyerGroups(syncClient: PoolClient, buyerEmail: string): Promise<string[]> {
  if (!buyerEmail.trim()) return [];
  const res = await syncClient.query<{ group_name: string | null }>(
    `SELECT DISTINCT g.name AS group_name
     FROM finance1_ext.employees e
     INNER JOIN finance1_ext.employee_groups eg ON e.id = eg.employee_id
     INNER JOIN finance1_ext.groups g ON eg.group_id = g.id
     WHERE e.email = $1
       AND g.name IS NOT NULL
     ORDER BY g.name`,
    [buyerEmail.trim()],
  );
  return res.rows
    .map((r) => (r.group_name ?? '').trim())
    .filter((name): name is string => name.length > 0);
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    // eslint-disable-next-line no-console
    console.error('Usage: tsx src/bin/resolveSpendCsv.ts <input.csv> [output.csv]');
    process.exitCode = 1;
    return;
  }

  const resolvedInput = path.resolve(process.cwd(), inputPath);
  const outputPathArg = process.argv[3];
  const outputPath = outputPathArg
    ? path.resolve(process.cwd(), outputPathArg)
    : resolvedInput.replace(/(\.csv)?$/i, '.resolved.csv');

  const { header, rows, processedAtIdx, cardGuidIdx } = await loadCsv(resolvedInput);

  const config = getConfig();
  const db = getDatabaseService(config);
  const mainClient = await db.getClient('main');
  const farmClient = await db.getClient('farm');
  const syncClient = config.syncDatabase ? await db.getClient('sync') : null;

  try {
    const extendedHeader = [...header, 'buyer_email', 'buyer_groups', 'profile_name', 'buyer_profile_source'];
    const outLines: string[] = [];
    outLines.push(extendedHeader.map(escapeCsvValue).join(','));

    for (const row of rows) {
      const processedAtStr = row[processedAtIdx] ?? '';
      const cardGuid = (row[cardGuidIdx] ?? '').trim();

      let buyer: string | null = null;
      let buyerGroups = '';
      let profileName: string | null = null;
      let source = 'not_found';

      const occurredAt = parseIsoDate(processedAtStr);
      if (cardGuid && occurredAt) {
        const cardRes = await mainClient.query<{ bank: string; card_number: string | null }>(
          `SELECT bank, card_number::text AS card_number
           FROM public.bank_cards
           WHERE ext_id = $1
           ORDER BY created_at DESC NULLS LAST
           LIMIT 1`,
          [cardGuid],
        );

        const cardRow = cardRes.rows[0];
        if (cardRow?.card_number) {
          const owner = await resolveOwnerByCardAndTime(
            mainClient,
            farmClient,
            cardRow.bank,
            cardRow.card_number,
            occurredAt,
          );
          buyer = owner.buyer;
          profileName = owner.profileName;
          source = owner.source;
        }
      }

      if (buyer && syncClient) {
        const groups = await resolveBuyerGroups(syncClient, buyer);
        buyerGroups = groups.join('; ');
      }

      const extendedRow = [...row, buyer ?? '', buyerGroups, profileName ?? '', source];
      outLines.push(extendedRow.map(escapeCsvValue).join(','));
    }

    await fs.writeFile(outputPath, `${outLines.join('\n')}\n`, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`Resolved CSV written to ${outputPath}`);
  } finally {
    mainClient.release();
    farmClient.release();
    if (syncClient) syncClient.release();
    await db.shutdown();
  }
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('CSV resolve failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

