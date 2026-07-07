# Design patterns cheatsheet

Apply a pattern only when it removes real duplication or coupling. If the code is
already clear and short, a pattern adds ceremony for no gain — skip it.

| Smell | Pattern | When to skip |
|---|---|---|
| Copy-pasted logic with minor variations | **Strategy** — extract the varying part into a function/object, pass it in | Fewer than 3 copies, or the variations are trivial one-liners |
| Long `if/else` or `switch` choosing behavior by type/string | **Strategy** or **Map lookup** — a plain `Record<string, handler>` is usually enough | Only 2–3 branches and unlikely to grow |
| Object construction with many optional params | **Builder** or plain options object | A single config object with defaults already reads well |
| Multiple callers need the same setup/teardown around a core operation | **Template Method** (or just a higher-order function) | Only one caller — inline the setup |
| Need to react to state changes across unrelated modules | **Observer / Event emitter** | Two modules — a direct callback is simpler |
| Expensive object creation, same inputs → same output | **Flyweight / Cache / Memoize** | Object is cheap, or inputs rarely repeat |
| Access to a resource that needs lifecycle management | **Dispose / using / context manager** | Resource is process-scoped (no cleanup needed) |
| External API that doesn't match your domain model | **Adapter** | You control both sides — just change the source |
| Deep nesting of decorators or wrappers | **Middleware / Pipeline** — compose a flat list | Two wrappers max — nesting is still readable |
| Repeated null-checks or fallback chains | **Null Object** or optional chaining (`?.`) | Language already has `??` / `?.` — use it (rung 3/4) |

## Anti-patterns to avoid

- **Singleton for testability**: makes mocking hard. Prefer dependency injection.
- **Factory for one type**: a constructor call is simpler.
- **Abstract base class with one subclass**: remove the abstraction.
- **Pattern just to match a textbook**: the code is the product, not the diagram.
