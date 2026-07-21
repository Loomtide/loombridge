using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.UIElements;

namespace UnityBridge.UI
{
    /// <summary>
    /// Generic "choose options with thumbnails" picker rendered as a UIToolkit
    /// EditorWindow. The agent proposes slots of candidate options (via the
    /// asset.picker_open bridge op); the user single-selects per slot and
    /// Confirms/Cancels. The bridge polls <see cref="Status"/>/<see cref="Selection"/>
    /// (via asset.picker_state) for the outcome.
    ///
    /// State is static so the (pump-safe) bridge ops can read it without
    /// touching UIToolkit. The window only renders; it never blocks the main
    /// thread or opens a native modal dialog.
    /// </summary>
    public partial class LoomtideAssetPicker : EditorWindow
    {
        // ── Static handshake state (read by asset.picker_state) ──
        public const string StatusNone = "none";
        public const string StatusPending = "pending";
        public const string StatusConfirmed = "confirmed";
        public const string StatusCancelled = "cancelled";

        /// <summary>Current picker status: none|pending|confirmed|cancelled.</summary>
        public static string Status { get; private set; } = StatusNone;

        /// <summary>Map of slot id → selected option id (only meaningful when confirmed).</summary>
        public static Dictionary<string, string> Selection { get; private set; } =
            new Dictionary<string, string>();

        // ── Per-window proposal data ──
        private string _title = "Choose options";
        private List<SlotModel> _slots = new List<SlotModel>();

        private class SlotModel
        {
            public string Slot;
            public string Label;
            public List<OptionModel> Options = new List<OptionModel>();
            public string SelectedId;
        }

        private class OptionModel
        {
            public string Id;
            public string Label;
            public string ImagePath;
            public List<string> Badges = new List<string>();
        }

        /// <summary>
        /// Opens (or refreshes) the picker window with the given proposal and
        /// resets handshake state to <see cref="StatusPending"/>. Called from the
        /// asset.picker_open bridge op on the main thread.
        /// </summary>
        public static void Open(JObject proposal)
        {
            var window = GetWindow<LoomtideAssetPicker>(utility: false);
            window.titleContent = new GUIContent("Loomtide Asset Picker");
            window.minSize = new Vector2(420f, 320f);
            window.ApplyProposal(proposal);

            // Fresh proposal → a new pending decision.
            Status = StatusPending;
            Selection = new Dictionary<string, string>();

            window.Rebuild();
            window.Show();
            window.Focus();
        }

        /// <summary>
        /// Shared handshake hook for richer picker surfaces. The registry browser
        /// uses the same poll state as the generic Phase-1 picker.
        /// </summary>
        public static void BeginPendingDecision()
        {
            Status = StatusPending;
            Selection = new Dictionary<string, string>();
        }

        /// <summary>Completes the shared picker handshake with a selection map.</summary>
        public static void ConfirmSelection(Dictionary<string, string> selection)
        {
            Selection = selection ?? new Dictionary<string, string>();
            Status = StatusConfirmed;
        }

        /// <summary>Cancels the shared picker handshake.</summary>
        public static void CancelDecision()
        {
            Selection = new Dictionary<string, string>();
            Status = StatusCancelled;
        }

        /// <summary>
        /// Closes the picker window if open and resets state to <see cref="StatusNone"/>.
        /// Called from the asset.picker_close bridge op.
        /// </summary>
        public static void ClosePicker()
        {
            Status = StatusNone;
            Selection = new Dictionary<string, string>();

            if (HasOpenInstances<LoomtideAssetPicker>())
            {
                var window = GetWindow<LoomtideAssetPicker>(utility: false);
                // Suppress the OnDestroy → cancelled transition; this is an
                // explicit programmatic close, not a user cancel.
                window._suppressDestroyCancel = true;
                window.Close();
            }
        }

        private bool _suppressDestroyCancel;

        private void ApplyProposal(JObject proposal)
        {
            // A new proposal replaces the images — release the old thumbnails first.
            DisposeTextures();
            _title = proposal?.Value<string>("title") ?? "Choose options";
            _slots = new List<SlotModel>();

            JArray slots = proposal?.Value<JArray>("slots");
            if (slots == null)
                return;

            foreach (JToken slotToken in slots)
            {
                if (!(slotToken is JObject slotObj))
                    continue;

                var slot = new SlotModel
                {
                    Slot = slotObj.Value<string>("slot") ?? "",
                    Label = slotObj.Value<string>("label"),
                    SelectedId = slotObj.Value<string>("selectedId")
                };
                if (string.IsNullOrEmpty(slot.Label))
                    slot.Label = slot.Slot;

                JArray options = slotObj.Value<JArray>("options");
                if (options != null)
                {
                    foreach (JToken optToken in options)
                    {
                        if (!(optToken is JObject optObj))
                            continue;

                        var option = new OptionModel
                        {
                            Id = optObj.Value<string>("id") ?? "",
                            Label = optObj.Value<string>("label"),
                            ImagePath = optObj.Value<string>("imagePath")
                        };
                        if (string.IsNullOrEmpty(option.Label))
                            option.Label = option.Id;

                        JArray badges = optObj.Value<JArray>("badges");
                        if (badges != null)
                        {
                            foreach (JToken badge in badges)
                            {
                                string badgeText = badge?.Value<string>();
                                if (!string.IsNullOrEmpty(badgeText))
                                    option.Badges.Add(badgeText);
                            }
                        }

                        slot.Options.Add(option);
                    }
                }

                // Default the selection to the proposed pick when valid.
                if (string.IsNullOrEmpty(slot.SelectedId) && slot.Options.Count > 0)
                    slot.SelectedId = slot.Options[0].Id;

                _slots.Add(slot);
            }
        }

        private void OnEnable()
        {
            // When a window is restored after a domain reload it has no proposal;
            // Rebuild renders an empty/placeholder state until Open() runs again.
            Rebuild();
        }

        private void Rebuild()
        {
            VisualElement root = rootVisualElement;
            root.Clear();
            root.style.paddingTop = 8;
            root.style.paddingBottom = 8;
            root.style.paddingLeft = 8;
            root.style.paddingRight = 8;

            var titleLabel = new Label(_title);
            titleLabel.style.unityFontStyleAndWeight = FontStyle.Bold;
            titleLabel.style.fontSize = 14;
            titleLabel.style.marginBottom = 8;
            root.Add(titleLabel);

            if (_slots.Count == 0)
            {
                var empty = new Label(
                    "Nothing to choose right now.\n\n"
                    + "The Loomtide agent opens this window with asset options for you to confirm or "
                    + "swap. Browsing the full asset library from here is coming in a later phase.");
                empty.style.color = new Color(0.6f, 0.6f, 0.6f);
                empty.style.whiteSpace = WhiteSpace.Normal;
                root.Add(empty);
                return;
            }

            var scroll = new ScrollView(ScrollViewMode.Vertical);
            scroll.style.flexGrow = 1;
            root.Add(scroll);

            foreach (SlotModel slot in _slots)
                scroll.Add(BuildSlotElement(slot));

            // Footer
            var footer = new VisualElement();
            footer.style.flexDirection = FlexDirection.Row;
            footer.style.justifyContent = Justify.FlexEnd;
            footer.style.marginTop = 8;
            footer.style.paddingTop = 6;

            var cancelButton = new Button(OnCancel) { text = "Cancel" };
            cancelButton.style.minWidth = 80;
            cancelButton.style.marginRight = 4;

            var confirmButton = new Button(OnConfirm) { text = "Confirm" };
            confirmButton.style.minWidth = 80;

            footer.Add(cancelButton);
            footer.Add(confirmButton);
            root.Add(footer);
        }

        private VisualElement BuildSlotElement(SlotModel slot)
        {
            var slotContainer = new VisualElement();
            slotContainer.style.marginBottom = 12;

            var slotLabel = new Label(slot.Label);
            slotLabel.style.unityFontStyleAndWeight = FontStyle.Bold;
            slotLabel.style.marginBottom = 4;
            slotContainer.Add(slotLabel);

            var cardRow = new VisualElement();
            cardRow.style.flexDirection = FlexDirection.Row;
            cardRow.style.flexWrap = Wrap.Wrap;
            slotContainer.Add(cardRow);

            foreach (OptionModel option in slot.Options)
                cardRow.Add(BuildOptionCard(slot, option));

            return slotContainer;
        }

        private VisualElement BuildOptionCard(SlotModel slot, OptionModel option)
        {
            var card = new VisualElement();
            card.style.width = 120;
            card.style.marginRight = 8;
            card.style.marginBottom = 8;
            card.style.paddingTop = 6;
            card.style.paddingBottom = 6;
            card.style.paddingLeft = 6;
            card.style.paddingRight = 6;
            card.style.borderTopWidth = 2;
            card.style.borderBottomWidth = 2;
            card.style.borderLeftWidth = 2;
            card.style.borderRightWidth = 2;
            ApplyCardBorder(card, slot.SelectedId == option.Id);

            // Thumbnail
            var thumb = new Image();
            thumb.style.width = 96;
            thumb.style.height = 96;
            thumb.scaleMode = ScaleMode.ScaleToFit;
            Texture2D tex = TryLoadTexture(option.ImagePath);
            if (tex != null)
            {
                thumb.image = tex;
            }
            else
            {
                // Neutral colored box for missing/failed thumbnails.
                thumb.style.backgroundColor = new Color(0.35f, 0.35f, 0.38f);
            }
            card.Add(thumb);

            // Label
            var label = new Label(option.Label);
            label.style.whiteSpace = WhiteSpace.Normal;
            label.style.marginTop = 4;
            label.style.fontSize = 11;
            card.Add(label);

            // Badges
            if (option.Badges.Count > 0)
            {
                var badgeRow = new VisualElement();
                badgeRow.style.flexDirection = FlexDirection.Row;
                badgeRow.style.flexWrap = Wrap.Wrap;
                badgeRow.style.marginTop = 2;
                foreach (string badge in option.Badges)
                    badgeRow.Add(BuildBadge(badge));
                card.Add(badgeRow);
            }

            // Single-select on click.
            card.RegisterCallback<MouseDownEvent>(_ =>
            {
                slot.SelectedId = option.Id;
                Rebuild();
            });

            return card;
        }

        private static VisualElement BuildBadge(string text)
        {
            var badge = new Label(text);
            badge.style.fontSize = 9;
            badge.style.marginRight = 3;
            badge.style.marginTop = 2;
            badge.style.paddingLeft = 4;
            badge.style.paddingRight = 4;
            badge.style.paddingTop = 1;
            badge.style.paddingBottom = 1;
            badge.style.borderTopLeftRadius = 3;
            badge.style.borderTopRightRadius = 3;
            badge.style.borderBottomLeftRadius = 3;
            badge.style.borderBottomRightRadius = 3;

            bool isPlaceholder = text.IndexOf("PLACEHOLDER", System.StringComparison.OrdinalIgnoreCase) >= 0;
            badge.style.backgroundColor = isPlaceholder
                ? new Color(0.6f, 0.4f, 0.1f)
                : new Color(0.25f, 0.25f, 0.3f);
            badge.style.color = Color.white;
            return badge;
        }

        private static void ApplyCardBorder(VisualElement card, bool selected)
        {
            Color color = selected
                ? new Color(0.3f, 0.6f, 1f)
                : new Color(0.3f, 0.3f, 0.3f);
            card.style.borderTopColor = color;
            card.style.borderBottomColor = color;
            card.style.borderLeftColor = color;
            card.style.borderRightColor = color;
        }

        // Thumbnails are loaded once per image path and reused across rebuilds (a card click
        // triggers a full Rebuild), then destroyed on teardown — otherwise every rebuild would
        // leak a Texture2D per option. Cache stores failures (null) too, to avoid re-reading.
        private readonly Dictionary<string, Texture2D> _textureCache =
            new Dictionary<string, Texture2D>();

        private Texture2D TryLoadTexture(string imagePath)
        {
            if (string.IsNullOrEmpty(imagePath))
                return null;

            if (_textureCache.TryGetValue(imagePath, out Texture2D cached))
                return cached;

            Texture2D result = null;
            try
            {
                if (File.Exists(imagePath))
                {
                    byte[] bytes = File.ReadAllBytes(imagePath);
                    var tex = new Texture2D(2, 2);
                    if (tex.LoadImage(bytes))
                        result = tex;
                    else
                        Object.DestroyImmediate(tex);
                }
            }
            catch
            {
                result = null;
            }

            _textureCache[imagePath] = result;
            return result;
        }

        private void DisposeTextures()
        {
            foreach (Texture2D tex in _textureCache.Values)
            {
                if (tex != null)
                    Object.DestroyImmediate(tex);
            }
            _textureCache.Clear();
        }

        private void OnConfirm()
        {
            var selection = new Dictionary<string, string>();
            foreach (SlotModel slot in _slots)
            {
                if (!string.IsNullOrEmpty(slot.SelectedId))
                    selection[slot.Slot] = slot.SelectedId;
            }

            Selection = selection;
            Status = StatusConfirmed;

            _suppressDestroyCancel = true;
            Close();
        }

        private void OnCancel()
        {
            Selection = new Dictionary<string, string>();
            Status = StatusCancelled;

            _suppressDestroyCancel = true;
            Close();
        }

        private void OnDestroy()
        {
            DisposeTextures();

            // Closing the window without confirming counts as a cancel,
            // but only while a decision is pending (don't clobber a
            // confirmed/cancelled result already set by the buttons, nor a
            // programmatic ClosePicker reset to none).
            if (!_suppressDestroyCancel && Status == StatusPending)
            {
                Selection = new Dictionary<string, string>();
                Status = StatusCancelled;
            }
        }
    }
}
