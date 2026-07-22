import { dirname } from '@std/path';
import MagicString, { type SourceMap } from 'magic-string';
import type { Plugin, TransformPluginContext } from 'rolldown';
import type { BatchEntry, BatchOutcome, Evaluator } from './evaluator.ts';
import {
    parseSync,
    collectComptimeBindings,
    findComptimeCalls,
    collectImportBindings,
    collectTopLevelDeclarations,
    collectIdentifierReferences,
    collectDenoEnvReads,
    type ComptimeCall,
    type TopLevelDecl,
} from './ast.ts';
import { ComptimeTransformError, getLocAndFrame } from './errors.ts';
import {
    normalizeToForwardSlashes,
    hasUriScheme,
    isLocalFile,
    resolveSpecifier,
} from './paths.ts';
import { shouldScan, type ComptimeOptions } from './options.ts';
import { allUnmodifiedDuring, depsUnchanged, stampAll } from './deps.ts';
import { withTimeout } from './timeout.ts';
import { createVirtualModule, contentHash, serializeValue } from './virtual.ts';

/**
 * The slice of rolldown's transform context the transform uses. Derived from
 * rolldown's own type rather than restated, and every member optional so that
 * a caller with nothing to register can pass an empty context.
 */
export type TransformContext = Partial<Pick<TransformPluginContext, 'addWatchFile'>>;

export type TransformResult = { code: string; map: SourceMap };

/**
 * Rewrites `comptime()` calls into literals, and owns the cache of literals
 * that survives across calls for one plugin instance.
 */
export type ComptimeTransformer = {
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

/**
 * Evaluates the cache-missed calls of a file and reports each outcome in-band,
 * never rejecting, so the caller can select the earliest failing call in source
 * order rather than whichever rejection lands first.
 *
 * An evaluator that offers `evaluateBatch` runs them in a single inner build; one
 * that does not - a test fake, above all - is driven one call at a time exactly
 * as before, with a per-call timeout. Both surface the same `{ ok, ... }` shape,
 * so the rest of the transform cannot tell which ran.
 */
function evaluateMissed(
    evaluator: Evaluator,
    entries: BatchEntry[],
    innerPlugins: Plugin[] | undefined,
    timeout: number,
): Promise<BatchOutcome[]> {
    if (evaluator.evaluateBatch) {
        return evaluator.evaluateBatch(entries, innerPlugins, timeout).catch(
            (err: unknown): BatchOutcome[] => {
                // evaluateBatch attributes per-call failures itself; a rejection
                // here is the whole batch giving out, which no single call owns,
                // so every missed call carries the same message.
                const message = messageFrom(err);
                return entries.map(() => ({ ok: false, message }));
            },
        );
    }
    return Promise.all(
        entries.map(async (e): Promise<BatchOutcome> => {
            try {
                const r = await withTimeout(
                    evaluator.evaluate(e.virtualId, e.virtualSource, innerPlugins),
                    timeout,
                );
                return { ok: true, value: r.value, watchFiles: r.watchFiles };
            } catch (err) {
                return { ok: false, message: messageFrom(err) };
            }
        }),
    );
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

/**
 * A call after its virtual module has been built and its cache consulted, but
 * before evaluation. A `hit` already has its literal; a `miss` carries what
 * evaluation and, on success, caching will need; an `error` is a fault found
 * without evaluating (bad parameters), held rather than thrown so the earliest
 * such fault in source order can still be selected against evaluation failures.
 */
type PreparedCall =
    | { kind: 'hit'; call: ComptimeCall; literal: string }
    | {
          kind: 'miss';
          call: ComptimeCall;
          virtualId: string;
          virtualSource: string;
          key: string;
          importStamps: Map<string, string>;
      }
    | { kind: 'error'; call: ComptimeCall; error: ComptimeTransformError };

export function createTransformer(
    evaluator: Evaluator,
    options: ComptimeOptions,
): ComptimeTransformer {
    const cache = new Map<string, CacheEntry>();
    const DEFAULT_TIMEOUT = 10_000;

    return {
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

            // Call-independent, so computed once rather than per call: a
            // declaration that encloses a comptime call must never be inlined.
            const inlinable = topLevelDecls.filter(
                (d) => !calls.some((c) => c.start >= d.start && c.end <= d.end),
            );

            // Phase 1: build each call's virtual module and consult the cache,
            // concurrently. This runs everything up to but not including
            // evaluation, so the misses can then share a single inner build. A
            // fault found here is held on the call rather than thrown, so it can
            // be weighed in source order against evaluation failures below.
            const prepared = await Promise.all(
                calls.map((call): Promise<PreparedCall> => prepareCall(call)),
            );

            function prepareCall(call: ComptimeCall): Promise<PreparedCall> {
                const fn = call.fn;

                if ((fn.params ?? []).length > 0) {
                    const { loc, frame } = getLocAndFrame(code, call.start, id);
                    return Promise.resolve({
                        kind: 'error',
                        call,
                        error: new ComptimeTransformError(
                            'comptime() requires a single arrow function with no parameters',
                            loc,
                            frame,
                        ),
                    });
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
                const virtualSource = createVirtualModule(
                    usedImports,
                    usedDecls,
                    rewrittenBody,
                );

                const envKeys = collectDenoEnvReads(fn.body);
                const envEntries: [string, string][] = [...envKeys].map((k) => [
                    k,
                    Deno.env.get(k) ?? '',
                ]);

                return (async (): Promise<PreparedCall> => {
                    const key = await contentHash(virtualSource, envEntries);

                    // Cache hit: skip re-evaluation and watch file registration.
                    // The entry only counts as a hit while its recorded dependencies
                    // still stamp identically, so an edit to an imported or watched
                    // file yields a fresh literal even without watch mode.
                    // invalidate() is called on watchChange, so if any watched file
                    // changes the cache is cleared and the next transform re-registers
                    // all watch files.
                    const cached = cache.get(key);
                    if (cached && (await depsUnchanged(cached.deps))) {
                        return { kind: 'hit', call, literal: cached.literal };
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

                    return {
                        kind: 'miss',
                        call,
                        virtualId: `\0comptime:${id}?comptime=${call.index}`,
                        virtualSource,
                        key,
                        importStamps,
                    };
                })();
            }

            // Phase 2: evaluate every missed call in one inner build (or, for an
            // evaluator without a batch, one at a time). Started here so that all
            // import stamps above are already taken - the ordering the cache relies
            // on - and so a single `startedAt` bounds every call's watch stamping.
            const misses = prepared.filter(
                (p): p is Extract<PreparedCall, { kind: 'miss' }> => p.kind === 'miss',
            );
            const startedAt = Date.now();
            const outcomes = new Map<number, BatchOutcome>();
            if (misses.length > 0) {
                const settled = await evaluateMissed(
                    evaluator,
                    misses.map((m) => ({
                        virtualId: m.virtualId,
                        virtualSource: m.virtualSource,
                    })),
                    options.innerPlugins as Plugin[] | undefined,
                    options.timeout ?? DEFAULT_TIMEOUT,
                );
                misses.forEach((m, i) => outcomes.set(m.call.index, settled[i]));
            }

            // Phase 3: resolve each call to a literal or an error, registering
            // watch files and serializing as it goes. Every call is resolved
            // before any error is thrown, so a later call's watch registration and
            // cache entry still land when an earlier call fails - exactly as when
            // the calls ran as independent concurrent tasks.
            type Resolved =
                | { start: number; end: number; literal: string }
                | { error: ComptimeTransformError };
            const cacheWrites: Array<{
                key: string;
                literal: string;
                importStamps: Map<string, string>;
                watchDeps: string[];
            }> = [];
            const resolved: Resolved[] = prepared.map((p): Resolved => {
                if (p.kind === 'error') return { error: p.error };
                if (p.kind === 'hit') {
                    return { start: p.call.start, end: p.call.end, literal: p.literal };
                }

                const outcome = outcomes.get(p.call.index)!;
                if (outcome.ok === false) {
                    const { loc, frame } = getLocAndFrame(code, p.call.start, id);
                    const msg = outcome.message;
                    return {
                        error: new ComptimeTransformError(
                            msg.startsWith('comptime')
                                ? msg
                                : `comptime evaluation threw: ${msg}`,
                            loc,
                            frame,
                        ),
                    };
                }

                for (const path of outcome.watchFiles) ctx.addWatchFile?.(path);

                let literal: string;
                try {
                    literal = serializeValue(outcome.value, options.serializers);
                } catch (err) {
                    const { loc, frame } = getLocAndFrame(code, p.call.start, id);
                    return { error: new ComptimeTransformError(messageFrom(err), loc, frame) };
                }

                // Watched paths can only be stamped after evaluation, since that is
                // when they become known. Relative ones are stamped as given, which
                // resolves against the process cwd exactly as the callback's own
                // reads did; scheme-carrying arguments (`npm:`, `http:`, ...) are
                // not files at all and would only record a dependency that can
                // never invalidate.
                cacheWrites.push({
                    key: p.key,
                    literal,
                    importStamps: p.importStamps,
                    watchDeps: outcome.watchFiles.filter((w) => !hasUriScheme(w)),
                });
                return { start: p.call.start, end: p.call.end, literal };
            });

            // Recording each entry needs its watched files to have held still,
            // concurrently as before. The second check covers writes landing during
            // the stamping itself, so the stamps and the literal cannot straddle one.
            await Promise.all(
                cacheWrites.map(async ({ key, literal, importStamps, watchDeps }) => {
                    if (!(await allUnmodifiedDuring(watchDeps, startedAt))) return;
                    const watchStamps = await stampAll(watchDeps);
                    if (!(await allUnmodifiedDuring(watchDeps, startedAt))) return;
                    for (const [path, stamp] of watchStamps) importStamps.set(path, stamp);
                    cache.set(key, { literal, deps: importStamps });
                }),
            );

            // The earliest failing call in source order is the one reported, which
            // is what a compiler diagnostic should do.
            for (const r of resolved) {
                if ('error' in r) throw r.error;
            }
            for (const r of resolved) {
                if ('error' in r) continue;
                s.overwrite(r.start, r.end, r.literal);
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
