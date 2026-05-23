export function comptime<T>(_fn: () => T | Promise<T>): T {
    throw new Error('comptime() must be replaced by the rolldown plugin before runtime');
}

export function watch(_path: string): void {}
