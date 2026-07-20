import type { SharedPlan } from "./plans.js";
export declare function planToolTitle(args: {
    action: string;
    title?: string;
    taskID?: string;
    status?: string;
}): string;
export declare function delegateToolTitle(role: string, description: string): string;
export declare function formatToolError(message: string): {
    title: string;
    output: string;
};
export declare function formatPlanOutput(plan: SharedPlan | null): string;
export declare function formatClosedPlanOutput(plan: SharedPlan, archived: string): string;
export declare function formatRunningDelegation(taskID: string, role: string, description: string): string;
export declare function formatDelegationResult(input: {
    taskID: string;
    role: string;
    state: "completed" | "error";
    description?: string;
    model?: string;
    usedFallback?: boolean;
    output?: string;
    error?: string;
    evidence: string;
}): string;
//# sourceMappingURL=present.d.ts.map