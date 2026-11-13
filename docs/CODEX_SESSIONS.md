# Persistent Codex sessions

## Ownership

Codex thread identity belongs to project + role + task/process, not an HTTP request or MCP access token.

| Role | Scope | Transport |
| --- | --- | --- |
| PM owner chat | project + manager + owner UUID | Codex App Server |
| PM task work | project + manager + task UUID | Codex App Server |
| Documentation analyst | project + analyst + import UUID | Codex App Server |
| Developer | project + development + task UUID | Codex CLI resume |
| QA | project + testing + task UUID | Codex CLI resume |
| Architect and conflict resolver | project + role + task UUID | Codex CLI resume |

The developer thread survives every ai_task_run, QA cycle, CI failure, and rework. QA has its own independent thread and must generate fresh evidence for the current SHA. Git, MCP and PostgreSQL remain sources of verified truth, rather than the model's memory.

Thread identifiers are stored in RUNNER_STATE_DIR/codex-threads and local Codex rollout history is stored in CODEX_HOME. Both already use persistent Docker volumes. Back up both; the ID alone does not restore missing rollout history. Developer workspaces persist under RUNNER_STATE_DIR/workspaces/<task_uuid>. Keep them through QA rework and avoid blind resets of uncommitted work. Archive only after confirmed task closure.

## Recovery

1. Persist thread ID immediately on the first Codex thread event, even if the turn later times out.
2. Reconnect by the saved thread ID; supply only new requirements, QA feedback or owner instructions on subsequent turns.
3. Serialize turns for the same logical thread; join duplicate in-flight requests rather than starting concurrent calls.
4. After a timeout or restart check durable Git/MCP/process state before any retry, to avoid duplicate mutations.
5. A successful model answer is not proof of completed work: use existing QA, PR and documentation completion gates.
6. Keep retries bounded; distinguish temporary runtime errors from missing owner approval, failed tests, authorization and usage limits.
7. If the Codex rollout is unavailable, surface that loss and use verified Git/MCP checkpoints, never silently fabricate restored reasoning.

## Project Manager

PM retains one owner/project conversation thread, but not a global thread across all owners or projects. The first turn receives role instructions. Subsequent turns receive only the latest owner message, reply reference and new process events; PM can ask MCP for historical facts as needed. MCP credentials rotate per turn and are never persisted with the thread ID.

Long-running PM delegations are owned and observed by Temporal. A PM reply must not block until the delegated analysis, development or QA completes. Temporal later delivers the process completion through the PM inbox, which resumes the same owner thread. Project decisions and rules remain in PostgreSQL, not exclusively in model conversation history.

## Security and token use

Keep the existing strict CLI permission profiles for developers, QA and architects. Proof of QA commands and Chromium assertions must come from the current run and commit, not a historical thread. Preserve owner separation, credential redaction and short-lived MCP access.

Persistent threads reduce repeated prompt assembly and can benefit from caching, but still consume inference tokens and ChatGPT subscription limits. Codex compaction is preferable to an indefinitely growing model context. Existing ephemeral runs cannot retroactively recover their discarded model history; migration begins with a new Codex thread while reusing real Git/MCP artifacts.

## Rollout testing

CI covers mocked App Server lifecycle, PM scope isolation, CLI resume, timeout persistence, TypeScript, integration suites and Docker startup. Real authenticated Codex turns in the running environment must additionally be checked before claiming end-to-end production validation.