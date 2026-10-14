
# Processor Hub – Dev Simulation Concept

## Overview

The Processor Hub system integrates with many external actors:

- Payment providers (ecards, stellarcards, multicards, adscards)
- SMS gateways
- OTP devices
- Taurus device infrastructure
- Farm extension
- Banking sessions / queues

In production these systems send **incoming events** such as:

- card issued
- transaction created
- transaction status update
- OTP received
- SMS received
- webhook callbacks
- Taurus heartbeat
- device status updates

For development this creates a problem: developers cannot rely on real providers or real devices to test the system.

The solution is to implement a **Dev Simulation Layer**.

---

# Core Idea

Instead of building fake versions of every external system, we create **one unified event injection mechanism**.

All external systems are conceptually reduced to one idea:

> External systems send events into Processor Hub.

In dev mode we simulate those events by inserting them into a **dev event inbox**.

This allows developers to trigger the same pipelines that production uses without calling real providers.

Architecture:

```
Dev Inbox Table
        ↓
Dev Worker
        ↓
Inbound Dispatcher
        ↓
Real Application Handlers
        ↓
Domain Logic
```

This ensures that development tests **real business logic**, not mocks.

---

# Dev Inbox Table

All simulated external events are stored in a single table.

Example schema:

```sql
CREATE TABLE dev_inbox_events (
  id UUID PRIMARY KEY,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  correlation_id UUID NULL,
  aggregate_key TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ NULL
);
```

Each row represents **one incoming external event**.

---

# Event Sources

The following sources should be supported:

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

# Event Types

Examples of supported events:

### Card events

- card_issued
- card_updated
- card_reassigned

### Transaction events

- transaction_created
- transaction_updated
- transaction_completed
- transaction_failed

### OTP / SMS

- otp_received
- sms_received
- sms_raw_received

### Taurus / device

- taurus_heartbeat
- taurus_status
- device_online
- device_offline

---

# Dev Worker

A background worker processes events from the dev inbox.

Steps:

1. Read events with `status = pending`
2. Lock rows with `FOR UPDATE SKIP LOCKED`
3. Mark event as `processing`
4. Dispatch to correct inbound handler
5. Mark as `processed` or `failed`

Important rule:

The worker must call **the same services used by production adapters**.

It must **not modify domain tables directly**.

---

# Dispatcher

The dispatcher routes events based on:

```
source + event_type
```

Example mapping:

```
ecards + card_issued → EcardsInboundService.handleCardIssued
stellarcards + transaction_created → StellarCardsInboundService.handleTransactionCreated
sms_device + otp_received → SmsInboundService.handleOtp
taurus + taurus_heartbeat → TaurusInboundService.handleHeartbeat
```

---

# Dev API

Developers must be able to inject events using an API.

Example endpoint:

```
POST /dev/inbox-events
```

Example request:

```json
{
  "source": "stellarcards",
  "event_type": "transaction_created",
  "payload": {
    "externalTransactionId": "tx-123",
    "amount": 100,
    "currency": "EUR"
  }
}
```

This inserts a record into `dev_inbox_events`.

---

# Farm Extension Integration

Farm extension should support dev mode.

Requests must include:

```
dev=true
```

Example:

```
POST /api/transactions?dev=true
```

Processor Hub detects this flag and routes the request into the **dev simulation pipeline**.

---

# Taurus Integration

Taurus devices should also support dev mode.

Example:

```
POST /taurus/heartbeat?dev=true
```

Events with `dev=true` are written to `dev_inbox_events` instead of production processing.

---

# Dev Fixtures

To simplify development we store example payloads in repository:

```
/dev-fixtures
```

Examples:

```
ecards.card-issued.json
stellarcards.transaction-created.json
sms.otp-received.json
taurus.heartbeat.json
```

Developers can replay these fixtures easily.

---

# Developer Workflow

Typical testing scenario:

1. Inject event `card_issued`
2. Worker processes event
3. Card appears in system

Then:

4. Inject `transaction_created`
5. Inject `otp_received`
6. Inject `transaction_completed`

This simulates the full production flow.

---

# Benefits

This approach provides:

- realistic event-driven testing
- no dependency on real providers
- reproducible debugging
- easy incident replay
- minimal infrastructure complexity

Most importantly:

> The same business logic is executed in dev as in production.

