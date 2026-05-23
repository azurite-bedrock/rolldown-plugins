import type { Plugin, TransformResult as RolldownTransformResult } from 'rolldown';
import { RolldownEvaluator } from './evaluator.ts';
import { createCore } from './core.ts';
import type { ComptimeOptions } from './ast.ts';

export function comptime(options: ComptimeOptions = {}): Plugin {
    const evaluator = new RolldownEvaluator();
    const core = createCore(evaluator, options);

    return {
        name: 'comptime',
        enforce: 'pre',
        resolveId(id: string) {
            return core.resolveId(id);
        },
        load(id: string) {
            return core.load(id);
        },
        async transform(
            this: { addWatchFile?: (id: string) => void },
            code: string,
            id: string,
        ) {
            const result = await core.transform(code, id, {
                addWatchFile: this.addWatchFile?.bind(this),
            });
            if (!result) return undefined;
            return {
                code: result.code,
                map: result.map,
            } as unknown as RolldownTransformResult;
        },
        watchChange() {
            core.invalidate();
        },
    } as Plugin;
}
