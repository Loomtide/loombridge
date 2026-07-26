/**
 * Playability gate (§3.3).
 *
 * INPUT (defined here; Phase F's orchestration supplies it by driving the
 * player via multi-driver `runtime.probe` + `runtime.assert_condition` on
 * `GameManager.isWin`/`lives`/`score`):
 *
 *   {
 *     completable: boolean,                 // player reached the goal -> win
 *     winRuleObserved: "reach-flag" | "all-fruit" | ...,  // how isWin actually fired
 *     hazardKills: boolean,                 // a hazard drive decremented lives
 *     collectibleIncrements: boolean,       // a collectible drive incremented score
 *   }
 *
 * ACCEPTANCE: the `win` section.
 *
 * CHECKS:
 *  - completable: the level can be finished -> FAIL if not. When completion was
 *    proven by TELEPORTING the player onto each goal/collectible
 *    (`completionMethod === "teleported"`) the check is DOWNGRADED to WARN: a
 *    teleport proves the win logic fires but NOT that the level is actually
 *    traversable, so an unreachable collectible would still "pass". Geometric
 *    reachability is verified separately by the `reachability` gate.
 *  - winRule: the observed win rule == `win.rule` -> FAIL if not (this is where
 *    the all-fruit-vs-reach-flag mismatch surfaces).
 *  - hazardKills: a hazard kills the player -> FAIL if not.
 *  - collectibleIncrements: a collectible increments score -> FAIL if not.
 *  - modal end-state: by default, winning must enter a modal completed state:
 *    gameplay input locked, player frozen, and restart works. Games that
 *    intentionally keep simulation running declare `win.endStateMode:
 *    "continuous"` in the acceptance contract.
 *
 * Fields that the orchestration could not measure may be left `undefined`;
 * those checks are reported as WARN ("not observed") rather than FAIL so a
 * partial run still produces a useful report.
 */

import type { AcceptanceContract } from "../types.js";
import {
  makeGateReport,
  type GateCheck,
  type GateReport,
} from "./types.js";

/** The measured playability results Phase F feeds in. */
export interface PlayabilityResults {
  /** Did the player reach the goal and trigger a win? */
  completable?: boolean;
  /**
   * HOW completion was proven: by actually moving the player ("played") or by
   * teleporting it onto the goal/collectibles ("teleported"). A teleport proves
   * the win logic but NOT traversal, so it downgrades the completable check to a
   * WARN (reachability is checked separately by the reachability gate). Absent
   * -> WARN ("method not recorded").
   */
  completionMethod?: "played" | "teleported";
  /** Which rule was observed to fire `isWin` (e.g. "reach-flag", "all-fruit"). */
  winRuleObserved?: string;
  /** Did a hazard contact decrement `lives`? */
  hazardKills?: boolean;
  /** Did collecting a pickup increment `score`? */
  collectibleIncrements?: boolean;
  /** After the win/lose overlay appears, does gameplay input stop affecting play? */
  postWinInputLocked?: boolean;
  /** After the win/lose overlay appears, is the player effectively frozen? */
  postWinPlayerFrozen?: boolean;
  /** Does the declared restart affordance return the game to a playable state? */
  restartWorks?: boolean;
}

export const GATE_NAME = "playability";

function boolCheck(
  id: string,
  observed: boolean | undefined,
  expectTrueDetail: string,
  failDetail: string,
): GateCheck {
  if (observed === undefined) {
    return {
      id,
      expected: "true",
      actual: "(not observed)",
      status: "warn",
      detail: `${failDetail} (not observed in this run).`,
    };
  }
  return {
    id,
    expected: "true",
    actual: String(observed),
    status: observed ? "pass" : "fail",
    detail: observed ? expectTrueDetail : failDetail,
  };
}

export function evaluatePlayability(
  results: PlayabilityResults,
  acceptance: AcceptanceContract,
): GateReport {
  const checks: GateCheck[] = [];

  // ---- completable (completion-method aware) ----
  if (results.completable === false) {
    // A failed completion is a hard FAIL regardless of method.
    checks.push({
      id: "playability.completable",
      expected: "true",
      actual: "false",
      status: "fail",
      detail: "Level NOT completable: player could not reach the goal / win never fired.",
    });
  } else if (results.completable === undefined) {
    checks.push({
      id: "playability.completable",
      expected: "true",
      actual: "(not observed)",
      status: "warn",
      detail: "Level NOT completable: player could not reach the goal / win never fired. (not observed in this run).",
    });
  } else if (results.completionMethod === "teleported") {
    // Completion proven by teleport: the win logic fired but traversal was NOT
    // demonstrated, so this only WARNs — reachability is verified separately.
    checks.push({
      id: "playability.completable",
      expected: "true (proven by movement)",
      actual: "true (proven by teleport)",
      status: "warn",
      detail:
        "Level completion was proven by TELEPORTING the player onto each goal/collectible, NOT by movement — this does not prove the level is traversable (an unreachable collectible would still pass). Geometric reachability is verified separately by the reachability gate.",
    });
  } else if (results.completionMethod === "played") {
    checks.push({
      id: "playability.completable",
      expected: "true (proven by movement)",
      actual: "true (proven by movement)",
      status: "pass",
      detail: "Level is completable: player reached the goal and won by moving.",
    });
  } else {
    // completable true but completionMethod not recorded -> WARN to capture it.
    checks.push({
      id: "playability.completable",
      expected: "true (proven by movement)",
      actual: "true (method not recorded)",
      status: "warn",
      detail:
        "Level reported completable, but completion method not recorded; capture it (\"played\" vs \"teleported\") so a teleport-only proof cannot mask an unreachable goal.",
    });
  }

  // ---- win rule conformance ----
  const expectedRule = acceptance.win.rule;
  if (results.winRuleObserved === undefined) {
    checks.push({
      id: "playability.winRule",
      expected: expectedRule,
      actual: "(not observed)",
      status: "warn",
      detail: `Win rule not observed; expected "${expectedRule}".`,
    });
  } else {
    const ok = results.winRuleObserved === expectedRule;
    checks.push({
      id: "playability.winRule",
      expected: expectedRule,
      actual: results.winRuleObserved,
      status: ok ? "pass" : "fail",
      detail: ok
        ? `Win fired by the intended rule "${expectedRule}".`
        : `Win fired by "${results.winRuleObserved}", expected "${expectedRule}". ${
            acceptance.win.buildRule
              ? `(buildRule note: ${acceptance.win.buildRule})`
              : ""
          }`.trim(),
    });
  }

  checks.push(
    boolCheck(
      "playability.hazardKills",
      results.hazardKills,
      "Hazard contact decremented lives (kills + respawn).",
      "Hazard did NOT decrement lives.",
    ),
  );

  checks.push(
    boolCheck(
      "playability.collectibleIncrements",
      results.collectibleIncrements,
      "Collecting a pickup incremented score.",
      "Collecting a pickup did NOT increment score.",
    ),
  );

  const endStateMode = acceptance.win.endStateMode ?? "modal";
  checks.push({
    id: "playability.endStateMode",
    expected: endStateMode,
    actual: endStateMode,
    status: "pass",
    detail:
      endStateMode === "modal"
        ? "Contract expects a modal end state: gameplay stops behind the win/lose overlay."
        : "Contract explicitly allows continuous simulation under the end-state overlay.",
  });

  if (endStateMode === "modal") {
    checks.push(
      boolCheck(
        "playability.postWinInputLocked",
        results.postWinInputLocked,
        "Post-win gameplay input is locked while the end-state overlay is shown.",
        "Post-win gameplay input still affects play behind the overlay.",
      ),
    );
    checks.push(
      boolCheck(
        "playability.postWinPlayerFrozen",
        results.postWinPlayerFrozen,
        "Post-win player motion is frozen while the end-state overlay is shown.",
        "The player can still move / fall / collide behind the win overlay.",
      ),
    );
    checks.push(
      boolCheck(
        "playability.restartWorks",
        results.restartWorks,
        acceptance.win.restartAction
          ? `Restart affordance (${acceptance.win.restartAction}) returns to a playable state.`
          : "Restart affordance returns to a playable state.",
        "Restart affordance did NOT return to a playable state.",
      ),
    );
  }

  return makeGateReport(GATE_NAME, checks);
}
