# comptime

Rolldown plugin that evaluates code at bundle time and replaces `comptime()` calls with their serialized results.
Write arbitrary TypeScript- read files, call APIs, compute lookup tables... and have the output inlined as a literal before your bundle ships.

## Installation

```ts
import { comptime } from 'jsr:@azurite/rolldown-plugins/comptime/plugin';
```

The runtime stub (required for type-checking and as a no-op at runtime) is exported separately:

```ts
import { comptime, watch } from 'jsr:@azurite/rolldown-plugins/comptime';
```

## Usage

Add the plugin to your Rolldown config and import `comptime` from `"comptime"` in any source file:

```ts
// rolldown.config.ts
import { comptime } from '@azurite/rolldown-plugins/comptime/plugin';

export default {
    input: 'src/index.ts',
    plugins: [comptime()],
};
```

```ts
// src/index.ts
import { comptime } from 'comptime';

export const SCHEMA = comptime(() => JSON.parse(Deno.readTextFileSync('./schema.json')));
export const VERSION = comptime(() => Deno.env.get('VERSION') ?? '0.0.0');
export const TABLE = comptime(() => Array.from({ length: 256 }, (_, i) => i * i));
```

Each `comptime()` call is replaced with its serialized value in the output bundle- no runtime overhead, no bundled dependencies from the evaluated code.

## Async bodies

Arrow functions can be `async`:

```ts
export const content = comptime(async () => {
    const raw = await Deno.readTextFile('./data.json');
    return JSON.parse(raw);
});
```

## Accessing imports

Any imports present in the file are available inside the `comptime` body. The plugin extracts the relevant bindings and re-imports them inside a virtual evaluation module:

```ts
import { comptime } from 'comptime';
import { parseConfig } from './config-parser.ts';

export const CONFIG = comptime(() => parseConfig('./app.config.toml'));
```

Top-level declarations (variables, functions, classes) are also available inside the body.

## File watching

Use `watch()` to register files as cache dependencies. If a watched file changes during `--watch` mode, the cache is invalidated and the call is re-evaluated:

```ts
import { comptime, watch } from 'comptime';

export const ROUTES = comptime(() => {
    watch('./routes.json');
    return JSON.parse(Deno.readTextFileSync('./routes.json'));
});
```

`watch` is a no-op at runtime and is excluded from the evaluation module's imports.

## Caching

Each `comptime()` call is evaluated once per plugin instance and the result is cached. The cache key is the content of the generated evaluation module (the hoisted imports, inlined declarations and the callback body) plus the values of any `Deno.env.get("KEY")` calls it makes. That key names imported modules by *path*, so it cannot see their contents changing. Each entry therefore also records a content hash of the files the evaluation is known to depend on, and an entry is only reused while those hashes still match.

**Tracked** — editing one of these between builds gives a fresh value on the next build, watch mode or not:

- local files behind the imports the callback actually uses,
- every path passed to `watch()`.

An edit that lands *while* an evaluation is running is a different matter: the literal being produced may already be out of date. Imports are hashed before evaluation starts, so for those the edit costs a re-evaluation rather than a wrong value. `watch()` paths cannot be hashed ahead of time — they are not known until the callback has run — so they are instead only recorded once the filesystem says they held still: the later of a file's `mtime` and `ctime` (and, if it is gone, the same pair for the directory that held it, which is what distinguishes a mid-evaluation deletion from a file that never existed) must predate the start of the evaluation by at least two seconds.

That check is only as good as the timestamps. `ctime` covers the cases where `mtime` is preserved or moved backwards across a write (`cp -p`, `rsync --times`), and the two-second margin covers coarse-grained filesystems, but a filesystem whose clock genuinely runs behind this process — a skewed container, some network mounts — can still report a concurrent write as an old one and pin a stale value for the lifetime of the entry. Removing a whole directory tree mid-evaluation is likewise not detected.

**Not tracked** — editing one of these can still yield a stale value within the lifetime of a plugin instance:

- _transitive_ imports. Only the file a callback imports directly is hashed, not what that file imports in turn. Call `watch()` on the transitive file if it matters.
- files read during evaluation (`Deno.readTextFile`, `fetch` to a local server, ...) without a matching `watch()` call. `watch()` is what makes such a read a declared dependency.
- `npm:`, `jsr:` and `node:` specifiers, which are pinned by version rather than by content. An argument to `watch()` carrying a scheme (`npm:`, `http:`, ...) is still registered with Rolldown, but it is not a path, so it is left out of the content stamps and can never invalidate an entry.

A file that cannot be read - missing, a directory, permission denied - is not an error: it is recorded as unreadable, and the entry is invalidated as soon as that changes.

In `--watch` mode this is all belt and braces: `watchChange` clears the whole cache, so any change to a file registered with Rolldown re-evaluates everything regardless.

## Options

```ts
comptime({
    include?: string | string[],   // glob patterns — only scan matching files
    exclude?: string | string[],   // glob patterns — skip matching files
    timeout?: number,              // ms before evaluation is aborted (default: 10000)
    innerPlugins?: Plugin[],       // extra Rolldown plugins used inside the evaluator
    serializers?: Array<{          // custom serializers for non-plain values
        test: (value: unknown) => boolean,
        serialize: (value: unknown) => string,
    }>,
})
```

### `innerPlugins`

Plugins passed here are used inside the inner Rolldown build that evaluates each `comptime` body. Useful for resolving virtual modules or aliases that your evaluation code depends on:

```ts
comptime({
    innerPlugins: [myVirtualModulePlugin()],
});
```

### `serializers`

By default, values are serialized with [`devalue`](https://github.com/Rich-Harris/devalue), which handles primitives, plain objects, arrays, `Map`, `Set`, `Date`, `RegExp`, and more. For custom types, provide a serializer:

```ts
comptime({
    serializers: [
        {
            test: (v) => v instanceof MyClass,
            serialize: (v) => `new MyClass(${JSON.stringify((v as MyClass).data)})`,
        },
    ],
});
```

## Environment variables

`Deno.env.get("KEY")` calls inside a `comptime` body are detected and their values are included in the cache key. Changing the environment variable invalidates the cache for that call.

## Errors

Evaluation errors are reported as `ComptimeTransformError` with a source location and frame pointing at the `comptime(...)` call site in the original file.

```
ComptimeTransformError: comptime evaluation threw: Cannot read file
  src/index.ts:5:18
  export const X = comptime(() => readMissing());
                   ^
```

## Constraints

- The arrow function passed to `comptime()` must have no parameters.
- `comptime()` calls cannot be nested. The enclosing call already runs at build
  time, so a nested one is redundant and is rejected with a
  `ComptimeTransformError` pointing at the inner call.
- The return value must be serializable by `devalue` (or a custom serializer).
- Dynamic imports inside the body using relative paths are rewritten to absolute paths automatically.
- Files are only scanned if they contain the substring `"comptime"` and have a supported extension (`.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`).
