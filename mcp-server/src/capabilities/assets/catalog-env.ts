import path from "node:path";

import { optionalCatalogUrlFromEnv } from "./catalog-source.js";

/**
 * The argv shape every catalog-reading verb shares.
 */
export interface CatalogSourceArgs {
  registryPath?: string;
  catalogPath?: string;
  catalogApiUrl?: string;
}

/**
 * Apply the `LOOMBRIDGE_ASSET_CATALOG_URL` fallback, in place, when NO source flag was passed.
 *
 * The variable has been advertised by five docs and by `catalogUrlFromEnv`'s own refusal message
 * for as long as it has existed, while nothing read it: `--catalog-api` / `--catalog` /
 * `--registry` were the only inputs, so setting the variable and running a verb still failed with
 * "Missing required ...". Wiring it here is what makes the promise true.
 *
 * It fills `catalogPath` (the `--catalog` slot), matching the shape the docs show
 * (`--catalog "$LOOMBRIDGE_ASSET_CATALOG_URL"`). An explicit flag always wins; when the variable
 * is unset nothing is filled and the caller refuses exactly as before.
 */
export function applyCatalogEnvFallback<T extends CatalogSourceArgs>(
  args: T,
  cwd: string = process.cwd(),
  env?: NodeJS.ProcessEnv,
): T {
  if (args.registryPath || args.catalogPath || args.catalogApiUrl) return args;
  const configured = optionalCatalogUrlFromEnv(env);
  if (!configured) return args;
  args.catalogPath = /^https?:\/\//.test(configured) ? configured : path.resolve(cwd, configured);
  return args;
}
