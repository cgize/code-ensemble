import type { ResolvedCodeEnsembleConfig } from "./types.js";

export function buildCommandDefinitions(config: ResolvedCodeEnsembleConfig) {
  return {
    "phase-status": {
      description: "Show the current code-ensemble phase state.",
      agent: "director",
      template: config.commandTemplates["phase-status"],
    },
    "approve-phase": {
      description: "Approve the pending code-ensemble phase transition.",
      agent: "director",
      template: config.commandTemplates["approve-phase"],
    },
    "force-phase": {
      description: "Force the current code-ensemble phase.",
      agent: "director",
      template: config.commandTemplates["force-phase"],
    },
    "reset-phase": {
      description: "Reset code-ensemble back to the plan phase.",
      agent: "director",
      template: config.commandTemplates["reset-phase"],
    },
  };
}
