# Processor-Hub — Cursor Epics Progress

Отслеживание выполнения эпиков и задач из [processor_hub_cursor_epics_tasks.md](../tasks/processor_hub_cursor_epics_tasks.md). Обновляется по мере выполнения.

**Цель:** привести реализацию в соответствие с архитектурой, доменной моделью и гарантиями надёжности.

**Рекомендуемый порядок:** Phase 1 (EPIC 1 → 2 → 3) → Phase 2 → … → Phase 5.

**Критичные пробелы и риски (честная оценка):**
- **Ownership (владение картой):** Реализованы bank_cards_history, is_buying и **setCardOwnership**; все смены владельца идут через неё, история пишется. Полная централизация в **CardOwnershipService** (запросы «кто владел в момент X», единый доменный слой) — EPIC 8 (Phase 3).
- **Outbox Worker** — реализован диспетчер по event_type и обработчик **profile_transferred_to_buyer** (setCardOwnership, аудит, Slack, removeLimits). События помечаются processed/failed.
- **MqttClient** — синглтон и reconnect есть; уровня «устойчивый internal platform module» нет: нет publish-буфера при disconnect, subscription registry, защиты от повторной регистрации, wildcard-диспетчеризации (сейчас только handlers.get(topic)). Закрытие — EPIC 6 (Phase 4).

См. [implementation_progress.md](./implementation_progress.md) § «Честная оценка готовности» и § «Домен владения картами (ownership)».

---

## Next steps — приоритеты (P0 / P1)

**P0 — без этого нельзя расширять домен.** Выполнить в первую очередь.

| # | Шаг | Связь с эпиками |
|---|-----|------------------|
| 1 | **Реально довести typecheck до зелёного состояния** | EPIC 1 — `npm run build`/typecheck проходят (06.03: исправлен тип в cards.ts get-by-bin). При появлении новых ошибок — добивать. |
| 2 | **Ввести настоящие integration tests** | EPIC 2 — test runner, окружение, тесты воркеров/очередей/ownership. |
| 3 | **Реализовать реальную Slack delivery в outgoing_notifications** | EPIC 5 — сделано: REST на slack-app (send-otp, send-to-channel), sent только после успеха. |
| 4 | **Реализовать настоящую бизнес-обработку в Outbox Worker** | EPIC 4 — сделано: диспетчер по event_type + profile_transferred_to_buyer. При необходимости добавить dead_profile_unlink и др. |
| 5 | **Собрать CardOwnershipService как единый доменный слой** | EPIC 8 — все операции владения и истории только через него. |

**P1 — сразу после P0.**

| # | Шаг | Связь с эпиками |
|---|-----|------------------|
| 1 | **Довести drafts до полного workflow** | EPIC 7 — оба типа payload, DraftService, lifecycle (pending/confirmed/expired), TTL. |
| 2 | **Укрепить MQTT-клиент до уровня platform module** | EPIC 6 — publish-буфер при disconnect, subscription registry, wildcard-диспетчеризация. |
| 3 | **Привести API validation/error handling к одному стандарту** | EPIC 10 — схемы на все роуты, централизованный маппинг ошибок, guards. |
| 4 | **Убрать дубли структуры** (statementsImport vs statements_import и подобное) | Организационный дрейф; naming governance; консолидация дублей; при необходимости — EPIC 13. |

---

## Легенда

| Статус      | Значение |
|------------|----------|
| Не начато  | Задача не взята в работу |
| В работе   | В процессе реализации |
| Готово     | Реализовано и зафиксировано (код/документация) |
| Отложено   | Приостановлено по решению |

---

## Phase 1 — Foundation

### EPIC 1 — Type Safety, Build Discipline, and Project Baseline

| Задача | Описание | Статус | Результат / ссылки |
|--------|----------|--------|---------------------|
| 1.1 | Add real TypeScript project configuration | Готово | `tsconfig.json`: strict, noUnusedLocals/Parameters, module NodeNext, outDir/rootDir. `npm run typecheck` проходит. |
| 1.2 | Normalize npm scripts (dev, build, start, typecheck, lint, test) | Готово | Скрипты в едином порядке; добавлен `test` (placeholder до EPIC 2). |
| 1.3 | Add ESLint / formatting baseline | Готово | ESLint 10 + typescript-eslint, flat config `eslint.config.js`. Правила: no-unused-vars, no-floating-promises (warn), no-explicit-any (warn), no-duplicate-imports. Линт проходит (остались предупреждения по `any` в части модулей). |

### EPIC 2 — Testing Foundation

| Задача | Описание | Статус | Результат / ссылки |
|--------|----------|--------|---------------------|
| 2.1 | Add testing framework and base setup | Готово | Vitest 2.x, `vitest.config.ts`, `npm run test` / `test:watch`. Тесты в `tests/*.test.ts` и `src/**/*.test.ts`. Юнит-тесты stateTransitions (14 тестов). |
| 2.2 | Integration tests for incoming worker | Не начато | |
| 2.3 | Integration tests for outgoing worker | Не начато | |
| 2.4 | Integration tests for queue lifecycle | Не начато | |
| 2.5 | Integration tests for ownership history | Не начато | |

### EPIC 3 — Core Processing Runtime Completion

| Задача | Описание | Статус | Результат / ссылки |
|--------|----------|--------|---------------------|
| 3.1 | Complete incoming worker lifecycle | В работе | Воркеры работают; переходы статусов через stateTransitions. |
| 3.2 | Complete stuck processing recovery job | Готово | StuckProcessingJob вызывает setIncomingReclaimPending, setIncomingStuckToFailed, setOutbox*, setOutgoingReclaimPending (stateTransitions). Reclaim/requeue — Priority 1.5. |
| 3.3 | Add failed/quarantine flow | Частично | dead_letter для statement_import_jobs в схеме и state_machines; переход failed→dead_letter вручную или будущей логикой. |

---

## Phase 2 — Critical runtime completion

| Эпик | Содержание | Связь с пробелами |
|------|------------|-------------------|
| EPIC 4 | Outbox: диспетчер по event_type, обработчик profile_transferred_to_buyer | Готово: `outboxHandlers.ts`, processingRuntime |
| EPIC 5 | Slack/MQTT доставка, rate limit | Outgoing — доставка есть; Slack заглушка |
| EPIC 7 | Drafts: оба типа payload, DraftService, lifecycle | |

## Phase 3 — Domain correctness

| Эпик | Содержание | Связь с рисками |
|------|------------|------------------|
| **EPIC 8** | **Card Ownership Domain Consolidation:** CardOwnershipService, инварианты history, ownership query helpers | **Закрывает главный архитектурный риск** — владение сейчас размазано по cardsDb, воркерам, transactions, queue, audit |
| EPIC 9 | Transaction enrichment, buyer/profile attribution, fallback matching | |

## Phase 4 — Hardening

| Эпик | Содержание | Связь с пробелами |
|------|------------|-------------------|
| EPIC 6 | MQTT: publish buffering при reconnect, subscription registry, идемпотентная подписка, topic/wildcard dispatch | **Закрывает пробел MqttClient** (сейчас каркас) |
| EPIC 10, 11, 12 | HTTP API, event contract, observability | |

## Phase 5 — Documentation alignment

| Эпик | Содержание | Связь с рисками |
|------|------------|------------------|
| EPIC 13 | Обновление архитектурной документации по факту, module-level README | В т.ч. возможность зафиксировать **naming governance** и правила структуры (см. организационный дрейф: statementsImport vs statements_import, смешение в infra) — implementation_progress.md § «Организационный дрейф» |

---

## Хронология изменений

| Дата | Что сделано |
|------|-------------|
| 06.03.2026 | Принят в работу документ Cursor epics/tasks. Создан этот прогресс-документ. Начата EPIC 1 (typecheck уже проходит, tsconfig с strict). |
| 06.03.2026 | **EPIC 1 завершён.** Добавлены ESLint 10 + typescript-eslint (flat config), скрипт `test`, приведены в порядок npm-скрипты. Исправлены ошибки линтера в routes (cards, draft), infra (logger, profileAuthChangeWorker, cardCredentials), ecards-адаптерах, mqtt/hardware. `npm run typecheck`, `lint`, `build` проходят. |
| 06.03.2026 | **bank_cards_history + setCardOwnership:** миграция, cardOwnership.ts; все смены владельца (get-by-bin, profileAuthChangeWorker, unlink) пишут историю. **Создание карт adscards/multicards:** вызовы mqtt_adscards /api/cards/issue и mqtt_multicards /api/cards/create; POST /api/cards/create/:bankId поддерживает ecards, adscards, multicards. Исправлен typecheck в cards.ts (return из withTransaction). |
