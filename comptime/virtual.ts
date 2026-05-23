import { uneval } from 'devalue';
import type { ImportBinding, TopLevelDecl, ComptimeOptions } from './ast.ts';

export function createVirtualModule(
    importBindings: ImportBinding[],
    topLevelDecls: TopLevelDecl[],
    bodyStatements: string,
): string {
    const lines: string[] = [];

    for (const b of importBindings) {
        if (b.importedName === 'default') {
            lines.push(`import ${b.localName} from "${b.absSpecifier}";`);
        } else if (b.importedName === '*') {
            lines.push(`import * as ${b.localName} from "${b.absSpecifier}";`);
        } else {
            const spec =
                b.importedName !== b.localName
                    ? `${b.importedName} as ${b.localName}`
                    : b.localName;
            lines.push(`import { ${spec} } from "${b.absSpecifier}";`);
        }
    }

    for (const decl of topLevelDecls) {
        lines.push(decl.source);
    }

    lines.push('const __comptime_watch_files = [];');
    lines.push('const watch = (path) => __comptime_watch_files.push(path);');
    lines.push(`let __comptime_result = await (async () => { ${bodyStatements} })();`);
    lines.push(
        'export { __comptime_result as default, __comptime_watch_files as __comptime_watch };',
    );

    return lines.join('\n');
}

export async function contentHash(
    source: string,
    envEntries: [string, string][],
): Promise<string> {
    const sorted = [...envEntries].sort(([a], [b]) => a.localeCompare(b));
    const input = source + '\0' + JSON.stringify(sorted);
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join(
        '',
    );
}

export function serializeValue(
    value: unknown,
    serializers: ComptimeOptions['serializers'],
): string {
    if (serializers) {
        for (const { test, serialize } of serializers) {
            if (test(value)) return serialize(value);
        }
    }
    try {
        return uneval(value);
    } catch (err) {
        throw new Error(
            `comptime returned a value that cannot be serialized: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}
