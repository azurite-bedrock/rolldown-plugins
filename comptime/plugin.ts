import type { Plugin } from 'rolldown';
import { RolldownEvaluator } from './evaluator.ts';
import { createTransformer } from './transform.ts';
import type { ComptimeOptions } from './options.ts';

/**
 * `enforce` is a Vite-compatibility field: rolldown's own `Plugin` does not
 * declare it, but hosts that honour plugin ordering read it, so it is kept and
 * declared here rather than cast away.
 */
export type ComptimePlugin = Plugin & { enforce: 'pre' };

export function comptime(options: ComptimeOptions = {}): ComptimePlugin {
    const transformer = createTransformer(new RolldownEvaluator(), options);

    const plugin: ComptimePlugin = {
        name: 'comptime',
        enforce: 'pre',
        async transform(code, id) {
            // `this` is rolldown's transform context; the transformer only ever
            // reaches for `addWatchFile`, and calling it as a method keeps its
            // receiver, so nothing needs binding.
            return (await transformer.transform(code, id, this)) ?? undefined;
        },
        watchChange() {
            transformer.invalidate();
        },
    };
    return plugin;
}
