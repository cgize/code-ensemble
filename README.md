# @cgize/code-ensemble

`code-ensemble` turns OpenCode into a focused software team while keeping one durable tasklist for the whole project.

## Workflow

The workflow is autonomous: the director never asks for plan approval and continues as soon as the plan is ready.

1. At the start of every turn, the director calls `plan` action `get` to read `.code-ensemble/TASKS.md`. If an active plan exists, work continues it instead of planning again.
2. For non-trivial new work, the director tasks explorer and visualizer (when applicable) to gather the minimum necessary evidence.
3. The planner calls `plan` `get` then `create` to persist a title and an actionable, ordered task list; each task integrates its acceptance criteria and the relevant tests. The planner does not implement.
4. The architect always runs as QA of the plan: it calls `plan` `get`, and replies `READY` if the plan is correct, or `plan` `replace` (with `expectedPlanID`/`revision`) to correct it and replies `REVISED` with the changes.
5. The director re-reads the plan, summarizes the title, tasks, and any architect changes to the user, and continues immediately without asking for approval or waiting for confirmation.
6. The implementer completes tasks and runs the relevant checks; the director records evidence by updating tasks.
7. The reviewer reports blocking findings. Remediation tasks are added with `plan` action `add`, completed through the implementer, and re-reviewed.
8. A clean, completed plan is archived under `.code-ensemble/plans/` via `plan` action `close`.

The tasklist is scoped to the worktree, not to one OpenCode conversation. A new session can continue the same active plan without rebuilding context from scratch. Revision checks prevent two sessions from silently overwriting each other.

## Team

| Agent | Responsibility | Default model |
|---|---|---|
| director | Coordinates work and maintains the shared plan | `opencode-go/deepseek-v4-pro` |
| explorer | Maps code, tests, and dependencies | `opencode-go/deepseek-v4-flash` |
| visualizer | Interprets screenshots and diagrams | `opencode-go/kimi-k2.7-code` |
| planner | Persists executable plans with integrated acceptance/tests | `openai/gpt-5.6-terra` |
| architect | QA of the plan: READY or REVISED before implementation | `openai/gpt-5.6-sol` |
| implementer | Edits code and runs relevant checks | `opencode-go/glm-5.2` |
| reviewer | Finds regressions, risks, and missing verification | `opencode-go/deepseek-v4-pro` |

Only implementer can use OpenCode's edit tool for application code. Implementer shell commands run without permission prompts, except destructive removal and package publishing commands, which remain blocked. Reviewer has unrestricted shell access for inspection and verification; director cannot edit or run shell commands.

Every specialist runs through OpenCode's native `task` tool, so planner and architect appear in the UI like any other subagent.

## Shared Plan

`.code-ensemble/TASKS.md` is the project-wide source of truth. Schema v2 fields:

- `version`: schema version (`2`)
- `id`: stable Plan ID (UUID) identifying this plan across sessions
- `revision`: integer incremented on every mutation; callers pass the current Plan ID and revision to detect conflicts
- `status`: `active` or `closed`
- `title`, `createdAt`, `updatedAt`: plan metadata
- `tasks[]`: ordered tasks with stable `id` (e.g. `T001`), `text` (action plus integrated acceptance/tests), `status` (`pending`/`in_progress`/`completed`/`blocked`), and optional `evidence`

There is no `approved` flag in schema v2. A plan becomes implementable as soon as the architect returns `READY`; no separate approval step exists.

```md
<!-- code-ensemble-plan
{"version":2,"id":"7e3f1a92-...","revision":4,"status":"active","title":"Dashboard","createdAt":"2026-07-20T12:00:00.000Z","updatedAt":"2026-07-20T12:05:00.000Z","tasks":[{"id":"T001","text":"Define the data model; schema tests pass","status":"completed","evidence":"schema tests pass"},{"id":"T002","text":"Implement the dashboard; renders without errors","status":"in_progress"},{"id":"T003","text":"Review responsive behavior; no layout regressions at common breakpoints","status":"pending"}]}
-->

# Plan: Dashboard

Status: **active**
Revision: **4**

## Tasks

- [x] **T001** Define the data model; schema tests pass
  - Evidence: schema tests pass
- [~] **T002** Implement the dashboard; renders without errors
- [ ] **T003** Review responsive behavior; no layout regressions at common breakpoints
```

## Plan Tool ACL

Only the `director` and the planning specialists can call `plan`; every other agent has `plan: deny`.

| Agent | Allowed `plan` actions |
|---|---|
| director | `get`, `create`, `update`, `add`, `close` |
| planner | `get`, `create` |
| architect | `get`, `replace` |
| explorer | none |
| visualizer | none |
| implementer | none |
| reviewer | none |

- `get` returns the active plan (or `No active plan.`).
- `create` writes a new plan and returns the initial `revision` (`1`); rejected when an active plan already exists.
- `replace` accepts the current `expectedPlanID` and `expectedRevision` plus the corrected `title` and `tasks`, and produces a new revision. Used only by the architect before implementation starts.
- `update`, `add`, and `close` require both `expectedPlanID` and `expectedRevision` to detect conflicts; only the director calls them.

The director is the only agent allowed to mutate plan status, tasks, and evidence. OpenCode todos may mirror current progress in the UI, but the Markdown file remains the durable source of truth.

## Plan Ownership

- **Planner** owns plan creation: it turns evidence into an actionable, ordered task list with integrated acceptance/tests and persists it with `create`.
- **Architect** owns plan correctness: it reviews the planner's plan with `get`, and either accepts it (`READY`) or corrects it with `replace` (`REVISED` + changes).
- **Director** owns plan lifecycle: it re-reads the plan after the architect, summarizes to the user, drives implementation through implementer/reviewer, records evidence with `update`, adds remediation with `add`, and archives completed work with `close`.

## Install

```sh
opencode plugin @cgize/code-ensemble@1.0.5
```

For a repository install, clone tag `v1.0.5`, run `npm ci --omit=dev`, then register the package root with `opencode plugin "file:///absolute/path/to/code-ensemble"`.

Restart OpenCode and select `director` from the agent selector.

## Configuration

Create `code-ensemble.json` in the project root only to override models or variants:

```json
{
  "models": {
    "planner": "openai/gpt-5.6-terra",
    "architect": "openai/gpt-5.6-sol"
  },
  "variants": {
    "planner": "xhigh",
    "architect": "xhigh"
  }
}
```

Every model identifier must use `provider/model` format.

## Development

```sh
npm run typecheck
npm test
npm run lint
npm run build
npm run smoke:package
```

## License

MIT
