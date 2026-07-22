/**
 * Runs `fn` at bundle time and replaces the whole `comptime(...)` call with the
 * serialized result. The callback itself is gone from the output; an import used
 * only inside it becomes unused and is dropped by the bundler, while one also
 * used elsewhere in the file stays, since the transform rewrites only the call
 * and never removes an import declaration.
 *
 * The callback may be `async`; the value is awaited during the build, which is
 * why an `async` callback still yields `T` here rather than `Promise<T>`.
 * Everything the body can reach is re-created in the module that evaluates it:
 * the imports and top-level declarations it names, plus, transitively, whatever
 * those declarations reference in turn. The exception is a top-level declaration
 * that itself encloses a `comptime()` call - that one is never inlined, so a
 * callback referencing it fails to evaluate. Relative dynamic imports written as
 * a plain string literal are rewritten to absolute paths so they resolve the
 * same way there; a template-literal or computed specifier is left alone and
 * resolves against the evaluation module instead.
 *
 * The call is only rewritten in files the plugin scans, and only when `comptime`
 * is bound by an import from the specifier `'comptime'` - it is that literal
 * specifier, before any import-map resolution, that the transform matches on.
 * The local name may be aliased (`import { comptime as ct } from 'comptime'`).
 *
 * What the callback returns has to survive serialization by `devalue` (or a
 * `serializers` entry on the plugin for anything it does not handle - see the
 * README). The callback takes no parameters, and calls cannot be nested, since
 * the outer one already runs at build time. Each of these is reported against
 * the original call site rather than the generated module.
 *
 * Paths in the callback resolve against the build process's working directory,
 * not the source file's directory - `'./schema.json'` below is read relative to
 * wherever the bundler was launched.
 *
 * @throws if it survives to runtime, which means the call was never rewritten:
 * the plugin is not installed, the file was not scanned (excluded by
 * `include`/`exclude`, or an extension outside
 * `.js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts`), or the call did not match the shape
 * the transform looks for - exactly one argument, written inline as a function
 * literal, with `comptime` bound by an unshadowed import from `'comptime'`.
 *
 * @example
 * ```ts
 * import { comptime } from 'comptime';
 *
 * // each becomes a literal in the bundle
 * export const SCHEMA = comptime(() => JSON.parse(Deno.readTextFileSync('./schema.json')));
 * export const TABLE = comptime(async () => JSON.parse(await Deno.readTextFile('./table.json')));
 * ```
 */
export function comptime<T>(_fn: () => T | Promise<T>): T {
    throw new Error('comptime() must be replaced by the rolldown plugin before runtime');
}

/**
 * Declares `path` as a dependency of the surrounding `comptime()` evaluation.
 * Does nothing at runtime, and nothing at all unless it runs during a `comptime()`
 * evaluation - inside the callback, or in a top-level helper the callback calls,
 * which is the only place the build can observe it.
 *
 * A callback's local-file imports are tracked for free, but a file it merely
 * reads is invisible to the plugin, and so is a transitive import of a module it
 * does import. `watch()` is what turns such a read into a declared dependency:
 * the path is registered with Rolldown, so watch mode rebuilds on a change to
 * it, and its contents are recorded as a content stamp on the cache entry, so
 * whenever the plugin instance is reused across builds an edit invalidates the
 * entry rather than replaying the cached literal.
 *
 * Relative paths resolve against the build process's working directory, the
 * same as the callback's own reads. An argument carrying a scheme (`npm:`,
 * `http:`, ...) is still registered with Rolldown, but it is not a file, so it
 * is left out of the cache entry's content stamps and can never invalidate one.
 *
 * The stamps are best-effort: if the filesystem cannot show every watched path
 * held still while the callback ran, the whole cache entry is suppressed - the
 * import stamps included - which costs a re-evaluation rather than pinning a
 * stale value. This depends on timestamps being truthful; a filesystem clock
 * running behind this process, or a whole tree removed mid-evaluation, can still
 * slip through.
 *
 * @example
 * ```ts
 * export const ROUTES = comptime(() => {
 *     watch('./routes.json');
 *     return JSON.parse(Deno.readTextFileSync('./routes.json'));
 * });
 * ```
 */
export function watch(_path: string): void {}
