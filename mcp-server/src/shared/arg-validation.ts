/**
 * Minimal, deliberately conservative argument checking against an op's declared
 * `inputSchema`, applied BEFORE the params are forwarded to Unity.
 *
 * Why this exists: the server advertised `locator` as an object with a required `path`,
 * but forwarded a caller's string straight through, and Unity answered
 * `[INTERNAL_ERROR] Invalid cast from 'System.String' to 'Newtonsoft.Json.Linq.JObject'`.
 * An agent reading that sees a bridge defect rather than its own correctable mistake —
 * and INTERNAL_ERROR is reserved for genuine harness faults, so mislabelling bad input as
 * one erodes the signal that tells a game bug apart from a harness bug.
 *
 * Scope is intentionally narrow — this is a guard rail, not a JSON Schema implementation:
 *  - a declared `required` property that is missing
 *  - a provided property whose JSON type contradicts the declared `type`
 *  - the same two checks one level into an object-typed property (so `locator.path` is
 *    covered, which is the case that actually bites)
 *
 * Unknown/extra properties are NOT rejected: ops evolve, and refusing an unrecognised key
 * would break callers the bridge would otherwise serve happily.
 */

type Json = Record<string, unknown>;

const jsonTypeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

/** Does `value` satisfy the declared JSON Schema `type` (which may be a union array)? */
function typeMatches(value: unknown, declared: unknown): boolean {
  const declaredTypes = Array.isArray(declared) ? declared : [declared];
  const actual = jsonTypeOf(value);
  return declaredTypes.some((t) => {
    if (typeof t !== "string") return true; // unrecognised declaration → do not judge
    if (t === "integer") return actual === "number" && Number.isInteger(value as number);
    if (t === "number") return actual === "number";
    return t === actual;
  });
}

const asSchema = (v: unknown): Json | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;

function checkObject(args: Json, schema: Json, pathPrefix: string, problems: string[], depth: number): void {
  const properties = asSchema(schema.properties) ?? {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  for (const name of required) {
    if (typeof name !== "string") continue;
    const value = args[name];
    if (value === undefined || value === null) {
      problems.push(`'${pathPrefix}${name}' is required`);
    }
  }

  for (const [name, rawPropSchema] of Object.entries(properties)) {
    const propSchema = asSchema(rawPropSchema);
    if (!propSchema) continue;
    const value = args[name];
    if (value === undefined || value === null) continue; // absence handled by `required` above

    if (propSchema.type !== undefined && !typeMatches(value, propSchema.type)) {
      const declared = Array.isArray(propSchema.type) ? propSchema.type.join(" | ") : String(propSchema.type);
      problems.push(
        `'${pathPrefix}${name}' must be ${declared}, got ${jsonTypeOf(value)}` +
          (jsonTypeOf(value) === "string" ? ` (${JSON.stringify(value)})` : ""),
      );
      continue; // a wrong-typed value cannot be inspected further
    }

    // One level deeper for object properties — this is what catches `locator` missing `path`.
    if (depth > 0 && propSchema.type === "object") {
      const nested = asSchema(value);
      if (nested) checkObject(nested, propSchema, `${pathPrefix}${name}.`, problems, depth - 1);
    }
  }
}

/**
 * Returns a list of human-readable problems; empty means "nothing provably wrong".
 * Never throws — a malformed schema yields no problems rather than blocking a valid call.
 */
export function validateOpArguments(args: unknown, inputSchema: unknown): string[] {
  const schema = asSchema(inputSchema);
  const provided = asSchema(args);
  if (!schema || !provided) return [];
  const problems: string[] = [];
  checkObject(provided, schema, "", problems, 1);
  return problems;
}
