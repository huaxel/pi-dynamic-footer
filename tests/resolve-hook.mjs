// Test-only module-resolution hook.
//
// The package sources use `.js` specifiers throughout (e.g. `./types.js`) so
// that pi's runtime loader — which maps `.js` → `.ts` — can consume them as-is.
// Node's native type stripping, however, requires explicit `.ts` specifiers and
// will not remap. This hook lets the test suite run under plain `node --test`
// by retrying failed relative `.js` resolutions against the sibling `.ts` file.
//
// Usage: node --import ./tests/resolve-hook.mjs --test tests/
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Only intervene on specifiers that failed to resolve normally.
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const isRelative =
        specifier.startsWith("./") || specifier.startsWith("../");
      if (err?.code === "ERR_MODULE_NOT_FOUND" && isRelative && specifier.endsWith(".js")) {
        const tsSpecifier = specifier.slice(0, -3) + ".ts";
        const candidate = new URL(tsSpecifier, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) {
          return nextResolve(tsSpecifier, { ...context, parentURL: context.parentURL });
        }
      }
      throw err;
    }
  },
});
