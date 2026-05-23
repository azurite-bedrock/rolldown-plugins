import {
    assertEquals,
    assertInstanceOf,
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
    const { watchNames } = collectComptimeBindings(program);
    const bindings = collectImportBindings(program, '/src', watchNames);
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
    const bindings = collectImportBindings(program, '/src', new Set());
    assertEquals(bindings.get('something')!.absSpecifier, 'npm:some-lib');
});

Deno.test('collectImportBindings handles default and namespace imports', () => {
    const code = `import Foo from "./foo.ts";\nimport * as Bar from "./bar.ts";`;
    const { program } = parseSync('/src/f.ts', code, {
        lang: 'ts',
        sourceType: 'module',
    });
    const bindings = collectImportBindings(program, '/src', new Set());
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
