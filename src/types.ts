export type Phase = "plan" | "implement" | "review";

export interface TransitionHistoryEntry {
  from: Phase;
  to: Phase;
  at: string;
  summary: string;
}

export interface CodeSwarmState {
  phase: Phase;
  proposedNextPhase: Phase | null;
  confirmationPending: boolean;
  history: TransitionHistoryEntry[];
  lastPlanSummary: string;
  lastReviewFindings: string[];
  openIssues: string[];
}

export type RoleName =
  | "orchestrator"
  | "explorer"
  | "researcher"
  | "planner"
  | "implementer"
  | "reviewer"
  | "tester";

export interface RoleDefaults {
  model: string;
  variant: string;
  mode: "primary" | "subagent";
  promptFile: string;
}

export interface CodeSwarmDefaults {
  stateFile: string;
  roles: Record<RoleName, RoleDefaults>;
  commands: Record<"phase-status" | "approve-phase" | "force-phase" | "reset-phase", string>;
  transitions: {
    reviewToPlanOnlyWithFindings: boolean;
  };
}

export interface CodeSwarmPluginOptions {
  configPath?: string;
}

export interface CodeSwarmProjectOverrides {
  models?: Partial<Record<RoleName, string>>;
  variants?: Partial<Record<RoleName, string>>;
  prompts?: Partial<Record<RoleName, string>>;
  subagents?: {
    disable?: Array<Exclude<RoleName, "orchestrator">>;
    rename?: Partial<Record<Exclude<RoleName, "orchestrator">, string>>;
  };
  transitions?: {
    reviewToPlanOnlyWithFindings?: boolean;
  };
}

export interface ResolvedRoleConfig extends RoleDefaults {
  promptText: string;
}

export interface ResolvedCodeSwarmConfig {
  stateFile: string;
  roles: Record<RoleName, ResolvedRoleConfig>;
  promptText: Record<RoleName, string>;
  commandTemplates: Record<"phase-status" | "approve-phase" | "force-phase" | "reset-phase", string>;
  disabledSubagents: Array<Exclude<RoleName, "orchestrator">>;
  renamedSubagents: Partial<Record<Exclude<RoleName, "orchestrator">, string>>;
  transitions: {
    reviewToPlanOnlyWithFindings: boolean;
  };
}
