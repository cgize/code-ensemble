import type { ResolvedCodeSwarmConfig } from "./types.js";

export function buildCommandDefinitions(config: ResolvedCodeSwarmConfig) {
  return {
    "phase-status": {
      description: "Show the current code-swarm phase state.",
      agent: "orchestrator",
      template: config.commandTemplates["phase-status"],
    },
    "approve-phase": {
      description: "Approve the pending code-swarm phase transition.",
      agent: "orchestrator",
      template: config.commandTemplates["approve-phase"],
    },
    "force-phase": {
      description: "Force the current code-swarm phase.",
      agent: "orchestrator",
      template: config.commandTemplates["force-phase"],
    },
    "reset-phase": {
      description: "Reset code-swarm back to the plan phase.",
      agent: "orchestrator",
      template: config.commandTemplates["reset-phase"],
    },
  };
}
