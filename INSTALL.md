# Installing @cgize/code-ensemble

## Project Installation

```sh
opencode plugin @cgize/code-ensemble@1.0.4
```

## Global Installation

```sh
opencode plugin --global @cgize/code-ensemble@1.0.4
```

## Repository Installation

Clone the release and install its runtime dependencies:

```sh
git clone --branch v1.0.4 https://github.com/cgize/code-ensemble.git
npm --prefix code-ensemble ci --omit=dev
```

Then register the cloned package from the project where you use OpenCode:

```sh
opencode plugin "file:///absolute/path/to/code-ensemble"
```

OpenCode's plugin command accepts npm packages and local package paths; it does not accept Git dependency specs directly.

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
  }
}
```

Only `models` and `variants` are accepted. The plugin creates `.code-ensemble/TASKS.md` when the director accepts a plan and archives completed plans under `.code-ensemble/plans/`.
