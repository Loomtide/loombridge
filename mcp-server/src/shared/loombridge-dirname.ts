/**
 * The ONE spelling of the project-local state directory name.
 *
 * It lives in `shared/` rather than in `domain/state.ts` (which re-exports it, so every
 * existing importer is unchanged) for one reason: `bridge/` may not import `domain/`
 * (`__tests__/unit/repo/layering.test.ts`), and `bridge/trace-directory.ts` has to resolve
 * a project-local trace directory. Before this module existed it re-spelled the literal,
 * which is this repo's signature failure shape: a path declared twice, where a rename moves
 * one copy and a full green suite proves nothing.
 *
 * A bare directory name carries no domain vocabulary, so it is a legitimate leaf. The
 * LAYOUT (`LoombridgePaths`) deliberately stays in `domain/state.ts`: that IS vocabulary,
 * and pulling it down here to serve one bridge module would invert the layering.
 *
 * The home root `~/.loombridge/` is a SEPARATE constant (`LOOMBRIDGE_HOME_DIRNAME` in
 * `domain/workspace-paths.ts`). The two happen to share a value today; they are not the
 * same thing, and renaming the project directory must not silently move a user's runtime.
 */
export const LOOMBRIDGE_DIRNAME = ".loombridge";
