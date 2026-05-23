# rolldown-plugins

Collection of [Rolldown](https://rolldown.rs) plugins developed and maintained by Azurite.

## Plugins

- **`comptime`**: Compile-time evaluation plugin. Replaces `comptime(() => ...)` calls with their serialized return values at bundle time. Supports async bodies, file watching for cache invalidation, custom serializers, and inner plugins for resolving imports inside evaluated code.
