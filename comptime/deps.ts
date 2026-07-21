import { createHash } from 'node:crypto';
import { dirname } from '@std/path';

/**
 * Stamp for a dependency that cannot be read: missing, a directory, permission
 * denied, anything. Being unreadable is a legitimate observed state, not an
 * error: the evaluation that produced the cached literal saw the same thing, so
 * an entry recorded while a dependency was unreadable stays valid for as long as
 * it stays unreadable, and is invalidated the moment it becomes readable. An
 * unreadable dependency therefore never fails the build and never disables
 * caching. Cannot collide with a real stamp, which is hex.
 */
const UNREADABLE_STAMP = '\0unreadable';

/**
 * Content stamp of a single dependency. Never throws, and never holds the file
 * in memory: a watched asset can be arbitrarily large and is re-read on every
 * cache hit, so it is digested incrementally as it streams.
 */
async function stampFile(path: string): Promise<string> {
    let file: Deno.FsFile;
    try {
        file = await Deno.open(path, { read: true });
    } catch {
        return UNREADABLE_STAMP;
    }
    const hash = createHash('sha256');
    // One reused buffer rather than `file.readable`, which allocates a fresh
    // chunk per read: measured on a 300MB dependency, this is ~480ms and no
    // resident growth against ~1.2s and tens of megabytes.
    const buf = new Uint8Array(1 << 20);
    try {
        while (true) {
            const n = await file.read(buf);
            if (n === null) break;
            hash.update(buf.subarray(0, n));
        }
    } catch {
        // Opening a directory succeeds on Unix and only fails on read, so this
        // is a normal path, not an exceptional one.
        return UNREADABLE_STAMP;
    } finally {
        file.close();
    }
    return hash.digest('hex');
}

export async function stampAll(paths: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(paths)];
    const stamps = await Promise.all(unique.map(stampFile));
    return new Map(unique.map((p, i) => [p, stamps[i]]));
}

/** Re-stamps a cache entry's dependencies and reports whether all still match. */
export async function depsUnchanged(deps: Map<string, string>): Promise<boolean> {
    if (deps.size === 0) return true;
    const entries = [...deps];
    const current = await Promise.all(entries.map(([path]) => stampFile(path)));
    return entries.every(([, stamp], i) => current[i] === stamp);
}

/**
 * Filesystem timestamps are not always fine-grained: many report whole seconds,
 * and FAT/exFAT report whole *two*-second stamps, so a write can be reported as
 * up to 1.999s earlier than it happened. A write is therefore treated as
 * concurrent with an evaluation when it lands anywhere within this window before
 * the evaluation began. Being wrong this way only costs a re-evaluation.
 */
const TIMESTAMP_SLACK_MS = 2_000;

/**
 * Whether a stat shows the entry was last touched before `cutoff`.
 *
 * mtime alone is not enough, because it is settable from userspace: `cp -p`,
 * `rsync --times` and editors that preserve timestamps can leave it unchanged or
 * move it backwards across a write. ctime cannot be set, and `utimes` bumps it
 * as a side effect of rewriting mtime, so taking the later of the two also
 * covers preserved mtimes, backwards mtimes and replacement-by-rename. What
 * remains is a filesystem clock genuinely running behind this process.
 */
function settledBefore(stat: Deno.FileInfo, cutoff: number): boolean {
    if (stat.mtime === null) return false;
    return Math.max(stat.mtime.getTime(), stat.ctime?.getTime() ?? 0) < cutoff;
}

/**
 * Whether none of `paths` was written during an evaluation that began at
 * `startedAt`.
 *
 * `watch()` paths are only known once evaluation has finished, so unlike hoisted
 * imports they cannot be stamped before it. A file edited between the callback
 * reading it and that stamp being taken would pair the OLD literal with the NEW
 * stamp, and the resulting entry would look valid forever. Timestamps are what
 * tell the two cases apart. Answering "modified" when in doubt only costs a
 * re-evaluation.
 */
export async function allUnmodifiedDuring(
    paths: string[],
    startedAt: number,
): Promise<boolean> {
    const cutoff = startedAt - TIMESTAMP_SLACK_MS;
    const results = await Promise.all(
        paths.map(async (path) => {
            try {
                return settledBefore(await Deno.stat(path), cutoff);
            } catch {
                // Not there. Removing a file bumps the mtime of the directory
                // that held it, which is what separates "deleted while the
                // callback ran" from "never existed" - the latter stamps as
                // unreadable and is perfectly cacheable.
                try {
                    return settledBefore(await Deno.stat(dirname(path)), cutoff);
                } catch {
                    // The directory is gone too, leaving nothing to compare
                    // against: a whole tree removed mid-evaluation is not seen.
                    return true;
                }
            }
        }),
    );
    return results.every(Boolean);
}
