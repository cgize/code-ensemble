import type { SharedPlan } from "./plans.js";
export declare function planToolTitle(args: {
    action: string;
    title?: string;
    taskID?: string;
    status?: string;
}): string;
export declare function formatToolError(message: string): {
    title: string;
    output: string;
};
export declare function formatPlanOutput(plan: SharedPlan | null): string;
export declare function formatClosedPlanOutput(plan: SharedPlan, archived: string): string;
//# sourceMappingURL=present.d.ts.map