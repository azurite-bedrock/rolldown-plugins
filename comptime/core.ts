import { createHash } from 'node:crypto';
import { dirname } from '@std/path';
import MagicString from 'magic-string';
import type { RolldownEvaluator, EvaluateResult } from './evaluator.ts';
import {
    parseSync,
    shouldScan,
    collectComptimeBindings,
    findComptimeCalls,
    collectImportBindings,
    collectTopLevelDeclarations,
    collectIdentifierReferences,
    collectDenoEnvReads,
    ComptimeTransformError,
    normalizeToForwardSlashes,
    hasUriScheme,
    isLocalFile,
    resolveSpecifier,
    type ComptimeOptions,
    type Loc,
    type TopLevelDecl,
} from './ast.ts';
import { createVirtualModule, contentHash, serializeValue } from './virtual.ts';

export type TransformContext = { addWatchFile?: (id: string) => void };
export type TransformResult = { code: string; map: unknown };

export type ComptimeCore = {
    resolveId(id: string): string | null;
    load(id: string): string | null;
    transform(
        code: string,
        id: string,
        ctx: TransformContext,
    ): Promise<TransformResult | null>;
    invalidate(): void;
};

function messageFrom(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function getLocAndFrame(
    code: string,
    pos: number,
    id: string,
): { loc: Loc; frame: string } {
    const before = code.slice(0, pos);
    const lines = before.split('\n');
    const line = lines.length;
    const column = lines[lines.length - 1].length + 1;
    const sourceLine = code.split('\n')[line - 1] ?? '';
    return {
        loc: { file: id, line, column },
        frame: `${sourceLine}\n${' '.repeat(column - 1)}^`,
    };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<never>((_, reject) => {
        timerId = setTimeout(
            () => reject(new Error(`comptime evaluation timed out after ${ms}ms`)),
            ms,
        );
    });
    try {
        return await Promise.race([promise, timer]);
    } finally {
        clearTimeout(timerId);
    }
}

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

async function stampAll(paths: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(paths)];
    const stamps = await Promise.all(unique.map(stampFile));
    return new Map(unique.map((p, i) => [p, stamps[i]]));
}

/** Re-stamps a cache entry's dependencies and reports whether all still match. */
async function depsUnchanged(deps: Map<string, string>): Promise<boolean> {
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
async function allUnmodifiedDuring(paths: string[], startedAt: number): Promise<boolean> {
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

/**
 * A cached literal together with the content stamps of the files the evaluation
 * that produced it is known to depend on. The cache key alone cannot cover
 * these: it hashes the virtual module source, which names imports by *path*, and
 * the files read at evaluation time are not known until after evaluation. So the
 * key selects a candidate entry and the stamps decide whether it is still valid.
 *
 * Tracked dependencies:
 *  - local files behind the hoisted imports the callback actually uses,
 *  - every path the callback passed to `watch()`.
 *
 * NOT tracked (a change to these can still yield a stale literal, see README):
 *  - transitive imports of a hoisted module - only the directly imported file is
 *    stamped, not what it imports in turn,
 *  - files read at evaluation time (`Deno.readTextFile`, ...) without a matching
 *    `watch()` call,
 *  - non-local specifiers (`npm:`, `jsr:`, `node:`), which are version-pinned.
 *
 * Stamps are taken so that they can only ever be too old, never too new: too old
 * costs a redundant re-evaluation, too new would pin a stale literal for the
 * lifetime of the entry. Imports are stamped before evaluation begins; watched
 * paths, which cannot be, are only recorded once their timestamps show they held
 * still while the callback ran (see `allUnmodifiedDuring`) - which relies on
 * those timestamps being truthful.
 */
type CacheEntry = { literal: string; deps: Map<string, string> };

export function createCore(
    evaluator: RolldownEvaluator,
    options: ComptimeOptions,
): ComptimeCore {
    const cache = new Map<string, CacheEntry>();
    const DEFAULT_TIMEOUT = 10_000;

    return {
        resolveId: () => null,
        load: () => null,

        async transform(code, id, ctx): Promise<TransformResult | null> {
            if (!shouldScan(code, id, options)) return null;

            const { program } = parseSync(id, code, { lang: 'ts', sourceType: 'module' });
            const { comptimeNames } = collectComptimeBindings(program);
            if (comptimeNames.size === 0) return null;

            const calls = findComptimeCalls(program, comptimeNames);
            if (calls.length === 0) return null;

            // A nested call cannot be evaluated: the enclosing callback is spliced
            // into the virtual module verbatim and `comptime` is never hoisted
            // there, so the inner call would fail with "comptime is not defined".
            const nested = calls.find((c) => c.nested);
            if (nested) {
                const { loc, frame } = getLocAndFrame(code, nested.start, id);
                throw new ComptimeTransformError(
                    'comptime() calls cannot be nested: the enclosing comptime() already runs at build time, so remove the inner call',
                    loc,
                    frame,
                );
            }

            const fileDir = normalizeToForwardSlashes(
                dirname(normalizeToForwardSlashes(id)),
            );
            const importBindings = collectImportBindings(program, fileDir);
            const topLevelDecls = collectTopLevelDeclarations(program, code);
            const s = new MagicString(code);

            const tasks = calls.map(async (call) => {
                const fn = call.fn;

                if ((fn.params ?? []).length > 0) {
                    const { loc, frame } = getLocAndFrame(code, call.start, id);
                    throw new ComptimeTransformError(
                        'comptime() requires a single arrow function with no parameters',
                        loc,
                        frame,
                    );
                }

                // Extract body: expression bodies get wrapped in return; block bodies strip braces
                const isExpressionBody = fn.body.type !== 'BlockStatement';
                const rawBody = code.slice(fn.body.start, fn.body.end);
                const bodyStatements = isExpressionBody
                    ? `return (${rawBody});`
                    : rawBody.slice(1, -1).trim();

                // Rewrite relative dynamic imports in body to absolute paths
                const rewrittenBody = bodyStatements.replace(
                    /import\(\s*["'](\.[^"']+)["']\s*\)/g,
                    (_, spec) => `import("${resolveSpecifier(spec, fileDir)}")`,
                );

                // Reachability fixpoint: start from what the callback body names,
                // then keep pulling in top-level declarations it can reach and the
                // identifiers those declarations reference in turn. Without this,
                // an inlined declaration could reference an import or another
                // declaration the callback never names, and evaluation would fail
                // with "X is not defined".
                const refs = collectIdentifierReferences(fn.body);
                // A declaration that encloses a comptime call must never be inlined,
                // so it also must not contribute its references.
                const inlinable = topLevelDecls.filter(
                    (d) => !calls.some((c) => c.start >= d.start && c.end <= d.end),
                );
                const selected = new Set<TopLevelDecl>();
                // Terminates because a pass only repeats when it selected a
                // declaration: at most one pass per declaration, since `selected`
                // is monotone and bounded by `inlinable.length`.
                for (let changed = true; changed; ) {
                    changed = false;
                    for (const d of inlinable) {
                        if (selected.has(d)) continue;
                        if (!d.names.some((n) => refs.has(n))) continue;
                        selected.add(d);
                        changed = true;
                        for (const r of d.refs) refs.add(r);
                    }
                }
                const usedImports = [...importBindings.values()].filter((b) =>
                    refs.has(b.localName),
                );
                // Original source order is preserved by filtering the collected list.
                const usedDecls = inlinable.filter((d) => selected.has(d));
                const virtual = createVirtualModule(
                    usedImports,
                    usedDecls,
                    rewrittenBody,
                );

                const envKeys = collectDenoEnvReads(fn.body);
                const envEntries: [string, string][] = [...envKeys].map((k) => [
                    k,
                    Deno.env.get(k) ?? '',
                ]);
                const key = await contentHash(virtual, envEntries);

                // Cache hit: skip re-evaluation and watch file registration.
                // The entry only counts as a hit while its recorded dependencies
                // still stamp identically, so an edit to an imported or watched
                // file yields a fresh literal even without watch mode.
                // invalidate() is called on watchChange, so if any watched file changes
                // the cache is cleared and the next transform re-registers all watch files.
                const cached = cache.get(key);
                if (cached && (await depsUnchanged(cached.deps))) {
                    return {
                        start: call.start,
                        end: call.end,
                        literal: cached.literal,
                    };
                }

                const localImports = usedImports
                    .map((b) => b.absSpecifier)
                    .filter(isLocalFile);
                for (const path of localImports) ctx.addWatchFile?.(path);

                // Stamped before evaluating, and awaited before it: a file edited
                // after this point leaves a stamp older than the content the
                // evaluation read, which costs a spurious re-evaluation next time
                // but can never pin a stale literal. Overlapping these reads with
                // the build would forfeit exactly that, since a queued read can
                // land after the build has already read the same file.
                const importStamps = await stampAll(localImports);

                const virtualId = `\0comptime:${id}?comptime=${call.index}`;
                const startedAt = Date.now();
                let evalResult: EvaluateResult;
                try {
                    evalResult = await withTimeout(
                        evaluator.evaluate(
                            virtualId,
                            virtual,
                            options.innerPlugins as any,
                        ),
                        options.timeout ?? DEFAULT_TIMEOUT,
                    );
                } catch (err) {
                    const { loc, frame } = getLocAndFrame(code, call.start, id);
                    const msg = messageFrom(err);
                    throw new ComptimeTransformError(
                        msg.startsWith('comptime')
                            ? msg
                            : `comptime evaluation threw: ${msg}`,
                        loc,
                        frame,
                    );
                }

                for (const path of evalResult.watchFiles) ctx.addWatchFile?.(path);

                let literal: string;
                try {
                    literal = serializeValue(evalResult.value, options.serializers);
                } catch (err) {
                    const { loc, frame } = getLocAndFrame(code, call.start, id);
                    throw new ComptimeTransformError(messageFrom(err), loc, frame);
                }

                // Watched paths can only be stamped after evaluation, since that is
                // when they become known. Relative ones are stamped as given, which
                // resolves against the process cwd exactly as the callback's own
                // reads did; scheme-carrying arguments (`npm:`, `http:`, ...) are
                // not files at all and would only record a dependency that can
                // never invalidate.
                const watchDeps = evalResult.watchFiles.filter((p) => !hasUriScheme(p));
                // The literal is returned either way; only recording it as a cache
                // entry needs the watched files to have held still. The second
                // check covers writes landing during the stamping itself, so the
                // stamps and the literal cannot straddle one.
                if (await allUnmodifiedDuring(watchDeps, startedAt)) {
                    const watchStamps = await stampAll(watchDeps);
                    if (await allUnmodifiedDuring(watchDeps, startedAt)) {
                        for (const [path, stamp] of watchStamps) {
                            importStamps.set(path, stamp);
                        }
                        cache.set(key, { literal, deps: importStamps });
                    }
                }
                return { start: call.start, end: call.end, literal };
            });

            // All tasks are already running (started by the map above), so awaiting
            // them one by one keeps the concurrency but makes failure deterministic:
            // the earliest failing call in source order is the one reported, which is
            // what a compiler diagnostic should do. Promise.all would instead surface
            // whichever rejection happened to land first. The no-op handler keeps a
            // later task rejecting while an earlier one is awaited from being an
            // unhandled rejection; the rejection is still observed by the await below
            // when it is the first to fail.
            // These two loops cannot be merged: the handlers must all be attached
            // in this synchronous turn, before the first await parks below.
            for (const t of tasks) t.catch(() => {});
            const results: Awaited<(typeof tasks)[number]>[] = [];
            for (const t of tasks) results.push(await t);

            for (const { start, end, literal } of results) {
                s.overwrite(start, end, literal);
            }

            return {
                code: s.toString(),
                map: s.generateMap({ hires: true, source: id }),
            };
        },

        invalidate() {
            cache.clear();
        },
    };
}
