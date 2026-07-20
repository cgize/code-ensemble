# Installing @cgize/code-ensemble

## Project Installation

```sh
opencode plugin @cgize/code-ensemble@1.0.2
```

## Global Installation

```sh
opencode plugin --global @cgize/code-ensemble@1.0.2
```

## GitHub Installation

Install the same release directly from the repository:

```sh
opencode plugin "github:cgize/code-ensemble#v1.0.2"
```

Restart OpenCode after installation or configuration changes, then select `director`.

## Optional Configuration

Create `code-ensemble.json` in the worktree root:

```json
{
  "models": {
    "visualizer": "opencode-go/kimi-k2.7-code",
    "planner": "openai/gpt-5.6-terra",
    "architect": "openai/gpt-5.6-sol",
    "reviewer": "opencode-go/deepseek-v4-pro"
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

Only `models`, `variants`, and `fallbacks` are accepted. The plugin creates `.code-ensemble/TASKS.md` when the director accepts a plan and archives completed plans under `.code-ensemble/plans/`.
