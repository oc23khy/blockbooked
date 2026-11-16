import { existsSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveFile(base) {
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export async function resolve(specifier, context, nextResolve) {
  if (isBuiltin(specifier) || specifier.startsWith("node:")) return nextResolve(specifier, context);
  if (specifier.startsWith("@/")) {
    const file = resolveFile(path.join(root, "src", specifier.slice(2)));
    if (!file) throw new Error(`Cannot resolve ${specifier}`);
    return nextResolve(pathToFileURL(file).href, context);
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : "";
      if (code !== "ERR_MODULE_NOT_FOUND" && code !== "ERR_UNSUPPORTED_DIR_IMPORT") throw error;
      const parent = context.parentURL ? fileURLToPath(context.parentURL) : root;
      const file = resolveFile(path.resolve(path.dirname(parent), specifier));
      if (!file) throw error;
      return nextResolve(pathToFileURL(file).href, context);
    }
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "";
    if (code !== "ERR_MODULE_NOT_FOUND" || specifier.endsWith(".js")) throw error;
    return nextResolve(`${specifier}.js`, context);
  }
}
