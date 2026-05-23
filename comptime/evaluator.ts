import { rolldown } from 'rolldown';
import type { Plugin } from 'rolldown';
import denoPlugin from '@deno/rolldown-plugin';

export type EvaluateResult = { value: unknown; watchFiles: string[] };

export class RolldownEvaluator {
    readonly #virtualModules = new Map<string, string>();
    #evalCount = 0;

    async evaluate(
        virtualId: string,
        virtualSource: string,
        innerPlugins: Plugin[] = [],
    ): Promise<EvaluateResult> {
        this.#virtualModules.set(virtualId, virtualSource);

        const bundle = await rolldown({
            input: virtualId,
            plugins: [
                this.#virtualPlugin(),
                ...innerPlugins,
                localFilesPlugin(),
                ...[denoPlugin()].flat(),
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
function localFilesPlugin(): Plugin {
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

function messageFrom(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
