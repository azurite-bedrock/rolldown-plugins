import { rolldown } from 'rolldown';
import type { Plugin } from 'rolldown';

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
            plugins: [this.#virtualPlugin(), ...innerPlugins],
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

function messageFrom(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
