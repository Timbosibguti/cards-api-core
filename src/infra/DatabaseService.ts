/**
 * Синглтон доступа к БД (finance, farm, sync).
 * Все запросы к БД идут через этот сервис.
 * Транзакции — через withTransaction('main' | 'farm' | 'sync', callback).
 */

import { Pool, type PoolClient } from 'pg';
import type { AppConfig, DatabaseConfig, FarmDatabaseConfig } from '../config/index.js';

export type PoolName = 'main' | 'farm' | 'sync';

export interface DatabaseService {
  /**
   * Выполнить callback в транзакции указанного пула.
   * Внутри callback запрещено самостоятельно вызывать BEGIN/COMMIT/ROLLBACK.
   */
  withTransaction<T>(pool: PoolName, fn: (client: PoolClient) => Promise<T>): Promise<T>;

  /**
   * Получить pg.Pool по имени (ленивая инициализация).
   * Обычно модулям достаточно withTransaction, но при необходимости
   * можно использовать pool.query для простых операций.
   */
  getPool(pool: PoolName): Promise<Pool>;

  /**
   * Выдать PoolClient без оборачивания в транзакцию.
   * Ответственность за client.release() лежит на вызывающем коде.
   */
  getClient(pool: PoolName): Promise<PoolClient>;

  /** Graceful shutdown: закрыть все пулы. */
  shutdown(): Promise<void>;
}

let instance: DatabaseService | null = null;

function quoteIdent(value: string): string {
  // Простейшее экранирование для идентификаторов (schema), "" → """, остальное без изменений.
  return `"${value.replace(/"/g, '""')}"`;
}

function createPool(name: PoolName, config: AppConfig): { pool: Pool; dbConfig: DatabaseConfig | FarmDatabaseConfig } {
  let dbConfig: DatabaseConfig | FarmDatabaseConfig | undefined;

  if (name === 'main') {
    dbConfig = config.database;
  } else if (name === 'farm') {
    dbConfig = config.farmDatabase;
  } else {
    dbConfig = config.syncDatabase;
  }

  if (!dbConfig) {
    throw new Error(`Database config for pool "${name}" is not defined`);
  }

  const isLocalHost =
    dbConfig.host === 'localhost' ||
    dbConfig.host === '127.0.0.1' ||
    dbConfig.host === '::1';

  const pool = new Pool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    // В проде/удалённых кластерах Postgres требует TLS; в локальной разработке — нет.
    // Для хостов, отличных от localhost, включаем SSL по аналогии с mqtt_ecards_transactions.
    ssl: isLocalHost ? undefined : { rejectUnauthorized: false },
  });

  return { pool, dbConfig };
}

function createDatabaseService(config: AppConfig): DatabaseService {
  const pools: Partial<Record<PoolName, Pool>> = {};
  const poolConfigs: Partial<Record<PoolName, DatabaseConfig | FarmDatabaseConfig>> = {};

  async function getOrCreatePool(name: PoolName): Promise<Pool> {
    if (pools[name]) return pools[name] as Pool;
    const { pool, dbConfig } = createPool(name, config);
    pools[name] = pool;
    poolConfigs[name] = dbConfig;
    return pool;
  }

  async function prepareClientSchema(client: PoolClient, name: PoolName): Promise<void> {
    const dbConfig = poolConfigs[name];
    const schema = dbConfig?.schema;
    if (!schema) return;
    await client.query(`SET search_path TO ${quoteIdent(schema)}, public`);
  }

  return {
    async withTransaction<T>(name: PoolName, fn: (client: PoolClient) => Promise<T>): Promise<T> {
      const pool = await getOrCreatePool(name);
      const client = await pool.connect();
      try {
        await prepareClientSchema(client, name);
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback error
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async getPool(name: PoolName): Promise<Pool> {
      return getOrCreatePool(name);
    },

    async getClient(name: PoolName): Promise<PoolClient> {
      const pool = await getOrCreatePool(name);
      const client = await pool.connect();
      await prepareClientSchema(client, name);
      return client;
    },

    async shutdown(): Promise<void> {
      const values = Object.values(pools) as Pool[];
      await Promise.all(values.map((p) => p.end()));
    },
  };
}

/**
 * Возвращает синглтон DatabaseService.
 * Инициализация при первом вызове (config должен быть уже загружен).
 */
export function getDatabaseService(config: AppConfig): DatabaseService {
  if (!instance) {
    instance = createDatabaseService(config);
  }
  return instance;
}

export function resetDatabaseService(): void {
  instance = null;
}

// Для обратной совместимости: TransactionClient = PoolClient.
export type TransactionClient = PoolClient;
