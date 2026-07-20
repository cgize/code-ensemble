export type RoleName = "director" | "explorer" | "visualizer" | "planner" | "architect" | "implementer" | "reviewer";
export interface RoleDefaults {
    model: string;
    variant?: string;
    mode: "primary" | "subagent";
    promptFile: string;
}
export interface CodeEnsembleDefaults {
    roles: Record<RoleName, RoleDefaults>;
}
export interface CodeEnsemblePluginOptions {
    configPath?: string;
}
export interface CodeEnsembleProjectOverrides {
    models?: Partial<Record<RoleName, string>>;
    variants?: Partial<Record<RoleName, string>>;
}
export interface ResolvedRoleConfig extends RoleDefaults {
    promptText: string;
}
export interface ResolvedCodeEnsembleConfig {
    roles: Record<RoleName, ResolvedRoleConfig>;
}
//# sourceMappingURL=types.d.ts.map