import micromatch from 'micromatch';

export type ComptimeOptions = {
    include?: string | string[];
    exclude?: string | string[];
    timeout?: number;
    innerPlugins?: unknown[];
    serializers?: Array<{
        test: (value: unknown) => boolean;
        serialize: (value: unknown) => string;
    }>;
};

const SUPPORTED_EXTENSIONS = new Set([
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
]);

export function shouldScan(code: string, id: string, options: ComptimeOptions): boolean {
    if (id.startsWith('\0')) return false;
    const dotIdx = id.lastIndexOf('.');
    if (dotIdx === -1 || !SUPPORTED_EXTENSIONS.has(id.slice(dotIdx))) return false;
    if (!code.includes('comptime')) return false;
    if (options.exclude && micromatch.isMatch(id, options.exclude)) return false;
    if (options.include && !micromatch.isMatch(id, options.include)) return false;
    return true;
}
