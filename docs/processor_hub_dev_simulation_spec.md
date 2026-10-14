
# Processor Hub — Dev Simulation Environment Specification

Author: CTO  
Purpose: Implement a lightweight development simulation environment for Processor Hub that allows developers to inject external events (payments, OTP, SMS, Taurus signals, etc.) without connecting to real external providers.

This document is intended for use with Cursor IDE and as internal developer documentation.

---

# 1. Goals

The development environment must:

1. Simulate all external incoming events.
2. Prevent connections to real payment systems, banks, SMS gateways, or devices.
3. Allow manual injection of events by developers.
4. Support farm extension and Taurus device integration in dev mode.
5. Reuse the same production processing pipeline for events.
6. Allow replaying and debugging real scenarios.

Core principle:

> All external interactions are simulated through a **Dev Inbox Event System**.

---

# 2. Dev Inbox Event Model

Instead of building fake banks, fake SMS systems, and fake providers separately, we create a unified **event injection layer**.

External systems normally send events to Processor Hub.  
In dev mode, these events will be inserted into a database table and processed by a worker.

Pipeline:

dev_inbox_events -> DevInboxWorker -> InboundDispatcher -> Real Application Services

---

# 3. Database Schema

Create the following table.

```sql
CREATE TABLE dev_inbox_events (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    event_type TEXT NOT NULL,
    external_id TEXT NULL,
    correlation_id UUID NULL,
    aggregate_key TEXT NULL,
    payload JSONB NOT NULL,
    meta JSONB NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT NULL,
    replay_of_event_id UUID NULL,
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ NULL,
    created_by TEXT NULL
);
```

Status values:

pending  
processing  
processed  
failed

---

# 4. Event Sources

Supported sources:

- ecards
- stellarcards
- multicards
- adscards
- sms_device
- sms_gateway
- taurus
- farm_extension
- manual

---

# 5. Event Types

Initial supported event types.

## Card Events

- card_issued
- card_updated
- card_reassigned

## Transaction Events

- transaction_created
- transaction_updated
- transaction_completed
- transaction_failed

## OTP / SMS

- otp_received
- sms_received
- sms_raw_received

## Taurus / Device

- taurus_heartbeat
- taurus_status
- device_online
- device_offline

## Webhooks

- provider_webhook

---

# 6. DevInboxWorker

Create background worker:

DevInboxWorker

Responsibilities:

1. Read events where status = pending
2. Lock rows using SELECT FOR UPDATE SKIP LOCKED
3. Mark status = processing
4. Dispatch event
5. Update status to processed or failed

Important rule:

Worker must never write directly to domain tables.

Worker must call the same application services used by real adapters.

---

# 7. Event Dispatcher

Create central dispatcher.

Example logic:

source + event_type determines which inbound service is executed.

Example:

ecards:card_issued -> EcardsInboundService.handleCardIssued  
stellarcards:transaction_created -> StellarCardsInboundService.handleTransactionCreated  
sms_device:otp_received -> SmsInboundService.handleOtp  
taurus:taurus_heartbeat -> TaurusInboundService.handleHeartbeat

---

# 8. Dev API Endpoints

Enable only when:

DEV_SIMULATION_ENABLED=true

## Insert Event

POST /dev/inbox-events

Example:

{
  "source": "stellarcards",
  "event_type": "transaction_created",
  "payload": {
    "externalTransactionId": "tx-123",
    "amount": 100,
    "currency": "EUR"
  }
}

## List Events

GET /dev/inbox-events

## Replay Event

POST /dev/inbox-events/{id}/replay

---

# 9. Dev Fixtures

Create repository folder:

/dev-fixtures

Example files:

ecards.card-issued.json  
stellarcards.transaction-created.json  
stellarcards.transaction-duplicate.json  
sms.otp-received.json  
taurus.heartbeat.json

Fixtures allow developers to replay common scenarios.

---

# 10. Adapter Behavior in Dev Mode

When environment:

NODE_ENV=development

Adapters must not call external providers.

Instead:

1. Log outbound request
2. Optionally create simulated response inside dev_inbox_events

Example:

Production:

ProcessorHub -> ecards API

Dev:

ProcessorHub -> DevSimulationService -> dev_inbox_events

---

# 11. Farm Extension Integration

Farm extension must support dev mode.

When sending requests include parameter:

dev=true

Example:

POST /api/transactions?dev=true

Processor Hub must detect this parameter and route events into the dev simulation system.

---

# 12. Taurus Integration

Taurus devices must also support dev environment.

When sending events include:

?dev=true

Example:

POST /taurus/heartbeat?dev=true

Instead of production processing, Taurus events are stored in dev_inbox_events.

**Production (не dev): карты для Taurus** — отдельные маршруты с ключом **`api-key`** (значение **`QUEUE_API_KEY`**, как у internal queue / card-block):

- `GET /taurus/buyer-cards?profile_name=...` — список карт баера, привязанных к email из Farm DB (`tbl_profiles.auth_id` → `tbl_users`).
- `POST /taurus/card-credentials` — тело JSON `profile_name`, `card_number`; ответ с полем `credentials_base64` (Base64-encoded JSON с реквизитами и `bank`).

Спецификация потока: [card_and_bank_flows.md](./card_and_bank_flows.md) § I.e.

---

# 13. Observability

Create helper view:

```sql
CREATE VIEW dev_inbox_events_recent AS
SELECT
  id,
  source,
  event_type,
  status,
  created_at,
  processed_at,
  error
FROM dev_inbox_events
ORDER BY created_at DESC;
```

---

# 14. Security

Dev simulation must be disabled in production.

Environment variable:

DEV_SIMULATION_ENABLED=false

Production must reject:

/dev/*

---

# 15. Expected Result

Developers can simulate:

- payment provider events
- card issuance
- transaction lifecycle
- OTP messages
- Taurus signals
- webhook callbacks

All events are processed through the real system logic.

---

# 16. Example Workflow

Developer injects event:

POST /dev/inbox-events

Worker processes event.

System behaves exactly as if event came from external provider.

---

# 17. Future Improvements

Possible extensions:

- Dev UI panel
- Scenario engine
- Event delay simulation
- Duplicate event simulation
- Replay production incidents
