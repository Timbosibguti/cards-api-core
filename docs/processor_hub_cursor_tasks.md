
# Processor Hub – Implementation Tasks (for Cursor IDE)

This document converts the CTO architecture review into a concrete **engineering backlog**
for the Processor Hub system.

**Разложение по файлам и эпикам:** [processor_hub_cursor_tasks_mapping.md](./processor_hub_cursor_tasks_mapping.md) — статус каждой задачи (готово/частично/открыто), привязка к EPIC, конкретные файлы и шаги.

System model:
- Modular Monolith
- Multi-instance deployment
- Fintech operational orchestration
- Core goals: idempotency, traceability, operational audit

Priority levels:

P0 — critical for correctness / risk mitigation  
P1 — production hardening  
P2 — architecture hygiene / long-term stability  

---

# P0 – Critical Tasks

## 1. Card Ownership Domain

### Goal
Guarantee that **card ownership is deterministic and historically reconstructable**.

### Problem
Cards can change owners (farmer → buyer etc.). Without strict ownership history,
it becomes impossible to determine who owned a card **at the time of a transaction**.

### Required Implementation

Create table:

```sql
card_ownership_history
(
  id UUID PK,
  card_id UUID,
  owner_id UUID,
  owner_type TEXT,
  valid_from TIMESTAMP,
  valid_to TIMESTAMP NULL,
  created_at TIMESTAMP,
  created_by_actor UUID
)
```

Rules:

- Only **one active owner** at any moment.
- Ownership change **closes previous record**.
- Transactions must reference **ownership snapshot**.

### Done when

- Ownership always resolved via `card_ownership_history`
- No direct ownership fields in card entity
- Transaction reconstruction shows correct owner

---

## 2. Event Correlation System

### Goal
Allow reconstruction of any operation across system events.

### Implementation

Introduce **correlation_id**.

Every operation must generate:

```
correlation_id = UUID
```

Attach to:

- transactions
- OTP requests
- provider calls
- queue events
- audit events

Example:

```json
{
  "correlation_id": "...",
  "transaction_id": "...",
  "actor_id": "..."
}
```

### Done when

Every event in logs can be traced via a single correlation_id.

---

## 3. Concurrency Safety

### Goal
Ensure correctness under **multi-instance workers**.

### Implementation

Use patterns:

```
SELECT ... FOR UPDATE SKIP LOCKED
ON CONFLICT DO NOTHING
idempotency keys
```

Protect critical flows:

- transaction submission
- OTP consumption
- queue slot allocation

### Done when

Parallel workers cannot cause duplicate operations.

---

# P1 – Production Hardening

## 4. Event Journal

### Goal
Guarantee full operational reconstruction.

Create immutable event log.

```
event_journal
(
  id UUID,
  correlation_id UUID,
  actor_id UUID,
  event_type TEXT,
  payload JSONB,
  created_at TIMESTAMP
)
```

Properties:

- append-only
- immutable
- linked by correlation_id

---

## 5. Observability

Add:

- Prometheus metrics
- correlation_id in logs
- error categories
- processing latency

Metrics examples:

```
transactions_total
otp_requests_total
provider_errors_total
queue_processing_latency
```

---

## 6. Production Readiness

Startup must fail fast if:

- database unavailable
- queue unavailable
- provider configuration invalid

Health endpoints:

```
/health
/readiness
/liveness
```

---

## 7. Integration Tests

Focus on full flows:

- transaction + OTP
- queue processing
- provider callbacks
- duplicate events

Example scenario:

```
Create transaction
Request OTP
Submit OTP
Provider confirms
Transaction completed
```

---

# P2 – Architecture Hygiene

## 8. Domain Boundaries Enforcement

Each module owns its tables.

Example rule:

```
transactions module
  owns: transactions tables

cards module
  owns: card tables
```

Other modules must access data through **domain services**, not direct queries.

---

# Final Target Architecture

Processor Hub should behave as:

```
Modular Monolith
+
Strong Audit Layer
+
Idempotent Processing
+
Deterministic State Machines
```

Primary invariant:

> Any operation must be fully reconstructable from event history.

