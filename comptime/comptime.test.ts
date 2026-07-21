import {
    assertEquals,
    assertInstanceOf,
    assertMatch,
    assertNotEquals,
    assertRejects,
    assertStringIncludes,
    assertThrows,
} from '@std/assert';
import { parseSync } from 'rolldown/experimental';
import { rolldown } from 'rolldown';
import { join } from '@std/path';
import { ensureDir } from '@std/fs';
import { comptime as comptimeRuntime, watch } from './runtime.ts';
import {
    collectComptimeBindings,
    collectDenoEnvReads,
    collectIdentifierReferences,
    collectImportBindings,
    collectTopLevelDeclarations,
    ComptimeTransformError,
    findComptimeCalls,
    isLocalFile,
    normalizeToForwardSlashes,
    resolveSpecifier,
    shouldScan,
    type ImportBinding,
} from './ast.ts';
import { contentHash, createVirtualModule, serializeValue } from './virtual.ts';
import { createCore } from './core.ts';
import { RolldownEvaluator, type EvaluateResult } from './evaluator.ts';
import { comptime as comptimePlugin } from './plugin.ts';

// runtime

Deno.test('comptime throws at runtime', () => {
    assertThrows(
        () => comptimeRuntime(() => 42),
        Error,
        'comptime() must be replaced by the rolldown plugin before runtime',
    );
});

Deno.test('watch is a no-op at runtime', () => {
    const result = watch('./some/file.ts');
    assertEquals(result, undefined);
});

// ComptimeTransformError

Deno.test('ComptimeTransformError has correct name', () => {
    const err = new ComptimeTransformError(
        'test error',
        { file: '/foo/bar.ts', line: 3, column: 5 },
        'const x = comptime(() => 1);\n         ^',
    );
    assertEquals(err.name, 'ComptimeTransformError');
    assertInstanceOf(err, Error);
});

Deno.test('ComptimeTransformError exposes message, loc, and frame', () => {
    const loc = { file: '/foo/bar.ts', line: 3, column: 5 };
    const frame = 'const x = comptime(() => 1);\n         ^';
    const err = new ComptimeTransformError('msg', loc, frame);
    assertEquals(err.message, 'msg');
    assertEquals(err.loc, loc);
    assertEquals(err.frame, frame);
});

// RolldownEvaluator

const V = '\0comptime:/fake/file.ts?comptime=0';

Deno.test('RolldownEvaluator evaluates a simple value', async () => {
    const evaluator = new RolldownEvaluator();
    const source = `export const __comptime_watch = [];\nexport default 42;`;
    const result = await evaluator.evaluate(V, source);
    assertEquals(result.value, 42);
    assertEquals(result.watchFiles, []);
});

Deno.test(
    'RolldownEvaluator returns watchFiles from __comptime_watch export',
    async () => {
        const evaluator = new RolldownEvaluator();
        const source = `export const __comptime_watch = ["./a.ts", "./b.ts"];\nexport default "hello";`;
        const result = await evaluator.evaluate(V, source);
        assertEquals(result.value, 'hello');
        assertEquals(result.watchFiles, ['./a.ts', './b.ts']);
    },
);

Deno.test('RolldownEvaluator nonce increments between evaluations', async () => {
    const evaluator = new RolldownEvaluator();
    const r1 = await evaluator.evaluate(
        V + '0',
        `export default 1; export const __comptime_watch = [];`,
    );
    const r2 = await evaluator.evaluate(
        V + '1',
        `export default 2; export const __comptime_watch = [];`,
    );
    assertEquals(r1.value, 1);
    assertEquals(r2.value, 2);
});

Deno.test('RolldownEvaluator throws on inner build failure', async () => {
    const evaluator = new RolldownEvaluator();
    const source = `
    import { missing } from "/nonexistent/module.ts";
    export default missing;
    export const __comptime_watch = [];
  `;
    await assertRejects(
        () => evaluator.evaluate(V, source),
        Error,
        'comptime inner build failed',
    );
});

Deno.test('RolldownEvaluator accepts innerPlugins', async () => {
    const evaluator = new RolldownEvaluator();
    const aliasPlugin = {
        name: 'alias',
        resolveId: (id: string) => (id === 'virtual:val' ? '\0virtual:val' : null),
        load: (id: string) => (id === '\0virtual:val' ? `export const x = 99;` : null),
    };
    const source = `
    import { x } from "virtual:val";
    export default x;
    export const __comptime_watch = [];
  `;
    const result = await evaluator.evaluate(V, source, [aliasPlugin]);
    assertEquals(result.value, 99);
});

// shouldScan

Deno.test('shouldScan returns false for virtual ids', () => {
    assertEquals(shouldScan('comptime', '\0virtual:mod', {}), false);
});

Deno.test('shouldScan returns false for unsupported extensions', () => {
    assertEquals(shouldScan('comptime', '/foo/bar.css', {}), false);
});

Deno.test("shouldScan returns false when code lacks 'comptime' substring", () => {
    assertEquals(shouldScan('const x = 1;', '/foo/bar.ts', {}), false);
});

Deno.test('shouldScan returns true for .ts file with comptime substring', () => {
    assertEquals(shouldScan('comptime(() => 1)', '/foo/bar.ts', {}), true);
});

Deno.test('shouldScan respects exclude option', () => {
    assertEquals(shouldScan('comptime', '/foo/bar.ts', { exclude: ['**/*.ts'] }), false);
});

Deno.test('shouldScan respects include option', () => {
    assertEquals(
        shouldScan('comptime', '/foo/bar.ts', { include: ['**/other/**'] }),
        false,
    );
    assertEquals(shouldScan('comptime', '/foo/bar.ts', { include: ['**/*.ts'] }), true);
});

// collectComptimeBindings

Deno.test('collectComptimeBindings finds comptime and watch bindings', () => {
    const { program } = parseSync(
        '/f.ts',
        `import { comptime, watch } from "comptime";`,
        { lang: 'ts', sourceType: 'module' },
    );
    const { comptimeNames, watchNames } = collectComptimeBindings(program);
    assertEquals(comptimeNames, new Set(['comptime']));
    assertEquals(watchNames, new Set(['watch']));
});

Deno.test('collectComptimeBindings handles aliased imports', () => {
    const { program } = parseSync(
        '/f.ts',
        `import { comptime as ct, watch as w } from "comptime";`,
        { lang: 'ts', sourceType: 'module' },
    );
    const { comptimeNames, watchNames } = collectComptimeBindings(program);
    assertEquals(comptimeNames, new Set(['ct']));
    assertEquals(watchNames, new Set(['w']));
});

Deno.test('collectComptimeBindings returns empty sets when no comptime import', () => {
    const { program } = parseSync('/f.ts', `import { foo } from "./bar.ts";`, {
        lang: 'ts',
        sourceType: 'module',
    });
    const { comptimeNames, watchNames } = collectComptimeBindings(program);
    assertEquals(comptimeNames, new Set());
    assertEquals(watchNames, new Set());
});

// findComptimeCalls

Deno.test('findComptimeCalls finds a single call', () => {
    const code = `import { comptime } from "comptime";\nexport const x = comptime(() => 42);`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const calls = findComptimeCalls(program, comptimeNames);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].index, 0);
});

Deno.test('findComptimeCalls finds multiple calls and assigns sequential indexes', () => {
    const code = `
import { comptime } from "comptime";
export const a = comptime(() => 1);
export const b = comptime(() => 2);
  `.trim();
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const calls = findComptimeCalls(program, comptimeNames);
    assertEquals(calls.length, 2);
    assertEquals(calls[0].index, 0);
    assertEquals(calls[1].index, 1);
});

Deno.test('findComptimeCalls ignores shadowed bindings', () => {
    const code = `
import { comptime } from "comptime";
function foo() {
  const comptime = (x: unknown) => x;
  return comptime(() => 99);
}
  `.trim();
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const calls = findComptimeCalls(program, comptimeNames);
    assertEquals(calls.length, 0);
});

// collectImportBindings

Deno.test("collectImportBindings excludes the 'comptime' import", () => {
    const code = `import { comptime, watch } from "comptime";\nimport { fib } from "./math.ts";`;
    const { program } = parseSync('/src/f.ts', code, {
        lang: 'ts',
        sourceType: 'module',
    });
    const bindings = collectImportBindings(program, '/src');
    assertEquals(bindings.has('comptime'), false);
    assertEquals(bindings.has('watch'), false);
    assertEquals(
        bindings.get('fib')!.absSpecifier,
        resolveSpecifier('./math.ts', '/src'),
    );
});

Deno.test('collectImportBindings passes npm: specifiers through unchanged', () => {
    const code = `import { something } from "npm:some-lib";`;
    const { program } = parseSync('/src/f.ts', code, {
        lang: 'ts',
        sourceType: 'module',
    });
    const bindings = collectImportBindings(program, '/src');
    assertEquals(bindings.get('something')!.absSpecifier, 'npm:some-lib');
});

Deno.test('collectImportBindings handles default and namespace imports', () => {
    const code = `import Foo from "./foo.ts";\nimport * as Bar from "./bar.ts";`;
    const { program } = parseSync('/src/f.ts', code, {
        lang: 'ts',
        sourceType: 'module',
    });
    const bindings = collectImportBindings(program, '/src');
    assertEquals(bindings.get('Foo')!.importedName, 'default');
    assertEquals(bindings.get('Bar')!.importedName, '*');
});

// collectTopLevelDeclarations

Deno.test(
    'collectTopLevelDeclarations finds const, function, and class declarations',
    () => {
        const code = `const PI = 3.14;\nfunction double(x: number) { return x * 2; }\nclass Foo {}`;
        const { program } = parseSync('/f.ts', code, {
            lang: 'ts',
            sourceType: 'module',
        });
        const decls = collectTopLevelDeclarations(program, code);
        const names = decls.flatMap((d) => d.names);
        assertEquals(names.includes('PI'), true);
        assertEquals(names.includes('double'), true);
        assertEquals(names.includes('Foo'), true);
    },
);

Deno.test(
    'collectTopLevelDeclarations extracts names from destructuring patterns',
    () => {
        const code = `const { a, b } = { a: 1, b: 2 };`;
        const { program } = parseSync('/f.ts', code, {
            lang: 'ts',
            sourceType: 'module',
        });
        const decls = collectTopLevelDeclarations(program, code);
        const names = decls.flatMap((d) => d.names);
        assertEquals(names.includes('a'), true);
        assertEquals(names.includes('b'), true);
    },
);

Deno.test('collectTopLevelDeclarations finds exported declarations', () => {
    const code = `export const x = 1;\nexport function helper() {}\nexport class MyClass {}`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const decls = collectTopLevelDeclarations(program, code);
    const names = decls.flatMap((d) => d.names);
    assertEquals(names.includes('x'), true);
    assertEquals(names.includes('helper'), true);
    assertEquals(names.includes('MyClass'), true);
});

// collectIdentifierReferences

Deno.test('collectIdentifierReferences finds free identifiers in a function body', () => {
    const code = `
import { comptime } from "comptime";
import { fib } from "./math.ts";
export const x = comptime(() => fib(10));
  `.trim();
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const calls = findComptimeCalls(program, comptimeNames);
    const refs = collectIdentifierReferences(calls[0].fn.body);
    assertEquals(refs.has('fib'), true);
});

// createVirtualModule

Deno.test('createVirtualModule injects watch() synthetic function', () => {
    const src = createVirtualModule([], [], `return 42;`);
    assertEquals(src.includes('const __comptime_watch_files = []'), true);
    assertEquals(src.includes('const watch = (path)'), true);
    assertEquals(src.includes('__comptime_watch_files.push(path)'), true);
});

Deno.test('createVirtualModule omits the watch shim when an import binds watch', () => {
    const binding: ImportBinding = {
        localName: 'watch',
        importedName: 'watch',
        absSpecifier: '/abs/fs-helpers.ts',
        originalSpecifier: './fs-helpers.ts',
    };
    const src = createVirtualModule([binding], [], `return watch("a.txt");`);
    assertEquals(src.includes('const watch = (path)'), false);
    assertEquals(src.includes(`import { watch } from "/abs/fs-helpers.ts"`), true);
    assertEquals(src.includes('const __comptime_watch_files = []'), true);
});

Deno.test('createVirtualModule exports default and __comptime_watch', () => {
    const src = createVirtualModule([], [], `return 42;`);
    assertEquals(src.includes('export { __comptime_result as default'), true);
    assertEquals(src.includes('__comptime_watch_files as __comptime_watch }'), true);
});

Deno.test('createVirtualModule rewrites named import to absolute specifier', () => {
    const binding: ImportBinding = {
        localName: 'fib',
        importedName: 'fibonacci',
        absSpecifier: '/abs/math.ts',
        originalSpecifier: './math.ts',
    };
    const src = createVirtualModule([binding], [], `return fib(10);`);
    assertEquals(src.includes(`import { fibonacci as fib } from "/abs/math.ts"`), true);
});

Deno.test('createVirtualModule rewrites default import', () => {
    const binding: ImportBinding = {
        localName: 'Foo',
        importedName: 'default',
        absSpecifier: '/abs/foo.ts',
        originalSpecifier: './foo.ts',
    };
    const src = createVirtualModule([binding], [], `return new Foo();`);
    assertEquals(src.includes(`import Foo from "/abs/foo.ts"`), true);
});

Deno.test('createVirtualModule rewrites namespace import', () => {
    const binding: ImportBinding = {
        localName: 'ns',
        importedName: '*',
        absSpecifier: '/abs/ns.ts',
        originalSpecifier: './ns.ts',
    };
    const src = createVirtualModule([binding], [], `return ns.x;`);
    assertEquals(src.includes(`import * as ns from "/abs/ns.ts"`), true);
});

// collectDenoEnvReads

Deno.test('collectDenoEnvReads finds static Deno.env.get keys', () => {
    const code = `import { comptime } from "comptime";\nexport const x = comptime(() => Deno.env.get("MY_KEY"));`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const calls = findComptimeCalls(program, comptimeNames);
    const keys = collectDenoEnvReads(calls[0].fn.body);
    assertEquals(keys, new Set(['MY_KEY']));
});

// contentHash

Deno.test('contentHash is stable for the same input', async () => {
    const h1 = await contentHash('source', [['KEY', 'v']]);
    const h2 = await contentHash('source', [['KEY', 'v']]);
    assertEquals(h1, h2);
});

Deno.test('contentHash differs when env values change', async () => {
    const h1 = await contentHash('source', [['KEY', 'v1']]);
    const h2 = await contentHash('source', [['KEY', 'v2']]);
    assertEquals(h1 === h2, false);
});

Deno.test('contentHash is order-independent for env entries', async () => {
    const h1 = await contentHash('s', [
        ['A', '1'],
        ['B', '2'],
    ]);
    const h2 = await contentHash('s', [
        ['B', '2'],
        ['A', '1'],
    ]);
    assertEquals(h1, h2);
});

// serializeValue

Deno.test('serializeValue serializes number', () => {
    assertEquals(serializeValue(42, undefined), '42');
});

Deno.test('serializeValue serializes string', () => {
    assertEquals(serializeValue('hello', undefined), `"hello"`);
});

Deno.test('serializeValue serializes array', () => {
    assertEquals(serializeValue([1, 2, 3], undefined), '[1,2,3]');
});

Deno.test('serializeValue uses custom serializer when test() matches', () => {
    const d = new Date('2024-01-01T00:00:00.000Z');
    const serializers = [
        {
            test: (v: unknown) => v instanceof Date,
            serialize: (v: unknown) => `new Date(${(v as Date).getTime()})`,
        },
    ];
    assertEquals(serializeValue(d, serializers), `new Date(${d.getTime()})`);
});

Deno.test('serializeValue throws for unserializable values', () => {
    assertThrows(
        () => serializeValue(() => {}, undefined),
        Error,
        'comptime returned a value that cannot be serialized',
    );
});

// createCore

const mockEvaluator = {
    evaluate: async (
        _id: string,
        _src: string,
        _plugins?: unknown[],
    ): Promise<EvaluateResult> => ({
        value: 55,
        watchFiles: [],
    }),
};

Deno.test(
    'createCore.transform replaces comptime call with serialized literal',
    async () => {
        const code = `import { comptime } from "comptime";\nexport const x = comptime(() => 42);`;
        const core = createCore(mockEvaluator as any, {});
        const result = await core.transform(code, '/src/file.ts', {});
        assertEquals(result !== null, true);
        assertEquals(result!.code.includes('55'), true);
        assertEquals(result!.code.includes('comptime('), false);
    },
);

Deno.test(
    'createCore.transform returns null when no comptime calls present',
    async () => {
        const code = `export const x = 1;`;
        const core = createCore(mockEvaluator as any, {});
        const result = await core.transform(code, '/src/file.ts', {});
        assertEquals(result, null);
    },
);

Deno.test('createCore.transform handles expression-body arrow functions', async () => {
    const code = `import { comptime } from "comptime";\nexport const x = comptime(() => 2 + 2);`;
    const fourEvaluator = {
        evaluate: async (): Promise<EvaluateResult> => ({ value: 4, watchFiles: [] }),
    };
    const core = createCore(fourEvaluator as any, {});
    const result = await core.transform(code, '/src/file.ts', {});
    assertEquals(result !== null, true);
    assertEquals(result!.code.includes('4'), true);
});

Deno.test(
    'createCore caches results and does not re-evaluate on identical calls',
    async () => {
        const code = `import { comptime } from "comptime";\nexport const x = comptime(() => 1);`;
        let calls = 0;
        const counting = {
            evaluate: async (): Promise<EvaluateResult> => {
                calls++;
                return { value: 1, watchFiles: [] };
            },
        };
        const core = createCore(counting as any, {});
        await core.transform(code, '/f.ts', {});
        await core.transform(code, '/f.ts', {});
        assertEquals(calls, 1);
    },
);

Deno.test(
    'createCore.invalidate clears the cache so next transform re-evaluates',
    async () => {
        const code = `import { comptime } from "comptime";\nexport const x = comptime(() => 1);`;
        let calls = 0;
        const counting = {
            evaluate: async (): Promise<EvaluateResult> => {
                calls++;
                return { value: 1, watchFiles: [] };
            },
        };
        const core = createCore(counting as any, {});
        await core.transform(code, '/f.ts', {});
        core.invalidate();
        await core.transform(code, '/f.ts', {});
        assertEquals(calls, 2);
    },
);

Deno.test(
    'createCore.transform throws ComptimeTransformError for arrow with params',
    async () => {
        const code = `import { comptime } from "comptime";\nexport const x = comptime((n: number) => n);`;
        const core = createCore(mockEvaluator as any, {});
        await assertRejects(
            () => core.transform(code, '/f.ts', {}),
            ComptimeTransformError,
            'comptime() requires a single arrow function with no parameters',
        );
    },
);

// plugin integration

const FIXTURE_DIR =
    (Deno.env.get('TEMP') ?? '/tmp').replace(/\\/g, '/') + '/comptime-plugin-test';
const runtimePath = new URL('./runtime.ts', import.meta.url).pathname.replace(/\\/g, '/');

function aliasComptime() {
    return {
        name: 'alias-comptime',
        resolveId: (id: string) => (id === 'comptime' ? runtimePath : null),
    };
}

async function setup() {
    await ensureDir(FIXTURE_DIR);
}
async function teardown() {
    await Deno.remove(FIXTURE_DIR, { recursive: true });
}

Deno.test('comptime plugin replaces call with evaluated literal', async () => {
    await setup();
    let build: Awaited<ReturnType<typeof rolldown>> | undefined;
    try {
        const entry = join(FIXTURE_DIR, 'simple.ts');
        await Deno.writeTextFile(
            entry,
            `
import { comptime } from "comptime";
export const value = comptime(() => 2 + 2);
    `.trim(),
        );

        build = await rolldown({
            input: entry,
            plugins: [aliasComptime(), comptimePlugin()],
        });
        const { output } = await build.generate({ format: 'esm' });

        assertStringIncludes(output[0].code, '4');
        assertEquals(output[0].code.includes('comptime('), false);
    } finally {
        await build?.close();
        await teardown();
    }
});

Deno.test('comptime plugin evaluates async body', async () => {
    await setup();
    let build: Awaited<ReturnType<typeof rolldown>> | undefined;
    try {
        const dataFile = join(FIXTURE_DIR, 'data.txt');
        const entry = join(FIXTURE_DIR, 'async.ts');
        await Deno.writeTextFile(dataFile, 'hello from file');
        await Deno.writeTextFile(
            entry,
            `
import { comptime } from "comptime";
export const content = comptime(async () => {
  return await Deno.readTextFile("${normalizeToForwardSlashes(dataFile)}");
});
    `.trim(),
        );

        build = await rolldown({
            input: entry,
            plugins: [aliasComptime(), comptimePlugin()],
        });
        const { output } = await build.generate({ format: 'esm' });

        assertStringIncludes(output[0].code, `"hello from file"`);
    } finally {
        await build?.close();
        await teardown();
    }
});

Deno.test('comptime plugin evaluates body referencing an imported function', async () => {
    await setup();
    let build: Awaited<ReturnType<typeof rolldown>> | undefined;
    try {
        const mathFile = join(FIXTURE_DIR, 'math.ts');
        const entry = join(FIXTURE_DIR, 'ref.ts');
        await Deno.writeTextFile(
            mathFile,
            `export function double(x: number) { return x * 2; }`,
        );
        await Deno.writeTextFile(
            entry,
            `
import { comptime } from "comptime";
import { double } from "${normalizeToForwardSlashes(mathFile)}";
export const value = comptime(() => double(21));
    `.trim(),
        );

        build = await rolldown({
            input: entry,
            plugins: [aliasComptime(), comptimePlugin()],
        });
        const { output } = await build.generate({ format: 'esm' });

        assertStringIncludes(output[0].code, '42');
        assertEquals(output[0].code.includes('comptime('), false);
    } finally {
        await build?.close();
        await teardown();
    }
});

Deno.test('comptime plugin serializes objects and arrays', async () => {
    await setup();
    let build: Awaited<ReturnType<typeof rolldown>> | undefined;
    try {
        const entry = join(FIXTURE_DIR, 'obj.ts');
        await Deno.writeTextFile(
            entry,
            `
import { comptime } from "comptime";
export const data = comptime(() => ({ x: 1, y: [2, 3] }));
    `.trim(),
        );

        build = await rolldown({
            input: entry,
            plugins: [aliasComptime(), comptimePlugin()],
        });
        const { output } = await build.generate({ format: 'esm' });

        assertStringIncludes(output[0].code, 'x:');
        assertStringIncludes(output[0].code, 'y:');
        assertEquals(output[0].code.includes('comptime('), false);
    } finally {
        await build?.close();
        await teardown();
    }
});

Deno.test('comptime plugin handles TypeScript type annotations in body', async () => {
    await setup();
    let build: Awaited<ReturnType<typeof rolldown>> | undefined;
    try {
        const entry = join(FIXTURE_DIR, 'typed.ts');
        await Deno.writeTextFile(
            entry,
            `
import { comptime } from "comptime";
export const value = comptime((): number => {
  const x: number = 21;
  const y: number = 21;
  return x + y;
});
    `.trim(),
        );

        build = await rolldown({
            input: entry,
            plugins: [aliasComptime(), comptimePlugin()],
        });
        const { output } = await build.generate({ format: 'esm' });

        assertStringIncludes(output[0].code, '42');
        assertEquals(output[0].code.includes('comptime('), false);
    } finally {
        await build?.close();
        await teardown();
    }
});

Deno.test('comptime plugin resolves relative imports in comptime body', async () => {
    await setup();
    let build: Awaited<ReturnType<typeof rolldown>> | undefined;
    try {
        const mathFile = join(FIXTURE_DIR, 'math2.ts');
        const entry = join(FIXTURE_DIR, 'rel.ts');
        await Deno.writeTextFile(
            mathFile,
            `export function triple(x: number) { return x * 3; }`,
        );
        await Deno.writeTextFile(
            entry,
            `
import { comptime } from "comptime";
import { triple } from "./math2.ts";
export const value = comptime(() => triple(14));
    `.trim(),
        );

        build = await rolldown({
            input: entry,
            plugins: [aliasComptime(), comptimePlugin()],
        });
        const { output } = await build.generate({ format: 'esm' });

        assertStringIncludes(output[0].code, '42');
        assertEquals(output[0].code.includes('comptime('), false);
    } finally {
        await build?.close();
        await teardown();
    }
});

Deno.test('comptime plugin evaluates a body using a watch import from another module', async () => {
    await setup();
    let build: Awaited<ReturnType<typeof rolldown>> | undefined;
    try {
        const helperFile = join(FIXTURE_DIR, 'fs-helpers.ts');
        const entry = join(FIXTURE_DIR, 'watch-name.ts');
        await Deno.writeTextFile(
            helperFile,
            `export function watch(path: string) { return "watching:" + path; }`,
        );
        await Deno.writeTextFile(
            entry,
            `
import { comptime } from "comptime";
import { watch } from "./fs-helpers.ts";
export const value = comptime(() => watch("config.json"));
    `.trim(),
        );

        build = await rolldown({
            input: entry,
            plugins: [aliasComptime(), comptimePlugin()],
        });
        const { output } = await build.generate({ format: 'esm' });

        assertStringIncludes(output[0].code, '"watching:config.json"');
        assertEquals(output[0].code.includes('comptime('), false);
    } finally {
        await build?.close();
        await teardown();
    }
});

// shouldScan extended

Deno.test('shouldScan accepts every supported extension', () => {
    for (const ext of ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts']) {
        assertEquals(shouldScan('comptime', `/foo/bar.${ext}`, {}), true);
    }
});

Deno.test('shouldScan rejects unsupported and extension-less ids', () => {
    assertEquals(shouldScan('comptime', '/foo/bar.json', {}), false);
    assertEquals(shouldScan('comptime', '/foo/bar.vue', {}), false);
    assertEquals(shouldScan('comptime', '/foo/barts', {}), false);
});

Deno.test('shouldScan extension matching is case sensitive', () => {
    assertEquals(shouldScan('comptime', '/foo/bar.TS', {}), false);
});

Deno.test('shouldScan accepts a plain string include/exclude', () => {
    assertEquals(shouldScan('comptime', '/foo/bar.ts', { include: '**/*.ts' }), true);
    assertEquals(shouldScan('comptime', '/foo/bar.ts', { exclude: '**/foo/**' }), false);
});

Deno.test('shouldScan applies exclude before include', () => {
    assertEquals(
        shouldScan('comptime', '/foo/bar.ts', {
            include: ['**/*.ts'],
            exclude: ['**/bar.ts'],
        }),
        false,
    );
});

Deno.test('shouldScan matches the substring anywhere in the code', () => {
    assertEquals(shouldScan('// mentions comptime in a comment', '/f.ts', {}), true);
    assertEquals(shouldScan('const comptimeish = 1;', '/f.ts', {}), true);
});

// collectComptimeBindings extended

Deno.test('collectComptimeBindings ignores default and namespace comptime imports', () => {
    for (const code of [
        `import comptime from "comptime";`,
        `import * as comptime from "comptime";`,
    ]) {
        const { program } = parseSync('/f.ts', code, {
            lang: 'ts',
            sourceType: 'module',
        });
        const { comptimeNames, watchNames } = collectComptimeBindings(program);
        assertEquals(comptimeNames, new Set());
        assertEquals(watchNames, new Set());
    }
});

Deno.test('collectComptimeBindings merges multiple comptime import declarations', () => {
    const code = `import { comptime } from "comptime";\nimport { comptime as ct, watch } from "comptime";`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames, watchNames } = collectComptimeBindings(program);
    assertEquals(comptimeNames, new Set(['comptime', 'ct']));
    assertEquals(watchNames, new Set(['watch']));
});

Deno.test('collectComptimeBindings ignores comptime-named imports from other modules', () => {
    const code = `import { comptime } from "./not-comptime.ts";`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    assertEquals(comptimeNames, new Set());
});

Deno.test('collectComptimeBindings supports string-literal import names', () => {
    const code = `import { "comptime" as ct } from "comptime";`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    assertEquals(comptimeNames, new Set(['ct']));
});

// findComptimeCalls extended

Deno.test('findComptimeCalls accepts function expressions as the argument', () => {
    const code = `import { comptime } from "comptime";\nexport const x = comptime(function () { return 1; });`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    assertEquals(findComptimeCalls(program, comptimeNames).length, 1);
});

Deno.test('findComptimeCalls ignores calls whose argument is not a function', () => {
    const code = `import { comptime } from "comptime";\nexport const x = comptime(42);`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    assertEquals(findComptimeCalls(program, comptimeNames).length, 0);
});

Deno.test('findComptimeCalls ignores calls with more than one argument', () => {
    const code = `import { comptime } from "comptime";\nexport const x = comptime(() => 1, 2);`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    assertEquals(findComptimeCalls(program, comptimeNames).length, 0);
});

Deno.test('findComptimeCalls flags an inner call as nested', () => {
    const code = `import { comptime } from "comptime";\nexport const x = comptime(() => comptime(() => 1));`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const calls = findComptimeCalls(program, comptimeNames);
    assertEquals(calls.length, 2);
    assertEquals(calls[0].nested, false);
    assertEquals(calls[1].nested, true);
    assertEquals(code.slice(calls[1].start, calls[1].end), 'comptime(() => 1)');
});

Deno.test('findComptimeCalls flags a nested call inside a function in the callback', () => {
    const code = `
import { comptime } from "comptime";
export const x = comptime(() => {
  function inner() { return comptime(() => 1); }
  return inner();
});
  `.trim();
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const calls = findComptimeCalls(program, comptimeNames);
    assertEquals(calls.length, 2);
    assertEquals(calls[1].nested, true);
});

Deno.test('findComptimeCalls does not flag a shadowed inner comptime as nested', () => {
    const code = `
import { comptime } from "comptime";
export const x = comptime(() => {
  const comptime = (f: () => number) => f();
  return comptime(() => 1);
});
  `.trim();
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const calls = findComptimeCalls(program, comptimeNames);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].nested, false);
});

Deno.test('findComptimeCalls does not flag a non-call comptime reference as nested', () => {
    const code = `import { comptime } from "comptime";\nexport const x = comptime(() => typeof comptime);`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const calls = findComptimeCalls(program, comptimeNames);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].nested, false);
});

Deno.test('findComptimeCalls does not flag sibling calls as nested', () => {
    const code = `
import { comptime } from "comptime";
export const a = comptime(() => 1);
export const b = comptime(() => 2);
  `.trim();
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const calls = findComptimeCalls(program, comptimeNames);
    assertEquals(
        calls.map((c) => c.nested),
        [false, false],
    );
});

Deno.test('findComptimeCalls finds calls nested in functions and object literals', () => {
    const code = `
import { comptime } from "comptime";
function f() { return comptime(() => 1); }
const obj = { m: comptime(() => 2) };
  `.trim();
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    assertEquals(findComptimeCalls(program, comptimeNames).length, 2);
});

Deno.test('findComptimeCalls treats function parameters as shadowing', () => {
    const code = `
import { comptime } from "comptime";
function f(comptime: unknown) { return (comptime as any)(() => 1); }
export const y = comptime(() => 2);
  `.trim();
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const calls = findComptimeCalls(program, comptimeNames);
    assertEquals(calls.length, 1);
    assertEquals(code.slice(calls[0].start, calls[0].end).includes('=> 2'), true);
});

Deno.test('findComptimeCalls records start/end spanning the whole call', () => {
    const code = `import { comptime } from "comptime";\nexport const x = comptime(() => 42);`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const calls = findComptimeCalls(program, comptimeNames);
    assertEquals(code.slice(calls[0].start, calls[0].end), 'comptime(() => 42)');
});

Deno.test('findComptimeCalls returns empty when comptimeNames is empty', () => {
    const code = `export const x = comptime(() => 42);`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    assertEquals(findComptimeCalls(program, new Set()).length, 0);
});

// resolveSpecifier / isLocalFile / normalizeToForwardSlashes

Deno.test('resolveSpecifier passes bare specifiers through unchanged', () => {
    for (const spec of [
        'npm:some-lib',
        'npm:some-lib@1.2.3',
        'jsr:@std/path',
        'node:fs',
        'lodash',
        '@scope/pkg',
        '#internal',
        'https://example.com/mod.ts',
    ]) {
        assertEquals(resolveSpecifier(spec, '/src'), spec);
    }
});

Deno.test('resolveSpecifier resolves relative specifiers against the file dir', () => {
    assertEquals(resolveSpecifier('./math.ts', '/src/app'), '/src/app/math.ts');
    assertEquals(resolveSpecifier('../math.ts', '/src/app'), '/src/math.ts');
    assertEquals(resolveSpecifier('./a/../b.ts', '/src'), '/src/b.ts');
});

Deno.test('resolveSpecifier keeps absolute posix paths absolute', () => {
    assertEquals(resolveSpecifier('/abs/math.ts', '/src'), '/abs/math.ts');
});

Deno.test('normalizeToForwardSlashes converts backslashes', () => {
    assertEquals(normalizeToForwardSlashes('C:\\a\\b\\c.ts'), 'C:/a/b/c.ts');
    assertEquals(normalizeToForwardSlashes('/already/posix.ts'), '/already/posix.ts');
});

Deno.test('isLocalFile distinguishes local paths from bare specifiers', () => {
    assertEquals(isLocalFile('/src/a.ts'), true);
    assertEquals(isLocalFile('C:/src/a.ts'), true);
    assertEquals(isLocalFile('C:\\src\\a.ts'), true);
    assertEquals(isLocalFile('npm:foo'), false);
    assertEquals(isLocalFile('jsr:@std/path'), false);
    assertEquals(isLocalFile('node:fs'), false);
    assertEquals(isLocalFile('./rel.ts'), false);
});

// collectImportBindings extended

Deno.test('collectImportBindings skips `import type` declarations', () => {
    const code = `import type { A } from "./a.ts";`;
    const { program } = parseSync('/src/f.ts', code, {
        lang: 'ts',
        sourceType: 'module',
    });
    assertEquals(collectImportBindings(program, '/src').size, 0);
});

Deno.test('collectImportBindings skips inline `type` specifiers but keeps values', () => {
    const code = `import { type A, B } from "./a.ts";`;
    const { program } = parseSync('/src/f.ts', code, {
        lang: 'ts',
        sourceType: 'module',
    });
    const bindings = collectImportBindings(program, '/src');
    assertEquals([...bindings.keys()], ['B']);
});

Deno.test('collectImportBindings ignores side-effect-only imports', () => {
    const code = `import "./side-effect.ts";`;
    const { program } = parseSync('/src/f.ts', code, {
        lang: 'ts',
        sourceType: 'module',
    });
    assertEquals(collectImportBindings(program, '/src').size, 0);
});

Deno.test('collectImportBindings ignores re-exports', () => {
    const code = `export { a } from "./a.ts";\nexport * from "./b.ts";\nexport * as ns from "./c.ts";`;
    const { program } = parseSync('/src/f.ts', code, {
        lang: 'ts',
        sourceType: 'module',
    });
    assertEquals(collectImportBindings(program, '/src').size, 0);
});

Deno.test('collectImportBindings handles mixed default and named imports', () => {
    const code = `import D, { n } from "./a.ts";`;
    const { program } = parseSync('/src/f.ts', code, {
        lang: 'ts',
        sourceType: 'module',
    });
    const bindings = collectImportBindings(program, '/src');
    assertEquals(bindings.get('D')!.importedName, 'default');
    assertEquals(bindings.get('n')!.importedName, 'n');
    assertEquals(bindings.get('D')!.absSpecifier, '/src/a.ts');
    assertEquals(bindings.get('n')!.absSpecifier, '/src/a.ts');
});

Deno.test('collectImportBindings handles mixed default and namespace imports', () => {
    const code = `import D, * as ns from "./a.ts";`;
    const { program } = parseSync('/src/f.ts', code, {
        lang: 'ts',
        sourceType: 'module',
    });
    const bindings = collectImportBindings(program, '/src');
    assertEquals(bindings.get('D')!.importedName, 'default');
    assertEquals(bindings.get('ns')!.importedName, '*');
});

Deno.test('collectImportBindings records aliases with imported and local names', () => {
    const code = `import { original as renamed } from "./a.ts";`;
    const { program } = parseSync('/src/f.ts', code, {
        lang: 'ts',
        sourceType: 'module',
    });
    const b = collectImportBindings(program, '/src').get('renamed')!;
    assertEquals(b.localName, 'renamed');
    assertEquals(b.importedName, 'original');
    assertEquals(b.originalSpecifier, './a.ts');
});

Deno.test('collectImportBindings supports string-literal imported names', () => {
    const code = `import { "orig-name" as loc } from "./a.ts";`;
    const { program } = parseSync('/src/f.ts', code, {
        lang: 'ts',
        sourceType: 'module',
    });
    const b = collectImportBindings(program, '/src').get('loc')!;
    assertEquals(b.importedName, 'orig-name');
});

Deno.test('collectImportBindings keeps the same local name across modules distinct', () => {
    const code = `import { a } from "./a.ts";\nimport { a as b } from "./b.ts";`;
    const { program } = parseSync('/src/f.ts', code, {
        lang: 'ts',
        sourceType: 'module',
    });
    const bindings = collectImportBindings(program, '/src');
    assertEquals(bindings.get('a')!.absSpecifier, '/src/a.ts');
    assertEquals(bindings.get('b')!.absSpecifier, '/src/b.ts');
    assertEquals(bindings.get('b')!.importedName, 'a');
});

Deno.test('collectImportBindings later declaration wins for a duplicated local name', () => {
    const code = `import { x } from "./a.ts";\nimport { x } from "./b.ts";`;
    const { program } = parseSync('/src/f.ts', code, {
        lang: 'ts',
        sourceType: 'module',
    });
    const bindings = collectImportBindings(program, '/src');
    assertEquals(bindings.size, 1);
    assertEquals(bindings.get('x')!.absSpecifier, '/src/b.ts');
});

Deno.test('collectImportBindings resolves parent-relative specifiers', () => {
    const code = `import { up } from "../shared/up.ts";`;
    const { program } = parseSync('/src/app/f.ts', code, {
        lang: 'ts',
        sourceType: 'module',
    });
    assertEquals(
        collectImportBindings(program, '/src/app').get('up')!.absSpecifier,
        '/src/shared/up.ts',
    );
});

Deno.test('collectImportBindings passes jsr:, node: and bare specifiers through', () => {
    const code = `
import { join } from "jsr:@std/path";
import { readFile } from "node:fs/promises";
import { basename } from "@std/path";
import lodash from "lodash";
  `.trim();
    const { program } = parseSync('/src/f.ts', code, {
        lang: 'ts',
        sourceType: 'module',
    });
    const bindings = collectImportBindings(program, '/src');
    assertEquals(bindings.get('join')!.absSpecifier, 'jsr:@std/path');
    assertEquals(bindings.get('readFile')!.absSpecifier, 'node:fs/promises');
    assertEquals(bindings.get('basename')!.absSpecifier, '@std/path');
    assertEquals(bindings.get('lodash')!.absSpecifier, 'lodash');
});

Deno.test(
    "collectImportBindings keeps an aliased import while dropping the 'comptime' watch",
    () => {
        const code = `import { comptime, watch } from "comptime";\nimport { watch as w } from "./x.ts";`;
        const { program } = parseSync('/src/f.ts', code, {
            lang: 'ts',
            sourceType: 'module',
        });
        const bindings = collectImportBindings(program, '/src');
        assertEquals(bindings.has('w'), true);
        assertEquals(bindings.has('watch'), false);
    },
);

Deno.test(
    'collectImportBindings keeps a same-named import from another module',
    () => {
        const code = `import { comptime, watch } from "comptime";\nimport { watch } from "./chokidar-ish.ts";`;
        const { program } = parseSync('/src/f.ts', code, {
            lang: 'ts',
            sourceType: 'module',
        });
        const bindings = collectImportBindings(program, '/src');
        assertEquals(bindings.has('watch'), true);
        assertEquals(bindings.get('watch')!.absSpecifier, '/src/chokidar-ish.ts');
    },
);

Deno.test(
    "collectImportBindings keeps an import named like an aliased 'comptime' watch",
    () => {
        const code = `import { comptime, watch as w } from "comptime";\nimport { w } from "./x.ts";`;
        const { program } = parseSync('/src/f.ts', code, {
            lang: 'ts',
            sourceType: 'module',
        });
        const bindings = collectImportBindings(program, '/src');
        assertEquals(bindings.has('w'), true);
        assertEquals(bindings.get('w')!.absSpecifier, '/src/x.ts');
    },
);

// collectTopLevelDeclarations extended

Deno.test('collectTopLevelDeclarations records multiple declarators in one statement', () => {
    const code = `var b = 2, c = 3;`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const decls = collectTopLevelDeclarations(program, code);
    assertEquals(decls.length, 1);
    assertEquals(decls[0].names, ['b', 'c']);
});

Deno.test('collectTopLevelDeclarations extracts array pattern and rest names', () => {
    const code = `const [first, ...rest] = [1, 2, 3];`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const names = collectTopLevelDeclarations(program, code).flatMap((d) => d.names);
    assertEquals(names, ['first', 'rest']);
});

Deno.test('collectTopLevelDeclarations extracts default-assignment pattern names', () => {
    const code = `const { a = 1, ...others } = {};`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const names = collectTopLevelDeclarations(program, code).flatMap((d) => d.names);
    assertEquals(names.includes('a'), true);
    assertEquals(names.includes('others'), true);
});

Deno.test('collectTopLevelDeclarations captures the exact declaration source', () => {
    const code = `const PI = 3.14;\nfunction double(x: number) { return x * 2; }`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const decls = collectTopLevelDeclarations(program, code);
    assertEquals(decls[0].source, 'const PI = 3.14;');
    assertEquals(decls[1].source, 'function double(x: number) { return x * 2; }');
});

Deno.test('collectTopLevelDeclarations skips type-level and export-default declarations', () => {
    const code = `interface I { a: number }\ntype T = number;\nexport default function d() {}\nconst ok = 1;`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const names = collectTopLevelDeclarations(program, code).flatMap((d) => d.names);
    assertEquals(names, ['ok']);
});

Deno.test('collectTopLevelDeclarations ignores non-declaration statements', () => {
    const code = `import { a } from "./a.ts";\nconsole.log(a);\nexport { a };`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    assertEquals(collectTopLevelDeclarations(program, code).length, 0);
});

// collectIdentifierReferences extended

Deno.test('collectIdentifierReferences skips static member-expression property names', () => {
    const code = `import { comptime } from "comptime";\nexport const x = comptime(() => ns.deep.prop);`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const calls = findComptimeCalls(program, comptimeNames);
    const refs = collectIdentifierReferences(calls[0].fn.body);
    assertEquals(refs.has('ns'), true);
    assertEquals(refs.has('deep'), false);
    assertEquals(refs.has('prop'), false);
});

Deno.test('collectIdentifierReferences collects computed member-expression keys', () => {
    const code = `import { comptime } from "comptime";\nexport const x = comptime(() => ns[key]);`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const calls = findComptimeCalls(program, comptimeNames);
    const refs = collectIdentifierReferences(calls[0].fn.body);
    assertEquals(refs.has('ns'), true);
    assertEquals(refs.has('key'), true);
});

Deno.test('collectIdentifierReferences skips object-literal keys but keeps values', () => {
    const code = `import { comptime } from "comptime";\nexport const x = comptime(() => ({ value: inner, [computedKey]: 1, shorthand }));`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const calls = findComptimeCalls(program, comptimeNames);
    const refs = collectIdentifierReferences(calls[0].fn.body);
    assertEquals(refs.has('value'), false);
    assertEquals(refs.has('inner'), true);
    assertEquals(refs.has('computedKey'), true);
    assertEquals(refs.has('shorthand'), true);
});

Deno.test('collectIdentifierReferences returns an empty set for a literal body', () => {
    const code = `import { comptime } from "comptime";\nexport const x = comptime(() => 42);`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const calls = findComptimeCalls(program, comptimeNames);
    assertEquals(collectIdentifierReferences(calls[0].fn.body), new Set());
});

Deno.test('collectIdentifierReferences finds identifiers used in nested scopes', () => {
    const code = `
import { comptime } from "comptime";
export const x = comptime(() => {
  const list = [1, 2].map((n) => helper(n));
  return list;
});
  `.trim();
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const refs = collectIdentifierReferences(findComptimeCalls(program, comptimeNames)[0].fn.body);
    assertEquals(refs.has('helper'), true);
    assertEquals(refs.has('list'), true);
});

// collectDenoEnvReads extended

Deno.test('collectDenoEnvReads finds several distinct keys', () => {
    const code = `import { comptime } from "comptime";\nexport const x = comptime(() => Deno.env.get("A") + Deno.env.get("B") + Deno.env.get("A"));`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const keys = collectDenoEnvReads(findComptimeCalls(program, comptimeNames)[0].fn.body);
    assertEquals(keys, new Set(['A', 'B']));
});

Deno.test('collectDenoEnvReads ignores dynamic keys and non-Deno env reads', () => {
    const code = `
import { comptime } from "comptime";
const k = "K";
export const x = comptime(() => Deno.env.get(k) + process.env.get("Q") + Deno.env.toObject());
  `.trim();
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const keys = collectDenoEnvReads(findComptimeCalls(program, comptimeNames)[0].fn.body);
    assertEquals(keys, new Set());
});

// createVirtualModule extended

Deno.test('createVirtualModule emits an unaliased named import when names match', () => {
    const binding: ImportBinding = {
        localName: 'fib',
        importedName: 'fib',
        absSpecifier: '/abs/math.ts',
        originalSpecifier: './math.ts',
    };
    const src = createVirtualModule([binding], [], `return fib(10);`);
    assertStringIncludes(src, `import { fib } from "/abs/math.ts";`);
    assertEquals(src.includes('fib as fib'), false);
});

Deno.test('createVirtualModule emits imports in the order given', () => {
    const mk = (n: string, spec: string): ImportBinding => ({
        localName: n,
        importedName: n,
        absSpecifier: spec,
        originalSpecifier: spec,
    });
    const src = createVirtualModule(
        [mk('a', '/a.ts'), mk('b', 'npm:pkg'), mk('c', 'jsr:@std/path')],
        [],
        `return a + b + c;`,
    );
    const lines = src.split('\n');
    assertEquals(lines[0], `import { a } from "/a.ts";`);
    assertEquals(lines[1], `import { b } from "npm:pkg";`);
    assertEquals(lines[2], `import { c } from "jsr:@std/path";`);
});

Deno.test('createVirtualModule puts imports before declarations before the body', () => {
    const binding: ImportBinding = {
        localName: 'a',
        importedName: 'a',
        absSpecifier: '/a.ts',
        originalSpecifier: './a.ts',
    };
    const src = createVirtualModule(
        [binding],
        [
            {
                names: ['helper'],
                source: 'const helper = () => a;',
                start: 0,
                end: 0,
                refs: new Set(['a']),
            },
        ],
        `return helper();`,
    );
    assertEquals(
        src.indexOf('import { a }') < src.indexOf('const helper'),
        true,
    );
    assertEquals(
        src.indexOf('const helper') < src.indexOf('__comptime_result'),
        true,
    );
});

Deno.test('createVirtualModule wraps the body in an async IIFE that is awaited', () => {
    const src = createVirtualModule([], [], `return 1;`);
    assertStringIncludes(src, 'await (async () => { return 1; })()');
});

Deno.test('createVirtualModule with no imports or declarations emits only the scaffold', () => {
    const src = createVirtualModule([], [], `return 1;`);
    assertEquals(src.split('\n').length, 4);
});

// contentHash extended

Deno.test('contentHash returns a 64-character lowercase hex digest', async () => {
    const h = await contentHash('source', []);
    assertEquals(h.length, 64);
    assertMatch(h, /^[0-9a-f]{64}$/);
});

Deno.test('contentHash differs when the source differs', async () => {
    assertNotEquals(await contentHash('a', []), await contentHash('b', []));
});

Deno.test('contentHash differs when an env key is added', async () => {
    assertNotEquals(await contentHash('s', []), await contentHash('s', [['K', '']]));
});

Deno.test('contentHash distinguishes source/env boundary shifts', async () => {
    const a = await contentHash('ab', []);
    const b = await contentHash('a', [['b', '']]);
    assertNotEquals(a, b);
});

// serializeValue exotic values

Deno.test('serializeValue serializes undefined and null', () => {
    assertEquals(serializeValue(undefined, undefined), 'void 0');
    assertEquals(serializeValue(null, undefined), 'null');
});

Deno.test('serializeValue serializes booleans and special numbers', () => {
    assertEquals(serializeValue(true, undefined), 'true');
    assertEquals(serializeValue(NaN, undefined), 'NaN');
    assertEquals(serializeValue(Infinity, undefined), 'Infinity');
    assertEquals(serializeValue(-Infinity, undefined), '-Infinity');
    assertEquals(serializeValue(-0, undefined), '-0');
});

Deno.test('serializeValue serializes BigInt', () => {
    assertEquals(serializeValue(10n, undefined), '10n');
});

Deno.test('serializeValue serializes Date, RegExp, Map and Set', () => {
    assertEquals(serializeValue(new Date(0), undefined), 'new Date(0)');
    assertEquals(serializeValue(/ab+c/gi, undefined), 'new RegExp("ab+c","gi")');
    assertEquals(serializeValue(new Map([['a', 1]]), undefined), 'new Map([["a",1]])');
    assertEquals(serializeValue(new Set([1, 2]), undefined), 'new Set([1,2])');
});

Deno.test('serializeValue serializes typed arrays and URLs', () => {
    assertEquals(
        serializeValue(new Uint8Array([1, 2, 3]), undefined),
        'new Uint8Array([1,2,3])',
    );
    assertEquals(
        serializeValue(new URL('https://example.com/'), undefined),
        'new URL("https://example.com/")',
    );
});

Deno.test('serializeValue escapes strings safely', () => {
    assertEquals(serializeValue('he said "hi"\n', undefined), '"he said \\"hi\\"\\n"');
});

Deno.test('serializeValue handles cyclic references', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = serializeValue(cyclic, undefined);
    assertStringIncludes(out, 'a.self=a');
});

Deno.test('serializeValue preserves repeated references as one object', () => {
    const shared = { s: 1 };
    const out = serializeValue({ x: shared, y: shared }, undefined);
    assertStringIncludes(out, '{x:a,y:a}');
});

Deno.test('serializeValue throws for symbols, class instances and Errors', () => {
    class Foo {
        x = 1;
    }
    for (const v of [Symbol('s'), new Foo(), new Error('boom')]) {
        assertThrows(
            () => serializeValue(v, undefined),
            Error,
            'comptime returned a value that cannot be serialized',
        );
    }
});

Deno.test('serializeValue tries serializers in order and falls through', () => {
    const order: string[] = [];
    const serializers = [
        {
            test: (v: unknown) => {
                order.push('first');
                return typeof v === 'string';
            },
            serialize: () => 'FIRST',
        },
        {
            test: (v: unknown) => {
                order.push('second');
                return typeof v === 'number';
            },
            serialize: () => 'SECOND',
        },
    ];
    assertEquals(serializeValue(1, serializers), 'SECOND');
    assertEquals(order, ['first', 'second']);
    assertEquals(serializeValue([1], serializers), '[1]');
});

Deno.test('serializeValue custom serializer can rescue an unserializable value', () => {
    const serializers = [
        { test: (v: unknown) => typeof v === 'function', serialize: () => '(() => 1)' },
    ];
    assertEquals(serializeValue(() => 2, serializers), '(() => 1)');
});

// createCore: import hoisting into the virtual module

function recordingEvaluator(value: unknown = 1, watchFiles: string[] = []) {
    const sources: string[] = [];
    return {
        sources,
        evaluate: (_id: string, src: string): Promise<EvaluateResult> => {
            sources.push(src);
            return Promise.resolve({ value, watchFiles });
        },
    };
}

async function virtualSourceFor(code: string, id = '/src/f.ts'): Promise<string> {
    const rec = recordingEvaluator();
    const core = createCore(rec as any, {});
    await core.transform(code, id, {});
    return rec.sources[0];
}

Deno.test('createCore hoists only the imports referenced inside the callback', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
import { used } from "./used.ts";
import { unused } from "./unused.ts";
export const x = comptime(() => used());
    `.trim(),
    );
    assertStringIncludes(src, `import { used } from "/src/used.ts";`);
    assertEquals(src.includes('unused'), false);
});

Deno.test('createCore does not hoist imports used only outside the callback', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
import { outside } from "./outside.ts";
export const x = comptime(() => 1);
export const y = outside;
    `.trim(),
    );
    assertEquals(src.includes('outside'), false);
});

Deno.test('createCore hoists aliased imports with the alias intact', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
import { original as renamed } from "./a.ts";
export const x = comptime(() => renamed());
    `.trim(),
    );
    assertStringIncludes(src, `import { original as renamed } from "/src/a.ts";`);
});

Deno.test('createCore hoists default imports', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
import Foo from "./foo.ts";
export const x = comptime(() => Foo());
    `.trim(),
    );
    assertStringIncludes(src, `import Foo from "/src/foo.ts";`);
});

Deno.test('createCore hoists namespace imports', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
import * as ns from "./ns.ts";
export const x = comptime(() => ns.value);
    `.trim(),
    );
    assertStringIncludes(src, `import * as ns from "/src/ns.ts";`);
});

Deno.test('createCore hoists default and named imports from the same module', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
import Def, { named } from "./both.ts";
export const x = comptime(() => Def() + named);
    `.trim(),
    );
    assertStringIncludes(src, `import Def from "/src/both.ts";`);
    assertStringIncludes(src, `import { named } from "/src/both.ts";`);
});

Deno.test('createCore leaves npm:, jsr: and node: specifiers untouched when hoisting', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
import { a } from "npm:pkg-a";
import { b } from "jsr:@scope/b";
import { c } from "node:path";
import { d } from "bare-pkg";
export const x = comptime(() => [a, b, c, d]);
    `.trim(),
    );
    assertStringIncludes(src, `import { a } from "npm:pkg-a";`);
    assertStringIncludes(src, `import { b } from "jsr:@scope/b";`);
    assertStringIncludes(src, `import { c } from "node:path";`);
    assertStringIncludes(src, `import { d } from "bare-pkg";`);
});

Deno.test('createCore resolves relative import specifiers against the module dir', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
import { up } from "../shared/up.ts";
export const x = comptime(() => up);
    `.trim(),
        '/src/app/f.ts',
    );
    assertStringIncludes(src, `import { up } from "/src/shared/up.ts";`);
});

Deno.test('createCore does not hoist type-only imports', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
import type { T } from "./types.ts";
export const x = comptime(() => { const v: T = 1 as any; return v; });
    `.trim(),
    );
    assertEquals(src.includes('./types.ts'), false);
    assertEquals(src.includes('/src/types.ts'), false);
});

Deno.test('createCore does not hoist re-exported bindings', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
export { thing } from "./thing.ts";
export const x = comptime(() => 1);
    `.trim(),
    );
    assertEquals(src.includes('thing'), false);
});

Deno.test('createCore does not hoist side-effect-only imports', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
import "./side-effect.ts";
export const x = comptime(() => 1);
    `.trim(),
    );
    assertEquals(src.includes('side-effect'), false);
});

Deno.test('createCore still hoists an import shadowed by a local declaration in the body', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
import { a } from "./a.ts";
export const x = comptime(() => { const a = 5; return a; });
    `.trim(),
    );
    assertStringIncludes(src, `import { a } from "/src/a.ts";`);
    assertStringIncludes(src, 'const a = 5;');
});

Deno.test('createCore hoists different import sets for different calls in one file', async () => {
    const rec = recordingEvaluator();
    const core = createCore(rec as any, {});
    await core.transform(
        `
import { comptime } from "comptime";
import { a } from "./a.ts";
import { b } from "./b.ts";
export const x = comptime(() => a);
export const y = comptime(() => b);
        `.trim(),
        '/src/f.ts',
        {},
    );
    assertEquals(rec.sources.length, 2);
    // Calls are evaluated concurrently, so identify each virtual module by its
    // callback body rather than by the order the evaluator saw it.
    const forA = rec.sources.find((s) => s.includes('return (a);'))!;
    const forB = rec.sources.find((s) => s.includes('return (b);'))!;
    assertStringIncludes(forA, '/src/a.ts');
    assertEquals(forA.includes('/src/b.ts'), false);
    assertStringIncludes(forB, '/src/b.ts');
    assertEquals(forB.includes('/src/a.ts'), false);
});

Deno.test('createCore inlines top-level declarations referenced by the callback', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
const PI = 3.14;
const UNUSED = 0;
export const x = comptime(() => PI * 2);
    `.trim(),
    );
    assertStringIncludes(src, 'const PI = 3.14;');
    assertEquals(src.includes('UNUSED'), false);
});

Deno.test('createCore does not inline the declaration that contains the call itself', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
export const x = comptime(() => x);
    `.trim(),
    );
    assertEquals(src.includes('export const x'), false);
});

// createCore: dynamic import rewriting

Deno.test('createCore rewrites relative dynamic imports inside the callback', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
export const x = comptime(async () => (await import("./mod.ts")).v);
    `.trim(),
    );
    assertStringIncludes(src, `import("/src/mod.ts")`);
});

Deno.test('createCore rewrites parent-relative dynamic imports', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
export const x = comptime(async () => { const m = await import('../up/mod.ts'); return m.v; });
    `.trim(),
        '/src/nested/f.ts',
    );
    assertStringIncludes(src, `import("/src/up/mod.ts")`);
});

Deno.test('createCore leaves bare dynamic import specifiers alone', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
export const x = comptime(async () => (await import("npm:foo")).v);
    `.trim(),
    );
    assertStringIncludes(src, `import("npm:foo")`);
});

Deno.test('createCore leaves absolute dynamic import specifiers alone', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
export const x = comptime(async () => (await import("/abs/mod.ts")).v);
    `.trim(),
    );
    assertStringIncludes(src, `import("/abs/mod.ts")`);
});

Deno.test('createCore rewrites several dynamic imports in one callback', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
export const x = comptime(async () => {
  const a = await import("./a.ts");
  const b = await import("./b.ts");
  return [a, b];
});
    `.trim(),
    );
    assertStringIncludes(src, `import("/src/a.ts")`);
    assertStringIncludes(src, `import("/src/b.ts")`);
});

// createCore: watch file registration

Deno.test('createCore registers watch files for local imports only', async () => {
    const watched: string[] = [];
    const core = createCore(recordingEvaluator() as any, {});
    await core.transform(
        `
import { comptime } from "comptime";
import { a } from "./a.ts";
import { b } from "npm:pkg";
export const x = comptime(() => a + b);
        `.trim(),
        '/src/f.ts',
        { addWatchFile: (id) => void watched.push(id) },
    );
    assertEquals(watched, ['/src/a.ts']);
});

Deno.test('createCore does not register watch files for unused imports', async () => {
    const watched: string[] = [];
    const core = createCore(recordingEvaluator() as any, {});
    await core.transform(
        `
import { comptime } from "comptime";
import { unused } from "./unused.ts";
export const x = comptime(() => 1);
        `.trim(),
        '/src/f.ts',
        { addWatchFile: (id) => void watched.push(id) },
    );
    assertEquals(watched, []);
});

Deno.test('createCore forwards watch files reported by the evaluator', async () => {
    const watched: string[] = [];
    const core = createCore(recordingEvaluator(1, ['/data/one.json']) as any, {});
    await core.transform(
        `import { comptime } from "comptime";\nexport const x = comptime(() => 1);`,
        '/src/f.ts',
        { addWatchFile: (id) => void watched.push(id) },
    );
    assertEquals(watched, ['/data/one.json']);
});

Deno.test("createCore registers files passed to the 'comptime' watch()", async () => {
    const watched: string[] = [];
    const core = createCore(new RolldownEvaluator(), {});
    const result = await core.transform(
        `
import { comptime, watch } from "comptime";
export const x = comptime(() => {
  watch("/data/config.json");
  return 7;
});
        `.trim(),
        '/src/f.ts',
        { addWatchFile: (id) => void watched.push(id) },
    );
    assertStringIncludes(result!.code, '7');
    assertEquals(watched, ['/data/config.json']);
});

Deno.test('createCore skips watch registration on a cache hit and re-registers after invalidate', async () => {
    const watched: string[] = [];
    const core = createCore(recordingEvaluator(1, ['/data/one.json']) as any, {});
    const code = `
import { comptime } from "comptime";
import { a } from "./a.ts";
export const x = comptime(() => a);
    `.trim();
    const ctx = { addWatchFile: (id: string) => void watched.push(id) };
    await core.transform(code, '/src/f.ts', ctx);
    assertEquals(watched, ['/src/a.ts', '/data/one.json']);
    await core.transform(code, '/src/f.ts', ctx);
    assertEquals(watched.length, 2);
    core.invalidate();
    await core.transform(code, '/src/f.ts', ctx);
    assertEquals(watched.length, 4);
});

Deno.test('createCore works when the context provides no addWatchFile', async () => {
    const core = createCore(recordingEvaluator(1, ['/data/one.json']) as any, {});
    const result = await core.transform(
        `import { comptime } from "comptime";\nimport { a } from "./a.ts";\nexport const x = comptime(() => a);`,
        '/src/f.ts',
        {},
    );
    assertEquals(result !== null, true);
});

// createCore: caching keyed on hoisted content

Deno.test('createCore cache keys differ when a hoisted import path differs', async () => {
    let count = 0;
    const counting = {
        evaluate: (): Promise<EvaluateResult> => {
            count++;
            return Promise.resolve({ value: 1, watchFiles: [] });
        },
    };
    const core = createCore(counting as any, {});
    const code = `import { comptime } from "comptime";\nimport { a } from "./a.ts";\nexport const x = comptime(() => a);`;
    await core.transform(code, '/one/f.ts', {});
    await core.transform(code, '/two/f.ts', {});
    assertEquals(count, 2);
});

Deno.test('createCore cache is shared across files with identical virtual modules', async () => {
    let count = 0;
    const counting = {
        evaluate: (): Promise<EvaluateResult> => {
            count++;
            return Promise.resolve({ value: 1, watchFiles: [] });
        },
    };
    const core = createCore(counting as any, {});
    const code = `import { comptime } from "comptime";\nexport const x = comptime(() => 1);`;
    await core.transform(code, '/one/f.ts', {});
    await core.transform(code, '/two/f.ts', {});
    assertEquals(count, 1);
});

Deno.test('createCore cache key includes referenced Deno.env values', async () => {
    let count = 0;
    const counting = {
        evaluate: (): Promise<EvaluateResult> => {
            count++;
            return Promise.resolve({ value: 1, watchFiles: [] });
        },
    };
    const core = createCore(counting as any, {});
    const code = `import { comptime } from "comptime";\nexport const x = comptime(() => Deno.env.get("COMPTIME_TEST_KEY"));`;
    Deno.env.set('COMPTIME_TEST_KEY', 'one');
    try {
        await core.transform(code, '/f.ts', {});
        await core.transform(code, '/f.ts', {});
        assertEquals(count, 1);
        Deno.env.set('COMPTIME_TEST_KEY', 'two');
        await core.transform(code, '/f.ts', {});
        assertEquals(count, 2);
    } finally {
        Deno.env.delete('COMPTIME_TEST_KEY');
    }
});

// createCore: options and results

Deno.test('createCore.transform returns null for excluded ids', async () => {
    const core = createCore(mockEvaluator as any, { exclude: ['**/skip/**'] });
    assertEquals(await core.transform(
        `import { comptime } from "comptime";\nexport const x = comptime(() => 1);`,
        '/skip/f.ts',
        {},
    ), null);
});

Deno.test('createCore.transform returns null for ids outside include', async () => {
    const core = createCore(mockEvaluator as any, { include: ['**/src/**'] });
    assertEquals(await core.transform(
        `import { comptime } from "comptime";\nexport const x = comptime(() => 1);`,
        '/other/f.ts',
        {},
    ), null);
});

Deno.test('createCore.transform returns null for virtual (\\0-prefixed) ids', async () => {
    const core = createCore(mockEvaluator as any, {});
    assertEquals(await core.transform(
        `import { comptime } from "comptime";\nexport const x = comptime(() => 1);`,
        '\0virtual.ts',
        {},
    ), null);
});

Deno.test('createCore.transform returns null when comptime is imported but never called', async () => {
    const core = createCore(mockEvaluator as any, {});
    assertEquals(await core.transform(
        `import { comptime } from "comptime";\nexport const x = 1;`,
        '/f.ts',
        {},
    ), null);
});

Deno.test('createCore.transform returns null when comptime() comes from another module', async () => {
    const core = createCore(mockEvaluator as any, {});
    assertEquals(await core.transform(
        `import { comptime } from "./local.ts";\nexport const x = comptime(() => 1);`,
        '/f.ts',
        {},
    ), null);
});

Deno.test('createCore.transform honours an aliased comptime import', async () => {
    const core = createCore(mockEvaluator as any, {});
    const result = await core.transform(
        `import { comptime as ct } from "comptime";\nexport const x = ct(() => 1);`,
        '/f.ts',
        {},
    );
    assertStringIncludes(result!.code, 'export const x = 55;');
});

Deno.test('createCore.transform replaces every call in a file', async () => {
    // Calls are evaluated concurrently, so the mock keys off the callback body in
    // the virtual module rather than off invocation order.
    const values: Record<string, unknown> = { '1': 1, '2': 'two', '3': { three: 3 } };
    const byBody = {
        evaluate: (_id: string, src: string): Promise<EvaluateResult> =>
            Promise.resolve({
                value: values[src.match(/return \((\d)\);/)![1]],
                watchFiles: [],
            }),
    };
    const core = createCore(byBody as any, {});
    const result = await core.transform(
        `
import { comptime } from "comptime";
export const a = comptime(() => 1);
export const b = comptime(() => 2);
export const c = comptime(() => 3);
        `.trim(),
        '/f.ts',
        {},
    );
    assertEquals(result!.code.includes('comptime(() =>'), false);
    assertStringIncludes(result!.code, 'export const a = 1;');
    assertStringIncludes(result!.code, 'export const b = "two";');
    assertStringIncludes(result!.code, 'export const c = {three:3};');
});

Deno.test('createCore.transform handles a call nested inside another expression', async () => {
    const core = createCore(mockEvaluator as any, {});
    const result = await core.transform(
        `import { comptime } from "comptime";\nexport const obj = { n: comptime(() => 1) + 1 };`,
        '/f.ts',
        {},
    );
    assertStringIncludes(result!.code, '{ n: 55 + 1 }');
});

Deno.test('createCore.transform applies custom serializers', async () => {
    const core = createCore(
        { evaluate: () => Promise.resolve({ value: new Date(0), watchFiles: [] }) } as any,
        {
            serializers: [
                { test: (v: unknown) => v instanceof Date, serialize: () => 'DATE_LITERAL' },
            ],
        },
    );
    const result = await core.transform(
        `import { comptime } from "comptime";\nexport const x = comptime(() => 1);`,
        '/f.ts',
        {},
    );
    assertStringIncludes(result!.code, 'export const x = DATE_LITERAL;');
});

Deno.test('createCore.transform forwards innerPlugins to the evaluator', async () => {
    const plugin = { name: 'inner' };
    let seen: unknown;
    const core = createCore(
        {
            evaluate: (_id: string, _src: string, plugins?: unknown[]) => {
                seen = plugins;
                return Promise.resolve({ value: 1, watchFiles: [] });
            },
        } as any,
        { innerPlugins: [plugin] },
    );
    await core.transform(
        `import { comptime } from "comptime";\nexport const x = comptime(() => 1);`,
        '/f.ts',
        {},
    );
    assertEquals(seen, [plugin]);
});

Deno.test('createCore.transform passes a distinct virtual id per call index', async () => {
    // Calls are evaluated concurrently, so each id is tied back to its own call
    // through the callback body rather than through invocation order.
    const idByBody = new Map<string, string>();
    const core = createCore(
        {
            evaluate: (id: string, src: string) => {
                idByBody.set(src.match(/return \((\d)\);/)![1], id);
                return Promise.resolve({ value: 1, watchFiles: [] });
            },
        } as any,
        {},
    );
    await core.transform(
        `import { comptime } from "comptime";\nexport const a = comptime(() => 1);\nexport const b = comptime(() => 2);`,
        '/src/f.ts',
        {},
    );
    assertEquals(idByBody.size, 2);
    assertEquals(idByBody.get('1'), '\0comptime:/src/f.ts?comptime=0');
    assertEquals(idByBody.get('2'), '\0comptime:/src/f.ts?comptime=1');
});

Deno.test('createCore.transform produces a source map naming the original file', async () => {
    const core = createCore(mockEvaluator as any, {});
    const result = await core.transform(
        `import { comptime } from "comptime";\nexport const x = comptime(() => 1);`,
        '/src/f.ts',
        {},
    );
    const map = result!.map as { version: number; sources: string[] };
    assertEquals(map.version, 3);
    assertEquals(map.sources, ['/src/f.ts']);
});

Deno.test('createCore.resolveId and load are inert', () => {
    const core = createCore(mockEvaluator as any, {});
    assertEquals(core.resolveId('anything'), null);
    assertEquals(core.load('anything'), null);
});

// createCore: error paths

Deno.test('createCore.transform reports loc and frame for evaluation errors', async () => {
    const core = createCore(
        { evaluate: () => Promise.reject(new Error('kaboom')) } as any,
        {},
    );
    const err = await assertRejects(
        () =>
            core.transform(
                `import { comptime } from "comptime";\nconst pad = 1;\nexport const x = comptime(() => 1);`,
                '/src/f.ts',
                {},
            ),
        ComptimeTransformError,
        'comptime evaluation threw: kaboom',
    );
    assertEquals(err.loc, { file: '/src/f.ts', line: 3, column: 18 });
    assertEquals(err.frame, 'export const x = comptime(() => 1);\n                 ^');
});

Deno.test('createCore.transform reports the earliest failing call when several fail', async () => {
    // The second call fails immediately while the first is still pending, so
    // reporting whichever rejection lands first would surface the second one.
    // The staggered delays are what make this a regression test: with both at
    // 0ms it would pass even without source-order selection.
    const core = createCore(
        {
            evaluate: (_id: string, src: string) =>
                new Promise((_, reject) => {
                    const isFirst = src.includes('return (1);');
                    setTimeout(
                        () => reject(new Error(isFirst ? 'first' : 'second')),
                        isFirst ? 20 : 0,
                    );
                }),
        } as any,
        {},
    );
    const err = await assertRejects(
        () =>
            core.transform(
                `import { comptime } from "comptime";\nexport const a = comptime(() => 1);\nexport const b = comptime(() => 2);`,
                '/src/f.ts',
                {},
            ),
        ComptimeTransformError,
        'comptime evaluation threw: first',
    );
    assertEquals(err.loc.line, 2);
});

Deno.test('createCore.transform does not double-prefix messages already starting with comptime', async () => {
    const core = createCore(
        { evaluate: () => Promise.reject(new Error('comptime inner build failed: nope')) } as any,
        {},
    );
    const err = await assertRejects(
        () =>
            core.transform(
                `import { comptime } from "comptime";\nexport const x = comptime(() => 1);`,
                '/f.ts',
                {},
            ),
        ComptimeTransformError,
    );
    assertEquals(err.message, 'comptime inner build failed: nope');
});

Deno.test('createCore.transform stringifies non-Error rejections', async () => {
    const core = createCore({ evaluate: () => Promise.reject('plain string') } as any, {});
    await assertRejects(
        () =>
            core.transform(
                `import { comptime } from "comptime";\nexport const x = comptime(() => 1);`,
                '/f.ts',
                {},
            ),
        ComptimeTransformError,
        'comptime evaluation threw: plain string',
    );
});

Deno.test('createCore.transform times out slow evaluations', async () => {
    const core = createCore({ evaluate: () => new Promise(() => {}) } as any, {
        timeout: 25,
    });
    await assertRejects(
        () =>
            core.transform(
                `import { comptime } from "comptime";\nexport const x = comptime(() => 1);`,
                '/f.ts',
                {},
            ),
        ComptimeTransformError,
        'comptime evaluation timed out after 25ms',
    );
});

Deno.test('createCore.transform reports loc and frame for serialization errors', async () => {
    const core = createCore(
        { evaluate: () => Promise.resolve({ value: () => {}, watchFiles: [] }) } as any,
        {},
    );
    const err = await assertRejects(
        () =>
            core.transform(
                `import { comptime } from "comptime";\nexport const x = comptime(() => 1);`,
                '/src/f.ts',
                {},
            ),
        ComptimeTransformError,
        'comptime returned a value that cannot be serialized',
    );
    assertEquals(err.loc.line, 2);
    assertEquals(err.loc.file, '/src/f.ts');
    assertStringIncludes(err.frame, '^');
});

Deno.test('createCore.transform rejects function-expression callbacks with parameters', async () => {
    const core = createCore(mockEvaluator as any, {});
    await assertRejects(
        () =>
            core.transform(
                `import { comptime } from "comptime";\nexport const x = comptime(function (n: number) { return n; });`,
                '/f.ts',
                {},
            ),
        ComptimeTransformError,
        'comptime() requires a single arrow function with no parameters',
    );
});

Deno.test('createCore.transform does not cache failed evaluations', async () => {
    let count = 0;
    const core = createCore(
        {
            evaluate: () => {
                count++;
                return Promise.reject(new Error('always fails'));
            },
        } as any,
        {},
    );
    const code = `import { comptime } from "comptime";\nexport const x = comptime(() => 1);`;
    await assertRejects(() => core.transform(code, '/f.ts', {}));
    await assertRejects(() => core.transform(code, '/f.ts', {}));
    assertEquals(count, 2);
});

// plugin surface

Deno.test('comptime plugin exposes the expected hook surface', () => {
    const p = comptimePlugin() as any;
    assertEquals(p.name, 'comptime');
    assertEquals(p.enforce, 'pre');
    assertEquals(typeof p.resolveId, 'function');
    assertEquals(typeof p.load, 'function');
    assertEquals(typeof p.transform, 'function');
    assertEquals(typeof p.watchChange, 'function');
});

Deno.test('comptime plugin resolveId and load return null', () => {
    const p = comptimePlugin() as any;
    assertEquals(p.resolveId.call({}, '/anything.ts'), null);
    assertEquals(p.load.call({}, '/anything.ts'), null);
});

Deno.test('comptime plugin transform returns undefined for non-comptime modules', async () => {
    const p = comptimePlugin() as any;
    assertEquals(await p.transform.call({}, 'export const x = 1;', '/f.ts'), undefined);
});

Deno.test('comptime plugin transform reports watch files through the plugin context', async () => {
    const dir = join(WATCH_FIXTURE_DIR, 'plugin-ctx');
    await ensureDir(dir);
    try {
        const lib = join(dir, 'lib.ts').replace(/\\/g, '/');
        await Deno.writeTextFile(lib, `export const N = 3;`);
        const watched: string[] = [];
        const p = comptimePlugin() as any;
        await p.transform.call(
            { addWatchFile: (id: string) => void watched.push(id) },
            `import { comptime } from "comptime";\nimport { N } from "./lib.ts";\nexport const x = comptime(() => N);`,
            join(dir, 'entry.ts'),
        );
        assertEquals(watched, [lib]);
    } finally {
        await Deno.remove(dir, { recursive: true });
        await Deno.remove(WATCH_FIXTURE_DIR).catch(() => {});
    }
});

Deno.test('comptime plugin watchChange invalidates the cache', async () => {
    const p = comptimePlugin() as any;
    const dir = join(WATCH_FIXTURE_DIR, 'invalidate');
    await ensureDir(dir);
    try {
        const dataFile = join(dir, 'v.txt').replace(/\\/g, '/');
        const entry = join(dir, 'entry.ts');
        await Deno.writeTextFile(dataFile, 'first');
        const code = `import { comptime } from "comptime";\nexport const v = comptime(async () => await Deno.readTextFile("${dataFile}"));`;
        const first = await p.transform.call({}, code, entry);
        assertStringIncludes(first.code, '"first"');

        await Deno.writeTextFile(dataFile, 'second');
        const cached = await p.transform.call({}, code, entry);
        assertStringIncludes(cached.code, '"first"');

        p.watchChange.call({}, dataFile, { event: 'update' });
        const fresh = await p.transform.call({}, code, entry);
        assertStringIncludes(fresh.code, '"second"');
    } finally {
        await Deno.remove(dir, { recursive: true });
        await Deno.remove(WATCH_FIXTURE_DIR).catch(() => {});
    }
});

// import integration helpers

const IMPORT_FIXTURE_DIR =
    (Deno.env.get('TEMP') ?? '/tmp').replace(/\\/g, '/') + '/comptime-import-test';
const WATCH_FIXTURE_DIR =
    (Deno.env.get('TEMP') ?? '/tmp').replace(/\\/g, '/') + '/comptime-watch-test';

async function buildFixture(
    name: string,
    entryName: string,
    makeFiles: (dir: string) => Record<string, string>,
): Promise<string> {
    const dir = join(IMPORT_FIXTURE_DIR, name).replace(/\\/g, '/');
    await ensureDir(dir);
    let build: Awaited<ReturnType<typeof rolldown>> | undefined;
    try {
        for (const [file, content] of Object.entries(makeFiles(dir))) {
            const target = join(dir, file);
            await ensureDir(join(target, '..'));
            await Deno.writeTextFile(target, content);
        }
        build = await rolldown({
            input: join(dir, entryName),
            plugins: [aliasComptime(), comptimePlugin()],
        });
        const { output } = await build.generate({ format: 'esm' });
        return output[0].code;
    } finally {
        await build?.close();
        await Deno.remove(dir, { recursive: true }).catch(() => {});
        // Removes the shared parent once the last fixture subdirectory is gone.
        await Deno.remove(IMPORT_FIXTURE_DIR).catch(() => {});
    }
}

// plugin integration: imports

Deno.test('comptime plugin evaluates through a named import', async () => {
    const code = await buildFixture('named', 'entry.ts', () => ({
        'lib.ts': `export function double(x: number) { return x * 2; }`,
        'entry.ts': `import { comptime } from "comptime";\nimport { double } from "./lib.ts";\nexport const v = comptime(() => double(21));`,
    }));
    assertStringIncludes(code, 'v = 42');
});

Deno.test('comptime plugin evaluates through an aliased import', async () => {
    const code = await buildFixture('aliased', 'entry.ts', () => ({
        'lib.ts': `export function original() { return "aliased"; }`,
        'entry.ts': `import { comptime } from "comptime";\nimport { original as renamed } from "./lib.ts";\nexport const v = comptime(() => renamed());`,
    }));
    assertStringIncludes(code, '"aliased"');
});

Deno.test('comptime plugin evaluates through a default import', async () => {
    const code = await buildFixture('default', 'entry.ts', () => ({
        'lib.ts': `export default function () { return "defaulted"; }`,
        'entry.ts': `import { comptime } from "comptime";\nimport def from "./lib.ts";\nexport const v = comptime(() => def());`,
    }));
    assertStringIncludes(code, '"defaulted"');
});

Deno.test('comptime plugin evaluates through a namespace import', async () => {
    const code = await buildFixture('namespace', 'entry.ts', () => ({
        'lib.ts': `export const a = 1;\nexport const b = 2;`,
        'entry.ts': `import { comptime } from "comptime";\nimport * as ns from "./lib.ts";\nexport const v = comptime(() => ns.a + ns.b);`,
    }));
    assertStringIncludes(code, 'v = 3');
});

Deno.test('comptime plugin evaluates default and named imports from one module', async () => {
    const code = await buildFixture('default-and-named', 'entry.ts', () => ({
        'lib.ts': `export default 10;\nexport const extra = 32;`,
        'entry.ts': `import { comptime } from "comptime";\nimport base, { extra } from "./lib.ts";\nexport const v = comptime(() => base + extra);`,
    }));
    assertStringIncludes(code, 'v = 42');
});

Deno.test('comptime plugin follows transitive imports of an imported module', async () => {
    const code = await buildFixture('transitive', 'entry.ts', () => ({
        'deep.ts': `export const DEEP = 7;`,
        'mid.ts': `import { DEEP } from "./deep.ts";\nexport const mid = DEEP * 3;`,
        'entry.ts': `import { comptime } from "comptime";\nimport { mid } from "./mid.ts";\nexport const v = comptime(() => mid);`,
    }));
    assertStringIncludes(code, 'v = 21');
});

Deno.test('comptime plugin follows a re-export chain', async () => {
    const code = await buildFixture('reexport', 'entry.ts', () => ({
        'base.ts': `export const BASE = "base-value";`,
        'reex.ts': `export { BASE } from "./base.ts";`,
        'entry.ts': `import { comptime } from "comptime";\nimport { BASE } from "./reex.ts";\nexport const v = comptime(() => BASE);`,
    }));
    assertStringIncludes(code, '"base-value"');
});

Deno.test('comptime plugin follows a star re-export', async () => {
    const code = await buildFixture('star-reexport', 'entry.ts', () => ({
        'base.ts': `export const STAR = "star-value";`,
        'reex.ts': `export * from "./base.ts";`,
        'entry.ts': `import { comptime } from "comptime";\nimport { STAR } from "./reex.ts";\nexport const v = comptime(() => STAR);`,
    }));
    assertStringIncludes(code, '"star-value"');
});

Deno.test('comptime plugin resolves imports from a subdirectory with ../ specifiers', async () => {
    const code = await buildFixture('parent-relative', 'sub/entry.ts', () => ({
        'shared.ts': `export const SHARED = "shared!";`,
        'sub/entry.ts': `import { comptime } from "comptime";\nimport { SHARED } from "../shared.ts";\nexport const v = comptime(() => SHARED);`,
    }));
    assertStringIncludes(code, '"shared!"');
});

Deno.test('comptime plugin resolves an absolute import specifier', async () => {
    const code = await buildFixture('absolute', 'entry.ts', (dir) => ({
        'abs.ts': `export const ABS = "absolute!";`,
        'entry.ts': `import { comptime } from "comptime";\nimport { ABS } from "${dir}/abs.ts";\nexport const v = comptime(() => ABS);`,
    }));
    assertStringIncludes(code, '"absolute!"');
});

Deno.test('comptime plugin keeps a side-effect import out of the comptime module', async () => {
    const code = await buildFixture('side-effect', 'entry.ts', () => ({
        'sfx.ts': `globalThis.__comptime_sfx = true;\nexport {};`,
        'entry.ts': `import { comptime } from "comptime";\nimport "./sfx.ts";\nexport const v = comptime(() => 1);`,
    }));
    assertStringIncludes(code, 'v = 1');
    assertStringIncludes(code, '__comptime_sfx');
});

Deno.test('comptime plugin ignores type-only imports while using value imports', async () => {
    const code = await buildFixture('type-only', 'entry.ts', () => ({
        'types.ts': `export type Shape = { n: number };\nexport const val = 5;`,
        'entry.ts': `
import { comptime } from "comptime";
import type { Shape } from "./types.ts";
import { val } from "./types.ts";
export const v = comptime(() => { const s: Shape = { n: val }; return s.n; });
        `.trim(),
    }));
    assertStringIncludes(code, 'v = 5');
});

Deno.test('comptime plugin supports imports used both inside and outside comptime', async () => {
    const code = await buildFixture('inside-and-outside', 'entry.ts', () => ({
        'lib.ts': `export const N = 4;`,
        'entry.ts': `import { comptime } from "comptime";\nimport { N } from "./lib.ts";\nexport const v = comptime(() => N * 2);\nexport const runtimeN = N;`,
    }));
    assertStringIncludes(code, 'v = 8');
    assertStringIncludes(code, 'runtimeN');
});

Deno.test('comptime plugin supports a dynamic relative import inside the callback', async () => {
    const code = await buildFixture('dynamic', 'entry.ts', () => ({
        'dyn.ts': `export const dynValue = "dynamic!";`,
        'entry.ts': `import { comptime } from "comptime";\nexport const v = comptime(async () => (await import("./dyn.ts")).dynValue);`,
    }));
    assertStringIncludes(code, '"dynamic!"');
});

Deno.test('comptime plugin supports a dynamic ../ import from a subdirectory', async () => {
    const code = await buildFixture('dynamic-parent', 'sub/entry.ts', () => ({
        'dyn.ts': `export const dynValue = "up-dynamic";`,
        'sub/entry.ts': `import { comptime } from "comptime";\nexport const v = comptime(async () => (await import("../dyn.ts")).dynValue);`,
    }));
    assertStringIncludes(code, '"up-dynamic"');
});

Deno.test('comptime plugin supports separate calls importing different modules', async () => {
    const code = await buildFixture('multi-module', 'entry.ts', () => ({
        'a.ts': `export const A = "alpha";`,
        'b.ts': `export const B = "beta";`,
        'entry.ts': `
import { comptime } from "comptime";
import { A } from "./a.ts";
import { B } from "./b.ts";
export const first = comptime(() => A);
export const second = comptime(() => B);
        `.trim(),
    }));
    assertStringIncludes(code, '"alpha"');
    assertStringIncludes(code, '"beta"');
    assertEquals(code.includes('comptime('), false);
});

Deno.test('comptime plugin supports imports used by two different entry modules', async () => {
    const code = await buildFixture('two-entries', 'entry.ts', () => ({
        'lib.ts': `export const L = 6;`,
        'other.ts': `import { comptime } from "comptime";\nimport { L } from "./lib.ts";\nexport const other = comptime(() => L * 7);`,
        'entry.ts': `import { comptime } from "comptime";\nimport { L } from "./lib.ts";\nimport { other } from "./other.ts";\nexport const v = comptime(() => L) + other;`,
    }));
    assertStringIncludes(code, '48');
    assertEquals(code.includes('comptime('), false);
});

// plugin integration: specifier kinds

Deno.test('comptime plugin evaluates a node: import', async () => {
    const code = await buildFixture('node-specifier', 'entry.ts', () => ({
        'entry.ts': `import { comptime } from "comptime";\nimport { basename } from "node:path";\nexport const v = comptime(() => basename("/a/b/c.txt"));`,
    }));
    assertStringIncludes(code, '"c.txt"');
});

Deno.test('comptime plugin evaluates an npm: import', async () => {
    const code = await buildFixture('npm-specifier', 'entry.ts', () => ({
        'entry.ts': `import { comptime } from "comptime";\nimport { uneval } from "npm:devalue@^5.8.1";\nexport const v = comptime(() => uneval([1, 2]));`,
    }));
    assertStringIncludes(code, '"[1,2]"');
});

Deno.test('comptime plugin evaluates a jsr: import', async () => {
    const code = await buildFixture('jsr-specifier', 'entry.ts', () => ({
        'entry.ts': `import { comptime } from "comptime";\nimport { join as j } from "jsr:@std/path@^1.1.4";\nexport const v = comptime(() => j("a", "b"));`,
    }));
    assertStringIncludes(code, '"a/b"');
});

Deno.test('comptime plugin evaluates a bare import mapped by deno.json', async () => {
    const code = await buildFixture('bare-specifier', 'entry.ts', () => ({
        'entry.ts': `import { comptime } from "comptime";\nimport { basename } from "@std/path";\nexport const v = comptime(() => basename("/x/y.txt"));`,
    }));
    assertStringIncludes(code, '"y.txt"');
});

// plugin integration: values, watch and errors

Deno.test('comptime plugin serializes exotic values end to end', async () => {
    const code = await buildFixture('exotic', 'entry.ts', () => ({
        'entry.ts': `
import { comptime } from "comptime";
export const m = comptime(() => new Map([["a", 1]]));
export const s = comptime(() => new Set([1, 2]));
export const d = comptime(() => new Date(0));
export const r = comptime(() => /ab+c/g);
export const b = comptime(() => 123n);
export const u = comptime(() => undefined);
        `.trim(),
    }));
    assertStringIncludes(code, 'new Map(');
    assertStringIncludes(code, 'new Set(');
    assertStringIncludes(code, 'new Date(0)');
    assertStringIncludes(code, 'new RegExp("ab+c", "g")');
    assertStringIncludes(code, '123n');
    assertStringIncludes(code, 'void 0');
});

Deno.test('comptime plugin evaluates async callbacks that await imports', async () => {
    const code = await buildFixture('async-import', 'entry.ts', () => ({
        'lib.ts': `export async function fetchish() { return await Promise.resolve("awaited"); }`,
        'entry.ts': `import { comptime } from "comptime";\nimport { fetchish } from "./lib.ts";\nexport const v = comptime(async () => await fetchish());`,
    }));
    assertStringIncludes(code, '"awaited"');
});

Deno.test('comptime plugin collects watch() calls without affecting the value', async () => {
    const code = await buildFixture('watch-call', 'entry.ts', (dir) => ({
        'watched.txt': `content-here`,
        'entry.ts': `
import { comptime, watch } from "comptime";
export const v = comptime(async () => {
  watch("${'${DIR}'.replace('${DIR}', dir)}/watched.txt");
  return await Deno.readTextFile("${'${DIR}'.replace('${DIR}', dir)}/watched.txt");
});
        `.trim(),
    }));
    assertStringIncludes(code, '"content-here"');
});

Deno.test('comptime plugin reads a file relative to import.meta.url of the source', async () => {
    const code = await buildFixture('import-meta', 'entry.ts', () => ({
        'meta.txt': `meta-content`,
        'entry.ts': `
import { comptime } from "comptime";
export const v = comptime(async () => {
  const url = new URL("./meta.txt", import.meta.url);
  return await Deno.readTextFile(url);
});
        `.trim(),
    }));
    assertStringIncludes(code, '"meta-content"');
});

Deno.test('comptime plugin surfaces errors thrown inside the callback', async () => {
    await assertRejects(
        () =>
            buildFixture('throwing', 'entry.ts', () => ({
                'entry.ts': `import { comptime } from "comptime";\nexport const v = comptime(() => { throw new Error("boom-inside"); });`,
            })),
        Error,
        'boom-inside',
    );
});

Deno.test('comptime plugin surfaces unserializable return values', async () => {
    await assertRejects(
        () =>
            buildFixture('unserializable', 'entry.ts', () => ({
                'entry.ts': `import { comptime } from "comptime";\nexport const v = comptime(() => () => 1);`,
            })),
        Error,
        'cannot be serialized',
    );
});

Deno.test('comptime plugin surfaces failures importing a missing module in the callback', async () => {
    await assertRejects(
        () =>
            buildFixture('missing-dynamic', 'entry.ts', () => ({
                'entry.ts': `import { comptime } from "comptime";\nexport const v = comptime(async () => (await import("./nope.ts")).x);`,
            })),
        Error,
        'comptime',
    );
});

// known limitations (asserting current behaviour)

Deno.test(
    'createCore hoists imports referenced only by an inlined top-level declaration',
    async () => {
        const src = await virtualSourceFor(
            `
import { comptime } from "comptime";
import { HV } from "./h.ts";
const helper = () => HV * 2;
export const x = comptime(() => helper());
        `.trim(),
        );
        assertStringIncludes(src, 'const helper = () => HV * 2;');
        assertStringIncludes(src, `import { HV } from "/src/h.ts";`);
    },
);

Deno.test(
    'comptime plugin evaluates a callback depending on an import via a helper',
    async () => {
        const code = await buildFixture('helper-import', 'entry.ts', () => ({
            'h.ts': `export const HV = 10;`,
            'entry.ts': `
import { comptime } from "comptime";
import { HV } from "./h.ts";
const helper = () => HV * 2;
export const v = comptime(() => helper());
                `.trim(),
        }));
        assertStringIncludes(code, '20');
    },
);

Deno.test(
    'createCore hoists declarations reached through a multi-hop chain',
    async () => {
        const src = await virtualSourceFor(
            `
import { comptime } from "comptime";
import { DEEP } from "./deep.ts";
const c = () => DEEP;
const b = () => c();
const a = () => b();
export const x = comptime(() => a());
        `.trim(),
        );
        assertStringIncludes(src, `import { DEEP } from "/src/deep.ts";`);
        assertStringIncludes(src, 'const c = () => DEEP;');
        assertStringIncludes(src, 'const b = () => c();');
        assertStringIncludes(src, 'const a = () => b();');
        // declarations keep their original source order
        assertEquals(src.indexOf('const c =') < src.indexOf('const b ='), true);
        assertEquals(src.indexOf('const b =') < src.indexOf('const a ='), true);
    },
);

Deno.test('createCore smoke test: mutually recursive top-level declarations converge', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
import { LIMIT } from "./limit.ts";
function even(n) { return n === 0 ? true : odd(n - 1); }
function odd(n) { return n === 0 ? false : even(n - LIMIT); }
export const x = comptime(() => even(4));
    `.trim(),
    );
    assertStringIncludes(src, 'function even(n)');
    assertStringIncludes(src, 'function odd(n)');
    assertStringIncludes(src, `import { LIMIT } from "/src/limit.ts";`);
});

Deno.test(
    'createCore does not inline a transitively reached declaration containing a comptime call',
    async () => {
        const rec = recordingEvaluator();
        const core = createCore(rec as any, {});
        await core.transform(
            `
import { comptime } from "comptime";
import { SECRET } from "./secret.ts";
export const inner = comptime(() => SECRET);
const helper = () => inner;
export const x = comptime(() => helper());
    `.trim(),
            '/src/f.ts',
            {},
        );
        // The pinned virtual module is intentionally non-evaluable: `helper` is
        // inlined but `inner` is deliberately left out (its declaration encloses a
        // comptime call), so a real evaluation would report "inner is not defined".
        // These are sibling calls, not nested ones - one comptime call depending on
        // the result of another is a separate known limitation, and unlike nesting
        // (which transform rejects outright) it is not diagnosed here.
        const src = rec.sources.find((s) => s.includes('helper'))!;
        assertStringIncludes(src, 'const helper = () => inner;');
        assertEquals(src.includes('export const inner'), false);
    },
);

Deno.test(
    'createCore does not hoist unrelated imports when following declaration references',
    async () => {
        const src = await virtualSourceFor(
            `
import { comptime } from "comptime";
import { rows } from "./data.ts";
import { unrelated } from "./unrelated.ts";
const config = unrelated();
const readConfig = (r) => r.config;
export const x = comptime(() => rows.map(readConfig));
    `.trim(),
        );
        assertStringIncludes(src, `import { rows } from "/src/data.ts";`);
        assertStringIncludes(src, 'const readConfig = (r) => r.config;');
        // `.config` is a property name, not a reference to the top-level `config`.
        assertEquals(src.includes('const config'), false);
        assertEquals(src.includes('unrelated'), false);
    },
);

Deno.test(
    'comptime plugin does not evaluate a top-level declaration matched only by a property name',
    async () => {
        const code = await buildFixture('property-name-noise', 'entry.ts', () => ({
            'data.ts': `export const rows = [{ config: 1 }];`,
            'entry.ts': `
import { comptime } from "comptime";
import { rows } from "./data.ts";
const config = document.querySelector("#cfg");
const readConfig = (r: { config: number }) => r.config;
export const v = comptime(() => rows.map(readConfig).join(","));
                `.trim(),
        }));
        assertStringIncludes(code, '"1"');
    },
);

Deno.test('createCore does not hoist a declaration shadowed by a helper parameter', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
import { unrelated } from "./unrelated.ts";
const value = unrelated();
const helper = (value) => value + 1;
export const x = comptime(() => helper(1));
    `.trim(),
    );
    assertStringIncludes(src, 'const helper = (value) => value + 1;');
    assertEquals(src.includes('const value'), false);
    assertEquals(src.includes('unrelated'), false);
});

Deno.test(
    'createCore does not hoist a declaration shadowed by an inner local binding',
    async () => {
        const src = await virtualSourceFor(
            `
import { comptime } from "comptime";
import { unrelated } from "./unrelated.ts";
const value = unrelated();
function helper() { const value = 2; return value; }
export const x = comptime(() => helper());
    `.trim(),
        );
        assertStringIncludes(src, 'function helper()');
        assertEquals(src.includes('const value = unrelated'), false);
        assertEquals(src.includes('unrelated'), false);
    },
);

Deno.test(
    'createCore hoists imports referenced from a destructuring pattern default',
    async () => {
        const src = await virtualSourceFor(
            `
import { comptime } from "comptime";
import { DEF, KEY, opts } from "./o.ts";
const { a = DEF } = opts;
const { [KEY]: b } = opts;
export const x = comptime(() => [a, b]);
    `.trim(),
        );
        assertStringIncludes(src, `import { DEF } from "/src/o.ts";`);
        assertStringIncludes(src, `import { KEY } from "/src/o.ts";`);
        assertStringIncludes(src, `import { opts } from "/src/o.ts";`);
        assertStringIncludes(src, 'const { a = DEF } = opts;');
        assertStringIncludes(src, 'const { [KEY]: b } = opts;');
    },
);

Deno.test(
    'comptime plugin evaluates declarations whose patterns reference imports',
    async () => {
        const code = await buildFixture('pattern-refs', 'entry.ts', () => ({
            'o.ts': `export const DEF = 7;\nexport const KEY = "k";\nexport const opts = { k: 9 };`,
            'entry.ts': `
import { comptime } from "comptime";
import { DEF, KEY, opts } from "./o.ts";
const { a = DEF } = opts as { a?: number };
const { [KEY]: b } = opts;
export const v = comptime(() => a + b);
                `.trim(),
        }));
        assertStringIncludes(code, '16');
    },
);

Deno.test('collectIdentifierReferences skips statement labels', () => {
    const code = `import { comptime } from "comptime";\nexport const x = comptime(() => { outer: for (;;) { continue outer; } });`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const { comptimeNames } = collectComptimeBindings(program);
    const calls = findComptimeCalls(program, comptimeNames);
    const refs = collectIdentifierReferences(calls[0].fn.body);
    assertEquals(refs.has('outer'), false);
});

Deno.test('collectIdentifierReferences skips static accessor-property keys', () => {
    const code = `class C { accessor value = inner; }`;
    const { program } = parseSync('/f.ts', code, { lang: 'ts', sourceType: 'module' });
    const refs = collectIdentifierReferences(program.body[0]);
    assertEquals(refs.has('value'), false);
    assertEquals(refs.has('inner'), true);
});

Deno.test(
    'comptime plugin does not hoist a declaration matched only by a statement label',
    async () => {
        const code = await buildFixture('label-noise', 'entry.ts', () => ({
            'entry.ts': `
import { comptime } from "comptime";
const outer = document.title;
function helper() { outer: for (let i = 0; i < 3; i++) { break outer; } return 9; }
export const v = comptime(() => helper());
                `.trim(),
        }));
        assertStringIncludes(code, '9');
    },
);

Deno.test(
    'comptime plugin does not hoist a declaration shadowed by a var in a nested block',
    async () => {
        const code = await buildFixture('nested-var-noise', 'entry.ts', () => ({
            'entry.ts': `
import { comptime } from "comptime";
const total = document.body.childNodes.length;
function helper() { if (true) { var total = 3; } return total; }
export const v = comptime(() => helper());
                `.trim(),
        }));
        assertStringIncludes(code, '3');
    },
);

Deno.test('createCore hoists imports referenced by a class decorator', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
import { deco } from "./deco.ts";
@deco
class Widget {}
export const x = comptime(() => Widget);
    `.trim(),
    );
    assertStringIncludes(src, `import { deco } from "/src/deco.ts";`);
});

Deno.test('createCore.transform rejects a directly nested comptime call', async () => {
    const core = createCore(mockEvaluator as any, {});
    const err = await assertRejects(
        () =>
            core.transform(
                `import { comptime } from "comptime";\nexport const x = comptime(() => comptime(() => 1));`,
                '/src/f.ts',
                {},
            ),
        ComptimeTransformError,
        'comptime() calls cannot be nested',
    );
    assertStringIncludes(err.message, 'remove the inner call');
    // loc and frame point at the inner call, not the outer one.
    assertEquals(err.loc, { file: '/src/f.ts', line: 2, column: 33 });
    assertEquals(
        err.frame,
        `export const x = comptime(() => comptime(() => 1));\n${' '.repeat(32)}^`,
    );
});

Deno.test(
    'createCore.transform rejects a nested comptime call inside a function in the callback',
    async () => {
        const core = createCore(mockEvaluator as any, {});
        const err = await assertRejects(
            () =>
                core.transform(
                    `
import { comptime } from "comptime";
export const x = comptime(() => {
  function inner() { return comptime(() => 1); }
  return inner();
});
        `.trim(),
                    '/src/f.ts',
                    {},
                ),
            ComptimeTransformError,
            'comptime() calls cannot be nested',
        );
        assertEquals(err.loc.line, 3);
        assertEquals(err.loc.column, 29);
        assertStringIncludes(err.frame, 'function inner() { return comptime(() => 1); }');
    },
);

Deno.test('createCore.transform accepts a shadowed inner comptime call', async () => {
    const src = await virtualSourceFor(
        `
import { comptime } from "comptime";
export const x = comptime(() => {
  const comptime = (f: () => number) => f();
  return comptime(() => 1);
});
    `.trim(),
    );
    assertStringIncludes(src, 'const comptime = (f: () => number) => f();');
    assertEquals(src.includes('import { comptime }'), false);
});

Deno.test('createCore.transform accepts a non-call comptime reference in the callback', async () => {
    const src = await virtualSourceFor(
        `import { comptime } from "comptime";\nexport const x = comptime(() => typeof comptime);`,
    );
    assertStringIncludes(src, 'return (typeof comptime);');
});

Deno.test('createCore.transform still evaluates two sibling comptime calls', async () => {
    const rec = recordingEvaluator();
    const core = createCore(rec as any, {});
    const result = await core.transform(
        `
import { comptime } from "comptime";
export const a = comptime(() => 1);
export const b = comptime(() => 2);
    `.trim(),
        '/src/f.ts',
        {},
    );
    assertEquals(rec.sources.length, 2);
    assertStringIncludes(result!.code, 'export const a = 1;');
    assertStringIncludes(result!.code, 'export const b = 1;');
});
