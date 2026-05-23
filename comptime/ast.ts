import micromatch from 'micromatch';
import { parseSync } from 'rolldown/experimental';
import { resolve } from '@std/path';

export { parseSync };

export type Loc = { file: string; line: number; column: number };

export class ComptimeTransformError extends Error {
    readonly loc: Loc;
    readonly frame: string;

    constructor(message: string, loc: Loc, frame: string) {
        super(message);
        this.name = 'ComptimeTransformError';
        this.loc = loc;
        this.frame = frame;
    }
}

const SUPPORTED_EXTENSIONS = new Set([
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
]);

export type ComptimeOptions = {
    include?: string | string[];
    exclude?: string | string[];
    timeout?: number;
    innerPlugins?: unknown[];
    serializers?: Array<{
        test: (value: unknown) => boolean;
        serialize: (value: unknown) => string;
    }>;
};

export function shouldScan(code: string, id: string, options: ComptimeOptions): boolean {
    if (id.startsWith('\0')) return false;
    const dotIdx = id.lastIndexOf('.');
    if (dotIdx === -1 || !SUPPORTED_EXTENSIONS.has(id.slice(dotIdx))) return false;
    if (!code.includes('comptime')) return false;
    if (options.exclude && micromatch.isMatch(id, options.exclude)) return false;
    if (options.include && !micromatch.isMatch(id, options.include)) return false;
    return true;
}

export type ComptimeBindings = { comptimeNames: Set<string>; watchNames: Set<string> };

export function collectComptimeBindings(program: any): ComptimeBindings {
    const comptimeNames = new Set<string>();
    const watchNames = new Set<string>();
    for (const node of program.body) {
        if (node.type !== 'ImportDeclaration' || node.source.value !== 'comptime')
            continue;
        for (const spec of node.specifiers) {
            if (spec.type !== 'ImportSpecifier') continue;
            const imported = spec.imported?.name ?? spec.imported?.value;
            const local = spec.local.name;
            if (imported === 'comptime') comptimeNames.add(local);
            if (imported === 'watch') watchNames.add(local);
        }
    }
    return { comptimeNames, watchNames };
}

export type ComptimeCall = { start: number; end: number; fn: any; index: number };

export function findComptimeCalls(
    program: any,
    comptimeNames: Set<string>,
): ComptimeCall[] {
    const calls: ComptimeCall[] = [];
    let index = 0;

    function walk(node: any, shadowed: Set<string>): void {
        if (!node || typeof node !== 'object') return;

        if (node.type === 'CallExpression') {
            const callee = node.callee;
            if (
                callee.type === 'Identifier' &&
                comptimeNames.has(callee.name) &&
                !shadowed.has(callee.name) &&
                node.arguments.length === 1 &&
                (node.arguments[0].type === 'ArrowFunctionExpression' ||
                    node.arguments[0].type === 'FunctionExpression')
            ) {
                calls.push({
                    start: node.start,
                    end: node.end,
                    fn: node.arguments[0],
                    index: index++,
                });
                return;
            }
        }

        const createsScope =
            node.type === 'FunctionDeclaration' ||
            node.type === 'FunctionExpression' ||
            node.type === 'ArrowFunctionExpression';

        let childShadowed = shadowed;
        if (createsScope) {
            childShadowed = new Set(shadowed);
            for (const param of node.params ?? []) {
                if (param.type === 'Identifier' && comptimeNames.has(param.name)) {
                    childShadowed.add(param.name);
                }
            }
        }

        for (const key of Object.keys(node)) {
            if (key === 'type' || key === 'start' || key === 'end') continue;
            const child = node[key];
            if (Array.isArray(child)) {
                // Accumulate shadows from VariableDeclarations as we iterate siblings
                let siblingShadowed = childShadowed;
                for (const item of child) {
                    if (!item || typeof item !== 'object' || !('type' in item)) continue;
                    if (item.type === 'VariableDeclaration') {
                        siblingShadowed = new Set(siblingShadowed);
                        for (const decl of item.declarations) {
                            if (
                                decl.id?.type === 'Identifier' &&
                                comptimeNames.has(decl.id.name)
                            ) {
                                siblingShadowed.add(decl.id.name);
                            }
                        }
                        // Still walk the initializers with the pre-shadow set so the init itself is not shadowed
                        walk(item, childShadowed);
                    } else {
                        walk(item, siblingShadowed);
                    }
                }
            } else if (child && typeof child === 'object' && 'type' in child) {
                walk(child, childShadowed);
            }
        }
    }

    walk(program, new Set());
    return calls;
}

export type ImportBinding = {
    localName: string;
    importedName: string;
    absSpecifier: string;
    originalSpecifier: string;
};

export function normalizeToForwardSlashes(p: string): string {
    return p.replace(/\\/g, '/');
}

function isWindowsDrivePath(p: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(p);
}

export function isLocalFile(p: string): boolean {
    return p.startsWith('/') || isWindowsDrivePath(p);
}

export function resolveSpecifier(spec: string, fileDir: string): string {
    // Bare module specifier (npm:, jsr:, etc.)
    if (!spec.startsWith('.') && !spec.startsWith('/') && !isWindowsDrivePath(spec))
        return spec;
    // native resolve handles both POSIX and Windows drive-letter paths;
    // normalize output to forward slashes for consistency.
    return normalizeToForwardSlashes(resolve(fileDir, spec));
}

export function collectImportBindings(
    program: any,
    fileDir: string,
    watchNames: Set<string>,
): Map<string, ImportBinding> {
    const bindings = new Map<string, ImportBinding>();
    for (const node of program.body) {
        if (node.type !== 'ImportDeclaration') continue;
        if ((node as any).importKind === 'type') continue;
        const originalSpecifier = node.source.value as string;
        if (originalSpecifier === 'comptime') continue;
        const absSpecifier = resolveSpecifier(originalSpecifier, fileDir);
        for (const s of node.specifiers) {
            if ((s as any).importKind === 'type') continue;
            const localName: string = s.local.name;
            if (watchNames.has(localName)) continue;
            const importedName: string =
                s.type === 'ImportDefaultSpecifier'
                    ? 'default'
                    : s.type === 'ImportNamespaceSpecifier'
                      ? '*'
                      : (s.imported?.name ?? s.imported?.value ?? localName);
            bindings.set(localName, {
                localName,
                importedName,
                absSpecifier,
                originalSpecifier,
            });
        }
    }
    return bindings;
}

export type TopLevelDecl = { names: string[]; source: string };

export function collectTopLevelDeclarations(program: any, code: string): TopLevelDecl[] {
    const decls: TopLevelDecl[] = [];

    function processDecl(node: any): void {
        if (node.type === 'VariableDeclaration') {
            const names = node.declarations.flatMap((d: any) =>
                extractPatternNames(d.id),
            );
            decls.push({ names, source: code.slice(node.start, node.end) });
        } else if (node.type === 'FunctionDeclaration' && node.id) {
            decls.push({
                names: [node.id.name],
                source: code.slice(node.start, node.end),
            });
        } else if (node.type === 'ClassDeclaration' && node.id) {
            decls.push({
                names: [node.id.name],
                source: code.slice(node.start, node.end),
            });
        }
    }

    for (const node of program.body) {
        if (node.type === 'ExportNamedDeclaration' && node.declaration) {
            processDecl(node.declaration);
        } else {
            processDecl(node);
        }
    }
    return decls;
}

function extractPatternNames(pat: any): string[] {
    if (!pat) return [];
    if (pat.type === 'Identifier') return [pat.name];
    if (pat.type === 'ObjectPattern')
        return pat.properties.flatMap((p: any) =>
            extractPatternNames(p.value ?? p.argument),
        );
    if (pat.type === 'ArrayPattern')
        return pat.elements.flatMap((e: any) => extractPatternNames(e));
    if (pat.type === 'AssignmentPattern') return extractPatternNames(pat.left);
    if (pat.type === 'RestElement') return extractPatternNames(pat.argument);
    return [];
}

export function collectIdentifierReferences(node: any): Set<string> {
    const refs = new Set<string>();
    function walk(n: any): void {
        if (!n || typeof n !== 'object') return;
        if (n.type === 'Identifier') refs.add(n.name);
        for (const key of Object.keys(n)) {
            if (key === 'type' || key === 'start' || key === 'end') continue;
            const child = n[key];
            if (Array.isArray(child))
                child.forEach((c: any) => {
                    if (c && typeof c === 'object') walk(c);
                });
            else if (child && typeof child === 'object') walk(child);
        }
    }
    walk(node);
    return refs;
}

export function collectDenoEnvReads(node: any): Set<string> {
    const keys = new Set<string>();
    function walk(n: any): void {
        if (!n || typeof n !== 'object') return;
        if (
            n.type === 'CallExpression' &&
            n.callee?.type === 'MemberExpression' &&
            n.callee.property?.name === 'get' &&
            n.callee.object?.type === 'MemberExpression' &&
            n.callee.object.property?.name === 'env' &&
            n.callee.object.object?.name === 'Deno' &&
            n.arguments?.length === 1 &&
            (n.arguments[0].type === 'StringLiteral' || n.arguments[0].type === 'Literal')
        ) {
            keys.add(n.arguments[0].value);
        }
        for (const key of Object.keys(n)) {
            if (key === 'type' || key === 'start' || key === 'end') continue;
            const child = n[key];
            if (Array.isArray(child))
                child.forEach((c: any) => {
                    if (c && typeof c === 'object') walk(c);
                });
            else if (child && typeof child === 'object') walk(child);
        }
    }
    walk(node);
    return keys;
}
