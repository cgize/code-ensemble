# Installing @cgize/code-ensemble

The plugin is a normal OpenCode npm plugin. Add it to your `opencode.json` and OpenCode installs, caches, and loads it automatically.

## 1. Configure opencode.json

Add the plugin to your project config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@cgize/code-ensemble"]
}
```

The first time you start OpenCode, it will install the plugin via Bun into `~/.cache/opencode/packages/`.

## 2. (Optional) Override defaults

Create a `code-ensemble.json` in your project root to swap models, add fallbacks, or change the director prompt:

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
  },
  "prompts": {
    "director": "./.code-ensemble/director.md"
  },
  "subagents": {
    "disable": ["researcher"],
    "rename": { "tester": "verifier" }
  },
  "transitions": {
    "reviewToPlanOnlyWithFindings": true,
    "autoLoop": false,
    "autoLoopMaxIterations": 5
  }
}
```

## 3. Restart OpenCode

The plugin auto-loads with all 9 agents (director, planner, implementer, etc.) and commands (`/phase-status`, `/approve-phase`, etc.).

## Internal helpers

Advanced programmatic access to state machines, config resolution, and prompt formatters is available at the subpath export `@cgize/code-ensemble/internal`. This subpath is not loaded by OpenCode, so it is safe to import from local scripts or tests without affecting the plugin lifecycle.
