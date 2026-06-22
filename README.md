# @crist/code-swarm

Phase-based OpenCode plugin with one visible `orchestrator` agent and shared subagents for planning, implementation, review, testing, research, and exploration.

## Local development in this repo

Add this plugin entry to `opencode.json`:

```json
{
  "plugin": [
    ["./packages/code-swarm/src/index.ts", { "configPath": "./code-swarm.json" }]
  ]
}
```

The `configPath` file is optional. If it does not exist, the plugin uses packaged defaults.

## Published usage

```json
{
  "plugin": [
    ["@crist/code-swarm", { "configPath": "./code-swarm.json" }]
  ]
}
```

## State file

The plugin persists runtime state to `.opencode/state/code-swarm.json`.

## Commands

- `/phase-status`
- `/approve-phase`
- `/force-phase <phase>`
- `/reset-phase`
