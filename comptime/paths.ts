import { resolve } from '@std/path';

export function normalizeToForwardSlashes(p: string): string {
    return p.replace(/\\/g, '/');
}

function isWindowsDrivePath(p: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(p);
}

export function isLocalFile(p: string): boolean {
    return p.startsWith('/') || isWindowsDrivePath(p);
}

/**
 * Whether `p` carries a URI scheme (`npm:`, `jsr:`, `node:`, `http:`, ...) and so
 * does not name a file on disk. Requires at least two characters before the
 * colon, which is what keeps a Windows drive path (`C:/x`) out.
 */
export function hasUriScheme(p: string): boolean {
    return /^[A-Za-z][A-Za-z0-9+.-]+:/.test(p);
}

export function resolveSpecifier(spec: string, fileDir: string): string {
    // Bare module specifier (npm:, jsr:, etc.)
    if (!spec.startsWith('.') && !spec.startsWith('/') && !isWindowsDrivePath(spec))
        return spec;
    // native resolve handles both POSIX and Windows drive-letter paths;
    // normalize output to forward slashes for consistency.
    return normalizeToForwardSlashes(resolve(fileDir, spec));
}
