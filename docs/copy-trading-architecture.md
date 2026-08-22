# Gate.io Private Copy Trading — Architecture Decision Record

Status: foundation implementation / dry-run only  
Target repository: `brandyaction-ricky/tooja`  
Target users: approved private members, initially 5–20 accounts

## 1. Current repository assessment

The current application is a static HTML/JavaScript dashboard deployed on Vercel. Server-side functions under `/api` read one Gate.io account through process-level environment variables. The existing Gate client supports signed `GET` requests only, and the current README explicitly notes that the deployed dashboard API is public to anyone who knows the URL.

That structure is suitable for a single read-only dashboard, but it is not a safe base for a multi-user trading system because it lacks:

- authenticated member isolation;
- per-member encrypted exchange credentials;
- durable trading jobs and leases;
- idempotent order state transitions;
- fixed-egress-IP worker execution;
- WebSocket lifecycle management;
- reconciliation after missed events or restarts;
- administrative audit controls.

The existing dashboard should remain operational while copy trading is introduced as a separate bounded context. A full Next.js migration can follow after the trading foundation is proven on Testnet.

## 2. Architecture decision

### 2.1 Components

```text
Browser
  │
  ▼
Vercel Web/API
  ├─ Supabase Auth session validation
  ├─ Member/Admin UI
  ├─ API credential intake (write-only)
  └─ Read models only — never executes exchange orders
  │
  ▼
Supabase Postgres
  ├─ RLS member isolation
  ├─ encrypted credential envelopes
  ├─ master snapshots
  ├─ copy targets
  ├─ durable copy order queue
  ├─ fills / positions / daily risk metrics
  └─ audit and error logs
  │
  ▼
Always-on Trading Worker with fixed outbound IP
  ├─ Master private WebSocket listener
  ├─ REST source-of-truth reconciler
  ├─ Copy target calculator
  ├─ Risk engine
  ├─ Postgres queue consumer
  ├─ Gate.io order executor
  └─ Position/fill reconciliation
  │
  ▼
Gate.io Futures API
```

### 2.2 Hosting boundary

Vercel remains responsible for the web application and short-lived authenticated APIs. It must not host the long-running WebSocket listener or the order queue consumer.

The trading worker must run in a container or VM with:

- fixed outbound IPv4 for Gate.io API-key IP allowlisting;
- process supervision and automatic restart;
- health checks and centralized logs;
- separate DEV and PRODUCTION secrets;
- one active leader for the master stream, with database leases preventing duplicate work.

For the initial small membership, Postgres is sufficient as the durable queue. Redis/BullMQ should be introduced only if measured order fan-out or latency requires it.

## 3. Core copying model: desired position, not order mirroring

The master account's actual position is the source of truth.

```text
master actual position
  → master exposure ratio
  → follower desired position
  → follower actual position
  → delta order(s)
```

### 3.1 Formula

```text
master_exposure_ratio = abs(master_position_notional) / master_equity
requested_follower_ratio = master_exposure_ratio × follower_copy_ratio
follower_target_ratio = min(requested_follower_ratio, follower_max_position_ratio)
follower_target_notional = follower_equity × follower_target_ratio × master_direction
follower_target_contracts = follower_target_notional / (mark_price × quanto_multiplier)
delta_contracts = follower_target_contracts - follower_actual_contracts
```

All contract quantities are quantized toward zero using the contract's supported size step. A drift tolerance prevents repeated tiny orders.

### 3.2 Why this model is mandatory

- A missed WebSocket event can be repaired from current positions.
- Worker restarts do not require replaying every historical master order.
- Partial fills are reconciled toward a target instead of blindly repeated.
- Members with different equity are normalized correctly.
- Position drift is observable and measurable.

WebSocket provides low-latency notification. Periodic REST snapshots remain the source of truth.

## 4. MVP execution constraints

The Testnet MVP intentionally supports a narrow operating envelope:

- Gate.io USDT perpetual futures only;
- one-way/single-position mode only;
- one dedicated Gate.io account or subaccount per member;
- no manual trading in the connected futures account;
- market IOC delta orders for Testnet validation;
- explicit slippage and liquidity checks before production;
- deterministic Gate `text` values for duplicate suppression;
- no live order placement unless two independent runtime flags are enabled;
- no withdrawal permission under any circumstance.

Hedge mode, portfolio margin, cross-exchange copying, member manual overrides, conditional orders, and public onboarding are out of MVP scope.

## 5. Direction changes and reductions

A direction flip is never submitted as one unprotected order.

Example: follower is `+500` contracts long and target is `-1,500` contracts short.

1. Submit `-500` contracts with `reduce_only=true`.
2. Confirm the close fill and refresh the actual position.
3. Submit `-1,500` contracts with `reduce_only=false` only if risk remains valid.

If new exposure is blocked between steps, the account stays flat. This is safer than opening the opposite side before the previous position is confirmed closed.

## 6. Risk semantics

The system uses three trading modes:

| Mode | New exposure | Reduction/close | Intended use |
|---|---:|---:|---|
| `active` | allowed | allowed | normal operation |
| `reduce_only` | blocked | allowed | member stop, loss limit, contract block, routine kill switch |
| `halted` | blocked | blocked | corrupted state, exchange incident, credential compromise |

Member emergency stop, maximum daily loss, maximum drawdown, maximum leverage, member pause, and contract block all change the account to effective reduce-only behavior. Existing exposure can still be reduced.

A hard halt is exceptional. It must create a critical alert because even risk-reducing automation is disabled.

## 7. Idempotency and duplicate prevention

Every planned order receives two identities:

1. database idempotency key scoped to member, master snapshot, contract, target and sequence;
2. Gate.io custom order `text`, generated as `t-ct_<24 hex chars>`.

The database enforces uniqueness for each exchange account and Gate order text. The worker must use this sequence:

```text
insert copy_order with unique idempotency key
  → lease row with FOR UPDATE SKIP LOCKED
  → query Gate by stored exchange_order_id/text when state is uncertain
  → submit only when no previous exchange order exists
  → persist exchange order ID before retryable follow-up work
```

Network timeout after submission is an `UNKNOWN` state, not an automatic resubmit. Reconciliation must query the exchange first.

## 8. Queue and state machines

### 8.1 Copy event

```text
DETECTED → CALCULATING → QUEUED → EXECUTING → RECONCILING → COMPLETED
                                      └──────────────→ PARTIAL / FAILED
```

### 8.2 Copy order

```text
PENDING → LEASED → SUBMITTED → PARTIAL_FILLED → FILLED
                       ├─────→ UNKNOWN → RECONCILING → FILLED / FAILED
                       ├─────→ RETRYING
                       └─────→ CANCELLED / FAILED
```

Retry applies only to failures known to be safe before exchange acceptance. Authentication errors, insufficient margin, position-mode conflicts, contract limits and risk blocks are not blind-retry conditions.

## 9. Database boundaries

The first migration creates:

- approved-member profiles and invitations;
- Gate exchange accounts separated from encrypted credentials;
- master account registration;
- copy/risk settings;
- singleton system control and blocked contracts;
- master position snapshots;
- copy events, targets and order queue;
- follower position snapshots, fills and daily metrics;
- audit, API and system error logs;
- RLS policies for member isolation;
- a service-role-only queue leasing function.

Encrypted credentials have no authenticated-user read policy. Only the service-role worker can retrieve ciphertext, and decryption occurs in worker memory using an encryption key stored outside the database.

## 10. Authentication and credential flow

```text
member enters API key + secret over HTTPS
  → authenticated server endpoint validates approved membership
  → server checks Gate futures-account access
  → AES-256-GCM encrypts key and secret with account-specific AAD
  → ciphertext stored in exchange_api_credentials
  → plaintext discarded
  → UI only receives status, UID, key suffix and verification time
```

The secret is never returned after initial submission. Updating credentials creates an audit event and increments the key version.

## 11. Position reconciliation

The reconciler periodically compares each follower's actual signed size with the latest desired signed size.

```text
abs(actual - target) <= tolerance  → SYNCED
small actionable difference        → DRIFT
blocked by risk/settings           → PAUSED
unknown/invalid exchange state     → ERROR
```

Automatic correction requires all of the following:

- copy enabled;
- member approved and not hard-paused;
- credentials verified;
- system not halted;
- no existing in-flight order for the same member/contract;
- fresh master and follower snapshots;
- contract metadata not stale;
- calculated delta above tolerance.

## 12. Admin and member information architecture

### Admin

- Operations overview
- Master account and current positions
- Members and approval state
- API connection health
- Copy status and drift monitor
- Order/fill monitor
- Risk limits and emergency controls
- Blocked contracts
- Error center
- Audit log
- System settings

### Member

- Dashboard
- Current positions
- Trade/fill history
- Performance
- Gate.io API connection
- Copy and risk settings
- Account/security

The first screen must answer: “Is copying active, is my account synchronized, and what risk limit currently applies?”

## 13. Delivery phases and gates

### Phase 0 — security containment

- Protect or remove the current public account-data endpoint.
- Separate legacy master read-only credentials from all follower credentials.
- Create DEV/PRODUCTION Supabase projects and secret stores.

### Phase 1 — foundation (this branch)

- target-state copy calculator;
- risk-state evaluator;
- deterministic Gate order text;
- AES-256-GCM credential envelope;
- environment-aware Gate client with live-trading guard;
- protected dry-run preview endpoint;
- Supabase schema/RLS/queue lease;
- unit tests.

Acceptance: no live order can be emitted, and deterministic calculations pass automated tests.

### Phase 2 — authenticated UI and API onboarding

- Supabase Auth;
- invitation/approval workflow;
- write-only API credential form;
- connection verification;
- admin/member read models.

Acceptance: one member sees only their own account; credentials cannot be read through the client API.

### Phase 3 — Testnet master listener and snapshots

- private WebSocket listener;
- REST reconciliation;
- master snapshot versioning;
- stale-data alarms.

Acceptance: every tested master change produces one durable snapshot/event after reconnects and restarts.

### Phase 4 — Testnet order executor

- queue worker;
- order submit/query/fill state machine;
- safe retry classifier;
- unknown-state reconciliation;
- position drift correction.

Acceptance: all required LONG, SHORT, add, reduce, close, flip, partial-fill, timeout and restart scenarios pass.

### Phase 5 — controlled production pilot

- legal/terms review;
- fixed production egress IP;
- production secrets and key rotation runbook;
- one master plus one operator-owned follower account;
- hard monetary and contract allowlists;
- manual operational checklist.

Acceptance: small live orders reconcile correctly before any external member is enabled.

## 14. Production release blockers

Production order execution must remain disabled until all are complete:

- Gate.io Testnet end-to-end suite;
- authenticated/RLS penetration review;
- encryption-key backup and rotation procedure;
- fixed-IP allowlist verified;
- worker singleton/lease behavior verified under restart;
- incident runbook and alert delivery tested;
- member terms, risk disclosure, privacy policy and Korean legal review completed;
- operator-owned live pilot completed with explicit size caps.
