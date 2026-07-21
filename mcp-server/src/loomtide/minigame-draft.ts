/**
 * Shared DRAFT / finalized detection for the mini-game pipeline — ONE rule, three call-sites.
 *
 * Historically each consumer rolled its own "is this a draft?" check and they DRIFTED, which is what
 * let a fused multi-scene contract skip finalize (PR #324):
 *   - `inspectWorkspace.contractFinalized` (minigame-next): a substring scan over the whole contract
 *     JSON — fragile (a locator/name merely CONTAINING `DRAFT:`/`TODO:` trips it) and it originally
 *     looked only for `TODO:`, missing the scan's `DRAFT:` prefix;
 *   - capture's reorder guard (`minigame-capture`): the TOP-LEVEL description's `DRAFT` prefix only,
 *     missing a scaffold whose top-level is `TODO:` and a fused contract whose top-level reads finalized
 *     while its per-scene SCAN states are still `DRAFT:`;
 *   - finalize's strip decision (`minigame-finalize`): `TODO:`-or-`draft`-prefixed top-level.
 *
 * The single rule below is structural (it inspects DESCRIPTIONS, not the raw JSON) and anchored at the
 * START of each description, so a real locator/name that happens to contain the token never trips it.
 */

/** The placeholder prefixes the scan (`DRAFT:`) and scaffold (`TODO:`) write into draft descriptions. */
const DRAFT_PREFIX_RE = /^\s*(?:draft|todo)[:\s]/i;

/** True for a draft PLACEHOLDER description — a scan `DRAFT:` or scaffold `TODO:` prefix
 *  (case-insensitive, leading whitespace tolerated). Anchored at the start: a description that merely
 *  mentions "draft"/"todo" later, or a path/name containing the token, is NOT a placeholder. Accepts
 *  `unknown` so it is safe over a `JSON.parse`d contract (a non-string is simply not a draft). */
export function isDraftDescription(description: unknown): boolean {
  return typeof description === "string" && DRAFT_PREFIX_RE.test(description);
}

/** The minimal shape `isDraftContract` reads — fields are `unknown` so it works on a typed
 *  `MinigameContract` OR a loosely-typed `JSON.parse`d object without casts. */
interface DraftishContract {
  description?: unknown;
  states?: unknown;
  requiredInFrame?: unknown;
  allowedOffscreen?: unknown;
}

/** The `description` of an arbitrary value, when it's an object that has one (else undefined). */
function descriptionOf(value: unknown): unknown {
  return value && typeof value === "object" ? (value as { description?: unknown }).description : undefined;
}

/** Any-draft-description over a value that should be an array (a non-array is simply empty). */
function anyDraft(list: unknown): boolean {
  return Array.isArray(list) && list.some((item) => isDraftDescription(descriptionOf(item)));
}

/**
 * True when a contract still carries ANY draft placeholder description — top-level, a state, or a
 * declared object (`requiredInFrame` / `allowedOffscreen`). Robust across single- AND multi-scene: a
 * fused multi-scene contract's top-level description can read finalized while its per-scene SCAN states
 * are still `DRAFT:` (the exact case that skipped finalize).
 *
 * Loop-safe: `finalize` rewrites every one of these fields (each state description → "<kind> screen.",
 * `requiredInFrame` rebuilt from real captures, the top-level description replaced) and REFUSES a draft
 * that still declares `allowedOffscreen` — so a finalized contract returns false and the
 * finalize→verify routing converges.
 */
export function isDraftContract(contract: DraftishContract): boolean {
  return (
    isDraftDescription(contract.description) ||
    anyDraft(contract.states) ||
    anyDraft(contract.requiredInFrame) ||
    anyDraft(contract.allowedOffscreen)
  );
}
