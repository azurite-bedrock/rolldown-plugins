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

export type TopLevelDecl = {
    names: string[];
    source: string;
    start: number;
    end: number;
    /** Identifiers referenced by the declaration's own body/initializers. */
    refs: Set<string>;
};

/**
 * Identifiers a declaration depends on, excluding the names it introduces itself
 * and anything bound locally inside it. Used to walk the dependency graph when
 * hoisting declarations into a virtual module, so it must not report names that
 * are not real references to outer bindings.
 */
function collectDeclReferences(node: any, names: string[]): Set<string> {
    const refs = new Set<string>();
    const add = (from: any) => {
        if (!from) return;
        for (const r of collectScopedReferences(from)) refs.add(r);
    };

    if (node.type === 'VariableDeclaration') {
        for (const d of node.declarations) {
            // The id can reference outer bindings too: `const { a = DEF } = o`
            // and `const { [KEY]: v } = o`. Bound names are stripped below.
            add(d.id);
            add(d.init);
        }
    } else if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
        // Whole node: covers params, body, superClass and decorators.
        add(node);
    }

    for (const n of names) refs.delete(n);
    return refs;
}

export function collectTopLevelDeclarations(program: any, code: string): TopLevelDecl[] {
    const decls: TopLevelDecl[] = [];

    function push(node: any, names: string[]): void {
        decls.push({
            names,
            source: code.slice(node.start, node.end),
            start: node.start,
            end: node.end,
            refs: collectDeclReferences(node, names),
        });
    }

    function processDecl(node: any): void {
        if (node.type === 'VariableDeclaration') {
            const names = node.declarations.flatMap((d: any) =>
                extractPatternNames(d.id),
            );
            push(node, names);
        } else if (node.type === 'FunctionDeclaration' && node.id) {
            push(node, [node.id.name]);
        } else if (node.type === 'ClassDeclaration' && node.id) {
            push(node, [node.id.name]);
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

/**
 * Identifier positions that never resolve to a binding, so they must not count
 * as references: property names (`x.config`, `{ value: 1 }`) and statement
 * labels (`outer:`, `break outer`). Shorthand properties keep their separate
 * `value` node, so the binding is still seen.
 */
function isNonReferenceKey(n: any, key: string): boolean {
    if (key === 'label')
        return (
            n.type === 'LabeledStatement' ||
            n.type === 'BreakStatement' ||
            n.type === 'ContinueStatement'
        );
    if (n.computed) return false;
    if (key === 'property') return n.type === 'MemberExpression';
    if (key === 'key')
        return (
            n.type === 'Property' ||
            n.type === 'PropertyDefinition' ||
            n.type === 'MethodDefinition' ||
            n.type === 'AccessorProperty'
        );
    return false;
}

function walkChildren(n: any, visit: (child: any) => void): void {
    for (const key of Object.keys(n)) {
        if (key === 'type' || key === 'start' || key === 'end') continue;
        if (isNonReferenceKey(n, key)) continue;
        const child = n[key];
        if (Array.isArray(child))
            child.forEach((c: any) => {
                if (c && typeof c === 'object') visit(c);
            });
        else if (child && typeof child === 'object') visit(child);
    }
}

export function collectIdentifierReferences(node: any): Set<string> {
    const refs = new Set<string>();
    function walk(n: any): void {
        if (!n || typeof n !== 'object') return;
        if (n.type === 'Identifier') refs.add(n.name);
        walkChildren(n, walk);
    }
    walk(node);
    return refs;
}

/**
 * `var` and function declarations are function-scoped: they hoist out of nested
 * blocks, loops, switch cases and try/catch. Collect them from anywhere under
 * `node` without crossing into a nested function or class, whose own `var`s
 * belong to that inner scope.
 */
function collectHoistedNames(node: any, names: string[]): void {
    if (!node || typeof node !== 'object') return;
    const type = node.type;
    if (
        type === 'FunctionExpression' ||
        type === 'ArrowFunctionExpression' ||
        type === 'ClassDeclaration' ||
        type === 'ClassExpression' ||
        type === 'StaticBlock'
    ) {
        return;
    }
    if (type === 'FunctionDeclaration') {
        // The name still binds in the enclosing scope (annex B in nested blocks).
        if (node.id?.name) names.push(node.id.name);
        return;
    }
    if (type === 'VariableDeclaration') {
        if (node.kind === 'var')
            for (const d of node.declarations) names.push(...extractPatternNames(d.id));
        return;
    }
    walkChildren(node, (child) => collectHoistedNames(child, names));
}

function declaredNamesIn(statements: any[]): string[] {
    const names: string[] = [];
    for (const st of statements ?? []) {
        if (!st || typeof st !== 'object') continue;
        // Lexical declarations bind only at this statement level...
        if (st.type === 'VariableDeclaration') {
            for (const d of st.declarations) names.push(...extractPatternNames(d.id));
        } else if (
            (st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') &&
            st.id
        ) {
            names.push(st.id.name);
        }
        // ...while `var`/function declarations hoist out of nested statements.
        collectHoistedNames(st, names);
    }
    return names;
}

/**
 * Like collectIdentifierReferences, but skips identifiers that resolve to a
 * binding introduced inside `node` (parameters, inner declarations, catch
 * params, loop bindings). Only free identifiers - references to outer scopes -
 * are reported.
 */
export function collectScopedReferences(node: any): Set<string> {
    const refs = new Set<string>();

    function walk(n: any, bound: Set<string>): void {
        if (!n || typeof n !== 'object') return;
        if (n.type === 'Identifier') {
            if (!bound.has(n.name)) refs.add(n.name);
            return;
        }

        let scope = bound;
        const bind = (names: string[]) => {
            if (names.length === 0) return;
            if (scope === bound) scope = new Set(bound);
            for (const name of names) scope.add(name);
        };

        if (
            n.type === 'FunctionDeclaration' ||
            n.type === 'FunctionExpression' ||
            n.type === 'ArrowFunctionExpression'
        ) {
            if (n.id?.name) bind([n.id.name]);
            for (const p of n.params ?? []) bind(extractPatternNames(p));
        } else if (
            n.type === 'BlockStatement' ||
            n.type === 'Program' ||
            n.type === 'StaticBlock'
        ) {
            bind(declaredNamesIn(n.body));
        } else if (n.type === 'CatchClause') {
            bind(extractPatternNames(n.param));
        } else if (
            n.type === 'ForStatement' ||
            n.type === 'ForInStatement' ||
            n.type === 'ForOfStatement'
        ) {
            const init = n.init ?? n.left;
            if (init?.type === 'VariableDeclaration') bind(declaredNamesIn([init]));
        } else if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') {
            if (n.id?.name) bind([n.id.name]);
        }

        walkChildren(n, (child) => walk(child, scope));
    }

    walk(node, new Set());
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
