import type { FallbackRole } from "./types.js";
type ClientResponse<T> = {
    data?: T;
    error?: unknown;
};
type FallbackClient = {
    session: {
        create(input: {
            body: {
                parentID: string;
                title: string;
            };
            signal?: AbortSignal;
        }): Promise<ClientResponse<{
            id: string;
        }>>;
        prompt(input: {
            path: {
                id: string;
            };
            body: {
                agent: string;
                parts: Array<{
                    type: "text";
                    text: string;
                }>;
            };
            signal?: AbortSignal;
        }): Promise<ClientResponse<{
            info: {
                error?: unknown;
            };
            parts: Array<{
                type: string;
                text?: string;
            }>;
        }>>;
        abort?(input: {
            path: {
                id: string;
            };
            signal?: AbortSignal;
        }): Promise<ClientResponse<boolean>>;
    };
};
export type DelegationResult = {
    output: string;
    sessionID: string;
    model: string;
    usedFallback: boolean;
};
export declare function isFallbackEligibleError(error: unknown): boolean;
export declare function fallbackAgentName(role: FallbackRole, index?: number): string;
export declare function delegateWithFallback(client: FallbackClient, input: {
    parentSessionID: string;
    description: string;
    prompt: string;
    role: FallbackRole;
    primaryAgent: string;
    primaryModel: string;
    fallbackModels: string[];
    signal?: AbortSignal;
}): Promise<DelegationResult>;
export {};
//# sourceMappingURL=fallback.d.ts.map