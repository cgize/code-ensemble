import type { PluginInput } from "@opencode-ai/plugin";
import type { FallbackRole } from "./types.js";
type StartInput = {
    parentSessionID: string;
    description: string;
    prompt: string;
    role: FallbackRole;
    primaryAgent: string;
    primaryModel: string;
    fallbackModels: string[];
    signal?: AbortSignal;
};
export declare function formatRunningDelegation(taskID: string, description: string): string;
export declare class FallbackDelegator {
    private readonly client;
    private readonly active;
    private disposed;
    constructor(client: PluginInput["client"]);
    start(input: StartInput): {
        taskID: string;
        output: string;
    };
    dispose(): Promise<void>;
    private run;
    private deliver;
}
export {};
//# sourceMappingURL=delegate.d.ts.map