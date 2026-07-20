# @cgize/code-ensemble

`code-ensemble` turns OpenCode into a focused software team while keeping one durable tasklist for the whole project.

## Workflow

1. The director reads `.code-ensemble/TASKS.md` on every turn.
2. Explorer and visualizer gather repository or image evidence when needed.
3. Planner creates the implementation plan; architect handles high-risk decisions.
4. The director writes the accepted tasks to the shared Markdown tasklist and asks for approval.
5. Implementer completes tasks and verification while the director records evidence.
6. Reviewer reports blocking findings. Remediation tasks are added to the same tasklist.
7. A clean, completed plan is archived under `.code-ensemble/plans/`.

The tasklist is scoped to the worktree, not to one OpenCode conversation. A new session can continue the same active plan without rebuilding context from scratch. Revision checks prevent two sessions from silently overwriting each other.

## Team

| Agent | Responsibility | Default model |
|---|---|---|
| director | Coordinates work and maintains the shared plan | `opencode-go/minimax-m3` |
| explorer | Maps code, tests, and dependencies | `opencode-go/deepseek-v4-flash` |
| visualizer | Interprets screenshots and diagrams | `opencode-go/kimi-k2.7-code` |
| planner | Produces executable plans and researches dependencies | `openai/gpt-5.6-terra` |
| architect | Resolves architecture, security, and compatibility decisions | `openai/gpt-5.6-sol` |
| implementer | Edits code and runs relevant checks | `opencode-go/glm-5.2` |
| reviewer | Finds regressions, risks, and missing verification | `opencode-go/deepseek-v4-pro` |

Only implementer can edit application code. The director cannot edit or run shell commands.

## Model Fallbacks

Planner and architect use `code_ensemble_delegate`, which runs without blocking the OpenCode UI. If the primary model fails because of quota, rate limits, availability, subscription, or access restrictions, configured fallback models are tried in order. Unrelated errors are not retried.

## Shared Plan

The generated `.code-ensemble/TASKS.md` contains stable task IDs, status, approval, revision, and evidence:

```md
# Plan: Dashboard

Status: **active**
Approved: **yes**
Revision: **6**

## Tasks

- [x] **T001** Define the data model
  - Evidence: schema tests pass
- [~] **T002** Implement the dashboard
- [ ] **T003** Review responsive behavior
```

The director is the only agent allowed to mutate this file through `code_ensemble_plan`. OpenCode todos may mirror current progress in the UI, but the Markdown file remains the durable source of truth.

## Install

```sh
opencode plugin @cgize/code-ensemble@1.0.3
```

The same release can be installed directly from GitHub with `opencode plugin "github:cgize/code-ensemble#v1.0.3"`.

Restart OpenCode and select `director` from the agent selector.

## Configuration

Create `code-ensemble.json` in the project root only to override models, variants, or fallbacks:

```json
{
  "models": {
    "planner": "openai/gpt-5.6-terra",
    "architect": "openai/gpt-5.6-sol"
  },
  "variants": {
    "planner": "xhigh",
    "architect": "xhigh"
  },
  "fallbacks": {
    "planner": ["opencode-go/glm-5.2"],
    "architect": ["opencode-go/glm-5.2"]
  }
}
```

Every model identifier must use `provider/model` format. Fallbacks are supported only for planner and architect.

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
