Parse `$1` before calling the tool:
- `on`, `true`, `enable`, `enabled`, `yes` -> `enabled: true`
- `off`, `false`, `disable`, `disabled`, `no` -> `enabled: false`

Use `code_ensemble_auto_loop` with the parsed boolean.
Then summarize whether auto-loop is now active, the iteration cap (from config), and that the director will skip confirmations and proceed through plan -> implement -> review until either the work is clean or the cap is hit. The cap can only be changed by editing `code-ensemble.json`.
