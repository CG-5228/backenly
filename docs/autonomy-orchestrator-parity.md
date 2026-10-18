# Retiring the agent orchestrator from autonomy: detector parity

> The orchestrator, its governor and its four agents have since been deleted. The paths below name files that no longer exist; this page is the record of why they could go.

The background monitor (`lib/ai/background-monitor.ts`) runs two detect-and-fix pipelines.

1. **The canonical loop.** The desired-state invariants feed the reconciler, which hands repairs to the auto-fix kernel. Each repair is re-checked against the live database, and its outcome is recorded.
2. **The agent orchestrator** (`lib/ai/agent-orchestrator.ts`). It runs four agents from `lib/ai/agents/`:
   - security
   - performance
   - migration
   - repair

   It files their findings, applies some fixes through its own connection pool, writes `AGENT_AUTO_FIXED` without a re-check, and sends an "Auto-fixed N backend issue(s)" notification.

The orchestrator is to be removed from the loop. That is only safe when two things hold:

- every real problem it can find is found by a canonical detector;
- none of its false findings is repeated there.

This document records that comparison, check by check. `tests/core/orchestrator-parity.test.ts` proves each row against a real PostgreSQL schema.

## Parity table

| Agent | Check | What it actually tests | Canonical counterpart | Verdict |
|---|---|---|---|---|
| security | `missing_rls` | Tables whose name looks sensitive, judged by whether `pg_policies` has rows | `user_data_is_rls_protected` (`detectMissingRls`) | **Covered, and wider.** |
| security | `auth_gap` | More than three tables and none named `users`, `sessions` or `tokens` | `auth_subsystem_is_intact` (`checkAuthIntegrity`) | **Dropped.** It describes the normal state of a backend nobody has signed up to. |
| security | model review | A model reads the table list and returns findings | none | **Dropped.** Its output had no evidence behind it. |
| performance | `missing_index` | Foreign-key columns with no index containing the column name | `relationships_are_indexed` (`detectMissingFkIndexes`) | **Covered after this change.** |
| performance | `n_plus_one_risk` | Junction tables by name, with at least 1,000 rows | `relationships_are_indexed` | **Covered.** The real cost is the junction's unindexed reference columns. |
| migration | snapshot drift | The live schema against the latest snapshot | `live_schema_matches_intent`, `the_schema_is_what_was_asked_for`, `live_tables_are_adopted`, `external_schema_changes_are_adopted` | **Covered.** |
| repair | `orphaned_fk` | A foreign key whose target table is not in the schema | none needed | **Dropped.** The condition cannot exist. |
| repair | `missing_realtime_triggers` | Any project with tables and no triggers | none needed | **Dropped.** It can only fire falsely. |

### Row security

`detectMissingRls` reads `relrowsecurity` and client reachability, not table names.

It catches two exposures the agent never reports:

- a table outside the agent's list of sensitive names (`invoices`);
- a table that has a policy while RLS is off (`payments`). The policy is not applied to anything.

The agent reads RLS on with no policy as "any authenticated user can read all rows". That is the opposite of what PostgreSQL does: it denies everyone. The canonical loop reports that state as `rls_denies_everything` (`rls_is_not_deny_all`), which describes it correctly.

### End-user auth

The workspace `users` table is created by the first sign-up. Its absence is therefore normal until auth is in use.

`checkAuthIntegrity` files `auth_users_table_missing` only when auth is configured (`getEndUserAuthUsage`). The agent files `auth_gap` ("End-users have no way to authenticate") on any project with four or more tables.

### Foreign-key indexes

This change gives `detectMissingFkIndexes` the evidence the performance agent used, and removes two false positives.

- **A declared constraint now makes a reference column, whatever its name.** The probe also reads foreign keys from `pg_constraint`, so `entries.author` is caught. Previously only columns named `*_id` were considered.
- **The `_` in `LIKE '%_id'` is escaped.** Unescaped, it matched any one character, so columns such as `paid` and `uuid` were treated as references.
- **An index covers a column when the column leads it, read from `pg_index`.** The old rule matched the name inside `indexdef`, which reported a column covered by a composite index as unindexed.

Each finding now records `basis: 'foreign_key' | 'name'`.

Both reference columns of a junction table are caught. That is the defect behind the agent's `n_plus_one_risk`, which flagged junction tables by name and row count without any query evidence.

### Schema drift

The migration agent compared the live schema with the latest snapshot. The canonical loop splits the same question by cause:

| Change | Canonical finding |
|---|---|
| Columns added outside the platform | `shadow_mutation` |
| Tables nobody registered | `orphan_table` |
| Columns that are missing, or whose type changed, against what was requested | `intent_drift` |
| DDL over a direct connection, including drops | `external_schema_change`, from the recorded events |

One limit applies. `external_schema_change` depends on the event trigger that `scripts/setup-direct-access.sql` installs. Without it, DDL run outside the platform by an operator with database credentials is not recorded. The snapshot check saw such changes, but only as differences, with no record of who made them or how.

The agent's `missing_table` fired for every table dropped after its snapshot. Load-test runs left such findings open until a dedicated reaper was added to withdraw them. A table dropped through the platform is a legitimate outcome, and one dropped over a direct connection is already recorded.

### Foreign key to a missing table

PostgreSQL refuses to drop a table that a foreign key references. `DROP ... CASCADE` removes the referencing constraint along with it. A foreign key whose target no longer exists therefore cannot be reached, and the check could only fire on a catalog visibility artifact.

### Realtime triggers

Turning realtime on for a table is installing its trigger (`lib/services/realtimeTriggers.ts`). A table without one simply has realtime off, which is a choice, and nothing records an intent to compare against. The agent filed a defect against every project that had not turned realtime on.

## How it is retired

`lib/ai/background-monitor.ts` no longer runs the orchestrator; it runs the canonical loop. The on-demand `/api/projects/[id]/agents` route, which had no callers, is deleted. The agent modules themselves are unreachable and are removed separately.

**Its findings** were recognized by the canonical kernel through the `PREFIX_MAP` aliases in `lib/core/types.ts`, so some may carry approval or repair state. `retireOrchestratorFindings` (`lib/core/finding-reaper.ts`) runs on every scheduled scan and every Re-scan.

- It withdraws each open finding the orchestrator filed (`details.agentType`), recording `withdrawnBy: 'detector_retired'` and the time.
- It keeps any finding someone already acted on:
  - one carrying `appliedUnverified`;
  - one carrying `rollbackData`;
  - one named by a `HEALTH_FIX_APPROVED` audit row.

  Those stay listed and read "From a retired check: …" wherever they are summarised.
- Each run that withdraws anything writes one `AUTONOMY_DETECTOR_RETIRED` audit row with what it withdrew and what it kept.

**Three aliases are removed:**

| Alias | What approving it actually ran |
|---|---|
| `orphaned_fk -> missing_fk` | `ADD_CONSTRAINT`, for a finding that said to drop a broken foreign key |
| `auth_gap -> broken_auth` | `FIX_AUTH`, on a project that had not asked for auth |
| `missing_realtime_triggers -> realtime_gap` | `FIX_REALTIME` |

Those types now normalise to nothing: no fix action, a manual hint only.

**History.** Historic `AGENT_AUTO_FIXED` rows record no re-check. Every feed shows them as applied but not confirmed.

The trust scoreboard's rollback count is now the fixes a person undid with Undo. It used to count deploy and version rollbacks people asked for, and never counted an undone fix.
