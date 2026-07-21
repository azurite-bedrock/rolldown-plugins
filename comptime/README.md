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
