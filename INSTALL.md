# Installing @cgize/code-ensemble

The plugin is a normal OpenCode npm plugin. Install it with OpenCode so the package and configuration are handled together.

## 1. Install the plugin

Run this from the project where you want to use the ensemble:

```sh
opencode plugin @cgize/code-ensemble@0.0.9
```

OpenCode installs the package and updates `.opencode/opencode.json` automatically. Pinning the concrete package version prevents an older unversioned cache entry from being reused.

For every project on the machine, install it globally instead:

```sh
opencode plugin --global @cgize/code-ensemble@0.0.9
```

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

## 3. Start OpenCode

The plugin auto-loads with all 9 agents (director, planner, implementer, etc.) and commands (`/phase-status`, `/approve-phase`, etc.). The `director` is a primary agent and appears in OpenCode's agent selector without additional configuration.

## Internal helpers

Advanced programmatic access to state machines, config resolution, and prompt formatters is available at the subpath export `@cgize/code-ensemble/internal`. This subpath is not loaded by OpenCode, so it is safe to import from local scripts or tests without affecting the plugin lifecycle.
