import { randomUUID } from "node:crypto";
import { delegateWithFallback } from "./fallback.js";
import { formatDelegationResult, formatRunningDelegation } from "./present.js";
const DELEGATION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RESULT_LENGTH = 256 * 1024;
const DELIVERY_RETRY_WINDOW_MS = 10 * 60 * 1000;
const MAX_DELIVERY_RETRY_DELAY_MS = 30_000;
const STATUS_TIMEOUT_MS = 5_000;
class DelegationTimeoutError extends Error {
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
function payload(input) {
    return JSON.stringify(input, null, 2).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}
function raceWithAbort(promise, signal) {
    if (signal.aborted)
        return Promise.reject(signal.reason ?? new Error("Delegation aborted"));
    return new Promise((resolve, reject) => {
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        const onAbort = () => {
            cleanup();
            reject(signal.reason ?? new Error("Delegation aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then((value) => {
            cleanup();
            resolve(value);
        }, (error) => {
            cleanup();
            reject(error);
        });
    });
}
async function delay(milliseconds, signal) {
    if (signal?.aborted)
        throw signal.reason ?? new Error("Delegation aborted");
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, milliseconds);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason ?? new Error("Delegation aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
export class FallbackDelegator {
    client;
    active = new Map();
    disposed = false;
    constructor(client) {
        this.client = client;
    }
    start(input) {
        if (this.disposed)
            throw new Error("Delegator is disposed");
        // Only reject if the director turn is already cancelled before launch.
        // Do not bind context.abort for the job lifetime: OpenCode aborts the tool
        // signal when the director ends its turn, but planner/architect must keep
        // running and deliver the synthetic result via promptAsync.
        if (input.signal?.aborted) {
            throw input.signal.reason instanceof Error ? input.signal.reason : new Error("Delegation aborted");
        }
        const taskID = randomUUID();
        const controller = new AbortController();
        const lifecycleController = new AbortController();
        const job = this.run(taskID, input, controller, lifecycleController);
        this.active.set(taskID, { controller, lifecycleController, job });
        void job.finally(() => {
            this.active.delete(taskID);
        }).catch(() => undefined);
        return { taskID, output: formatRunningDelegation(taskID, input.role, input.description) };
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        for (const task of this.active.values()) {
            const reason = new Error("Plugin disposed");
            task.controller.abort(reason);
            task.lifecycleController.abort(reason);
        }
        await Promise.allSettled([...this.active.values()].map((task) => task.job));
        this.active.clear();
    }
    async run(taskID, input, controller, lifecycleController) {
        const timeout = setTimeout(() => controller.abort(new DelegationTimeoutError(`Delegation timed out after ${DELEGATION_TIMEOUT_MS / 60_000} minutes`)), DELEGATION_TIMEOUT_MS);
        timeout.unref?.();
        let state;
        let resultPayload;
        let timedOut = false;
        try {
            const result = await raceWithAbort(delegateWithFallback(this.client, { ...input, signal: controller.signal }), controller.signal);
            state = "completed";
            resultPayload = {
                description: input.description,
                model: result.model,
                usedFallback: result.usedFallback,
                output: result.output.slice(0, MAX_RESULT_LENGTH),
            };
        }
        catch (error) {
            timedOut = controller.signal.reason instanceof DelegationTimeoutError;
            if (this.disposed || (controller.signal.aborted && !timedOut))
                return;
            state = "error";
            resultPayload = {
                description: input.description,
                error: message(error),
            };
        }
        finally {
            clearTimeout(timeout);
        }
        if (this.disposed)
            return;
        try {
            await this.deliver(input.parentSessionID, taskID, input.role, state, resultPayload, lifecycleController.signal);
        }
        catch {
            // The child session remains in OpenCode history when delivery fails.
        }
    }
    async deliver(parentSessionID, taskID, role, state, result, signal) {
        const text = formatDelegationResult({
            taskID,
            role,
            state,
            description: typeof result.description === "string" ? result.description : undefined,
            model: typeof result.model === "string" ? result.model : undefined,
            usedFallback: result.usedFallback === true,
            output: typeof result.output === "string" ? result.output : undefined,
            error: typeof result.error === "string" ? result.error : undefined,
            // Keep a compact machine payload for the director without dumping raw XML walls.
            evidence: payload(result),
        });
        const started = Date.now();
        let lastError;
        let attempt = 0;
        while (Date.now() - started < DELIVERY_RETRY_WINDOW_MS) {
            try {
                if (await this.parentIsBusy(parentSessionID, signal))
                    throw new Error("Parent session is busy");
                const response = await this.client.session.promptAsync({
                    path: { id: parentSessionID },
                    body: { messageID: `msg_${taskID}`, agent: "director", parts: [{ type: "text", text, synthetic: true }] },
                    signal: signal
                        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
                        : AbortSignal.timeout(30_000),
                });
                if (response.error)
                    throw response.error;
                return;
            }
            catch (error) {
                lastError = error;
                if (signal?.aborted)
                    throw error;
                const remaining = DELIVERY_RETRY_WINDOW_MS - (Date.now() - started);
                if (remaining <= 0)
                    break;
                const retryDelay = Math.min(250 * 2 ** attempt, MAX_DELIVERY_RETRY_DELAY_MS, remaining);
                await delay(retryDelay, signal);
                attempt += 1;
            }
        }
        throw lastError;
    }
    async parentIsBusy(parentSessionID, signal) {
        try {
            const status = await this.client.session.status({
                signal: signal
                    ? AbortSignal.any([signal, AbortSignal.timeout(STATUS_TIMEOUT_MS)])
                    : AbortSignal.timeout(STATUS_TIMEOUT_MS),
            });
            if (status.error)
                return false;
            const parentStatus = status.data?.[parentSessionID];
            return !!parentStatus && parentStatus.type !== "idle";
        }
        catch (error) {
            if (signal?.aborted)
                throw error;
            // Older OpenCode clients may not expose session.status; promptAsync can still be attempted safely.
            return false;
        }
    }
}
//# sourceMappingURL=delegate.js.map