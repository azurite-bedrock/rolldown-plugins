import { parseSync, type ESTree } from 'rolldown/utils';
import { resolveSpecifier } from './paths.ts';

export { parseSync };

/**
 * Structural view of an AST node for the reflective walkers below, which key
 * over arbitrary node properties and so cannot use a precise oxc union. `type`
 * carries through so it can be discriminated; every other property surfaces as
 * `unknown` and is narrowed at the point of use. `start`/`end` are trusted to be
 * present because every real oxc node carries a span.
 */
type Node = { type?: string; start: number; end: number; [key: string]: unknown };

/** Any non-null object is treated as a walkable node. */
function isNode(value: unknown): value is Node {
    return typeof value === 'object' && value !== null;
}

/** The node elements of an arbitrary value, dropping holes and non-objects. */
function nodeArray(value: unknown): Node[] {
    return Array.isArray(value) ? value.filter(isNode) : [];
}

/** The textual name an `import`/`export` specifier resolves to. */
function moduleExportName(name: ESTree.ModuleExportName): string {
    return name.type === 'Identifier' ? name.name : name.value;
}

export type ComptimeBindings = { comptimeNames: Set<string>; watchNames: Set<string> };

export function collectComptimeBindings(program: ESTree.Program): ComptimeBindings {
    const comptimeNames = new Set<string>();
    const watchNames = new Set<string>();
    for (const node of program.body) {
        if (node.type !== 'ImportDeclaration' || node.source.value !== 'comptime')
            continue;
        for (const spec of node.specifiers) {
            if (spec.type !== 'ImportSpecifier') continue;
            const imported = moduleExportName(spec.imported);
            const local = spec.local.name;
            if (imported === 'comptime') comptimeNames.add(local);
            if (imported === 'watch') watchNames.add(local);
        }
    }
    return { comptimeNames, watchNames };
}

/** The single callback passed to a comptime() call: an arrow or function expression. */
export type ComptimeCallback =
    | ESTree.ArrowFunctionExpression
    | (ESTree.Function & { body: ESTree.FunctionBody });

export type ComptimeCall = {
    start: number;
    end: number;
    fn: ComptimeCallback;
    index: number;
    /** True when this call sits inside another comptime call's callback. */
    nested: boolean;
};

export function findComptimeCalls(
    program: ESTree.Program,
    comptimeNames: Set<string>,
): ComptimeCall[] {
    const calls: ComptimeCall[] = [];
    let index = 0;

    function walk(node: unknown, shadowed: Set<string>, inComptime: boolean): void {
        if (!isNode(node)) return;

        let childInComptime = inComptime;
        if (node.type === 'CallExpression') {
            const callee = node.callee;
            const args = node.arguments;
            const arg = Array.isArray(args) && args.length === 1 ? args[0] : undefined;
            if (
                isNode(callee) &&
                callee.type === 'Identifier' &&
                typeof callee.name === 'string' &&
                comptimeNames.has(callee.name) &&
                !shadowed.has(callee.name) &&
                isNode(arg) &&
                (arg.type === 'ArrowFunctionExpression' ||
                    arg.type === 'FunctionExpression')
            ) {
                calls.push({
                    start: node.start,
                    end: node.end,
                    fn: arg as unknown as ComptimeCallback,
                    index: index++,
                    nested: inComptime,
                });
                // Keep descending: the callback is spliced into a virtual module
                // verbatim, and a comptime call inside it would land there with no
                // binding to resolve it. Reporting those is the caller's job.
                childInComptime = true;
            }
        }

        const createsScope =
            node.type === 'FunctionDeclaration' ||
            node.type === 'FunctionExpression' ||
            node.type === 'ArrowFunctionExpression';

        let childShadowed = shadowed;
        if (createsScope) {
            childShadowed = new Set(shadowed);
            for (const param of nodeArray(node.params)) {
                if (
                    param.type === 'Identifier' &&
                    typeof param.name === 'string' &&
                    comptimeNames.has(param.name)
                ) {
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
                    if (!isNode(item) || !('type' in item)) continue;
                    if (item.type === 'VariableDeclaration') {
                        siblingShadowed = new Set(siblingShadowed);
                        for (const decl of nodeArray(item.declarations)) {
                            if (
                                isNode(decl.id) &&
                                decl.id.type === 'Identifier' &&
                                typeof decl.id.name === 'string' &&
                                comptimeNames.has(decl.id.name)
                            ) {
                                siblingShadowed.add(decl.id.name);
                            }
                        }
                        // Still walk the initializers with the pre-shadow set so the init itself is not shadowed
                        walk(item, childShadowed, childInComptime);
                    } else {
                        walk(item, siblingShadowed, childInComptime);
                    }
                }
            } else if (isNode(child)) {
                walk(child, childShadowed, childInComptime);
            }
        }
    }

    walk(program, new Set(), false);
    return calls;
}

export type ImportBinding = {
    localName: string;
    importedName: string;
    absSpecifier: string;
    originalSpecifier: string;
};

export function collectImportBindings(
    program: ESTree.Program,
    fileDir: string,
): Map<string, ImportBinding> {
    const bindings = new Map<string, ImportBinding>();
    for (const node of program.body) {
        if (node.type !== 'ImportDeclaration') continue;
        if (node.importKind === 'type') continue;
        const originalSpecifier = node.source.value;
        if (originalSpecifier === 'comptime') continue;
        const absSpecifier = resolveSpecifier(originalSpecifier, fileDir);
        for (const s of node.specifiers) {
            if (s.type === 'ImportSpecifier' && s.importKind === 'type') continue;
            const localName = s.local.name;
            const importedName =
                s.type === 'ImportDefaultSpecifier'
                    ? 'default'
                    : s.type === 'ImportNamespaceSpecifier'
                      ? '*'
                      : moduleExportName(s.imported);
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
function collectDeclReferences(node: Node, names: string[]): Set<string> {
    const refs = new Set<string>();
    const add = (from: unknown) => {
        if (!isNode(from)) return;
        for (const r of collectScopedReferences(from)) refs.add(r);
    };

    if (node.type === 'VariableDeclaration') {
        for (const d of nodeArray(node.declarations)) {
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

export function collectTopLevelDeclarations(
    program: ESTree.Program,
    code: string,
): TopLevelDecl[] {
    const decls: TopLevelDecl[] = [];

    function push(node: Node, names: string[]): void {
        decls.push({
            names,
            source: code.slice(node.start, node.end),
            start: node.start,
            end: node.end,
            refs: collectDeclReferences(node, names),
        });
    }

    function processDecl(node: unknown): void {
        if (!isNode(node)) return;
        if (node.type === 'VariableDeclaration') {
            const names = nodeArray(node.declarations).flatMap((d) =>
                extractPatternNames(d.id),
            );
            push(node, names);
        } else if (node.type === 'FunctionDeclaration' && isNode(node.id)) {
            if (typeof node.id.name === 'string') push(node, [node.id.name]);
        } else if (node.type === 'ClassDeclaration' && isNode(node.id)) {
            if (typeof node.id.name === 'string') push(node, [node.id.name]);
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

function extractPatternNames(pat: unknown): string[] {
    if (!isNode(pat)) return [];
    if (pat.type === 'Identifier')
        return typeof pat.name === 'string' ? [pat.name] : [];
    if (pat.type === 'ObjectPattern')
        return nodeArray(pat.properties).flatMap((p) =>
            extractPatternNames(p.value ?? p.argument),
        );
    if (pat.type === 'ArrayPattern')
        return nodeArray(pat.elements).flatMap((e) => extractPatternNames(e));
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
function isNonReferenceKey(n: Node, key: string): boolean {
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

/** Visit each child node, skipping identifier positions that are not references. */
function walkChildren(n: Node, visit: (child: unknown) => void): void {
    for (const key of Object.keys(n)) {
        if (key === 'type' || key === 'start' || key === 'end') continue;
        if (isNonReferenceKey(n, key)) continue;
        const child = n[key];
        if (Array.isArray(child)) {
            for (const c of child) if (isNode(c)) visit(c);
        } else if (isNode(child)) {
            visit(child);
        }
    }
}

/** Visit every child node, without the reference-position filtering. */
function eachChild(n: Node, visit: (child: unknown) => void): void {
    for (const key of Object.keys(n)) {
        if (key === 'type' || key === 'start' || key === 'end') continue;
        const child = n[key];
        if (Array.isArray(child)) {
            for (const c of child) if (isNode(c)) visit(c);
        } else if (isNode(child)) {
            visit(child);
        }
    }
}

export function collectIdentifierReferences(node: unknown): Set<string> {
    const refs = new Set<string>();
    function walk(n: unknown): void {
        if (!isNode(n)) return;
        if (n.type === 'Identifier' && typeof n.name === 'string') refs.add(n.name);
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
function collectHoistedNames(node: Node, names: string[]): void {
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
        if (isNode(node.id) && typeof node.id.name === 'string') names.push(node.id.name);
        return;
    }
    if (type === 'VariableDeclaration') {
        if (node.kind === 'var')
            for (const d of nodeArray(node.declarations))
                names.push(...extractPatternNames(d.id));
        return;
    }
    walkChildren(node, (child) => {
        if (isNode(child)) collectHoistedNames(child, names);
    });
}

function declaredNamesIn(statements: unknown): string[] {
    const names: string[] = [];
    for (const st of nodeArray(statements)) {
        // Lexical declarations bind only at this statement level...
        if (st.type === 'VariableDeclaration') {
            for (const d of nodeArray(st.declarations))
                names.push(...extractPatternNames(d.id));
        } else if (
            (st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') &&
            isNode(st.id) &&
            typeof st.id.name === 'string'
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
export function collectScopedReferences(node: unknown): Set<string> {
    const refs = new Set<string>();

    function walk(n: unknown, bound: Set<string>): void {
        if (!isNode(n)) return;
        if (n.type === 'Identifier') {
            if (typeof n.name === 'string' && !bound.has(n.name)) refs.add(n.name);
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
            if (isNode(n.id) && typeof n.id.name === 'string') bind([n.id.name]);
            for (const p of nodeArray(n.params)) bind(extractPatternNames(p));
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
            if (isNode(init) && init.type === 'VariableDeclaration')
                bind(declaredNamesIn([init]));
        } else if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') {
            if (isNode(n.id) && typeof n.id.name === 'string') bind([n.id.name]);
        }

        walkChildren(n, (child) => walk(child, scope));
    }

    walk(node, new Set());
    return refs;
}

export function collectDenoEnvReads(node: unknown): Set<string> {
    const keys = new Set<string>();
    function walk(n: unknown): void {
        if (!isNode(n)) return;
        const callee = n.callee;
        if (n.type === 'CallExpression' && isNode(callee) && callee.type === 'MemberExpression') {
            const property = callee.property;
            const object = callee.object;
            const innerProp = isNode(object) ? object.property : undefined;
            const innerObj = isNode(object) ? object.object : undefined;
            if (
                isNode(property) &&
                property.name === 'get' &&
                isNode(object) &&
                object.type === 'MemberExpression' &&
                isNode(innerProp) &&
                innerProp.name === 'env' &&
                isNode(innerObj) &&
                innerObj.name === 'Deno'
            ) {
                const args = n.arguments;
                const arg = Array.isArray(args) && args.length === 1 ? args[0] : undefined;
                if (
                    isNode(arg) &&
                    (arg.type === 'StringLiteral' || arg.type === 'Literal') &&
                    typeof arg.value === 'string'
                ) {
                    keys.add(arg.value);
                }
            }
        }
        eachChild(n, walk);
    }
    walk(node);
    return keys;
}
