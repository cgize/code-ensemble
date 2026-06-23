# @crist/code-ensemble

A phase-based multi-agent orchestration plugin for OpenCode. Instead of one model doing everything, `code-ensemble` gives you a team of specialized agents, each with a different model, a different strength, and a clear role.

The **director** runs the workflow. It never touches files or shells. It delegates everything to subagents, tracks progress in structured markdown plans, and keeps you in the loop with phase transitions that require your approval.

---

## How it works

Every session follows a three-phase rhythm: **plan, implement, review**.

1. You describe what you want.
2. The **director** dispatches the **planner** (or **architect** for critical decisions), gets back a structured plan with tasks, risks, and test checkpoints, and saves it to disk.
3. You approve the plan. The phase transitions to implement.
4. The **implementer** makes the changes, the **tester** verifies them, and the director updates the plan's checkboxes as tasks complete.
5. If the task includes screenshots, diagrams, or image attachments, the director sends them to the **visualizer** before planning or implementation.
6. The director proposes a transition to review.
7. The **reviewer** inspects everything. If it finds blocking issues, the director loops back to the implementer automatically until the review is clean.
8. When the review passes, the director generates a session summary and a suggested commit message.

Every transition requires your confirmation. You're always in control.

---

## The team

| Agent | Model | Strengths | Can edit? |
|---|---|---|---|
| **director** | `deepseek-v4-pro` | Coordinates the ensemble, enforces phase rules | No |
| **explorer** | `deepseek-v4-flash` | Fast codebase search and file discovery | No |
| **researcher** | `deepseek-v4-flash` | Web and docs lookups for external context | No |
| **visualizer** | `mimo-v2.5` | Screenshots, diagrams, visual UI issues, image attachments | No |
| **planner** | `gpt-5.4` (xhigh) | Structured implementation plans with risks and checkpoints | No |
| **architect** | `gpt-5.5` (xhigh) | Critical architecture decisions, security trade-offs | No |
| **implementer** | `deepseek-v4-pro` | Minimum correct code changes with verification | Yes |
| **reviewer** | `glm-5.2` | Bug detection, regression analysis, edge cases | No |
| **tester** | `minimax-m3` | Targeted test execution with precise failure reporting | Yes |

Each model was chosen based on real benchmark data from LMArena Agent Arena and Vellum. The director and implementer use `deepseek-v4-pro` for a good balance of quality and cost. The planner uses `gpt-5.4` for reasoning quality. The architect brings in `gpt-5.5` only when a decision truly warrants the cost. The visualizer uses `mimo-v2.5` because it is a cheap vision-capable opencode-go model. The reviewer uses `glm-5.2`, which beats `gpt-5.4` on confirmed success rate. And `minimax-m3` handles testing with the lowest tool hallucination rate.

The explorer and researcher use `deepseek-v4-flash` because they just need to be fast.

---

## Image support

Most cheap code models do not reliably handle images. Instead of forcing every agent onto an expensive vision model, code-ensemble routes visual work to one dedicated subagent: **visualizer**.

When the user attaches a screenshot, UI capture, diagram, or other image, the director delegates that context to `visualizer`. It uses `opencode-go/mimo-v2.5`, analyzes the image, and returns technical findings the rest of the ensemble can use.

Example flow:

```
user + screenshot
  -> director
  -> visualizer: describes the UI issue
  -> explorer: finds likely files
  -> planner: creates the plan
  -> implementer: fixes it
  -> tester + reviewer
```

---

## Quota fallbacks

External subscription models like GPT or Claude have separate billing from the opencode-go provider. If a subscription model runs out of quota mid-session, the plugin automatically falls back to an opencode-go model:
- **planner** goes to `glm-5.2` (same agentic quality tier)
- **architect** goes to `deepseek-v4-pro` (solid reasoning, distinct quota pool)

You can override fallbacks per role in your project config.

---

## Plan persistence and progress tracking

Plans don't live in ephemeral chat context. The director saves every plan as a structured `.md` file under `.code-ensemble/artifacts/`. As tasks are completed, the director reads the plan back, flips `[ ]` to `[x]`, and saves it again.

This means plans survive context compaction, serve as documentation, and are always accurate about what's done and what's left.

Plans follow a consistent format:
```md
## Plan: {title}
### Tasks
- [ ] task 1
- [ ] task 2
### Risks
- risk 1
### Test Checkpoints
- [ ] checkpoint 1
CONFIDENCE: 8
```

---

## Confidence scoring

Every subagent reports a `CONFIDENCE` score from 1 to 10. The director watches these numbers. If any agent reports confidence below 5, the director escalates the decision to the **architect**. Low confidence on critical work deserves a second opinion from the most capable model.

---

## Auto-feedback loop

When the reviewer marks issues as `BLOCKING`, the director automatically dispatches the implementer to fix them, then sends the changes back to the reviewer. This loop repeats until no blocking issues remain. No manual intervention needed.

---

## Commands

| Command | What it does |
|---|---|
| `/phase-status` | Shows the current phase, pending transition, open issues, and review findings |
| `/approve-phase` | Confirms the pending phase transition |
| `/force-phase <phase>` | Jumps directly to a phase (bypasses confirmation) |
| `/reset-phase` | Resets the entire state machine back to plan |

---

## Installation

```json
{
  "plugin": [
    ["@crist/code-ensemble", { "configPath": "./code-ensemble.json" }]
  ]
}
```

The `configPath` is optional. If you skip it, the plugin uses the packaged defaults.

---

## Configuration

Create a `code-ensemble.json` in your project root:

```json
{
  "models": {
    "visualizer": "opencode-go/mimo-v2.5",
    "planner": "openai/gpt-5.4",
    "architect": "openai/gpt-5.5",
    "reviewer": "opencode-go/glm-5.2"
  },
  "variants": {
    "visualizer": "max",
    "planner": "xhigh",
    "architect": "xhigh",
    "reviewer": "max"
  },
  "fallbacks": {
    "planner": ["opencode-go/glm-5.2"],
    "architect": ["opencode-go/deepseek-v4-pro"]
  },
  "prompts": {
    "director": "./.code-ensemble/director.md"
  },
  "subagents": {
    "disable": ["researcher"],
    "rename": {
      "tester": "verifier"
    }
  },
  "transitions": {
    "reviewToPlanOnlyWithFindings": true
  }
}
```

- **`models`**: swap any agent's model
- **`variants`**: change the thinking variant (max, high, xhigh)
- **`fallbacks`**: ordered list of backup models when the primary is out of quota
- **`prompts`**: point any agent to a custom prompt file
- **`subagents.disable`**: remove agents you don't need
- **`subagents.rename`**: give agents names that fit your team's vocabulary
- **`transitions`**: when true, you can only transition from review back to plan if there are findings

---

## State

The plugin writes its runtime state to `.opencode/state/code-ensemble.json`.

---

## Architecture

```
┌──────────────────────────────────────┐
│              director                  │
│  (read-only, dispatches, tracks plans) │
└──────┬──────┬──────┬──────┬───────────┘
       │      │      │      │
       ▼      ▼      ▼      ▼
   planner  arch   impl   reviewer
       │      │      │      │
       ▼      ▼      ▼      ▼
   explorer  researcher  tester
```

The director is the only `primary` agent. All others are `subagent` mode. They execute in isolated contexts and return results back. The director never edits files or runs shell commands. It delegates, tracks, and decides.
