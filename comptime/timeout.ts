/**
 * The message a comptime evaluation rejects with once it exceeds its budget.
 * Shared so the in-process timeout and the batch wrapper's inlined timeout,
 * which have to report the same thing for attribution, cannot drift apart.
 */
export function timeoutMessage(ms: number): string {
    return `comptime evaluation timed out after ${ms}ms`;
}

/**
 * Rejects with a timeout error if `promise` has not settled within `ms`, and
 * always clears the timer so a settled race does not keep the process alive.
 *
 * A synchronous infinite loop in the awaited work blocks the event loop and so
 * cannot be interrupted here - the timer only fires once control returns to the
 * loop, which is the same limit the platform imposes on any timeout.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<never>((_, reject) => {
        timerId = setTimeout(() => reject(new Error(timeoutMessage(ms))), ms);
    });
    try {
        return await Promise.race([promise, timer]);
    } finally {
        clearTimeout(timerId);
    }
}
