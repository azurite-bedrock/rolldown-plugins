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

export function createCore(
    evaluator: RolldownEvaluator,
    options: ComptimeOptions,
): ComptimeCore {
    const cache = new Map<string, string>();
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
                // invalidate() is called on watchChange, so if any watched file changes
                // the cache is cleared and the next transform re-registers all watch files.
                if (cache.has(key)) {
                    return {
                        start: call.start,
                        end: call.end,
                        literal: cache.get(key)!,
                    };
                }

                for (const b of usedImports) {
                    if (isLocalFile(b.absSpecifier))
                        ctx.addWatchFile?.(b.absSpecifier);
                }

                const virtualId = `\0comptime:${id}?comptime=${call.index}`;
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

                cache.set(key, literal);
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
