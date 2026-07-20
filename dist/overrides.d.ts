import type { CodeEnsemblePluginOptions, CodeEnsembleProjectOverrides, ResolvedCodeEnsembleConfig } from "./types.js";
declare class ConfigValidationError extends Error {
    constructor(path: string, got: unknown, want: string);
}
export declare function parseOverrides(raw: unknown): CodeEnsembleProjectOverrides;
export declare function resolveCodeEnsembleConfig(worktree: string, options?: CodeEnsemblePluginOptions, metaUrl?: string): ResolvedCodeEnsembleConfig;
export { ConfigValidationError };
//# sourceMappingURL=overrides.d.ts.map