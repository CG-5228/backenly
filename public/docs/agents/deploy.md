# Deploy

Index: https://backenly.com/llms.txt

Versioned deployments with history and rollback. A deployment that would break the live schema is refused at plan time.

## Actions

<!-- generated:actions:deploy by scripts/generate-agent-docs.ts from lib/mcp/domains.ts; do not edit -->
Call as `deploy { action: "<action>", … }`.

| Action | What it does | Needs | Read-only key | Approval |
| --- | --- | --- | --- | --- |
| `status` | the live version, when it shipped and its state | nothing | yes | no |
| `history` | every published version, which one is serving, and which can be rolled back to | nothing | yes | no |
| `readiness` | the 0-100 readiness score with blockers; fixes nothing unless autoFix is true | nothing | yes | no |
| `deploy` | publish the current backend | nothing | no | waits for a human |
| `rollback` | return to an earlier published version | nothing | no | waits for a human |
| `changes` | every schema change to production, newest first: its changeId, who made it, what it did to each table, and whether it can be rolled back | nothing | yes | no |
| `revert_change` | roll one schema change (changeId) back to its restore point, with the data it removed; a person approves it first | `changeId` | no | waits for a human |
<!-- end generated -->

- `readiness` reports what stands between the project and a working deploy. It is a read and fixes nothing, unless a read-write key passes `autoFix: true`; a read-only key's readiness read never changes anything.
- `history` lists every published version, which one is serving, and which can be rolled back to.
- `deploy` and `rollback` wait for a human's approval (see `autonomy`); the approved call runs exactly as you made it.

## Rolling back a schema change

Every change to the production schema is recorded with a restore point taken before its first statement: each `apply_migration`, each schema change `backend_chat` makes, each approved drop, each branch merge, and each repair the autonomy loop applies.

- `changes` lists them, newest first: the `changeId`, who made it, what it did to each table, and whether it can still be rolled back. A successful `apply_migration` returns its own `change` too.
- `revert_change { changeId }` asks for one to be rolled back. It waits for a human (you can request a rollback, never approve one). Once approved it is rehearsed against the live data, run in one transaction, and checked against the restore point afterwards; `check_approval` then reports what came back.
- Nothing is deleted by a rollback. A table the change created is moved aside with its rows, and a column it added has its values kept, so rolling the rollback back restores them, including rows written after the change.
- A rollback is refused, with nothing changed, when a later change touched the same tables. `changes` shows which; roll that one back first.
- A migration that fails part-way is rolled back automatically: the response's `applied` is empty and `rolledBack` lists what ran and was undone. Fix the failing statement and send the whole migration again.
- Dropping a table or a column (asked for through `backend_chat`, approved by a human) keeps its data the same way, so an approved drop can be undone within the rollback window: 7 days on Free, 30 on Pro, 90 on Enterprise, a year self-hosted.

Custom domains are set in the dashboard.
