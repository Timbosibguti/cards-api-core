# Processor-Hub — Epic Breakdown and Task Requirements for Cursor IDE

Version: 1.0  
Scope: Close the gap between current architecture and production-ready implementation of Processor-Hub.  
Audience: Engineering team / Cursor IDE task execution.

---

# Goal

Bring the current Processor-Hub implementation in line with its architecture, domain model, and reliability guarantees.

This plan is based on the current state of the project:
- architecture is strong,
- implementation is partial,
- several critical modules are still skeletal,
- code quality and operational guarantees need to be completed before adding more business logic.

Primary objective:
- finish the foundation,
- align implementation with documented architecture,
- make the system safe to extend.

---

# Delivery Principles

1. Do not expand business scope before closing platform gaps.
2. All new work must follow the existing architectural model:
   - internal processing bus
   - idempotent ingestion
   - worker-based processing
   - outgoing side-effects through outgoing_notifications
3. Avoid ad hoc logic in routes and workers.
4. Centralize domain invariants in dedicated services.
5. Prefer one shared implementation path over duplicating logic in multiple modules.

---

# EPIC 1 — Type Safety, Build Discipline, and Project Baseline

## Goal
Make the project reliably buildable, type-checkable, and safe for refactoring.

## Task 1.1 — Add real TypeScript project configuration
**Objective:** enable actual type checking and compilation discipline.

**Requirements:**
- Add `tsconfig.json`
- Ensure `npm run typecheck` actually validates the entire project
- Configure:
  - strict mode
  - no implicit any
  - module resolution compatible with current codebase
  - output dir and root dir
- Resolve current type issues until typecheck passes cleanly

**Done when:**
- `npm run typecheck` succeeds
- project is fully covered by compiler

---

## Task 1.2 — Normalize npm scripts
**Objective:** standardize execution scripts for engineering workflow.

**Requirements:**
- Ensure package scripts include:
  - `dev`
  - `build`
  - `start`
  - `typecheck`
  - `lint`
  - `test`
- Remove placeholder or misleading scripts

**Done when:**
- local workflow is deterministic
- CI-ready scripts exist

---

## Task 1.3 — Add ESLint / formatting baseline
**Objective:** reduce inconsistent style and hidden mistakes.

**Requirements:**
- Add ESLint for TypeScript
- Add formatting standard
- Enforce no unused vars, no floating promises, no implicit any, no duplicated imports

**Done when:**
- lint passes
- project style is stable

---

# EPIC 2 — Testing Foundation

## Goal
Introduce minimum automated safety for the system's most critical behavior.

## Task 2.1 — Add testing framework and base setup
**Objective:** enable unit + integration tests.

**Requirements:**
- Add test runner and config
- Support:
  - unit tests
  - integration tests
  - environment bootstrapping
- Add fixtures/helpers for DB and worker tests

**Done when:**
- a sample test suite runs from `npm test`

---

## Task 2.2 — Integration tests for incoming worker
**Objective:** guarantee processing semantics of incoming events.

**Test cases:**
- pending record is picked once
- duplicate ingest with same idempotency key does not duplicate domain effect
- stuck processing can be retried
- failed record transitions correctly after max attempts

**Done when:**
- incoming worker behavior is reproducible in tests

---

## Task 2.3 — Integration tests for outgoing worker
**Objective:** guarantee notification semantics.

**Test cases:**
- outgoing notification is sent once
- duplicate worker execution does not produce duplicate delivery when dedup key matches
- retry/backoff works
- failure transitions to failed after limit

**Done when:**
- outgoing side-effects are safe under retries

---

## Task 2.4 — Integration tests for queue lifecycle
**Objective:** lock down acquire/release logic.

**Test cases:**
- acquire free queue
- extend same owner
- deny different owner
- release by owner
- release noop by non-owner
- cleanup expired queue

**Done when:**
- queue behavior is covered

---

## Task 2.5 — Integration tests for ownership history
**Objective:** verify card ownership timeline consistency.

**Test cases:**
- issue card creates initial history row
- farmer link creates current ownership
- profile transfer closes previous interval and inserts new
- dead profile unlink clears current ownership and closes interval
- only one active ownership interval exists per card

**Done when:**
- ownership timeline is trustworthy

---

# EPIC 3 — Core Processing Runtime Completion

## Goal
Finish the runtime so it behaves like the documented architecture.

## Task 3.1 — Complete incoming worker lifecycle
**Objective:** make incoming processing fully production-safe.

**Requirements:**
- Standardize statuses:
  - pending
  - processing
  - processed
  - failed
- Track:
  - attempts
  - processing_started_at
  - processed_at
  - failed_reason
- Use concurrency-safe picking strategy
- Ensure idempotent execution path

**Done when:**
- incoming worker follows one consistent lifecycle

---

## Task 3.2 — Complete stuck processing recovery job
**Objective:** recover records stuck in processing.

**Requirements:**
- Reset stale `processing` records back to `pending`
- Increment attempts or preserve retry semantics as defined
- Apply to:
  - incoming transactions
  - outbox events
  - outgoing notifications
- Avoid infinite retry loops

**Done when:**
- system self-heals from interrupted processing

---

## Task 3.3 — Add failed/quarantine flow
**Objective:** stop poison events from looping forever.

**Requirements:**
- Define max attempts
- Move unrecoverable records to `failed`
- Preserve failure details
- Add reprocess path for operators/devs

**Done when:**
- poison events are contained

---

# EPIC 4 — Outbox Worker: Replace Skeleton with Real Domain Handling

## Goal
Turn outbox processing from placeholder behavior into real business execution.

## Task 4.1 — Implement profile transfer domain handler
**Objective:** process `profile_transferred_to_buyer` events correctly.

**Requirements:**
- Resolve buyer email by auth_id
- Update current card ownership
- Write ownership history
- Write audit
- Mark outbox processed only after domain handling succeeds
- Keep handler idempotent

**Done when:**
- profile transfer outbox event fully performs domain logic

---

## Task 4.2 — Implement dead profile unlink domain handler
**Objective:** process profile death/unlink consistently.

**Requirements:**
- Detect dead profile condition using existing domain rule
- Clear `buyer` and `profile_name` on current card ownership
- Write ownership history change
- Write audit
- Ensure repeat-safe execution

**Done when:**
- dead profile unlink is centrally handled

---

## Task 4.3 — Standardize outbox event dispatching
**Objective:** prevent outbox logic from becoming scattered.

**Requirements:**
- Create typed dispatcher/registry by event_type
- One handler per event type
- Shared error handling and status transitions
- Shared correlation/idempotency plumbing

**Done when:**
- outbox worker is modular and maintainable

---

# EPIC 5 — Notification Delivery: Real Slack/MQTT Delivery

## Goal
Replace placeholder notification behavior with production-safe delivery.

## Task 5.1 — Implement Slack adapter
**Objective:** stop marking fake sent messages as delivered.

**Requirements:**
- Real Slack API integration
- Support:
  - channel posting
  - DM posting
- Errors must keep notification in retryable state
- Only mark sent after actual success

**Done when:**
- Slack notifications are real, not mocked

---

## Task 5.2 — Complete outgoing_notifications delivery pipeline
**Objective:** make outgoing side-effects reliable.

**Requirements:**
- Respect dedup key
- Support retry/backoff
- Support attempts and failure tracking
- Standardize channels:
  - slack_dm
  - slack_channel
  - mqtt
- Preserve delivery metadata

**Done when:**
- notification delivery is reliable and observable

---

## Task 5.3 — Add rate limit handling
**Objective:** prevent notifier meltdown under Slack/API limits.

**Requirements:**
- Detect rate-limited responses
- Defer retry via next_retry_at
- Avoid marking failed too early

**Done when:**
- transient limits are handled gracefully

---

# EPIC 6 — MQTT Layer Hardening

## Goal
Bring MQTT implementation up to the architectural standard described in docs.

## Task 6.1 — Add publish buffering during reconnect
**Objective:** avoid message loss during temporary disconnects.

**Requirements:**
- Queue publish requests while disconnected
- Define bounded buffer policy
- Flush on reconnect
- Preserve ordering where reasonable

**Done when:**
- temporary MQTT disconnect does not drop notifications immediately

---

## Task 6.2 — Add subscription registry and idempotent subscribe behavior
**Objective:** avoid duplicate subscriptions and inconsistent reconnect handling.

**Requirements:**
- Track active subscriptions
- Reapply safely on reconnect
- Prevent duplicate handler registration

**Done when:**
- reconnect does not multiply event handling

---

## Task 6.3 — Improve topic dispatch
**Objective:** make MQTT handling extensible and correct.

**Requirements:**
- Centralize topic-to-handler dispatch
- Support expected wildcard patterns if required
- Add guardrails for unknown topic types

**Done when:**
- MQTT routing is predictable

---

# EPIC 7 — Drafts Domain Completion

## Goal
Finish the draft/pre-transaction model so it matches architecture and business flow.

## Task 7.1 — Complete support for both /draft payload types
**Objective:** align implementation with documented `/draft` semantics.

**Payload types:**
- bank pre-transaction:
  - `{ transactionId, bank, profile_name }`
- card OTP draft:
  - `{ profile_name, otp }`

**Requirements:**
- Both types must be ingested and normalized
- Both must resolve buyer via `profile_name`
- Both must write/upsert into `drafts`

**Done when:**
- `/draft` fully supports both documented forms

---

## Task 7.2 — Implement DraftService
**Objective:** centralize all draft rules.

**Requirements:**
- One domain service for:
  - key generation
  - upsert rules
  - state transitions
  - TTL / expiration
  - matching helpers
- Ban ad hoc direct draft writing in workers/routes

**Done when:**
- drafts are governed by one implementation path

---

## Task 7.3 — Add draft lifecycle management
**Objective:** keep drafts bounded and queryable.

**Requirements:**
- states:
  - pending
  - confirmed
  - expired
- expiration policy
- cleanup/archive strategy
- safe transition rules

**Done when:**
- drafts cannot become an unbounded graveyard

---

# EPIC 8 — Card Ownership Domain Consolidation

## Goal
Create one central domain service for card lifecycle and ownership transitions.

## Task 8.1 — Introduce CardOwnershipService
**Objective:** consolidate all ownership-changing operations.

**Operations to centralize:**
- card issuance
- farmer link
- transfer to buyer
- dead profile unlink
- current owner update
- history update
- audit write

**Done when:**
- no ownership-changing logic is scattered across unrelated modules

---

## Task 8.2 — Enforce history invariants through service layer
**Objective:** guarantee timeline correctness.

**Requirements:**
- On ownership change:
  - close previous active interval
  - insert new interval
- Guard against two active ownership rows
- Standardize reason / actor metadata for history entries

**Done when:**
- ownership history is always internally consistent

---

## Task 8.3 — Add ownership query helpers
**Objective:** support core operational questions safely.

**Queries to support:**
- owner of card at time
- current owner of card
- card transfer history
- cards held by buyer at time

**Done when:**
- history and ownership become easy to query and reuse

---

# EPIC 9 — Transaction Enrichment and Attribution Completion

## Goal
Guarantee that transactions are fully enriched with card, buyer, and profile context.

## Task 9.1 — Normalize and persist card data from providers
**Objective:** make transaction-to-card attribution explicit and durable.

**Requirements:**
- Extract provider card information on ingest
- Persist normalized card info in `bank_transactions`
- Use one unified internal card structure

**Done when:**
- "which card was used" is always answerable from transactions

---

## Task 9.2 — Complete buyer/profile attribution flow
**Objective:** make transaction enrichment deterministic.

**Requirements:**
- Attach `buyer_email` and `profile_name` whenever possible
- Support late enrichment/backfill
- Match through:
  - direct transaction data
  - drafts
  - ownership context
  - fallback strategy where applicable

**Done when:**
- transactions reliably carry buyer/profile attribution

---

## Task 9.3 — Implement fallback matching for bank statement imports
**Objective:** preserve attribution when pre-transaction is missing.

**Requirements:**
- If bank statement row has no matching draft:
  - attempt fallback using encoded aff_id from amount
- Persist match method
- Mark fallback usage in audit

**Done when:**
- missing pre-transaction does not break attribution pipeline

---

# EPIC 10 — HTTP API Hardening

## Goal
Make all ingress and operational endpoints safe and explicit.

## Task 10.1 — Add schema validation for all routes
**Objective:** reject malformed input at the edge.

**Requirements:**
- Define request schemas for all endpoints
- Validate body/query/params
- Reject invalid payloads consistently

**Done when:**
- no route accepts undefined payload shape

---

## Task 10.2 — Standardize error mapping
**Objective:** produce predictable API behavior.

**Requirements:**
- Central error classes / mapping
- Clear 4xx vs 5xx handling
- Preserve internal logging and correlation ids

**Done when:**
- errors are consistent and diagnosable

---

## Task 10.3 — Centralize auth/authorization guards
**Objective:** avoid hand-written auth drift.

**Requirements:**
- Shared middleware/guards for:
  - JWT
  - API key
  - role/capability checks where applicable
- Remove duplicated auth logic in routes

**Done when:**
- route protection is centralized

---

# EPIC 11 — Event Contract Enforcement

## Goal
Make event_contract.md a real implementation artifact, not just documentation.

## Task 11.1 — Implement typed event envelope library
**Objective:** standardize all outgoing events.

**Requirements:**
- Shared TypeScript types/interfaces for event envelope
- Shared builders/validators
- Required metadata:
  - schema_version
  - producer
  - occurred_at
  - correlation_id
  - idempotency_key

**Done when:**
- emitted events are structurally consistent

---

## Task 11.2 — Add contract validation tests
**Objective:** prevent schema drift.

**Requirements:**
- Test that emitted event payloads match contract
- Cover at least:
  - OTP event
  - transaction event
  - card/ownership event
  - audit event if emitted over MQTT

**Done when:**
- contract regressions are caught automatically

---

# EPIC 12 — Observability and Operational Support

## Goal
Make the system debuggable in production.

## Task 12.1 — Expand structured logging
**Objective:** ensure every flow is traceable.

**Requirements:**
- Include correlation_id everywhere possible
- Include event ids / transaction ids / draft ids / queue keys
- Standardize worker lifecycle logs

**Done when:**
- logs support incident reconstruction

---

## Task 12.2 — Add health and readiness coverage
**Objective:** support safe deployment and orchestration.

**Requirements:**
- DB readiness
- MQTT readiness
- worker health visibility
- degraded state visibility

**Done when:**
- runtime health is externally visible

---

## Task 12.3 — Add operational reprocess tooling
**Objective:** support safe manual recovery.

**Requirements:**
- reprocess failed incoming record
- reprocess failed outbox event
- reprocess failed outgoing notification
- log manual intervention

**Done when:**
- operators/devs can recover bad events safely

---

# EPIC 13 — Documentation Alignment

## Goal
Ensure code, architecture docs, and process docs do not drift apart.

## Task 13.1 — Update architecture docs to reflect real implementation progress
**Objective:** remove false confidence.

**Requirements:**
- mark completed vs partial vs planned modules
- document actual worker flows
- document exact route behavior
- document unresolved gaps explicitly

**Done when:**
- docs match implementation honestly

---

## Task 13.2 — Add module-level README files
**Objective:** help future contributors navigate domain boundaries.

**Requirements:**
- one README per major module:
  - core
  - cards
  - drafts
  - queue
  - notifications
  - mqtt
- include responsibilities and invariants

**Done when:**
- team can reason locally about modules

---

# Recommended Execution Order

## Phase 1 — Foundation
1. EPIC 1
2. EPIC 2
3. EPIC 3

## Phase 2 — Critical runtime completion
4. EPIC 4
5. EPIC 5
6. EPIC 7

## Phase 3 — Domain correctness
7. EPIC 8
8. EPIC 9

## Phase 4 — Hardening
9. EPIC 10
10. EPIC 11
11. EPIC 12

## Phase 5 — Documentation alignment
12. EPIC 13

---

# Final Rule

Do not add new business flows until these epics are materially completed.

Processor-Hub already has the correct architectural backbone.
The current priority is not widening scope — it is finishing the implementation depth so the backbone becomes trustworthy.
