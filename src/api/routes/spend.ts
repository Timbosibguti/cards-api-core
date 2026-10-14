import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getConfig } from '../../config/index.js';
import { getDatabaseService } from '../../infra/index.js';
import { getCurrentUserByProfileName } from '../../infra/farmDb.js';
import { logger } from '../../infra/logger.js';

type SpendStrategyId =
  | 'bank_cards'
  | 'bank_cards_history'
  | 'bank_cards_shown'
  | 'funds_from_account';

type EvidenceItem = {
  strategy: SpendStrategyId;
  summary: string;
  details?: Record<string, unknown>;
};

type Candidate = {
  email: string;
  score: number;
  reasons: string[];
  evidence: EvidenceItem[];
};

function normalizeDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function safeTrim(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t : null;
}

function addCandidate(
  map: Map<string, Candidate>,
  email: string,
  scoreDelta: number,
  reason: string,
  evidence: EvidenceItem,
): void {
  const key = email.toLowerCase();
  const existing = map.get(key);
  if (!existing) {
    map.set(key, { email, score: scoreDelta, reasons: [reason], evidence: [evidence] });
    return;
  }
  existing.score += scoreDelta;
  existing.reasons.push(reason);
  existing.evidence.push(evidence);
}

export async function registerSpendRoutes(server: FastifyInstance): Promise<void> {
  server.get<{
    Querystring: { card_number?: string; occurred_at?: string; account_id?: string };
  }>('/spend', async (request: FastifyRequest<{ Querystring: { card_number?: string; occurred_at?: string; account_id?: string } }>, reply: FastifyReply) => {
    const q = request.query ?? {};
    const card = typeof q.card_number === 'string' ? q.card_number : '';
    const occurredAt = typeof q.occurred_at === 'string' ? q.occurred_at : '';
    const accountId = typeof q.account_id === 'string' ? q.account_id : '';

    const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>/spend</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "Noto Sans", "Liberation Sans", sans-serif; margin: 24px; }
    .wrap { max-width: 980px; margin: 0 auto; }
    h1 { font-size: 20px; margin: 0 0 12px; }
    form { display: grid; gap: 12px; padding: 16px; border: 1px solid rgba(127,127,127,.35); border-radius: 10px; }
    label { display: grid; gap: 6px; font-size: 13px; }
    input { padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(127,127,127,.45); font-size: 14px; }
    button { padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(127,127,127,.45); font-size: 14px; cursor: pointer; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .row > * { min-width: 0; }
    .muted { opacity: .75; font-size: 12px; }
    pre { white-space: pre-wrap; word-break: break-word; padding: 16px; border-radius: 10px; border: 1px solid rgba(127,127,127,.35); }
    .card { border: 1px solid rgba(127,127,127,.35); border-radius: 10px; padding: 14px; margin-top: 14px; }
    .kpi { font-size: 14px; margin: 4px 0; }
    .list { margin: 8px 0 0 18px; }
    .list li { margin: 4px 0; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .err { color: #b00020; }
    .ok { color: #137333; }
    @media (max-width: 780px) { .row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Spend lookup</h1>
    <form id="f">
      <div class="row">
        <label>
          card_number
          <input id="card" name="card_number" value="${escapeHtml(card)}" placeholder="4288420033389425 или ****1234" />
        </label>
        <label>
          occurred_at (ISO, UTC)
          <input id="dt" name="occurred_at" value="${escapeHtml(occurredAt)}" placeholder="2026-03-26T12:47:16.170Z" />
        </label>
      </div>
      <label>
        account_id (optional, Google Ads)
        <input id="acc" name="account_id" value="${escapeHtml(accountId)}" placeholder="833-315-4978" />
      </label>
      <button type="submit">POST /spend</button>
      <div id="status" class="muted"></div>
    </form>

    <h2 style="font-size:16px; margin:16px 0 8px;">Отчёт</h2>
    <div id="report" class="card muted">Нет данных. Заполните форму и нажмите POST /spend.</div>

    <h2 style="font-size:16px; margin:16px 0 8px;">Response (raw)</h2>
    <pre id="out">{}</pre>
  </div>

  <script>
    function qs(id){ return document.getElementById(id); }
    function val(id){ return (qs(id).value || '').trim(); }
    function setStatus(text, cls){
      const el = qs('status');
      el.className = cls ? cls : 'muted';
      el.textContent = text;
    }
    function buildBody(){
      const body = { card_number: val('card'), occurred_at: val('dt') };
      const accountId = val('acc');
      if (accountId) body.account_id = accountId;
      return body;
    }
    function esc(v){
      return String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    }
    function renderReport(data){
      const root = qs('report');
      if (!data || typeof data !== 'object'){
        root.className = 'card err';
        root.textContent = 'Некорректный ответ сервера';
        return;
      }
      if (data.ok === false){
        root.className = 'card err';
        root.innerHTML = '<div><b>Ошибка</b></div><div class="mono">' + esc(data.error || 'Unknown error') + '</div>';
        return;
      }
      const best = data.best_guess || null;
      const candidates = Array.isArray(data.candidates) ? data.candidates : [];
      const strategies = Array.isArray(data.strategies) ? data.strategies : [];
      const warnings = Array.isArray(data.warnings) ? data.warnings : [];

      const candidatesHtml = candidates.length
        ? '<ol class="list">' + candidates.map((c) => {
            const reasons = Array.isArray(c.reasons) ? c.reasons : [];
            return '<li><div><b>' + esc(c.email) + '</b> — score: <span class="mono">' + esc(c.score) + '</span></div>'
              + (reasons.length ? '<div class="muted">Причины: ' + esc(reasons.join(' | ')) + '</div>' : '')
              + '</li>';
          }).join('') + '</ol>'
        : '<div class="muted">Кандидаты не найдены</div>';

      const strategiesHtml = strategies.length
        ? '<ul class="list">' + strategies.map((s) =>
            '<li><span class="mono">' + esc(s.id) + '</span>: '
              + (s.ok ? '<span class="ok">ok</span>' : '<span class="err">failed</span>')
              + (s.note ? ' — ' + esc(s.note) : '') + '</li>'
          ).join('') + '</ul>'
        : '<div class="muted">Стратегии не вернулись</div>';

      const warningsHtml = warnings.length
        ? '<ul class="list">' + warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul>'
        : '<div class="muted">Нет предупреждений</div>';

      root.className = 'card';
      root.innerHTML = ''
        + '<div class="kpi"><b>Best guess:</b> '
        + (best ? '<span class="mono">' + esc(best.email) + '</span> (score: <span class="mono">' + esc(best.score) + '</span>)' : '—')
        + '</div>'
        + '<div class="kpi"><b>Кандидаты:</b></div>' + candidatesHtml
        + '<div class="kpi"><b>Стратегии:</b></div>' + strategiesHtml
        + '<div class="kpi"><b>Warnings:</b></div>' + warningsHtml;
    }
    async function run(){
      const body = buildBody();
      setStatus('Requesting...', 'muted');
      qs('out').textContent = '';
      try{
        const r = await fetch('/spend', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        qs('out').textContent = json ? JSON.stringify(json, null, 2) : text;
        if (json) renderReport(json);
        setStatus(r.ok ? 'OK' : ('HTTP ' + r.status), r.ok ? 'ok' : 'err');
      } catch(e){
        qs('out').textContent = String(e && e.message ? e.message : e);
        qs('report').className = 'card err';
        qs('report').textContent = String(e && e.message ? e.message : e);
        setStatus('Request failed', 'err');
      }
    }
    qs('f').addEventListener('submit', (e) => { e.preventDefault(); run(); });
  </script>
</body>
</html>`;

    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .send(html);
  });

  server.post<{
    Body: unknown;
  }>('/spend', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
    const body = request.body;
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ ok: false, error: 'JSON body is required' });
    }

    const cardRaw = safeTrim((body as { card_number?: unknown }).card_number);
    const occurredAtRaw = safeTrim((body as { occurred_at?: unknown }).occurred_at);
    const accountIdRaw = safeTrim((body as { account_id?: unknown }).account_id);

    if (!cardRaw) {
      return reply.status(400).send({ ok: false, error: 'card_number is required' });
    }
    if (!occurredAtRaw) {
      return reply.status(400).send({ ok: false, error: 'occurred_at is required (ISO timestamp)' });
    }

    const cardDigits = normalizeDigits(cardRaw);
    if (cardDigits.length < 4) {
      return reply.status(400).send({ ok: false, error: 'card_number must contain at least 4 digits' });
    }

    const occurredAt = new Date(occurredAtRaw);
    if (Number.isNaN(occurredAt.getTime())) {
      return reply.status(400).send({ ok: false, error: 'occurred_at must be a valid ISO timestamp' });
    }

    const config = getConfig();
    const db = getDatabaseService(config);

    const candidates = new Map<string, Candidate>();
    const strategies: Array<{ id: SpendStrategyId; ok: boolean; note?: string }> = [];
    const warnings: string[] = [];

    const isLikelyFullPan = cardDigits.length >= 12;
    const last4 = cardDigits.slice(-4);

    // --- absolute strategy: finance0_ext.funds_from_account (sync DB) + farm ownership resolution ---
    let fundsResolved = false;
    if (accountIdRaw) {
      if (!config.syncDatabase) {
        strategies.push({ id: 'funds_from_account', ok: false, note: 'syncDatabase is not configured' });
        warnings.push('account_id provided, but syncDatabase is not configured; funds_from_account strategy skipped');
      } else {
        const syncClient = await db.getClient('sync');
        const farmClient = await db.getClient('farm');
        try {
          const funds = await syncClient.query<{ profile_name: string | null }>(
            `SELECT profile_name
             FROM finance0_ext.funds_from_account
             WHERE account_id = $1
             LIMIT 20`,
            [accountIdRaw],
          );
          strategies.push({ id: 'funds_from_account', ok: true, note: `matched_rows=${funds.rows.length}` });
          for (const r of funds.rows) {
            const profileName = r.profile_name ? String(r.profile_name).trim() : '';
            if (!profileName) continue;
            const current = await getCurrentUserByProfileName(farmClient, profileName);
            if (current?.email) {
              fundsResolved = true;
              addCandidate(
                candidates,
                current.email,
                100,
                `funds_from_account (absolute match): account_id=${accountIdRaw} -> profile_name=${profileName} -> owner_email=${current.email}`,
                {
                  strategy: 'funds_from_account',
                  summary: 'Resolved owner via finance0_ext.funds_from_account → farm profile owner',
                  details: {
                    account_id: accountIdRaw,
                    profile_name: profileName,
                    owner: current,
                  },
                },
              );
            } else {
              warnings.push(`account_id matched profile_name=${profileName}, but owner email was not resolved from farm DB`);
            }
          }
        } catch (err) {
          strategies.push({ id: 'funds_from_account', ok: false, note: err instanceof Error ? err.message : String(err) });
        } finally {
          syncClient.release();
          farmClient.release();
        }
      }
    } else {
      strategies.push({ id: 'funds_from_account', ok: true, note: 'skipped (account_id not provided)' });
    }

    // If funds_from_account resolved owner, this is a definitive result.
    if (!fundsResolved) {
      const farmClient = await db.getClient('farm');
      try {
        await db.withTransaction('main', async (client) => {
          // bank_cards
          try {
            const cardsRows = isLikelyFullPan
              ? await client.query<{
                  bank: string;
                  card_number: string;
                  buyer: string | null;
                  profile_name: string | null;
                  acc_no: string | null;
                  ext_id: string | null;
                  created_at: Date | null;
                  updated_at: Date | null;
                }>(
                  `SELECT bank,
                          card_number::text AS card_number,
                          buyer,
                          profile_name,
                          acc_no,
                          ext_id,
                          created_at,
                          updated_at
                   FROM public.bank_cards
                   WHERE card_number = $1::bigint
                   ORDER BY created_at DESC NULLS LAST
                   LIMIT 20`,
                  [cardDigits],
                )
              : await client.query<{
                  bank: string;
                  card_number: string;
                  buyer: string | null;
                  profile_name: string | null;
                  acc_no: string | null;
                  ext_id: string | null;
                  created_at: Date | null;
                  updated_at: Date | null;
                }>(
                  `SELECT bank,
                          card_number::text AS card_number,
                          buyer,
                          profile_name,
                          acc_no,
                          ext_id,
                          created_at,
                          updated_at
                   FROM public.bank_cards
                   WHERE right(card_number::text, 4) = $1
                   ORDER BY created_at DESC NULLS LAST
                   LIMIT 50`,
                  [last4],
                );

            const rows = cardsRows.rows;
            strategies.push({
              id: 'bank_cards',
              ok: true,
              note: `matched_rows=${rows.length}${isLikelyFullPan ? '' : ' (last4 match)'}`,
            });
            if (!isLikelyFullPan && rows.length > 1) {
              warnings.push(`card_number matched by last4=${last4}; ${rows.length} possible cards found`);
            }
            for (const r of rows) {
              if (r.buyer) {
                addCandidate(
                  candidates,
                  r.buyer,
                  80,
                  `bank_cards: buyer=${r.buyer}`,
                  {
                    strategy: 'bank_cards',
                    summary: `Found buyer in bank_cards for bank=${r.bank}`,
                    details: r,
                  },
                );
              }
            }
          } catch (err) {
            strategies.push({ id: 'bank_cards', ok: false, note: err instanceof Error ? err.message : String(err) });
          }

          // bank_cards_history
          try {
            if (isLikelyFullPan) {
              const hist = await client.query<{
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
                [cardDigits, occurredAt.toISOString()],
              );
              strategies.push({ id: 'bank_cards_history', ok: true, note: `matched_rows=${hist.rows.length}` });
              for (const r of hist.rows) {
                if (r.buyer_email) {
                  addCandidate(
                    candidates,
                    r.buyer_email,
                    100,
                    `bank_cards_history: buyer_email=${r.buyer_email} (owner at occurred_at)`,
                    {
                      strategy: 'bank_cards_history',
                      summary: 'Owner resolved via bank_cards_history interval at occurred_at',
                      details: { ...r, occurred_at: occurredAt.toISOString() },
                    },
                  );
                }
              }
            } else {
              strategies.push({ id: 'bank_cards_history', ok: true, note: 'skipped (needs full card_number digits)' });
            }
          } catch (err) {
            strategies.push({ id: 'bank_cards_history', ok: false, note: err instanceof Error ? err.message : String(err) });
          }

          // bank_cards_shown (resolve owner via profile_name)
          try {
            if (isLikelyFullPan) {
              const shown = await client.query<{
                email: string | null;
                profile_name: string | null;
                created_at: Date;
              }>(
                `SELECT email, profile_name, created_at
                 FROM public.bank_cards_shown
                 WHERE card_number = $1::bigint
                   AND created_at <= $2::timestamptz
                 ORDER BY created_at DESC
                 LIMIT 20`,
                [cardDigits, occurredAt.toISOString()],
              );
              strategies.push({ id: 'bank_cards_shown', ok: true, note: `matched_rows=${shown.rows.length}` });
              for (const r of shown.rows) {
                const profileName = r.profile_name ? String(r.profile_name).trim() : '';
                if (!profileName) continue;
                const current = await getCurrentUserByProfileName(farmClient, profileName);
                if (!current?.email) continue;
                addCandidate(
                  candidates,
                  current.email,
                  40,
                  `bank_cards_shown: shown_to=${r.email ?? 'unknown'} profile_name=${profileName} -> owner_email=${current.email}`,
                  {
                    strategy: 'bank_cards_shown',
                    summary: 'Resolved owner via bank_cards_shown.profile_name',
                    details: {
                      shown_to: r.email ?? null,
                      profile_name: profileName,
                      shown_at: r.created_at,
                      owner: current,
                      occurred_at: occurredAt.toISOString(),
                    },
                  },
                );
              }
            } else {
              strategies.push({ id: 'bank_cards_shown', ok: true, note: 'skipped (needs full card_number digits)' });
            }
          } catch (err) {
            strategies.push({ id: 'bank_cards_shown', ok: false, note: err instanceof Error ? err.message : String(err) });
          }
        });
      } finally {
        farmClient.release();
      }
    } else {
      strategies.push({ id: 'bank_cards', ok: true, note: 'skipped (definitive match from funds_from_account)' });
      strategies.push({ id: 'bank_cards_history', ok: true, note: 'skipped (definitive match from funds_from_account)' });
      strategies.push({ id: 'bank_cards_shown', ok: true, note: 'skipped (definitive match from funds_from_account)' });
    }

    const list = Array.from(candidates.values()).sort((a, b) => b.score - a.score);
    const bestGuess = list.length > 0 ? { email: list[0].email, score: list[0].score } : null;

    logger.info('[SPEND] resolved candidates', {
      card_last4: last4,
      occurred_at: occurredAt.toISOString(),
      account_id: accountIdRaw ?? null,
      candidates: list.slice(0, 5).map((c) => ({ email: c.email, score: c.score })),
      strategies,
    });

    return reply.send({
      ok: true,
      input: {
        card_number: cardRaw,
        occurred_at: occurredAt.toISOString(),
        account_id: accountIdRaw ?? null,
      },
      best_guess: bestGuess,
      candidates: list,
      strategies,
      warnings,
    });
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

