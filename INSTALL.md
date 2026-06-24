# Installing @cgize/code-ensemble

The plugin is installed as a local OpenCode plugin (not via the npm `plugin` array, which has compatibility limitations with scoped packages).

## 1. Create the plugin wrapper

`.opencode/plugins/code-ensemble.js`

```js
import codeEnsemblePlugin from "@cgize/code-ensemble";

export default async function codeEnsembleCompat(input) {
  return codeEnsemblePlugin(
    {
      ...input,
      worktree: input.worktree ?? input.directory,
    },
    { configPath: "./code-ensemble.json" },
  );
}
```

## 2. Create the plugin dependencies manifest

`.opencode/package.json`

```json
{
  "private": true,
  "type": "module",
  "dependencies": {
    "@cgize/code-ensemble": "0.0.6"
  }
}
```

## 3. Install plugin dependencies

From your project root:

```
npm install --prefix .opencode
```

## 4. Create the code-ensemble config

`code-ensemble.json` (project root)

```json
{
  "models": {},
  "variants": {},
  "fallbacks": {},
  "prompts": {},
  "subagents": {},
  "transitions": {
    "reviewToPlanOnlyWithFindings": true,
    "autoLoop": false,
    "autoLoopMaxIterations": 5
  }
}
```

## 5. Verify opencode.json

Your `opencode.json` (project root) only needs the schema reference:

```json
{
  "$schema": "https://opencode.ai/config.json"
}
```

## 6. Restart OpenCode

The plugin auto-loads from `.opencode/plugins/` with all 9 agents (director, planner, implementer, etc.) and commands (`/phase-status`, `/approve-phase`, etc.).
