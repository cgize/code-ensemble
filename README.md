# @cgize/code-ensemble

`code-ensemble` turns OpenCode into a small software team.

Instead of asking one agent to plan, edit, test, and review everything, you describe the outcome you want and the plugin coordinates specialists for each part of the work. You remain in control of the important handoffs.

## What it helps with

Use it when a change needs more than a quick edit:

- Plan a feature before changing code.
- Investigate an unfamiliar codebase.
- Turn a screenshot or diagram into an actionable implementation plan.
- Implement a change, run focused checks, and review the result.
- Keep a written record of the plan, progress, findings, and remaining work.

It is designed for normal development work: bug fixes, features, refactors, reviews, and UI issues.

## What happens in a session

1. Tell OpenCode what you want to change.
2. The director asks the right specialists to inspect the codebase, research a dependency, or understand an image.
3. The planner produces a practical plan with tasks, risks, and test checkpoints.
4. You approve the plan before implementation starts.
5. The implementer makes the changes while the tester runs relevant checks.
6. The reviewer looks for bugs, regressions, and missing tests.
7. If the review finds blocking issues, the team fixes them and reviews again.
8. When the work is clean, you get a summary and a suggested commit message.

The plan is saved under `.code-ensemble/artifacts/`, so it survives long conversations and gives you a useful record of the work.

## You stay in control

By default, the plugin pauses between plan, implementation, and review so you can approve the next phase. The director coordinates the work but does not edit files or run commands itself.

Only the implementer can edit. Shell commands require approval for every specialist, including commands that appear read-only, because shell tools can bypass file protections.

For routine work, you can enable auto-loop. It runs the full plan, implement, and review cycle without asking at every handoff, but it never skips review and stops after the configured number of fix cycles.

```text
/auto-loop on
/auto-loop off
```

## Images and UI work

When you attach a screenshot, diagram, or visual bug report, the visualizer examines it first. It returns a shared text description for the rest of the team, so the planner and implementer work from the same interpretation instead of guessing from the image.

```text
Screenshot or mockup
  -> visualizer explains the issue
  -> explorer finds the relevant code
  -> planner proposes the change
  -> implementer, tester, and reviewer finish it
```

## The team

| Agent | What it does | Default model |
|---|---|---|
| director | Coordinates the workflow and tracks progress | `opencode-go/minimax-m3` |
| explorer | Finds relevant files and code paths | `opencode-go/deepseek-v4-flash` |
| researcher | Looks up external documentation and dependencies | `opencode-go/qwen3.7-plus` |
| visualizer | Interprets screenshots, diagrams, and UI issues | `opencode-go/kimi-k2.7-code` |
| planner | Produces the implementation plan | `openai/gpt-5.6-terra` (`xhigh`) |
| architect | Handles important technical or security decisions | `openai/gpt-5.6-sol` (`xhigh`) |
| implementer | Makes focused code changes | `opencode-go/glm-5.2` |
| reviewer | Finds bugs, regressions, and missing coverage | `opencode-go/deepseek-v4-pro` |
| tester | Runs targeted checks and explains failures | `opencode-go/mimo-v2.5` |

The defaults favor OpenCode Go for everyday work. ChatGPT models are reserved for planning and higher-risk architecture decisions.

## If a ChatGPT model is unavailable

The planner and architect can each have an ordered list of backup models. The defaults use `opencode-go/glm-5.2`.

If OpenCode reports that a model request is out of quota, rate-limited, unavailable, blocked by the user's plan, or inaccessible to that account, the plugin repeats that delegated task with each configured backup model in order.

It does not retry unrelated failures such as invalid credentials, cancelled requests, tool errors, timeouts, or server errors.

## Install

Install the plugin through OpenCode:

```sh
opencode plugin @cgize/code-ensemble@0.0.9
```

The command installs the package and updates the project configuration automatically. The concrete version prevents OpenCode from reusing a stale unversioned package cache. Start OpenCode and select `director` from the primary-agent selector. See [INSTALL.md](INSTALL.md) for global installation and customization.

## Useful commands

| Command | Use it to |
|---|---|
| `/phase-status` | See the current phase, open issues, and latest review findings |
| `/approve-phase` | Approve the next phase |
| `/force-phase <phase>` | Move directly to plan, implement, or review, bypassing the normal transition graph |
| `/reset-phase` | Start the workflow over from planning |
| `/auto-loop on\|off` | Enable or disable automatic phase handoffs |

## Customize a project

Create `code-ensemble.json` in the project root only when you want to change the defaults. For example, you can swap a model, change the planner's reasoning level, disable an agent, or change the auto-loop limit.

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
  },
  "subagents": {
    "disable": ["researcher"]
  },
  "transitions": {
    "autoLoop": false,
    "autoLoopMaxIterations": 5
  }
}
```

- `models`: Choose a different model for an agent.
- `variants`: Set the reasoning level when the model supports it.
- `fallbacks`: Set the backup model for planner or architect quota, access, or availability failures.
- `subagents.disable`: Remove specialists your project does not need.
- `subagents.rename`: Rename a specialist for your team's vocabulary.
- Project prompt paths must resolve inside the worktree, including through symlinks. External prompt files require the trusted plugin option `allowExternalPrompts: true`.
- `transitions.autoLoop`: Skip confirmation between phases.
- `transitions.autoLoopMaxIterations`: Limit review-to-implementation fix cycles.

The plugin migrates an existing `.opencode/state/code-ensemble.json` and legacy artifacts once, then stores isolated data per root OpenCode conversation below `.opencode/state/` and `.code-ensemble/artifacts/`. Calls to the advanced `./internal` state API should pass a `sessionID` after migration.
