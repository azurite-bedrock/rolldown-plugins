import { rolldown } from "rolldown";
import type { Plugin } from "rolldown";
import denoPlugin from "@deno/rolldown-plugin";
import { dirname, join } from "@std/path";

export type EvaluateResult = { value: unknown; watchFiles: string[] };

/**
 * Evaluates one virtual module and reports what it produced. Named as an
 * interface rather than the concrete class so a caller - a test above all - can
 * supply an evaluator that does not run a real inner build.
 */
export type Evaluator = {
    evaluate(
        virtualId: string,
        virtualSource: string,
        innerPlugins?: Plugin[],
    ): Promise<EvaluateResult>;
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

        const sourcePath = virtualIdToSourcePath(virtualId);
        const configPath = findDenoConfig(dirname(sourcePath));

        const bundle = await rolldown({
            input: virtualId,
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
            // virtualId is \0comptime:<absPath>?comptime=<n> — derive a file:// URL
            // so that import.meta.url inside the bundle resolves relative paths correctly
            const sourcePath = virtualId
                .slice('\0comptime:'.length)
                .replace(/\?comptime=\d+$/, '');
            const sourceFileUrl = /^[A-Za-z]:/.test(sourcePath)
                ? `file:///${sourcePath.replace(/\\/g, '/')}`
                : `file://${sourcePath}`;
            const rawCode = first.code.replace(
                /\bimport\.meta\.url\b/g,
                JSON.stringify(sourceFileUrl),
            );
            const code = `${rawCode}\n// __comptime_eval_${this.#evalCount++}`;
            const url = `data:text/javascript,${encodeURIComponent(code)}`;
            const mod = await import(url);
            return {
                value: mod.default,
                watchFiles: Array.isArray(mod.__comptime_watch)
                    ? mod.__comptime_watch
                    : [],
            };
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
        .replace(/\?comptime=\d+$/, "");
}

function messageFrom(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
