export type Phase = "plan" | "implement" | "review";

export interface TransitionHistoryEntry {
  from: Phase;
  to: Phase;
  at: string;
  summary: string;
}

export interface CodeEnsembleState {
  phase: Phase;
  proposedNextPhase: Phase | null;
  confirmationPending: boolean;
  history: TransitionHistoryEntry[];
  lastPlanSummary: string;
  lastReviewFindings: string[];
  openIssues: string[];
  autoLoop: boolean;
  autoLoopMaxIterations: number;
  loopIteration: number;
  pendingPlanSummary: string;
  pendingReviewFindings: string[];
  pendingOpenIssues: string[];
}

export type RoleName =
  | "director"
  | "explorer"
  | "researcher"
  | "visualizer"
  | "planner"
  | "architect"
  | "implementer"
  | "reviewer"
  | "tester";

export interface RoleDefaults {
  model: string;
  variant?: string;
  mode: "primary" | "subagent";
  promptFile: string;
  fallbacks?: string[];
}

export interface CodeEnsembleDefaults {
  stateFile: string;
  roles: Record<RoleName, RoleDefaults>;
  commands: Record<"phase-status" | "approve-phase" | "force-phase" | "reset-phase" | "auto-loop", string>;
  transitions: {
    reviewToPlanOnlyWithFindings: boolean;
    autoLoop: boolean;
    autoLoopMaxIterations: number;
  };
}

export interface CodeEnsemblePluginOptions {
  configPath?: string;
}

export interface CodeEnsembleProjectOverrides {
  models?: Partial<Record<RoleName, string>>;
  variants?: Partial<Record<RoleName, string>>;
  fallbacks?: Partial<Record<RoleName, string[]>>;
  prompts?: Partial<Record<RoleName, string>>;
  subagents?: {
    disable?: Array<Exclude<RoleName, "director">>;
    rename?: Partial<Record<Exclude<RoleName, "director">, string>>;
  };
  transitions?: {
    reviewToPlanOnlyWithFindings?: boolean;
    autoLoop?: boolean;
    autoLoopMaxIterations?: number;
  };
}

export interface ResolvedRoleConfig extends RoleDefaults {
  promptText: string;
}

export interface ResolvedCodeEnsembleConfig {
  stateFile: string;
  roles: Record<RoleName, ResolvedRoleConfig>;
  promptText: Record<RoleName, string>;
  fallbacks: Record<RoleName, string[]>;
  commandTemplates: Record<"phase-status" | "approve-phase" | "force-phase" | "reset-phase" | "auto-loop", string>;
  disabledSubagents: Array<Exclude<RoleName, "director">>;
  renamedSubagents: Partial<Record<Exclude<RoleName, "director">, string>>;
  transitions: {
    reviewToPlanOnlyWithFindings: boolean;
    autoLoop: boolean;
    autoLoopMaxIterations: number;
  };
}
