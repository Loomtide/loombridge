# Unity Autonomous Launch

Agents should not ask the user to open a repo-owned Unity project until the autonomous launcher has failed.

Use:

```bash
scripts/unity/open-project.sh unity-projects/shooter-3d-combat-dogfood
```

or, for a repo-owned project name:

```bash
scripts/unity/open-project.sh shooter-3d-combat-dogfood
```

The launcher:

1. Resolves the Unity project path.
2. Reads `ProjectSettings/ProjectVersion.txt`.
3. Locates the matching Unity editor, or uses `UNITY_EDITOR` / `--unity`.
4. Starts Unity with `-projectPath`.
5. Builds `mcp-server`.
6. Waits until `scripts/phase3-mcp-smoke.mjs --expect-connected` passes with
   `LOOMTIDE_UNITY_PROJECT` / `LOOMTIDE_TARGET_PROJECT_PATH` pinned to the requested project.

Useful options:

```bash
scripts/unity/open-project.sh shooter-3d-combat-dogfood --assert-compile-clean
scripts/unity/open-project.sh shooter-3d-combat-dogfood --timeout 300
scripts/unity/open-project.sh shooter-3d-combat-dogfood --print-command
scripts/unity/open-project.sh shooter-3d-combat-dogfood --no-launch
```

Only ask the user to open Unity manually when the launcher cannot find the editor, the user must complete a
Unity licensing/login prompt, or the project still is not routable after the wait timeout.
