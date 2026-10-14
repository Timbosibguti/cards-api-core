import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../../config/index.js';
import { getDatabaseService } from '../../infra/index.js';
import { logger } from '../../infra/logger.js';

type ImportStatusResponse =
  | { success: false; error: string }
  | {
      success: true;
      id: string;
      status: string;
      created_at: string;
      started_at?: string | null;
      finished_at?: string | null;
      error?: string | null;
    };

type StatementImportParsedRowJson = {
  id: string;
  row_index: number;
  parsed: unknown;
  enriched: unknown;
  bank_transactions_applied: boolean;
  bank_transactions_applied_at: string | null;
  created_at: string;
};

type LatestStatementImportResponse =
  | { success: false; error: string }
  | {
      success: true;
      job: {
        id: string;
        file_name: string;
        file_type: string | null;
        file_size: number | null;
        status: string;
        created_at: string;
        started_at: string | null;
        finished_at: string | null;
        error: string | null;
        correlation_id: string | null;
        idempotency_key: string | null;
      } | null;
      parsed_rows: StatementImportParsedRowJson[];
    };

export async function registerStatementsRoutes(server: FastifyInstance): Promise<void> {
  const config = getConfig();
  const db = getDatabaseService(config);

  await server.register(multipart);

  // POST /statements/import — приём файла, постановка job в очередь
  server.post('/statements/import', async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKey = (request.headers['api-key'] as string) ?? '';
    if (apiKey !== config.queueApi.apiKey) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }
    
    const mpReq = request as any;
    const file = await mpReq.file();
    if (!file) {
      return reply.status(400).send({ success: false, error: 'File is required (field name: file)' });
    }

    const buffer: Buffer = await file.toBuffer();
    const fileName: string = file.filename ?? 'statement';
    const fileType: string | undefined = file.mimetype;

    const jobId = randomUUID();

    try {
      await db.withTransaction('main', async (client) => {
        await client.query(
          `INSERT INTO public.statement_import_jobs (id, file_name, file_type, file_size, file_contents, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')`,
          [jobId, fileName, fileType ?? null, buffer.length, buffer],
        );
      });

      logger.info('Statement import job created', { jobId, fileName, fileType, fileSize: buffer.length });

      return reply.status(202).send({
        success: true,
        id: jobId,
        status: 'accepted',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to enqueue statement import job', { error: msg });
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });


  server.get('/statements/latest', async (_request: FastifyRequest, reply: FastifyReply) => {
    const apiKey = (_request.headers['api-key'] as string) ?? '';
    if (apiKey !== config.queueApi.apiKey) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' } satisfies LatestStatementImportResponse);
    }

    try {
      const row = await db.withTransaction('main', async (client) => {
        const r = await client.query<{
          id: string;
          file_name: string;
          file_type: string | null;
          file_size: string | null;
          status: string;
          created_at: Date;
          started_at: Date | null;
          finished_at: Date | null;
          error: string | null;
          correlation_id: string | null;
          idempotency_key: string | null;
          parsed_rows: StatementImportParsedRowJson[] | null;
        }>(
          `WITH latest AS (
             SELECT id, file_name, file_type, file_size, status, created_at, started_at, finished_at,
                    error, correlation_id, idempotency_key
             FROM public.statement_import_jobs
             ORDER BY created_at DESC
             LIMIT 1
           )
           SELECT l.id,
                  l.file_name,
                  l.file_type,
                  l.file_size,
                  l.status,
                  l.created_at,
                  l.started_at,
                  l.finished_at,
                  l.error,
                  l.correlation_id,
                  l.idempotency_key,
                  COALESCE(
                    (
                      SELECT json_agg(
                        json_build_object(
                          'id', pr.id,
                          'row_index', pr.row_index,
                          'parsed', pr.parsed,
                          'enriched', pr.enriched,
                          'bank_transactions_applied', pr.bank_transactions_applied,
                          'bank_transactions_applied_at', pr.bank_transactions_applied_at,
                          'created_at', pr.created_at
                        )
                        ORDER BY pr.row_index
                      )
                      FROM public.statement_import_parsed_rows pr
                      WHERE pr.job_id = l.id
                    ),
                    '[]'::json
                  ) AS parsed_rows
           FROM latest l`,
        );
        return r.rows[0] ?? null;
      });

      if (!row) {
        return reply.status(200).send({
          success: true,
          job: null,
          parsed_rows: [],
        } satisfies LatestStatementImportResponse);
      }

      const fileSize =
        row.file_size != null && row.file_size !== ''
          ? Number(row.file_size)
          : null;

      return reply.status(200).send({
        success: true,
        job: {
          id: row.id,
          file_name: row.file_name,
          file_type: row.file_type,
          file_size: Number.isFinite(fileSize as number) ? (fileSize as number) : null,
          status: row.status,
          created_at: row.created_at.toISOString(),
          started_at: row.started_at ? row.started_at.toISOString() : null,
          finished_at: row.finished_at ? row.finished_at.toISOString() : null,
          error: row.error,
          correlation_id: row.correlation_id,
          idempotency_key: row.idempotency_key,
        },
        parsed_rows: (row.parsed_rows ?? []).map((pr) => ({
          ...pr,
          created_at:
            typeof pr.created_at === 'string'
              ? pr.created_at
              : new Date(pr.created_at as unknown as Date).toISOString(),
          bank_transactions_applied_at:
            pr.bank_transactions_applied_at == null
              ? null
              : typeof pr.bank_transactions_applied_at === 'string'
                ? pr.bank_transactions_applied_at
                : new Date(pr.bank_transactions_applied_at as unknown as Date).toISOString(),
        })),
      } satisfies LatestStatementImportResponse);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to get latest statement import', { error: msg });
      return reply
        .status(500)
        .send({ success: false, error: 'Internal server error' } satisfies LatestStatementImportResponse);
    }
  });

  // GET /statements/status?id=...
  server.get('/statements/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKey = (request.headers['api-key'] as string) ?? '';
    if (apiKey !== config.queueApi.apiKey) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' } satisfies ImportStatusResponse);
    }

    const query = request.query as { id?: string };
    const id = query.id;
    if (!id) {
      return reply
        .status(400)
        .send({ success: false, error: 'Query parameter id is required' } satisfies ImportStatusResponse);
    }

    try {
      const res = await db.withTransaction('main', async (client) => {
        const r = await client.query<{
          id: string;
          status: string;
          created_at: Date;
          started_at: Date | null;
          finished_at: Date | null;
          error: string | null;
        }>(
          `SELECT id, status, created_at, started_at, finished_at, error
           FROM public.statement_import_jobs
           WHERE id = $1`,
          [id],
        );
        return r.rows[0] ?? null;
      });

      if (!res) {
        return reply
          .status(404)
          .send({ success: false, error: 'Job not found' } satisfies ImportStatusResponse);
      }

      return reply.status(200).send({
        success: true,
        id: res.id,
        status: res.status,
        created_at: res.created_at.toISOString(),
        started_at: res.started_at ? res.started_at.toISOString() : null,
        finished_at: res.finished_at ? res.finished_at.toISOString() : null,
        error: res.error,
      } satisfies ImportStatusResponse);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to get statement import status', { error: msg });
      return reply.status(500).send({ success: false, error: 'Internal server error' } satisfies ImportStatusResponse);
    }
  });
}

