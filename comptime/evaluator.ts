import { rolldown } from "rolldown";
import type { Plugin } from "rolldown";
import denoPlugin from "@deno/rolldown-plugin";
import { dirname, join } from "@std/path";
import { timeoutMessage, withTimeout } from "./timeout.ts";

export type EvaluateResult = { value: unknown; watchFiles: string[] };

/** One virtual module to evaluate as part of a batch. */
export type BatchEntry = { virtualId: string; virtualSource: string };

/**
 * The per-call result of a batch evaluation. Unlike {@link EvaluateResult} a
 * failure is reported in-band rather than thrown, so one call throwing does not
 * hide the outcomes of its siblings: the transform still selects the earliest
 * failing call in source order from the whole set. `message` is what a per-call
 * `evaluate` would have rejected with, so the transform prefixes it identically.
 */
export type BatchOutcome =
    | { ok: true; value: unknown; watchFiles: string[] }
    | { ok: false; message: string };

/**
 * Evaluates virtual modules and reports what they produced. Named as an
 * interface rather than the concrete class so a caller - a test above all - can
 * supply an evaluator that does not run a real inner build.
 *
 * `evaluate` handles one module at a time and is the primitive every caller can
 * rely on. `evaluateBatch` is an optional fast path: when present the transform
 * hands it all the cache-missed calls of a file at once so they share a single
 * inner build instead of one build each. An evaluator that omits it still works
 * - the transform falls back to `evaluate` per call - which is what keeps the
 * seam fakeable without a real build.
 */
export type Evaluator = {
    evaluate(
        virtualId: string,
        virtualSource: string,
        innerPlugins?: Plugin[],
    ): Promise<EvaluateResult>;
    evaluateBatch?(
        entries: BatchEntry[],
        innerPlugins?: Plugin[],
        timeoutMs?: number,
    ): Promise<BatchOutcome[]>;
};

export class RolldownEvaluator {
    readonly #virtualModules = new Map<string, string>();
    #evalCount = 0;

    async evaluate(
        virtualId: string,
        virtualSource: string,
        innerPlugins: Plugin[] = [],
    ): Promise<EvaluateResult> {
        this.#virtualModules.set(virtualId, virtualSource);
        const mod = await this.#buildAndImport(virtualId, innerPlugins);
        return {
            value: mod.default,
            watchFiles: Array.isArray(mod.__comptime_watch) ? mod.__comptime_watch : [],
        };
    }

    /**
     * Evaluates every entry in a single inner build. Each entry keeps its own
     * virtual module verbatim - the same imports, inlined declarations, body and
     * `import.meta.url` rewriting a per-call `evaluate` would use - and a wrapper
     * entry imports them dynamically so that a call throwing (or a module it
     * imports throwing on load) is caught and attributed to that call rather than
     * aborting the batch. A failure of the build itself, which cannot be pinned
     * on one call, falls back to building each entry alone so the culprit is
     * still reported against its own call.
     *
     * The entries must share a source file - the transform only ever batches the
     * calls of one file - so a single `import.meta.url` resolves them all.
     */
    async evaluateBatch(
        entries: BatchEntry[],
        innerPlugins: Plugin[] = [],
        timeoutMs = 10_000,
    ): Promise<BatchOutcome[]> {
        if (entries.length === 0) return [];
        // A lone call gains nothing from the wrapper and its extra dynamic-import
        // layer, so evaluate it directly - the common single-call file then takes
        // exactly the path it always did.
        if (entries.length === 1) {
            return [await this.#evaluateOneAsOutcome(entries[0], innerPlugins, timeoutMs)];
        }

        for (const e of entries) this.#virtualModules.set(e.virtualId, e.virtualSource);
        const sourcePath = virtualIdToSourcePath(entries[0].virtualId);
        const wrapperId = `\0comptime:${sourcePath}?comptime=batch`;
        this.#virtualModules.set(
            wrapperId,
            batchWrapperSource(entries.map((e) => e.virtualId), timeoutMs),
        );

        let batch: unknown;
        try {
            const mod = await withTimeout(
                this.#buildAndImport(wrapperId, innerPlugins),
                timeoutMs,
            );
            batch = mod.default;
        } catch {
            // The build (or the whole import) failed or hung, which is not one
            // call's fault to attribute. Rebuild each entry on its own so a
            // per-call build error lands on its own call.
            return Promise.all(
                entries.map((e) => this.#evaluateOneAsOutcome(e, innerPlugins, timeoutMs)),
            );
        }

        const results = Array.isArray(batch) ? batch : [];
        return entries.map((_, i): BatchOutcome => {
            const r = results[i] as
                | { ok?: boolean; value?: unknown; watch?: unknown; error?: unknown }
                | undefined;
            if (r && r.ok) {
                return {
                    ok: true,
                    value: r.value,
                    watchFiles: Array.isArray(r.watch) ? r.watch : [],
                };
            }
            return {
                ok: false,
                message: r ? String(r.error) : 'comptime inner build produced no result',
            };
        });
    }

    async #evaluateOneAsOutcome(
        entry: BatchEntry,
        innerPlugins: Plugin[],
        timeoutMs: number,
    ): Promise<BatchOutcome> {
        try {
            const r = await withTimeout(
                this.evaluate(entry.virtualId, entry.virtualSource, innerPlugins),
                timeoutMs,
            );
            return { ok: true, value: r.value, watchFiles: r.watchFiles };
        } catch (err) {
            return { ok: false, message: messageFrom(err) };
        }
    }

    /** Builds `entryId` into one chunk and imports it, returning the module namespace. */
    async #buildAndImport(
        entryId: string,
        innerPlugins: Plugin[],
    ): Promise<{ default: unknown; __comptime_watch?: unknown }> {
        const configPath = findDenoConfig(dirname(virtualIdToSourcePath(entryId)));

        const bundle = await rolldown({
            input: entryId,
            plugins: [
                this.#virtualPlugin(),
                ...innerPlugins,
                localFilesPlugin(),
                ...[denoPlugin({ configPath })].flat(),
            ],
        }).catch((err: unknown) => {
            throw new Error(`comptime inner build failed: ${messageFrom(err)}`, {
                cause: err,
            });
        });

        try {
            const { output } = await bundle
                .generate({
                    format: 'esm',
                    codeSplitting: false,
                })
                .catch((err: unknown) => {
                    throw new Error(`comptime inner build failed: ${messageFrom(err)}`, {
                        cause: err,
                    });
                });
            const first = output[0];
            if (!first || first.type !== 'chunk') {
                throw new Error(
                    'comptime inner build failed: expected a single output chunk',
                );
            }
            // entryId is \0comptime:<absPath>?comptime=<n|batch> — derive a file://
            // URL so import.meta.url inside the bundle resolves relative paths
            // correctly. Every module in the chunk shares this source file.
            const sourcePath = virtualIdToSourcePath(entryId);
            const sourceFileUrl = /^[A-Za-z]:/.test(sourcePath)
                ? `file:///${sourcePath.replace(/\\/g, '/')}`
                : `file://${sourcePath}`;
            const rawCode = first.code.replace(
                /\bimport\.meta\.url\b/g,
                JSON.stringify(sourceFileUrl),
            );
            const code = `${rawCode}\n// __comptime_eval_${this.#evalCount++}`;
            const url = `data:text/javascript,${encodeURIComponent(code)}`;
            return await import(url);
        } finally {
            await bundle.close();
        }
    }

    #virtualPlugin(): Plugin {
        return {
            name: 'comptime-virtual',
            resolveId: (id: string) => (this.#virtualModules.has(id) ? id : null),
            load: (id: string) => {
                const code = this.#virtualModules.get(id);
                if (code === undefined) return null;
                return { code, moduleType: 'ts' as const };
            },
        };
    }
}

/**
 * Source of the wrapper entry that drives a batch: it imports each virtual
 * module dynamically and records `{ ok, value, watch }` or `{ ok: false, error }`
 * per call, so a throw is contained to its own call. Each import races a timeout
 * whose message matches the single-call path, so a call that hangs is attributed
 * to itself rather than failing the batch. `error` is the same message a per-call
 * `evaluate` would reject with, so the transform prefixes it identically.
 */
function batchWrapperSource(ids: string[], timeoutMs: number): string {
    const runs = ids.map((id, i) => {
        const spec = JSON.stringify(id);
        const to = timeoutMessage(timeoutMs);
        return (
            `(async () => {\n` +
            `  let __t;\n` +
            `  try {\n` +
            `    const __m = await Promise.race([\n` +
            `      import(${spec}),\n` +
            `      new Promise((_, __r) => { __t = setTimeout(() => __r(new Error(${JSON.stringify(to)})), ${timeoutMs}); }),\n` +
            `    ]);\n` +
            `    __b[${i}] = { ok: true, value: __m.default, watch: __m.__comptime_watch };\n` +
            `  } catch (__e) {\n` +
            `    __b[${i}] = { ok: false, error: __e instanceof Error ? __e.message : String(__e) };\n` +
            `  } finally {\n` +
            `    clearTimeout(__t);\n` +
            `  }\n` +
            `})()`
        );
    });
    return `const __b = [];\nawait Promise.all([\n${runs.join(',\n')}\n]);\nexport { __b as default };`;
}

// Load local files directly so deno-plugin's WASM loader doesn't handle them
// Exported for tests only.
export function localFilesPlugin(): Plugin {
    return {
        name: 'comptime-local-files',
        resolveId(id) {
            if (/^[A-Za-z]:/.test(id)) return id;
            return null;
        },
        async load(id) {
            if (/^[A-Za-z]:/.test(id)) {
                const code = await Deno.readTextFile(id);
                return { code, moduleType: 'ts' as const };
            }
            return null;
        },
    };
}

const configCache = new Map<string, string | undefined>();

/** Exported for tests only. */
export function findDenoConfig(startDir: string): string | undefined {
    if (configCache.has(startDir)) return configCache.get(startDir);

    let dir = startDir;
    while (true) {
        for (const name of ["deno.json", "deno.jsonc"]) {
            const candidate = join(dir, name);
            try {
                if (Deno.statSync(candidate).isFile) {
                    configCache.set(startDir, candidate);
                    return candidate;
                }
            } catch {
                continue;
            }
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    configCache.set(startDir, undefined);
    return undefined;
}

/** Exported for tests only. */
export function virtualIdToSourcePath(virtualId: string): string {
    return virtualId
        .slice("\0comptime:".length)
        .replace(/\?comptime=(?:\d+|batch)$/, "");
}

function messageFrom(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
