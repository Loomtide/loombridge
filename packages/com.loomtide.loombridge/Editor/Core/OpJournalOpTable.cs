using System;
using System.Collections.Generic;

namespace UnityBridge.Core
{
    /// <summary>
    /// THE OP CLASSIFICATION TABLE the journal binds targets with.
    ///
    /// One explicit row per published op. NEVER a heuristic: a rule like "an op whose
    /// name starts with set_ is a write" is exactly the shape that silently
    /// misclassifies the next op someone adds, and a misclassified op is a write that
    /// records no target and reads downstream as an innocent poll.
    ///
    /// THE AXIS is "does this op mutate the Unity project, the scene, the editor's own
    /// state, or the running game?". It is not "does this op have any side effect at
    /// all": ops that only write an EVIDENCE file (editor.screenshot,
    /// scene.snapshot_gameplay_geometry) are reads on this axis, and each one says so
    /// on its row. Ops that advance game time (editor.tick, replay.settle_and_capture,
    /// the runtime capture ops) are WRITES, because a frame that passed is game state
    /// that changed.
    ///
    /// WHEN IN DOUBT, WRITE. Over-classifying costs one locator resolution; under-
    /// classifying hides a mutation from the consumer that has to refuse on it.
    ///
    /// The third column is the PRIMARY target parameter: the top-level param key that
    /// carries the locator the op acts on ("" when the op has none). When that param
    /// holds an array of locators, the FIRST is the primary one.
    ///
    /// This table is a declared path nothing walks, so it is walked: the repo guard
    /// `unity-op-journal-table.test.ts` asserts it matches the TS op registry EXACTLY,
    /// in both directions, and that every named target param exists in that op's schema.
    /// </summary>
    public static class OpJournalOpTable
    {
        public const string KindRead = "read";
        public const string KindWrite = "write";

        /// <summary>An op this table has never heard of. Treated as a write.</summary>
        public const string KindUnknown = "unknown";

        // command                                  kind      primary target param
        private static readonly string[,] Rows =
        {
            { "scene.new_scene",                    KindWrite, "" },
            { "scene.open_scene",                   KindWrite, "" },
            { "scene.save_scene",                   KindWrite, "" },
            { "scene.create_object",                KindWrite, "parent" },
            { "scene.create_primitive",             KindWrite, "parent" },
            { "scene.set_layer",                    KindWrite, "locator" },
            { "scene.set_tag",                      KindWrite, "locator" },
            { "scene.delete_object",                KindWrite, "locator" },
            { "scene.duplicate_object",             KindWrite, "locator" },
            { "scene.set_parent",                   KindWrite, "locator" },
            { "scene.set_sibling_index",            KindWrite, "locator" },
            { "scene.set_transform",                KindWrite, "locator" },
            // Editor SELECTION and the scene-view camera are editor state, not game
            // state, but they are still mutations and are classified as such.
            { "scene.select_object",                KindWrite, "locator" },
            { "scene.frame_object",                 KindWrite, "locator" },
            { "scene.set_active",                   KindWrite, "locator" },
            { "scene.set_render_settings",          KindWrite, "" },
            { "scene.find_object",                  KindRead,  "" },
            { "scene.get_hierarchy",                KindRead,  "" },
            { "scene.get_bounds",                   KindRead,  "" },
            { "scene.get_screen_rects",             KindRead,  "" },
            { "scene.verify_manifest",              KindRead,  "" },
            { "scene.get_render_settings",          KindRead,  "" },
            { "scene.find_references_to",           KindRead,  "" },
            { "scene.validate_references",          KindRead,  "" },
            // Writes an evidence JSON to disk; mutates nothing in Unity.
            { "scene.snapshot_gameplay_geometry",   KindRead,  "" },
            { "scene.compare_gameplay_geometry",    KindRead,  "" },

            // editor.screenshot writes an image file and may frame the scene view when
            // focusLocator is supplied; neither touches the game, and it is THE evidence
            // op, so it is a read.
            { "editor.screenshot",                  KindRead,  "" },
            { "editor.get_state",                   KindRead,  "" },
            { "editor.get_project_diagnostics",     KindRead,  "" },
            { "editor.audit_mobile_assets",         KindRead,  "" },
            { "editor.console_logs",                KindRead,  "" },
            // A wait OBSERVES the editor until a condition holds; it forces no ticks.
            { "editor.wait_for",                    KindRead,  "" },
            { "editor.set_game_view_size",          KindWrite, "" },
            { "editor.focus_game_view",             KindWrite, "" },
            { "editor.set_show_work",               KindWrite, "" },
            { "editor.show_work_pulse",             KindWrite, "locator" },
            { "editor.play",                        KindWrite, "" },
            { "editor.stop",                        KindWrite, "" },
            { "editor.pause",                       KindWrite, "" },
            // Clearing the console DESTROYS evidence: unambiguously a write.
            { "editor.clear_console",               KindWrite, "" },
            { "editor.refresh_assets",              KindWrite, "" },
            { "editor.execute_menu_item",           KindWrite, "" },
            { "editor.begin_undo_group",            KindWrite, "" },
            { "editor.end_undo_group",              KindWrite, "" },
            // A tick ADVANCES the simulation: frames that passed are game state.
            { "editor.tick",                        KindWrite, "" },

            { "input.get_capabilities",             KindRead,  "" },
            // Every other input op actuates the game.
            { "input.begin_session",                KindWrite, "" },
            { "input.key_down",                     KindWrite, "" },
            { "input.key_up",                       KindWrite, "" },
            { "input.key_tap",                      KindWrite, "" },
            { "input.click_ui",                     KindWrite, "" },
            { "input.observe_start",                KindWrite, "" },
            { "input.pointer_tap",                  KindWrite, "" },
            { "input.pointer_tap_world",            KindWrite, "" },
            { "input.observe_stop",                 KindWrite, "" },
            { "input.end_session",                  KindWrite, "" },

            { "runtime.get_snapshot",               KindRead,  "" },
            { "runtime.assert_condition",           KindRead,  "" },
            { "runtime.wait_for_condition",         KindRead,  "" },
            // The capture family advances time (and the driver variants also write
            // component properties on the way), so all of it is a write.
            { "runtime.measure_motion",             KindWrite, "locator" },
            { "runtime.probe",                      KindWrite, "measure" },
            { "runtime.capture_sequence",           KindWrite, "measure" },
            { "runtime.capture_input_motion",       KindWrite, "measure" },
            { "runtime.capture_pointer_motion",     KindWrite, "measure" },
            { "runtime.capture_pointer_hold_motion", KindWrite, "measure" },
            { "runtime.sample_animator",            KindWrite, "locator" },

            { "component.list",                     KindRead,  "" },
            { "component.get_properties",           KindRead,  "" },
            { "component.describe",                 KindRead,  "" },
            { "component.add",                      KindWrite, "locator" },
            { "component.remove",                   KindWrite, "locator" },
            { "component.set_property",             KindWrite, "locator" },

            { "code.read_script",                   KindRead,  "" },
            { "code.create_script",                 KindWrite, "" },
            { "code.modify_script",                 KindWrite, "" },
            { "code.attach_script",                 KindWrite, "locator" },

            { "animator.get_state_machine",         KindRead,  "" },
            { "animator.create_controller",         KindWrite, "" },
            { "animator.add_parameter",             KindWrite, "" },
            { "animator.add_state",                 KindWrite, "" },
            { "animator.set_default_state",         KindWrite, "" },
            { "animator.add_transition",            KindWrite, "" },
            { "animator.assign_controller",         KindWrite, "locator" },
            { "animator.set_state_motion",          KindWrite, "" },
            { "animator.apply_spec",                KindWrite, "" },

            { "ui.scan_text_components",            KindRead,  "" },
            { "ui.get_screen_rects",                KindRead,  "" },
            { "ui.create_canvas",                   KindWrite, "" },
            { "ui.add_text",                        KindWrite, "parent" },
            { "ui.add_image",                       KindWrite, "parent" },
            { "ui.add_button",                      KindWrite, "parent" },
            { "ui.set_rect_transform",              KindWrite, "locator" },
            { "ui.dispatch_pointer",                KindWrite, "locator" },
            { "ui.set_text_style",                  KindWrite, "locator" },

            { "asset.list_sub_assets",              KindRead,  "" },
            { "asset.inspect_model_importer",       KindRead,  "" },
            { "asset.inspect_audio_importer",       KindRead,  "" },
            { "asset.picker_state",                 KindRead,  "" },
            { "asset.create_sprite",                KindWrite, "" },
            { "asset.create_material",              KindWrite, "" },
            { "asset.create_prefab",                KindWrite, "locator" },
            { "asset.create_prefab_variant",        KindWrite, "" },
            { "asset.replace_with_prefab",          KindWrite, "locators" },
            { "asset.instantiate_prefab",           KindWrite, "parent" },
            { "asset.set_texture_import_settings",  KindWrite, "" },
            { "asset.channel_pack",                 KindWrite, "" },
            { "asset.set_renderer_materials",       KindWrite, "locator" },
            { "asset.configure_model_importer",     KindWrite, "" },
            { "asset.configure_audio_importer",     KindWrite, "" },
            { "asset.assign_sprite",                KindWrite, "locator" },
            { "asset.picker_open",                  KindWrite, "" },
            { "asset.picker_close",                 KindWrite, "" },
            { "asset.browser_open",                 KindWrite, "" },

            { "package.list",                       KindRead,  "" },
            { "package.search",                     KindRead,  "" },
            { "package.add",                        KindWrite, "" },
            { "package.remove",                     KindWrite, "" },

            // Invokes an arbitrary allowlisted static method: a write by definition.
            { "capture.invoke_static",              KindWrite, "" },

            // ops.batch's OWN effect is its children's, and every child is journaled
            // individually through ExecuteCommandInline. The parent row is a write so a
            // batch can never read as an innocent poll on the strength of its wrapper.
            { "ops.batch",                          KindWrite, "" },
            // Discovery ops are answered by the MCP server and never reach Unity, so
            // they never actually appear in this journal. Rowed anyway: the guard
            // compares this table to the registry in both directions.
            { "ops.list",                           KindRead,  "" },
            { "ops.describe",                       KindRead,  "" },

            // Settling advances game time and then captures.
            { "replay.settle_and_capture",          KindWrite, "" },

            { "observe.status",                     KindRead,  "" },
            // start instantiates the recorder pump; drain destroys it and releases the
            // window's buffers.
            { "observe.start",                      KindWrite, "" },
            { "observe.drain",                      KindWrite, "" },

            { "journal.stats",                      KindRead,  "" },
            { "journal.window",                     KindRead,  "" },
        };

        private static readonly Dictionary<string, string> _kinds = BuildKinds();
        private static readonly Dictionary<string, string> _targets = BuildTargets();

        private static Dictionary<string, string> BuildKinds()
        {
            var map = new Dictionary<string, string>(StringComparer.Ordinal);
            for (int i = 0; i < Rows.GetLength(0); i++)
                map[Rows[i, 0]] = Rows[i, 1];
            return map;
        }

        private static Dictionary<string, string> BuildTargets()
        {
            var map = new Dictionary<string, string>(StringComparer.Ordinal);
            for (int i = 0; i < Rows.GetLength(0); i++)
            {
                if (!string.IsNullOrEmpty(Rows[i, 2]))
                    map[Rows[i, 0]] = Rows[i, 2];
            }
            return map;
        }

        /// <summary>Number of classified ops. Read by the EditMode tests and the repo guard.</summary>
        public static int RowCount
        {
            get { return Rows.GetLength(0); }
        }

        /// <summary>Every classified command, for the guard's set comparison.</summary>
        public static string[] Commands
        {
            get
            {
                var all = new string[Rows.GetLength(0)];
                for (int i = 0; i < all.Length; i++)
                    all[i] = Rows[i, 0];
                return all;
            }
        }

        /// <summary>
        /// "read", "write", or "unknown" for a command this table has never heard of.
        /// An unknown op is NOT a read: a bridge newer than this table must surface as
        /// unclassified so a consumer can refuse it, never as an innocent poll.
        /// </summary>
        public static string KindOf(string command)
        {
            if (string.IsNullOrEmpty(command))
                return KindUnknown;
            string kind;
            return _kinds.TryGetValue(command, out kind) ? kind : KindUnknown;
        }

        /// <summary>The op's primary target param name, or null when it has none.</summary>
        public static string TargetParamOf(string command)
        {
            if (string.IsNullOrEmpty(command))
                return null;
            string param;
            return _targets.TryGetValue(command, out param) ? param : null;
        }
    }
}
