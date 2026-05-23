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
            const { comptimeNames, watchNames } = collectComptimeBindings(program);
            if (comptimeNames.size === 0) return null;

            const calls = findComptimeCalls(program, comptimeNames);
            if (calls.length === 0) return null;

            const fileDir = normalizeToForwardSlashes(
                dirname(normalizeToForwardSlashes(id)),
            );
            const importBindings = collectImportBindings(program, fileDir, watchNames);
            const topLevelDecls = collectTopLevelDeclarations(program, code);
            const s = new MagicString(code);

            const results = await Promise.all(
                calls.map(async (call) => {
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

                    const refs = collectIdentifierReferences(fn.body);
                    const usedImports = [...importBindings.values()].filter((b) =>
                        refs.has(b.localName),
                    );
                    const usedDecls = topLevelDecls.filter(
                        (d) =>
                            d.names.some((n) => refs.has(n)) &&
                            !calls.some((c) => c.start >= d.start && c.end <= d.end),
                    );
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
                }),
            );

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
