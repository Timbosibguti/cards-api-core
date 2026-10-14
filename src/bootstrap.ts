/**
 * Bootstrap entrypoint: загружает .env/.env.local ДО импорта остального кода,
 * чтобы logger и SeqTransport видели все переменные окружения.
 */

import dotenv from 'dotenv';

// Порядок важен: .env.local перекрывает .env
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

// После загрузки env импортируем основной entrypoint
await import('./index.js');

