using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.UIElements;

namespace UnityBridge.UI
{
    /// <summary>
    /// Registry asset browser surface. The agent supplies a generic library
    /// payload assembled from the registry; this window renders browse/filter/
    /// inventory interactions and completes the existing LoombridgeAssetPicker
    /// poll handshake when the user confirms.
    /// </summary>
    public class LoombridgeAssetBrowser : EditorWindow
    {
        private const string CategoryAll = "all";

        // Hosted read-only catalog search API. The endpoint is CONFIGURATION, never a baked-in
        // default: Loombridge ships no deployment hostname (see Docs/Design/AssetRegistryOssBoundary.md).
        // Resolution order: EditorPrefs key, then the environment variable, then unconfigured.
        // Unconfigured is a clean, named refusal in the window, never a silent reach at someone's host.
        private const string ApiBaseUrlPrefKey = "loombridge.assetApiBaseUrl";
        private const string ApiBaseUrlEnvVar = "LOOMBRIDGE_ASSET_CATALOG_URL";
        private const string ApiBaseUrlUnconfiguredMessage =
            "hosted catalog not configured: set EditorPrefs '" + ApiBaseUrlPrefKey + "' or the " +
            ApiBaseUrlEnvVar + " environment variable to the catalog API base URL";

        private readonly List<CategoryModel> _categories = new List<CategoryModel>();
        private readonly List<AssetModel> _assets = new List<AssetModel>();
        private readonly List<string> _inventory = new List<string>();
        private readonly HashSet<string> _styleFilters = new HashSet<string>();
        private readonly HashSet<string> _licenseFilters = new HashSet<string>();
        private readonly HashSet<string> _colorFilters = new HashSet<string>();
        private readonly Dictionary<string, Texture2D> _textureCache = new Dictionary<string, Texture2D>();

        private string _title = "Loombridge Asset Browser";
        private string _registryName = "registry";
        private string _registryStatus = "loaded";
        private string _registrySynced = "agent payload";
        private string _activeCategory = CategoryAll;
        private string _query = "";
        private string _sort = "priority";
        private bool _suppressDestroyCancel;

        // --- Live hosted-catalog fetch state ---
        // Each asset card (by asset id) tracks its grid VisualElement so a late
        // thumbnail download can refresh just that cell.
        private readonly Dictionary<string, VisualElement> _cardThumbHosts = new Dictionary<string, VisualElement>();
        private EditorApplication.CallbackFunction _searchDebouncePump;
        private double _searchDebounceFireTime;
        private bool _searchDebounceArmed;
        // Registry meta line ("N assets - status - syncedLabel"); refreshed on every RefreshAll.
        private Label _registryMetaLabel;
        private int _fetchGeneration;
        private readonly List<UnityWebRequest> _activeRequests = new List<UnityWebRequest>();
        private readonly List<EditorApplication.CallbackFunction> _activePumps = new List<EditorApplication.CallbackFunction>();

        private TextField _searchField;
        private Label _resultCountLabel;
        private Label _gridTitleLabel;
        private Label _gridSubLabel;
        private VisualElement _categoryList;
        private VisualElement _styleChipRow;
        private VisualElement _licenseChipRow;
        private VisualElement _colorChipRow;
        private VisualElement _activeFiltersRow;
        private VisualElement _grid;
        private VisualElement _inventorySlots;
        private Label _inventoryCountLabel;
        private Label _statusInventoryLabel;

        private static readonly Color Bg0 = new Color(0.105f, 0.125f, 0.145f);
        private static readonly Color Bg1 = new Color(0.135f, 0.165f, 0.185f);
        private static readonly Color Bg2 = new Color(0.17f, 0.205f, 0.23f);
        private static readonly Color Bg3 = new Color(0.22f, 0.26f, 0.285f);
        private static readonly Color Line = new Color(0.31f, 0.36f, 0.39f);
        private static readonly Color LineStrong = new Color(0.43f, 0.49f, 0.52f);
        private static readonly Color Fg0 = new Color(0.93f, 0.96f, 0.96f);
        private static readonly Color Fg1 = new Color(0.75f, 0.82f, 0.82f);
        private static readonly Color Fg2 = new Color(0.55f, 0.62f, 0.64f);
        private static readonly Color Fg3 = new Color(0.4f, 0.47f, 0.5f);
        private static readonly Color Accent = new Color(0.48f, 0.84f, 0.78f);
        private static readonly Color AccentDark = new Color(0.16f, 0.34f, 0.34f);
        private static readonly Color Secondary = new Color(0.91f, 0.72f, 0.35f);
        private static readonly Color Danger = new Color(0.72f, 0.26f, 0.2f);

        private class CategoryModel
        {
            public string Id;
            public string Label;
            public int Count;
        }

        private class AssetModel
        {
            public string Id;
            public string Name;
            public string Category;
            public string CategoryLabel;
            public string Primitive;
            public string Kind;
            public string ImagePath;
            public string License;
            public string LicenseName;
            public string Style;
            public string ColorTone;
            public string Author;
            public string SourceTitle;
            public string SourceUrl;
            public string Provider;
            public string ProviderType;
            public string UnityPath;
            public string FileRole;
            public string FileFormat;
            public string FileSize;
            public string Version;
            public int Priority;
            public bool Placeholder;
            public float? Rating;
            public int? Downloads;
            public int? Width;
            public int? Height;
            public int? PixelsPerUnit;
            public readonly List<string> Tags = new List<string>();
            public readonly List<string> Badges = new List<string>();

            public string StyleOrDash()
            {
                return string.IsNullOrEmpty(Style) ? "style not provided" : Style;
            }

            public string ProviderTypeOrDash()
            {
                return string.IsNullOrEmpty(ProviderType) ? "type not provided" : ProviderType;
            }

            public string PrimitiveOrDash()
            {
                return string.IsNullOrEmpty(Primitive) ? "Not provided" : Primitive;
            }

            public string KindOrDash()
            {
                return string.IsNullOrEmpty(Kind) ? "Not provided" : Kind;
            }

            public string LicenseOrDash()
            {
                return string.IsNullOrEmpty(License) ? "Not provided" : License;
            }

            public string UnityPathOrDash()
            {
                return string.IsNullOrEmpty(UnityPath) ? "Not provided" : UnityPath;
            }
        }

        public static void Open(JObject payload)
        {
            if (payload == null)
                payload = new JObject();

            var window = GetWindow<LoombridgeAssetBrowser>(utility: false);
            window.titleContent = new GUIContent("Loombridge Asset Browser");
            window.minSize = new Vector2(960f, 620f);
            window.ApplyPayload(payload);

            LoombridgeAssetPicker.BeginPendingDecision();

            window._suppressDestroyCancel = false;
            window.Rebuild();
            window.Show();
            window.Focus();
        }

        [MenuItem("Window/Loombridge/Asset Browser")]
        public static void ShowWindow()
        {
            var window = GetWindow<LoombridgeAssetBrowser>(utility: false);
            window.titleContent = new GUIContent("Loombridge Asset Browser");
            window.minSize = new Vector2(960f, 620f);
            // Seed an empty "loading" state so the window renders immediately,
            // then populate from the hosted catalog asynchronously.
            window.ApplyPayload(BuildLoadingPayload());
            LoombridgeAssetPicker.BeginPendingDecision();
            window._suppressDestroyCancel = false;
            window.Rebuild();
            window.Show();
            window.Focus();
            window.FetchAndApply(profile: null, kind: null, primitive: null, text: null);
        }

        private static JObject BuildLoadingPayload()
        {
            return new JObject
            {
                ["title"] = "Loombridge Asset Browser",
                ["registry"] = new JObject
                {
                    ["name"] = "Loomtide Hosted Catalog",
                    ["status"] = "loading",
                    ["syncedLabel"] = "fetching live catalog..."
                },
                ["categories"] = DefaultCategoryPayload(),
                ["assets"] = new JArray(),
                ["inventory"] = new JArray()
            };
        }

        private static JObject BuildDefaultRegistryPayload()
        {
            string registryPath = FindDefaultRegistryPath();
            if (string.IsNullOrEmpty(registryPath) || !File.Exists(registryPath))
            {
                return new JObject
                {
                    ["title"] = "Loombridge Asset Browser",
                    ["registry"] = new JObject
                    {
                        ["name"] = "platformer-2d",
                        ["status"] = "missing",
                        ["syncedLabel"] = "registry file not found"
                    },
                    ["categories"] = DefaultCategoryPayload(),
                    ["assets"] = new JArray(),
                    ["inventory"] = new JArray()
                };
            }

            JObject registry = JObject.Parse(File.ReadAllText(registryPath));
            string registryRoot = Directory.GetParent(Directory.GetParent(Path.GetDirectoryName(registryPath)).FullName).FullName;
            var entries = registry.Value<JArray>("entries")?
                .OfType<JObject>()
                .Where(entry => entry.Value<string>("genre") == "platformer-2d")
                .OrderByDescending(entry => entry.Value<int?>("priority") ?? 0)
                .ThenBy(entry => entry.Value<string>("id") ?? "")
                .ToList() ?? new List<JObject>();

            var titleCounts = new Dictionary<string, int>();
            foreach (JObject entry in entries)
            {
                string title = entry.Value<JObject>("source")?.Value<string>("title") ?? entry.Value<string>("id") ?? "Unnamed asset";
                titleCounts[title] = titleCounts.ContainsKey(title) ? titleCounts[title] + 1 : 1;
            }

            var assets = new JArray();
            foreach (JObject entry in entries)
            {
                string title = entry.Value<JObject>("source")?.Value<string>("title") ?? entry.Value<string>("id") ?? "Unnamed asset";
                assets.Add(DefaultAssetPayload(entry, registryRoot, titleCounts.ContainsKey(title) && titleCounts[title] > 1));
            }

            return new JObject
            {
                ["title"] = "Loombridge Asset Browser",
                ["registry"] = new JObject
                {
                    ["name"] = registry.Value<string>("name") ?? "platformer-2d",
                    ["status"] = "loaded",
                    ["syncedLabel"] = entries.Count + " registry entries"
                },
                ["categories"] = DefaultCategoryPayload(),
                ["assets"] = assets,
                ["inventory"] = new JArray()
            };
        }

        private static string FindDefaultRegistryPath()
        {
            string current = Application.dataPath;
            for (int i = 0; i < 10 && !string.IsNullOrEmpty(current); i++)
            {
                string candidate = Path.Combine(current, "asset-layer/registry/platformer-2d.json");
                if (File.Exists(candidate))
                    return candidate;

                DirectoryInfo parent = Directory.GetParent(current);
                current = parent?.FullName;
            }

            return null;
        }

        private static JArray DefaultCategoryPayload()
        {
            return new JArray
            {
                CategoryPayload("characters", "Characters"),
                CategoryPayload("environments", "Environments"),
                CategoryPayload("props", "Props & Items"),
                CategoryPayload("weapons", "Weapons"),
                CategoryPayload("vfx", "VFX"),
                CategoryPayload("audio", "Audio"),
                CategoryPayload("animations", "Animations"),
                CategoryPayload("materials", "Materials"),
                CategoryPayload("ui", "UI Kits")
            };
        }

        private static JObject CategoryPayload(string id, string label)
        {
            return new JObject
            {
                ["id"] = id,
                ["label"] = label
            };
        }

        private static JObject DefaultAssetPayload(JObject entry, string registryRoot, bool duplicateSourceTitle)
        {
            JObject source = entry.Value<JObject>("source");
            JObject license = entry.Value<JObject>("license");
            JObject provider = entry.Value<JObject>("provider");
            JObject technical = entry.Value<JObject>("technical");
            JObject unity = entry.Value<JObject>("unity");
            JObject file = entry.Value<JArray>("files")?.OfType<JObject>().FirstOrDefault();
            string id = entry.Value<string>("id") ?? "";
            string primitive = entry.Value<string>("primitive") ?? "";
            string kind = entry.Value<string>("kind") ?? "";
            string category = CategoryForPrimitive(primitive, kind);
            string sourceTitle = source?.Value<string>("title") ?? id;
            string displayName = duplicateSourceTitle && !string.IsNullOrEmpty(primitive)
                ? sourceTitle + " - " + primitive.Replace("_", " ")
                : sourceTitle;
            string licenseSpdx = license?.Value<string>("spdx") ?? "";
            bool placeholder = entry.Value<bool?>("placeholder") ?? false;

            var badges = new JArray();
            if (!string.IsNullOrEmpty(licenseSpdx))
                badges.Add(licenseSpdx);
            if (!string.IsNullOrEmpty(primitive))
                badges.Add(primitive);
            if (placeholder)
                badges.Add("PLACEHOLDER");

            var asset = new JObject
            {
                ["id"] = id,
                ["name"] = displayName,
                ["category"] = category,
                ["categoryLabel"] = LabelForCategory(category),
                ["primitive"] = primitive,
                ["kind"] = string.IsNullOrEmpty(kind) ? KindForFile(file) : kind,
                ["license"] = licenseSpdx,
                ["licenseName"] = license?.Value<string>("name") ?? "",
                ["placeholder"] = placeholder,
                ["tags"] = entry.Value<JArray>("tags") ?? new JArray(),
                ["badges"] = badges,
                ["author"] = source?.Value<string>("author") ?? "",
                ["sourceTitle"] = sourceTitle,
                ["sourceUrl"] = source?.Value<string>("url") ?? "",
                ["provider"] = provider?.Value<string>("name") ?? "",
                ["providerType"] = provider?.Value<string>("type") ?? "",
                ["unityPath"] = unity?.Value<string>("path") ?? "",
                ["fileRole"] = file?.Value<string>("role") ?? "",
                ["fileFormat"] = file?.Value<string>("format") ?? "",
                ["priority"] = entry.Value<int?>("priority") ?? 0
            };

            string imagePath = LocalImagePath(id, file, registryRoot);
            if (!string.IsNullOrEmpty(imagePath))
                asset["imagePath"] = imagePath;

            string fileSize = LocalFileSize(file, registryRoot);
            if (!string.IsNullOrEmpty(fileSize))
                asset["fileSize"] = fileSize;

            int? width = technical?.Value<int?>("width");
            int? height = technical?.Value<int?>("height");
            int? pixelsPerUnit = technical?.Value<int?>("pixelsPerUnit") ?? unity?.Value<int?>("pixelsPerUnit");
            if (width.HasValue)
                asset["width"] = width.Value;
            if (height.HasValue)
                asset["height"] = height.Value;
            if (pixelsPerUnit.HasValue)
                asset["pixelsPerUnit"] = pixelsPerUnit.Value;

            return asset;
        }

        private static string KindForFile(JObject file)
        {
            string role = file?.Value<string>("role") ?? "";
            string format = file?.Value<string>("format") ?? "";
            if (role == "audio" || format == "wav")
                return "audio";

            return "sprite";
        }

        private static string LocalImagePath(string entryId, JObject file, string registryRoot)
        {
            string format = file?.Value<string>("format") ?? "";
            string localPath = file?.Value<string>("localPath") ?? "";
            if (!IsImageFormat(format))
                return null;

            if (!string.IsNullOrEmpty(localPath))
            {
                string absolutePath = Path.GetFullPath(Path.Combine(registryRoot, localPath));
                if (File.Exists(absolutePath))
                    return absolutePath;
            }

            string cachedPath = BrowserPreviewCachePath(entryId, file, registryRoot);
            if (string.IsNullOrEmpty(cachedPath) || !File.Exists(cachedPath))
                return null;

            return ChecksumMatches(cachedPath, file) ? cachedPath : null;
        }

        private static bool IsImageFormat(string format)
        {
            return string.Equals(format, "png", StringComparison.OrdinalIgnoreCase)
                || string.Equals(format, "jpg", StringComparison.OrdinalIgnoreCase)
                || string.Equals(format, "jpeg", StringComparison.OrdinalIgnoreCase);
        }

        private static string BrowserPreviewCachePath(string entryId, JObject file, string registryRoot)
        {
            string url = file?.Value<string>("url") ?? "";
            string localPath = file?.Value<string>("localPath") ?? "";
            string role = file?.Value<string>("role") ?? "";
            string format = file?.Value<string>("format") ?? "";
            if (string.IsNullOrEmpty(entryId) || string.IsNullOrEmpty(format) || string.IsNullOrEmpty(url))
                return null;

            string sourceReference = string.IsNullOrEmpty(url) ? (string.IsNullOrEmpty(localPath) ? "unknown" : localPath) : url;
            string hash = Sha256Hex(entryId + ":" + sourceReference).Substring(0, 12);
            string fileName = SafeName(entryId) + "-" + SafeName(role) + "-" + hash + "." + format;
            return Path.Combine(registryRoot, "demos/.artifacts/asset-cache/browser-previews", fileName);
        }

        private static bool ChecksumMatches(string path, JObject file)
        {
            string expected = file?.Value<JObject>("checksum")?.Value<string>("value") ?? "";
            return string.IsNullOrEmpty(expected) || string.Equals(Sha256Hex(File.ReadAllBytes(path)), expected, StringComparison.OrdinalIgnoreCase);
        }

        private static string Sha256Hex(string value)
        {
            return Sha256Hex(Encoding.UTF8.GetBytes(value));
        }

        private static string Sha256Hex(byte[] bytes)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(bytes);
                var sb = new StringBuilder(hash.Length * 2);
                foreach (byte b in hash)
                    sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }

        private static string SafeName(string value)
        {
            var sb = new StringBuilder();
            bool previousDash = false;
            foreach (char c in value ?? "")
            {
                bool safe = char.IsLetterOrDigit(c) || c == '.' || c == '_' || c == '-';
                if (safe)
                {
                    sb.Append(char.ToLowerInvariant(c));
                    previousDash = false;
                }
                else if (!previousDash)
                {
                    sb.Append('-');
                    previousDash = true;
                }
            }

            return sb.ToString().Trim('-');
        }

        private static string LocalFileSize(JObject file, string registryRoot)
        {
            string localPath = file?.Value<string>("localPath") ?? "";
            if (string.IsNullOrEmpty(localPath))
                return null;

            string absolutePath = Path.GetFullPath(Path.Combine(registryRoot, localPath));
            if (!File.Exists(absolutePath))
                return null;

            long size = new FileInfo(absolutePath).Length;
            if (size < 1024)
                return size + " B";
            if (size < 1024 * 1024)
                return (size / 1024f).ToString("0.0") + " KB";

            return (size / (1024f * 1024f)).ToString("0.0") + " MB";
        }

        private void OnEnable()
        {
            Rebuild();
        }

        // =====================================================================
        // Live hosted-catalog fetch
        // =====================================================================

        /// <summary>
        /// The configured catalog API base, or an empty string when none is configured.
        /// There is deliberately no fallback host.
        /// </summary>
        private static string ApiBaseUrl()
        {
            string configured = EditorPrefs.GetString(ApiBaseUrlPrefKey, string.Empty);
            if (string.IsNullOrWhiteSpace(configured))
                configured = Environment.GetEnvironmentVariable(ApiBaseUrlEnvVar) ?? string.Empty;
            return configured.Trim().TrimEnd('/');
        }

        /// <summary>
        /// Fetch the hosted catalog with the given filters, map records into the
        /// payload shape ApplyPayload expects, render, then lazily download
        /// thumbnails. All work runs on the editor main thread via an
        /// EditorApplication.update pump (no thread blocking).
        /// </summary>
        private void FetchAndApply(string profile, string kind, string primitive, string text, int limit = 120, string preserveCategory = null)
        {
            int generation = ++_fetchGeneration;

            if (string.IsNullOrEmpty(ApiBaseUrl()))
            {
                Debug.LogWarning("[Loombridge] [LiveCatalog] " + ApiBaseUrlUnconfiguredMessage);
                ApplyPayload(BuildFetchFailedPayload(ApiBaseUrlUnconfiguredMessage));
                RefreshAll();
                return;
            }

            string url = BuildSearchUrl(profile, kind, primitive, text, limit);

            UnityWebRequest request = UnityWebRequest.Get(url);
            PumpRequest(request, () =>
            {
                // Drop the result if a newer fetch superseded this one.
                if (generation != _fetchGeneration)
                {
                    request.Dispose();
                    return;
                }

                bool ok = request.result == UnityWebRequest.Result.Success;
                string body = ok ? request.downloadHandler?.text : null;
                string error = ok ? null : request.error;
                request.Dispose();

                if (!ok)
                {
                    Debug.LogWarning("[LiveCatalog] fetch FAILED: " + (error ?? "unknown error"));
                    ApplyPayload(BuildFetchFailedPayload("live fetch failed: " + (error ?? "unknown error")));
                    RefreshAll();
                    return;
                }

                JObject payload;
                List<JObject> records;
                try
                {
                    JObject parsed = JObject.Parse(body ?? "{}");
                    records = (parsed.Value<JArray>("records") ?? new JArray())
                        .OfType<JObject>()
                        .ToList();
                    payload = BuildLivePayload(records);
                }
                catch (Exception ex)
                {
                    ApplyPayload(BuildFetchFailedPayload("live fetch parse error: " + ex.Message));
                    RefreshAll();
                    return;
                }

                ApplyPayload(payload);
                if (!string.IsNullOrEmpty(preserveCategory))
                    _activeCategory = preserveCategory;
                RefreshAll();

                DownloadThumbnails(records, generation);
            });
        }

        private static string BuildSearchUrl(string profile, string kind, string primitive, string text, int limit)
        {
            var sb = new StringBuilder();
            sb.Append(ApiBaseUrl());
            sb.Append("/v1/assets/search?");

            var parts = new List<string>();
            AppendQueryParam(parts, "profile", profile);
            AppendQueryParam(parts, "primitive", primitive);
            AppendQueryParam(parts, "kind", kind);
            AppendQueryParam(parts, "text", text);
            if (limit > 0)
                AppendQueryParam(parts, "limit", limit.ToString());

            sb.Append(string.Join("&", parts));
            return sb.ToString();
        }

        private static void AppendQueryParam(List<string> parts, string key, string value)
        {
            if (string.IsNullOrWhiteSpace(value))
                return;
            parts.Add(key + "=" + UnityWebRequest.EscapeURL(value));
        }

        private static JObject BuildFetchFailedPayload(string message)
        {
            return new JObject
            {
                ["title"] = "Loombridge Asset Browser",
                ["registry"] = new JObject
                {
                    ["name"] = "Loomtide Hosted Catalog",
                    ["status"] = "error",
                    ["syncedLabel"] = message
                },
                ["categories"] = DefaultCategoryPayload(),
                ["assets"] = new JArray(),
                ["inventory"] = new JArray()
            };
        }

        private static JObject BuildLivePayload(List<JObject> records)
        {
            var assets = new JArray();
            foreach (JObject record in records)
                assets.Add(MapRecordToAsset(record));

            return new JObject
            {
                ["title"] = "Loombridge Asset Browser",
                ["registry"] = new JObject
                {
                    ["name"] = "Loomtide Hosted Catalog",
                    ["status"] = "loaded",
                    ["syncedLabel"] = records.Count + " results (live)"
                },
                ["categories"] = DefaultCategoryPayload(),
                ["assets"] = assets,
                ["inventory"] = new JArray()
            };
        }

        private static JObject MapRecordToAsset(JObject record)
        {
            string id = record.Value<string>("id") ?? "";
            string primitive = record.Value<string>("primitive") ?? "";
            string kind = record.Value<string>("kind") ?? "";
            string genre = record.Value<string>("genre") ?? "";
            var tags = (record.Value<JArray>("tags") ?? new JArray())
                .Select(t => t.Value<string>())
                .Where(t => !string.IsNullOrWhiteSpace(t))
                .ToList();

            JObject license = record.Value<JObject>("license");
            string licenseSpdx = license?.Value<string>("spdx") ?? "";

            JObject review = record.Value<JObject>("review");
            string reviewStatus = review?.Value<string>("status") ?? "";

            string trustTier = record.Value<string>("trustTier") ?? "";

            JObject firstFile = record.Value<JArray>("files")?.OfType<JObject>().FirstOrDefault();
            string downloadUrl = firstFile?.Value<string>("url") ?? "";

            JObject unity = record.Value<JObject>("unity");
            string unityPath = unity?.Value<string>("path") ?? "";

            JObject technical = record.Value<JObject>("technical");

            JObject source = record.Value<JObject>("source");

            string category = CategoryForLiveRecord(kind, primitive);

            var badges = new JArray();
            if (!string.IsNullOrEmpty(licenseSpdx))
                badges.Add(licenseSpdx);
            if (!string.IsNullOrEmpty(primitive))
                badges.Add(primitive);
            if (string.Equals(reviewStatus, "verified", StringComparison.OrdinalIgnoreCase))
                badges.Add("VERIFIED");

            var asset = new JObject
            {
                ["id"] = id,
                ["name"] = DeriveDisplayName(id, primitive, tags),
                ["category"] = category,
                ["categoryLabel"] = LabelForCategory(category),
                ["primitive"] = primitive,
                ["kind"] = kind,
                ["license"] = licenseSpdx,
                ["trustTier"] = trustTier,
                ["policyStatus"] = trustTier,
                ["badges"] = badges,
                ["directDownloadUrl"] = downloadUrl,
                ["reviewStatus"] = reviewStatus,
                ["unityPath"] = unityPath,
                ["sourceUrl"] = source?.Value<string>("url") ?? "",
                ["sourceTitle"] = source?.Value<string>("origin") ?? "",
                ["actionIntents"] = new JArray { "inspect-source", "select" },
                ["tags"] = new JArray(tags),
                // imagePath intentionally left empty; filled by DownloadThumbnails.
                ["imagePath"] = ""
            };

            int? width = technical?.Value<int?>("width");
            int? height = technical?.Value<int?>("height");
            if (width.HasValue)
                asset["width"] = width.Value;
            if (height.HasValue)
                asset["height"] = height.Value;

            int? pixelsPerUnit = unity?.Value<int?>("pixelsPerUnit");
            if (pixelsPerUnit.HasValue)
                asset["pixelsPerUnit"] = pixelsPerUnit.Value;

            return asset;
        }

        private static string DeriveDisplayName(string id, string primitive, List<string> tags)
        {
            string basis = id;
            if (string.IsNullOrWhiteSpace(basis))
                basis = primitive;
            if (string.IsNullOrWhiteSpace(basis) && tags.Count > 0)
                basis = tags[0];
            if (string.IsNullOrWhiteSpace(basis))
                return "Unnamed asset";

            // ids look like "platformer_player_idle" -> "Platformer Player Idle".
            string readable = basis.Replace('_', ' ').Replace('-', ' ').Replace('/', ' ').Trim();
            return ObjectNames.NicifyVariableName(readable);
        }

        private static string CategoryForLiveRecord(string kind, string primitive)
        {
            if (string.Equals(kind, "audio", StringComparison.OrdinalIgnoreCase))
                return "audio";
            if (string.Equals(kind, "vector", StringComparison.OrdinalIgnoreCase))
                return "ui";

            switch (primitive)
            {
                case "player":
                case "enemy":
                    return "characters";
                case "tile":
                case "background":
                case "parallax_background":
                    return "environments";
                case "vfx":
                    return "vfx";
                case "collectible":
                case "decor":
                    return "props";
            }

            return CategoryForPrimitive(primitive, kind);
        }

        /// <summary>
        /// Maps a browser category id to hosted-catalog query params.
        /// </summary>
        private static (string profile, string kind, string primitive, string text) ParamsForCategory(string id)
        {
            switch (id)
            {
                case "characters":
                    return (null, null, "player", null);
                case "environments":
                    return (null, null, "tile", null);
                case "props":
                    return (null, null, "collectible", null);
                case "weapons":
                    return (null, null, null, "weapon");
                case "vfx":
                    return (null, null, "vfx", null);
                case "audio":
                    return (null, "audio", null, null);
                case "materials":
                    return (null, "material", null, null);
                case "ui":
                    return (null, "vector", null, null);
                case "animations":
                    return (null, null, null, "animation");
                default:
                    return (null, null, null, null);
            }
        }

        // ---- Debounced live search ----

        private void ScheduleLiveSearch(string text)
        {
            _searchDebounceFireTime = EditorApplication.timeSinceStartup + 0.35;
            if (_searchDebounceArmed)
                return;

            _searchDebounceArmed = true;
            _searchDebouncePump = () =>
            {
                if (EditorApplication.timeSinceStartup < _searchDebounceFireTime)
                    return;

                EditorApplication.update -= _searchDebouncePump;
                _searchDebouncePump = null;
                _searchDebounceArmed = false;

                string query = _searchField != null ? (_searchField.value ?? "") : text;
                // A live text search ignores the category sidebar filter on purpose.
                FetchAndApply(profile: null, kind: null, primitive: null,
                    text: string.IsNullOrWhiteSpace(query) ? null : query);
            };
            EditorApplication.update += _searchDebouncePump;
        }

        // ---- Editor-pumped UnityWebRequest ----

        /// <summary>
        /// Sends a UnityWebRequest and invokes onDone (main thread) when it
        /// completes, polling via EditorApplication.update. The caller owns
        /// disposing the request inside onDone.
        /// </summary>
        private void PumpRequest(UnityWebRequest request, Action onDone)
        {
            UnityWebRequestAsyncOperation op = request.SendWebRequest();
            _activeRequests.Add(request);

            EditorApplication.CallbackFunction pump = null;
            pump = () =>
            {
                if (op == null || !op.isDone)
                    return;

                EditorApplication.update -= pump;
                _activePumps.Remove(pump);
                _activeRequests.Remove(request);

                try
                {
                    onDone();
                }
                catch (Exception ex)
                {
                    Debug.LogWarning("[Loombridge] asset browser request callback failed: " + ex.Message);
                }
            };

            _activePumps.Add(pump);
            EditorApplication.update += pump;
        }

        // ---- Thumbnail caching ----

        private static string ThumbnailCacheDir()
        {
            return Path.Combine(Path.GetTempPath(), "loombridge-browser-cache");
        }

        private void DownloadThumbnails(List<JObject> records, int generation)
        {
            var queue = new Queue<(string id, string url)>();
            foreach (JObject record in records)
            {
                string id = record.Value<string>("id") ?? "";
                if (string.IsNullOrEmpty(id))
                    continue;

                string thumbUrl = record.Value<string>("thumbnailUrl");
                if (string.IsNullOrWhiteSpace(thumbUrl))
                    thumbUrl = record.Value<JArray>("files")?.OfType<JObject>().FirstOrDefault()?.Value<string>("url");

                if (!IsRasterUrl(thumbUrl))
                    continue;

                queue.Enqueue((id, thumbUrl));
            }

            const int maxInFlight = 6;
            int inFlight = 0;

            void StartNext()
            {
                while (inFlight < maxInFlight && queue.Count > 0)
                {
                    if (generation != _fetchGeneration)
                        return;

                    var item = queue.Dequeue();
                    inFlight++;
                    DownloadSingleThumbnail(item.id, item.url, generation, () =>
                    {
                        inFlight--;
                        StartNext();
                    });
                }
            }

            StartNext();
        }

        private void DownloadSingleThumbnail(string assetId, string url, int generation, Action onComplete)
        {
            string cachePath = ThumbnailCachePathForUrl(url);

            // Reuse an already-cached file without re-downloading.
            if (!string.IsNullOrEmpty(cachePath) && File.Exists(cachePath))
            {
                ApplyThumbnail(assetId, cachePath, generation);
                onComplete();
                return;
            }

            UnityWebRequest request = UnityWebRequestTexture.GetTexture(url, nonReadable: true);
            PumpRequest(request, () =>
            {
                try
                {
                    if (generation != _fetchGeneration)
                        return;

                    if (request.result == UnityWebRequest.Result.Success)
                    {
                        byte[] data = request.downloadHandler?.data;
                        if (data != null && data.Length > 0 && !string.IsNullOrEmpty(cachePath))
                        {
                            try
                            {
                                Directory.CreateDirectory(Path.GetDirectoryName(cachePath));
                                File.WriteAllBytes(cachePath, data);
                                ApplyThumbnail(assetId, cachePath, generation);
                            }
                            catch (Exception ex)
                            {
                                Debug.LogWarning("[Loombridge] thumbnail cache write failed: " + ex.Message);
                            }
                        }
                    }
                }
                finally
                {
                    request.Dispose();
                    onComplete();
                }
            });
        }

        private void ApplyThumbnail(string assetId, string cachePath, int generation)
        {
            if (generation != _fetchGeneration)
                return;

            AssetModel asset = AssetById(assetId);
            if (asset == null)
                return;

            asset.ImagePath = cachePath;
            RefreshThumbnailCell(asset);
        }

        private void RefreshThumbnailCell(AssetModel asset)
        {
            if (asset == null || string.IsNullOrEmpty(asset.Id))
                return;

            // Replace the placeholder thumb for just this card if it is on screen.
            if (_cardThumbHosts.TryGetValue(asset.Id, out VisualElement host) && host != null && host.parent != null)
            {
                VisualElement parent = host.parent;
                int index = parent.IndexOf(host);
                if (index >= 0)
                {
                    var replacement = BuildThumbnail(asset, 194, 116);
                    parent.Insert(index, replacement);
                    host.RemoveFromHierarchy();
                    _cardThumbHosts[asset.Id] = replacement;
                    return;
                }
            }

            // Fallback: rebuild the whole grid (e.g. card not currently tracked).
            RefreshGrid();
        }

        private static bool IsRasterUrl(string url)
        {
            if (string.IsNullOrWhiteSpace(url))
                return false;

            string lower = url.ToLowerInvariant();
            int query = lower.IndexOf('?');
            if (query >= 0)
                lower = lower.Substring(0, query);

            return lower.EndsWith(".png")
                || lower.EndsWith(".jpg")
                || lower.EndsWith(".jpeg");
        }

        private static string ThumbnailCachePathForUrl(string url)
        {
            if (string.IsNullOrWhiteSpace(url))
                return null;

            string ext = ".png";
            string lower = url.ToLowerInvariant();
            int query = lower.IndexOf('?');
            string pathPart = query >= 0 ? lower.Substring(0, query) : lower;
            if (pathPart.EndsWith(".jpg") || pathPart.EndsWith(".jpeg"))
                ext = ".jpg";

            string hash = Sha256Hex(url).Substring(0, 16);
            return Path.Combine(ThumbnailCacheDir(), hash + ext);
        }

        private void CancelLiveWork()
        {
            // Supersede any pending fetch/thumbnail generation.
            _fetchGeneration++;

            if (_searchDebouncePump != null)
            {
                EditorApplication.update -= _searchDebouncePump;
                _searchDebouncePump = null;
            }
            _searchDebounceArmed = false;

            foreach (EditorApplication.CallbackFunction pump in _activePumps.ToList())
                EditorApplication.update -= pump;
            _activePumps.Clear();

            foreach (UnityWebRequest request in _activeRequests.ToList())
            {
                try
                {
                    request.Abort();
                    request.Dispose();
                }
                catch
                {
                    // best-effort teardown
                }
            }
            _activeRequests.Clear();
        }

        private void ApplyPayload(JObject payload)
        {
            DisposeTextures();
            _categories.Clear();
            _assets.Clear();
            _inventory.Clear();
            _styleFilters.Clear();
            _licenseFilters.Clear();
            _colorFilters.Clear();
            _activeCategory = CategoryAll;
            _query = "";
            _sort = "priority";

            _title = payload.Value<string>("title") ?? "Loombridge Asset Browser";

            JObject registry = payload.Value<JObject>("registry");
            _registryName = registry?.Value<string>("name") ?? payload.Value<string>("registryName") ?? "registry";
            _registryStatus = registry?.Value<string>("status") ?? "loaded";
            _registrySynced = registry?.Value<string>("syncedLabel") ?? "agent payload";

            ParseAssets(payload.Value<JArray>("assets"));
            ParseCategories(payload.Value<JArray>("categories"));
            ParseInventory(payload);
        }

        private void ParseAssets(JArray assets)
        {
            if (assets == null)
                return;

            foreach (JToken token in assets)
            {
                if (!(token is JObject obj))
                    continue;

                var asset = new AssetModel
                {
                    Id = obj.Value<string>("id") ?? "",
                    Name = obj.Value<string>("name") ?? obj.Value<string>("label") ?? obj.Value<string>("id") ?? "Unnamed asset",
                    Primitive = obj.Value<string>("primitive") ?? "",
                    Kind = obj.Value<string>("kind") ?? "",
                    ImagePath = obj.Value<string>("imagePath") ?? obj.Value<string>("thumbnailPath"),
                    License = obj.Value<string>("license") ?? "",
                    LicenseName = obj.Value<string>("licenseName") ?? "",
                    Style = obj.Value<string>("style") ?? "",
                    ColorTone = obj.Value<string>("color") ?? obj.Value<string>("colorTone") ?? "",
                    Author = obj.Value<string>("author") ?? "",
                    SourceTitle = obj.Value<string>("sourceTitle") ?? "",
                    SourceUrl = obj.Value<string>("sourceUrl") ?? "",
                    Provider = obj.Value<string>("provider") ?? "",
                    ProviderType = obj.Value<string>("providerType") ?? "",
                    UnityPath = obj.Value<string>("unityPath") ?? "",
                    FileRole = obj.Value<string>("fileRole") ?? "",
                    FileFormat = obj.Value<string>("fileFormat") ?? "",
                    FileSize = obj.Value<string>("fileSize") ?? "",
                    Version = obj.Value<string>("version") ?? "",
                    Priority = obj.Value<int?>("priority") ?? 0,
                    Placeholder = obj.Value<bool?>("placeholder") ?? false,
                    Rating = obj.Value<float?>("rating"),
                    Downloads = obj.Value<int?>("downloads"),
                    Width = obj.Value<int?>("width"),
                    Height = obj.Value<int?>("height"),
                    PixelsPerUnit = obj.Value<int?>("pixelsPerUnit")
                };

                asset.Category = obj.Value<string>("category") ?? CategoryForPrimitive(asset.Primitive, asset.Kind);
                asset.CategoryLabel = obj.Value<string>("categoryLabel") ?? LabelForCategory(asset.Category);

                AddStrings(asset.Tags, obj.Value<JArray>("tags"));
                AddStrings(asset.Badges, obj.Value<JArray>("badges"));
                if (!string.IsNullOrEmpty(asset.License) && !asset.Badges.Contains(asset.License))
                    asset.Badges.Add(asset.License);
                if (asset.Placeholder && !asset.Badges.Any(IsPlaceholderBadge))
                    asset.Badges.Add("PLACEHOLDER");

                if (!string.IsNullOrEmpty(asset.Id))
                    _assets.Add(asset);
            }
        }

        private void ParseCategories(JArray categories)
        {
            _categories.Add(new CategoryModel
            {
                Id = CategoryAll,
                Label = "All Assets",
                Count = _assets.Count
            });

            var explicitIds = new HashSet<string> { CategoryAll };
            if (categories != null)
            {
                foreach (JToken token in categories)
                {
                    if (!(token is JObject obj))
                        continue;

                    string id = obj.Value<string>("id") ?? "";
                    if (string.IsNullOrEmpty(id) || id == CategoryAll || explicitIds.Contains(id))
                        continue;

                    _categories.Add(new CategoryModel
                    {
                        Id = id,
                        Label = obj.Value<string>("label") ?? LabelForCategory(id),
                        Count = _assets.Count(asset => asset.Category == id)
                    });
                    explicitIds.Add(id);
                }
            }

            foreach (string category in _assets.Select(asset => asset.Category).Distinct().OrderBy(value => value))
            {
                if (explicitIds.Contains(category))
                    continue;

                _categories.Add(new CategoryModel
                {
                    Id = category,
                    Label = LabelForCategory(category),
                    Count = _assets.Count(asset => asset.Category == category)
                });
            }
        }

        private void ParseInventory(JObject payload)
        {
            AddInventoryIds(payload.Value<JArray>("inventory"));

            JArray slots = payload.Value<JArray>("slots");
            if (slots != null)
            {
                foreach (JToken token in slots)
                {
                    if (!(token is JObject slot))
                        continue;

                    string id = slot.Value<string>("selectedId");
                    if (!string.IsNullOrEmpty(id))
                        AddToInventory(id);
                }
            }

        }

        private void Rebuild()
        {
            VisualElement root = rootVisualElement;
            root.Clear();
            root.style.flexDirection = FlexDirection.Column;
            root.style.backgroundColor = Bg0;
            root.style.color = Fg0;
            // Top inset so the toolbar (search box) clears the OS window title bar
            // when the window is zoomed/maximized (otherwise it renders behind it).
            root.style.paddingTop = 24;

            BuildChrome(root);
            BuildToolbar(root);

            var main = new VisualElement();
            main.style.flexDirection = FlexDirection.Row;
            main.style.flexGrow = 1;
            main.style.minHeight = 0;
            root.Add(main);

            BuildSidebar(main);
            BuildGridArea(main);
            BuildInventory(root);
            BuildStatusBar(root);

            RefreshAll();
        }

        private void BuildChrome(VisualElement root)
        {
            var chrome = Row();
            chrome.style.height = 28;
            chrome.style.paddingLeft = 12;
            chrome.style.paddingRight = 12;
            chrome.style.alignItems = Align.Center;
            chrome.style.backgroundColor = new Color(0.075f, 0.09f, 0.105f);
            BorderBottom(chrome, Line);
            root.Add(chrome);

            var dots = Row();
            dots.style.marginRight = 14;
            dots.Add(Dot(new Color(0.93f, 0.42f, 0.37f)));
            dots.Add(Dot(new Color(0.96f, 0.75f, 0.31f)));
            dots.Add(Dot(new Color(0.38f, 0.77f, 0.33f)));
            chrome.Add(dots);

            var title = LabelText("LT  " + _title + "  -  registry: " + _registryName, 11, Fg1, true);
            title.style.flexGrow = 1;
            chrome.Add(title);

            foreach (string tab in new[] { "Asset Picker", "Scene", "Game", "Inspector" })
            {
                var label = LabelText(tab, 11, tab == "Asset Picker" ? Fg0 : Fg3, false);
                label.style.paddingLeft = 10;
                label.style.paddingRight = 10;
                label.style.paddingTop = 3;
                label.style.paddingBottom = 3;
                label.style.marginLeft = 2;
                label.style.borderTopLeftRadius = 3;
                label.style.borderTopRightRadius = 3;
                label.style.borderBottomLeftRadius = 3;
                label.style.borderBottomRightRadius = 3;
                if (tab == "Asset Picker")
                    label.style.backgroundColor = Bg2;
                chrome.Add(label);
            }
        }

        private void BuildToolbar(VisualElement root)
        {
            var toolbar = Row();
            toolbar.style.height = 56;
            toolbar.style.paddingLeft = 14;
            toolbar.style.paddingRight = 14;
            toolbar.style.alignItems = Align.Center;
            toolbar.style.backgroundColor = Bg1;
            BorderBottom(toolbar, Line);
            root.Add(toolbar);

            var brand = Row();
            brand.style.width = 250;
            brand.style.alignItems = Align.Center;
            toolbar.Add(brand);

            var mark = LabelText("LT", 13, new Color(0.08f, 0.15f, 0.15f), true);
            mark.style.width = 32;
            mark.style.height = 32;
            mark.style.unityTextAlign = TextAnchor.MiddleCenter;
            mark.style.backgroundColor = Accent;
            mark.style.borderTopLeftRadius = 7;
            mark.style.borderTopRightRadius = 7;
            mark.style.borderBottomLeftRadius = 7;
            mark.style.borderBottomRightRadius = 7;
            brand.Add(mark);

            var brandText = new VisualElement();
            brandText.style.marginLeft = 9;
            brand.Add(brandText);
            brandText.Add(LabelText("Loombridge", 14, Fg0, true));
            brandText.Add(LabelText("Asset Browser", 10, Fg3, false));

            var tabs = Row();
            tabs.style.marginLeft = 12;
            tabs.style.paddingTop = 2;
            tabs.style.paddingBottom = 2;
            tabs.style.paddingLeft = 2;
            tabs.style.paddingRight = 2;
            tabs.style.backgroundColor = Bg0;
            Border(tabs, Line);
            Radius(tabs, 7);
            toolbar.Add(tabs);

            tabs.Add(TabLabel("Browse", true));
            tabs.Add(TabLabel("Imported", false));
            tabs.Add(TabLabel("Recent", false));

            _searchField = new TextField();
            _searchField.value = _query;
            _searchField.style.flexGrow = 1;
            _searchField.style.maxWidth = 520;
            _searchField.style.marginLeft = 16;
            _searchField.style.marginRight = 12;
            _searchField.style.height = 30;
            _searchField.RegisterValueChangedCallback(evt =>
            {
                _query = evt.newValue ?? "";
                ScheduleLiveSearch(_query);
            });
            _searchField.tooltip = "Search by name, tag, author, source, or id";
            toolbar.Add(_searchField);

            _resultCountLabel = LabelText("0 results", 11, Fg3, true);
            _resultCountLabel.style.minWidth = 70;
            toolbar.Add(_resultCountLabel);

            var sort = new PopupField<string>(
                new List<string> { "priority", "name", "license", "kind" },
                _sort);
            sort.formatListItemCallback = FormatSortLabel;
            sort.formatSelectedValueCallback = value => "Sort: " + FormatSortLabel(value);
            sort.style.width = 135;
            sort.style.marginLeft = 8;
            sort.RegisterValueChangedCallback(evt =>
            {
                _sort = evt.newValue;
                RefreshAll();
            });
            toolbar.Add(sort);
        }

        private void BuildSidebar(VisualElement main)
        {
            var sidebar = new ScrollView(ScrollViewMode.Vertical);
            sidebar.style.width = 248;
            sidebar.style.flexShrink = 0;
            sidebar.style.backgroundColor = Bg1;
            BorderRight(sidebar, Line);
            main.Add(sidebar);

            var registrySection = Section(sidebar, "Registry");
            var registryRow = Row();
            registryRow.style.alignItems = Align.Center;
            registryRow.style.paddingTop = 8;
            registryRow.style.paddingBottom = 8;
            registryRow.style.paddingLeft = 10;
            registryRow.style.paddingRight = 10;
            registryRow.style.backgroundColor = Bg0;
            registryRow.style.overflow = Overflow.Hidden;
            Border(registryRow, Line);
            Radius(registryRow, 7);
            registrySection.Add(registryRow);

            var statusDot = Dot(new Color(0.48f, 0.82f, 0.45f));
            statusDot.style.flexShrink = 0;
            statusDot.style.marginRight = 8;
            registryRow.Add(statusDot);

            var registryMeta = new VisualElement();
            registryMeta.style.flexGrow = 1;
            registryMeta.style.flexShrink = 1;
            registryMeta.style.overflow = Overflow.Hidden;
            registryRow.Add(registryMeta);
            registryMeta.Add(TruncatedLabel(_registryName, 11, Fg0, true));
            _registryMetaLabel = TruncatedLabel(_assets.Count + " assets - " + _registryStatus + " - " + _registrySynced, 10, Fg3, false);
            registryMeta.Add(_registryMetaLabel);

            var categorySection = Section(sidebar, "Categories");
            _categoryList = new VisualElement();
            categorySection.Add(_categoryList);

            var filterSection = Section(sidebar, "Filters");
            filterSection.Add(FilterHeader("Style"));
            _styleChipRow = ChipRow();
            filterSection.Add(_styleChipRow);
            filterSection.Add(FilterHeader("License"));
            _licenseChipRow = ChipRow();
            filterSection.Add(_licenseChipRow);
            filterSection.Add(FilterHeader("Color"));
            _colorChipRow = ChipRow();
            filterSection.Add(_colorChipRow);
        }

        private void BuildGridArea(VisualElement main)
        {
            var gridWrap = new VisualElement();
            gridWrap.style.flexGrow = 1;
            gridWrap.style.minWidth = 0;
            gridWrap.style.backgroundColor = Bg0;
            main.Add(gridWrap);

            var gridHead = Row();
            gridHead.style.alignItems = Align.FlexEnd;
            gridHead.style.justifyContent = Justify.SpaceBetween;
            gridHead.style.paddingTop = 16;
            gridHead.style.paddingBottom = 12;
            gridHead.style.paddingLeft = 20;
            gridHead.style.paddingRight = 20;
            BorderBottom(gridHead, Line);
            gridWrap.Add(gridHead);

            var titleStack = new VisualElement();
            gridHead.Add(titleStack);
            _gridTitleLabel = LabelText("All Assets", 18, Fg0, true);
            titleStack.Add(_gridTitleLabel);
            _gridSubLabel = LabelText("", 11, Fg3, true);
            titleStack.Add(_gridSubLabel);

            _activeFiltersRow = Row();
            _activeFiltersRow.style.flexWrap = Wrap.Wrap;
            _activeFiltersRow.style.justifyContent = Justify.FlexEnd;
            _activeFiltersRow.style.flexGrow = 1;
            gridHead.Add(_activeFiltersRow);

            var scroll = new ScrollView(ScrollViewMode.Vertical);
            scroll.style.flexGrow = 1;
            scroll.style.minHeight = 0;
            gridWrap.Add(scroll);

            _grid = new VisualElement();
            _grid.style.flexDirection = FlexDirection.Row;
            _grid.style.flexWrap = Wrap.Wrap;
            _grid.style.paddingTop = 18;
            _grid.style.paddingBottom = 26;
            _grid.style.paddingLeft = 20;
            _grid.style.paddingRight = 20;
            scroll.Add(_grid);
        }

        private void BuildInventory(VisualElement root)
        {
            var inventory = new VisualElement();
            inventory.style.height = 154;
            inventory.style.minHeight = 154;
            inventory.style.paddingTop = 10;
            inventory.style.paddingBottom = 10;
            inventory.style.paddingLeft = 16;
            inventory.style.paddingRight = 16;
            inventory.style.backgroundColor = new Color(0.12f, 0.15f, 0.165f);
            BorderTop(inventory, Line);
            root.Add(inventory);

            var header = Row();
            header.style.justifyContent = Justify.SpaceBetween;
            header.style.alignItems = Align.Center;
            header.style.marginBottom = 8;
            inventory.Add(header);

            var titleRow = Row();
            titleRow.style.alignItems = Align.FlexEnd;
            header.Add(titleRow);
            titleRow.Add(LabelText("Inventory", 11, Fg1, true));
            _inventoryCountLabel = LabelText("0 selected", 11, Fg3, true);
            _inventoryCountLabel.style.marginLeft = 10;
            titleRow.Add(_inventoryCountLabel);

            var actionRow = Row();
            header.Add(actionRow);
            actionRow.Add(SecondaryButton("Clear", ClearInventory));
            var cancel = SecondaryButton("Cancel", CancelAndClose);
            cancel.style.marginLeft = 6;
            actionRow.Add(cancel);
            var confirm = PrimaryButton("Confirm Selection", ConfirmAndClose);
            confirm.style.marginLeft = 6;
            actionRow.Add(confirm);

            var scroll = new ScrollView(ScrollViewMode.Horizontal);
            scroll.style.height = 108;
            scroll.style.minHeight = 108;
            inventory.Add(scroll);

            _inventorySlots = new VisualElement();
            _inventorySlots.style.flexDirection = FlexDirection.Row;
            _inventorySlots.style.height = 104;
            scroll.Add(_inventorySlots);
        }

        private void BuildStatusBar(VisualElement root)
        {
            var status = Row();
            status.style.height = 22;
            status.style.paddingLeft = 14;
            status.style.paddingRight = 14;
            status.style.alignItems = Align.Center;
            status.style.justifyContent = Justify.SpaceBetween;
            status.style.backgroundColor = new Color(0.075f, 0.09f, 0.105f);
            BorderTop(status, Line);
            root.Add(status);

            var left = Row();
            left.style.alignItems = Align.Center;
            status.Add(left);
            var dot = Dot(new Color(0.48f, 0.82f, 0.45f));
            dot.style.marginRight = 6;
            left.Add(dot);
            left.Add(LabelText("Unity Bridge connected - MCP: loombridge - status: " + LoombridgeAssetPicker.Status, 11, Fg3, true));

            _statusInventoryLabel = LabelText("", 11, Fg3, true);
            status.Add(_statusInventoryLabel);
        }

        private void RefreshAll()
        {
            if (_registryMetaLabel != null)
                _registryMetaLabel.text = _assets.Count + " assets - " + _registryStatus + " - " + _registrySynced;
            RefreshCategories();
            RefreshFilters();
            RefreshGrid();
            RefreshInventory();
        }

        private void RefreshCategories()
        {
            if (_categoryList == null)
                return;

            _categoryList.Clear();
            foreach (CategoryModel category in _categories)
                _categoryList.Add(BuildCategoryButton(category));
        }

        private void RefreshFilters()
        {
            RefreshChipRow(_styleChipRow, DistinctNonEmpty(_assets.Select(asset => asset.Style)), _styleFilters, "No style metadata");
            RefreshChipRow(_licenseChipRow, DistinctNonEmpty(_assets.Select(asset => asset.License)), _licenseFilters, "No license metadata");
            RefreshChipRow(_colorChipRow, DistinctNonEmpty(_assets.Select(asset => asset.ColorTone)), _colorFilters, "No color metadata");

            if (_activeFiltersRow == null)
                return;

            _activeFiltersRow.Clear();
            foreach (string value in _styleFilters.OrderBy(value => value))
                _activeFiltersRow.Add(ActiveFilterChip(value, () => ToggleFilter(_styleFilters, value)));
            foreach (string value in _licenseFilters.OrderBy(value => value))
                _activeFiltersRow.Add(ActiveFilterChip(value, () => ToggleFilter(_licenseFilters, value)));
            foreach (string value in _colorFilters.OrderBy(value => value))
                _activeFiltersRow.Add(ActiveFilterChip(value, () => ToggleFilter(_colorFilters, value)));
        }

        private void RefreshGrid()
        {
            if (_grid == null)
                return;

            List<AssetModel> filtered = FilteredAssets();
            _grid.Clear();
            _cardThumbHosts.Clear();

            string categoryLabel = _categories.FirstOrDefault(category => category.Id == _activeCategory)?.Label ?? LabelForCategory(_activeCategory);
            _gridTitleLabel.text = categoryLabel;
            _gridSubLabel.text = filtered.Count + " of " + CategoryCount(_activeCategory) + " assets shown";
            _resultCountLabel.text = filtered.Count + " results";

            if (filtered.Count == 0)
            {
                var empty = new VisualElement();
                empty.style.alignItems = Align.Center;
                empty.style.justifyContent = Justify.Center;
                empty.style.height = 260;
                empty.style.flexGrow = 1;
                empty.Add(LabelText("No assets match", 15, Fg1, true));
                empty.Add(LabelText("No registry entries are visible for this view.", 12, Fg3, false));
                _grid.Add(empty);
                return;
            }

            foreach (AssetModel asset in filtered)
                _grid.Add(BuildAssetCard(asset));
        }

        private void RefreshInventory()
        {
            if (_inventorySlots == null)
                return;

            _inventory.RemoveAll(id => AssetById(id) == null);
            _inventorySlots.Clear();
            _inventoryCountLabel.text = _inventory.Count + " selected";
            _statusInventoryLabel.text = _inventory.Count + " in inventory - Registry: " + _registryName;

            if (_inventory.Count == 0)
            {
                var empty = Row();
                empty.style.alignItems = Align.Center;
                empty.style.height = 96;
                empty.style.flexGrow = 1;
                empty.style.paddingLeft = 14;
                empty.style.paddingRight = 14;
                empty.style.backgroundColor = Bg0;
                Border(empty, LineStrong);
                Radius(empty, 8);
                empty.Add(LabelText("+", 20, Fg2, true));
                var text = new VisualElement();
                text.style.marginLeft = 12;
                empty.Add(text);
                text.Add(LabelText("No assets selected", 12, Fg1, true));
                text.Add(LabelText("Inventory is empty.", 11, Fg3, false));
                _inventorySlots.Add(empty);
                return;
            }

            for (int i = 0; i < _inventory.Count; i++)
            {
                AssetModel asset = AssetById(_inventory[i]);
                if (asset != null)
                    _inventorySlots.Add(BuildInventorySlot(asset, i));
            }

            var addSlot = new VisualElement();
            addSlot.style.width = 124;
            addSlot.style.height = 96;
            addSlot.style.marginRight = 8;
            addSlot.style.alignItems = Align.Center;
            addSlot.style.justifyContent = Justify.Center;
            Border(addSlot, LineStrong);
            Radius(addSlot, 7);
            addSlot.Add(LabelText("Drop asset", 10, Fg3, true));
            _inventorySlots.Add(addSlot);
        }

        private VisualElement BuildCategoryButton(CategoryModel category)
        {
            var button = new Button(() =>
            {
                _activeCategory = category.Id;
                RefreshAll();
                // Live-filter against the hosted catalog for this category.
                var p = ParamsForCategory(category.Id);
                FetchAndApply(p.profile, p.kind, p.primitive, p.text, preserveCategory: category.Id);
            });
            button.text = "";
            button.style.flexDirection = FlexDirection.Row;
            button.style.alignItems = Align.Center;
            button.style.height = 48;
            button.style.marginBottom = 4;
            button.style.paddingLeft = 14;
            button.style.paddingRight = 14;
            button.style.backgroundColor = category.Id == _activeCategory ? AccentDark : Color.clear;
            Border(button, category.Id == _activeCategory ? Accent : Color.clear);
            Radius(button, 8);

            var icon = LabelText(IconForCategory(category.Id), 20, category.Id == _activeCategory ? Accent : Fg3, false);
            icon.style.width = 34;
            icon.style.marginRight = 12;
            icon.style.unityTextAlign = TextAnchor.MiddleCenter;
            button.Add(icon);

            var label = LabelText(category.Label, 14, category.Id == _activeCategory ? Fg0 : Fg1, false);
            label.style.flexGrow = 1;
            button.Add(label);

            var count = LabelText(category.Count.ToString(), 12, Fg2, true);
            count.style.minWidth = 34;
            count.style.height = 22;
            count.style.unityTextAlign = TextAnchor.MiddleCenter;
            count.style.backgroundColor = Bg0;
            count.style.borderTopLeftRadius = 11;
            count.style.borderTopRightRadius = 11;
            count.style.borderBottomLeftRadius = 11;
            count.style.borderBottomRightRadius = 11;
            button.Add(count);

            return button;
        }

        private VisualElement BuildAssetCard(AssetModel asset)
        {
            var card = new VisualElement();
            card.style.width = 196;
            card.style.marginRight = 14;
            card.style.marginBottom = 14;
            card.style.backgroundColor = Bg1;
            card.style.overflow = Overflow.Hidden;
            Border(card, _inventory.Contains(asset.Id) ? Accent : Line);
            Radius(card, 0);
            card.RegisterCallback<MouseDownEvent>(evt =>
            {
                if (evt.clickCount >= 2)
                {
                    AddOrSwapInventory(asset);
                    RefreshAll();
                    evt.StopPropagation();
                    return;
                }

                ShowPreview(asset);
                evt.StopPropagation();
            });

            var thumb = BuildThumbnail(asset, 194, 116);
            card.Add(thumb);
            if (!string.IsNullOrEmpty(asset.Id))
                _cardThumbHosts[asset.Id] = thumb;

            var selected = LabelText("IN INVENTORY", 9, new Color(0.08f, 0.15f, 0.15f), true);
            selected.style.position = Position.Absolute;
            selected.style.left = 6;
            selected.style.top = 6;
            selected.style.paddingLeft = 6;
            selected.style.paddingRight = 6;
            selected.style.paddingTop = 2;
            selected.style.paddingBottom = 2;
            selected.style.backgroundColor = Accent;
            Radius(selected, 10);
            selected.style.display = _inventory.Contains(asset.Id) ? DisplayStyle.Flex : DisplayStyle.None;
            card.Add(selected);

            if (!string.IsNullOrEmpty(asset.Style))
            {
                var style = Pill(asset.Style, Bg0, Fg1);
                style.style.position = Position.Absolute;
                style.style.left = 6;
                style.style.top = 88;
                card.Add(style);
            }

            var foot = new VisualElement();
            foot.style.paddingLeft = 10;
            foot.style.paddingRight = 10;
            foot.style.paddingTop = 8;
            foot.style.paddingBottom = 6;
            foot.style.width = 194;
            card.Add(foot);

            var name = LabelText(asset.Name, 12, Fg0, true);
            name.style.width = 174;
            name.style.height = 32;
            name.style.whiteSpace = WhiteSpace.Normal;
            name.style.overflow = Overflow.Hidden;
            name.style.textOverflow = TextOverflow.Ellipsis;
            name.style.unityTextAlign = TextAnchor.UpperLeft;
            foot.Add(name);

            var meta = Row();
            meta.style.marginTop = 4;
            meta.style.alignItems = Align.Center;
            foot.Add(meta);

            var rating = LabelText(asset.Rating.HasValue ? "* " + asset.Rating.Value.ToString("0.0") : "unrated", 10, asset.Rating.HasValue ? Secondary : Fg3, true);
            rating.style.maxWidth = 62;
            rating.style.overflow = Overflow.Hidden;
            rating.style.textOverflow = TextOverflow.Ellipsis;
            meta.Add(rating);

            if (!string.IsNullOrEmpty(asset.Primitive))
            {
                var primitive = LabelText(asset.Primitive, 10, Fg3, true);
                primitive.style.marginLeft = 6;
                primitive.style.maxWidth = 104;
                primitive.style.overflow = Overflow.Hidden;
                primitive.style.textOverflow = TextOverflow.Ellipsis;
                meta.Add(primitive);
            }

            var badgeRow = Row();
            badgeRow.style.flexWrap = Wrap.Wrap;
            badgeRow.style.paddingLeft = 10;
            badgeRow.style.paddingRight = 10;
            badgeRow.style.paddingBottom = 10;
            card.Add(badgeRow);

            foreach (string badge in asset.Badges.Take(3))
                badgeRow.Add(Pill(badge, IsPlaceholderBadge(badge) ? new Color(0.46f, 0.31f, 0.08f) : Bg2, Fg1));

            return card;
        }

        private VisualElement BuildInventorySlot(AssetModel asset, int index)
        {
            var slot = new VisualElement();
            slot.style.width = 124;
            slot.style.height = 96;
            slot.style.marginRight = 8;
            slot.style.backgroundColor = Bg0;
            slot.style.overflow = Overflow.Hidden;
            Border(slot, Line);
            Radius(slot, 7);
            slot.RegisterCallback<MouseDownEvent>(_ => ShowPreview(asset));

            slot.Add(BuildThumbnail(asset, 122, 56));

            var foot = new VisualElement();
            foot.style.height = 38;
            foot.style.paddingLeft = 7;
            foot.style.paddingRight = 7;
            foot.style.paddingTop = 3;
            foot.style.paddingBottom = 4;
            foot.style.backgroundColor = Bg1;
            BorderTop(foot, Line);
            slot.Add(foot);
            var name = LabelText(asset.Name, 10, Fg0, true);
            name.style.height = 14;
            name.style.overflow = Overflow.Hidden;
            name.style.textOverflow = TextOverflow.Ellipsis;
            foot.Add(name);
            var primitive = LabelText(asset.Primitive, 9, Fg3, true);
            primitive.style.height = 13;
            primitive.style.overflow = Overflow.Hidden;
            primitive.style.textOverflow = TextOverflow.Ellipsis;
            foot.Add(primitive);

            var remove = new Button(() =>
            {
                _inventory.RemoveAt(index);
                RefreshAll();
            });
            remove.text = "x";
            remove.style.position = Position.Absolute;
            remove.style.right = 4;
            remove.style.top = 4;
            remove.style.width = 20;
            remove.style.height = 18;
            remove.style.backgroundColor = Danger;
            remove.style.color = Color.white;
            Radius(remove, 9);
            slot.Add(remove);

            return slot;
        }

        private VisualElement BuildThumbnail(AssetModel asset, float width, float height)
        {
            var wrap = new VisualElement();
            wrap.style.width = width;
            wrap.style.height = height;
            wrap.style.backgroundColor = PaletteFor(asset);
            wrap.style.overflow = Overflow.Hidden;

            Texture2D tex = TryLoadTexture(asset.ImagePath);
            if (tex != null)
            {
                var image = new Image();
                image.image = tex;
                image.scaleMode = ScaleMode.ScaleToFit;
                image.style.width = width;
                image.style.height = height;
                wrap.Add(image);
            }
            else
            {
                if (asset.Kind == "audio")
                {
                    wrap.Add(BuildAudioPreview(width, height));
                }
                else
                {
                    var label = LabelText(Initials(asset.Name), 22, new Color(1f, 1f, 1f, 0.72f), true);
                    label.style.unityTextAlign = TextAnchor.MiddleCenter;
                    label.style.flexGrow = 1;
                    label.style.height = height;
                    wrap.Add(label);
                }

                var placeholder = LabelText(asset.Kind == "audio" ? "AUDIO" : "PREVIEW", 9, new Color(1f, 1f, 1f, 0.5f), true);
                placeholder.style.position = Position.Absolute;
                placeholder.style.left = 6;
                placeholder.style.bottom = 5;
                wrap.Add(placeholder);
            }

            if (asset.Placeholder)
            {
                var flag = LabelText("PLACEHOLDER", 9, Color.white, true);
                flag.style.position = Position.Absolute;
                flag.style.right = 6;
                flag.style.bottom = 5;
                flag.style.paddingLeft = 5;
                flag.style.paddingRight = 5;
                flag.style.paddingTop = 1;
                flag.style.paddingBottom = 1;
                flag.style.backgroundColor = new Color(0.54f, 0.34f, 0.06f, 0.92f);
                Radius(flag, 8);
                wrap.Add(flag);
            }

            return wrap;
        }

        private static VisualElement BuildAudioPreview(float width, float height)
        {
            var preview = new VisualElement();
            preview.style.width = width;
            preview.style.height = height;
            preview.style.alignItems = Align.Center;
            preview.style.justifyContent = Justify.Center;

            var mark = Row();
            mark.style.alignItems = Align.Center;
            mark.style.justifyContent = Justify.Center;
            preview.Add(mark);

            float[] bars = { 18f, 34f, 48f, 30f, 42f, 24f, 38f, 20f };
            foreach (float barHeight in bars)
            {
                var bar = new VisualElement();
                bar.style.width = 6;
                bar.style.height = Mathf.Min(barHeight, height - 24f);
                bar.style.marginLeft = 2;
                bar.style.marginRight = 2;
                bar.style.backgroundColor = Accent;
                Radius(bar, 3);
                mark.Add(bar);
            }

            var play = LabelText(">", 18, new Color(0.08f, 0.15f, 0.15f), true);
            play.style.width = 34;
            play.style.height = 34;
            play.style.marginLeft = 12;
            play.style.unityTextAlign = TextAnchor.MiddleCenter;
            play.style.backgroundColor = Secondary;
            Radius(play, 17);
            mark.Add(play);

            return preview;
        }

        private void ShowPreview(AssetModel asset)
        {
            var modal = new EditorWindowPreview(this, asset);
            modal.Show();
        }

        private class EditorWindowPreview
        {
            private readonly LoombridgeAssetBrowser _owner;
            private readonly AssetModel _asset;
            private VisualElement _overlay;
            private VisualElement _imageOverlay;

            public EditorWindowPreview(LoombridgeAssetBrowser owner, AssetModel asset)
            {
                _owner = owner;
                _asset = asset;
            }

            public void Show()
            {
                _overlay = new VisualElement();
                _overlay.style.position = Position.Absolute;
                _overlay.style.left = 0;
                _overlay.style.right = 0;
                _overlay.style.top = 0;
                _overlay.style.bottom = 0;
                _overlay.style.backgroundColor = new Color(0.02f, 0.025f, 0.03f, 0.72f);
                _overlay.style.alignItems = Align.Center;
                _overlay.style.justifyContent = Justify.Center;
                _owner.rootVisualElement.Add(_overlay);

                var panel = new VisualElement();
                panel.style.width = 820;
                panel.style.maxHeight = 560;
                panel.style.backgroundColor = Bg1;
                Border(panel, LineStrong);
                Radius(panel, 0);
                _overlay.Add(panel);

                var head = Row();
                head.style.justifyContent = Justify.SpaceBetween;
                head.style.alignItems = Align.Center;
                head.style.paddingLeft = 16;
                head.style.paddingRight = 12;
                head.style.paddingTop = 12;
                head.style.paddingBottom = 12;
                head.style.backgroundColor = Bg2;
                BorderBottom(head, Line);
                panel.Add(head);

                head.Add(LabelText("Registry > " + _asset.CategoryLabel + " > " + _asset.Id, 11, Fg3, true));
                head.Add(SecondaryButton("x", Close));

                var body = Row();
                body.style.minHeight = 360;
                panel.Add(body);

                var preview = new VisualElement();
                preview.style.width = 330;
                preview.style.paddingTop = 18;
                preview.style.paddingBottom = 18;
                preview.style.paddingLeft = 18;
                preview.style.paddingRight = 18;
                preview.style.backgroundColor = Bg0;
                BorderRight(preview, Line);
                body.Add(preview);
                var thumbnail = _owner.BuildThumbnail(_asset, 292, 180);
                if (!string.IsNullOrEmpty(_asset.ImagePath))
                {
                    thumbnail.RegisterCallback<MouseDownEvent>(evt =>
                    {
                        ShowImageOverlay();
                        evt.StopPropagation();
                    });
                }
                preview.Add(thumbnail);

                var tools = Row();
                tools.style.marginTop = 10;
                tools.Add(SecondaryButton("Show in Project", () => { }));
                var importButton = SecondaryButton("Import via MCP", () =>
                {
                    _owner.AddOrSwapInventory(_asset);
                    _owner.ConfirmAndClose();
                });
                importButton.style.marginLeft = 6;
                tools.Add(importButton);
                preview.Add(tools);

                var detail = new ScrollView(ScrollViewMode.Vertical);
                detail.style.flexGrow = 1;
                detail.style.paddingTop = 18;
                detail.style.paddingBottom = 18;
                detail.style.paddingLeft = 18;
                detail.style.paddingRight = 18;
                body.Add(detail);

                detail.Add(LabelText((_asset.StyleOrDash() + " - " + _asset.CategoryLabel).ToUpperInvariant(), 11, Accent, true));
                var name = LabelText(_asset.Name, 22, Fg0, true);
                name.style.marginTop = 4;
                detail.Add(name);

                string author = string.IsNullOrEmpty(_asset.Author) ? "Unknown author" : _asset.Author;
                string provider = string.IsNullOrEmpty(_asset.Provider) ? "Unknown provider" : _asset.Provider;
                var authorBox = new VisualElement();
                authorBox.style.marginTop = 12;
                authorBox.style.paddingTop = 10;
                authorBox.style.paddingBottom = 10;
                authorBox.style.paddingLeft = 10;
                authorBox.style.paddingRight = 10;
                authorBox.style.backgroundColor = Bg0;
                Border(authorBox, Line);
                Radius(authorBox, 8);
                var authorRow = Row();
                authorRow.style.alignItems = Align.Center;
                authorBox.Add(authorRow);

                var sourceText = new VisualElement();
                sourceText.style.flexGrow = 1;
                authorRow.Add(sourceText);
                sourceText.Add(LabelText(author, 13, Fg0, true));
                sourceText.Add(LabelText(provider + " - " + (_asset.ProviderTypeOrDash()), 10, Fg3, true));

                if (!string.IsNullOrEmpty(_asset.SourceUrl))
                {
                    var openSource = SecondaryButton("Open Source", () => Application.OpenURL(_asset.SourceUrl));
                    openSource.style.marginLeft = 10;
                    authorRow.Add(openSource);
                    authorBox.RegisterCallback<MouseDownEvent>(evt =>
                    {
                        Application.OpenURL(_asset.SourceUrl);
                        evt.StopPropagation();
                    });
                    openSource.RegisterCallback<MouseDownEvent>(evt => evt.StopPropagation());
                }
                detail.Add(authorBox);

                var tagRow = Row();
                tagRow.style.flexWrap = Wrap.Wrap;
                tagRow.style.marginTop = 12;
                foreach (string tag in _asset.Tags)
                    tagRow.Add(Pill(tag, Bg0, Fg2));
                if (_asset.Tags.Count == 0)
                    tagRow.Add(Pill("no tags", Bg0, Fg3));
                detail.Add(tagRow);

                var spec = new VisualElement();
                spec.style.flexDirection = FlexDirection.Row;
                spec.style.flexWrap = Wrap.Wrap;
                spec.style.marginTop = 12;
                detail.Add(spec);

                AddSpec(spec, "Primitive", _asset.PrimitiveOrDash());
                AddSpec(spec, "Kind", _asset.KindOrDash());
                AddSpec(spec, "License", _asset.LicenseOrDash());
                AddSpec(spec, "Rating", _asset.Rating.HasValue ? _asset.Rating.Value.ToString("0.0") : "Not provided");
                AddSpec(spec, "Downloads", _asset.Downloads.HasValue ? _asset.Downloads.Value.ToString() : "Not provided");
                AddSpec(spec, "Size", string.IsNullOrEmpty(_asset.FileSize) ? "Not provided" : _asset.FileSize);
                AddSpec(spec, "Dimensions", _asset.Width.HasValue && _asset.Height.HasValue ? _asset.Width + "x" + _asset.Height : "Not provided");
                AddSpec(spec, "Unity path", _asset.UnityPathOrDash());
                AddSpec(spec, "Placeholder", _asset.Placeholder ? "Yes" : "No");

                var actions = Row();
                actions.style.marginTop = 14;
                if (_owner._inventory.Contains(_asset.Id))
                {
                    actions.Add(PrimaryButton("Remove from Inventory", () =>
                    {
                        _owner._inventory.Remove(_asset.Id);
                        _owner.RefreshAll();
                        Close();
                    }, true));
                }
                else
                {
                    actions.Add(PrimaryButton("Add to Inventory", () =>
                    {
                        _owner.AddOrSwapInventory(_asset);
                        _owner.RefreshAll();
                        Close();
                    }, false));
                }
                detail.Add(actions);
            }

            private void Close()
            {
                CloseImageOverlay();
                if (_overlay != null)
                {
                    _overlay.RemoveFromHierarchy();
                    _overlay = null;
                }
            }

            private void ShowImageOverlay()
            {
                Texture2D texture = _owner.TryLoadTexture(_asset.ImagePath);
                if (texture == null)
                    return;

                CloseImageOverlay();

                _imageOverlay = new VisualElement();
                _imageOverlay.style.position = Position.Absolute;
                _imageOverlay.style.left = 0;
                _imageOverlay.style.right = 0;
                _imageOverlay.style.top = 0;
                _imageOverlay.style.bottom = 0;
                _imageOverlay.style.backgroundColor = new Color(0.02f, 0.025f, 0.03f, 0.82f);
                _imageOverlay.style.alignItems = Align.Center;
                _imageOverlay.style.justifyContent = Justify.Center;
                _owner.rootVisualElement.Add(_imageOverlay);

                var panel = new VisualElement();
                panel.style.width = 920;
                panel.style.height = 680;
                panel.style.backgroundColor = Bg1;
                Border(panel, LineStrong);
                Radius(panel, 0);
                _imageOverlay.Add(panel);

                var head = Row();
                head.style.height = 44;
                head.style.alignItems = Align.Center;
                head.style.justifyContent = Justify.SpaceBetween;
                head.style.paddingLeft = 14;
                head.style.paddingRight = 10;
                head.style.backgroundColor = Bg2;
                BorderBottom(head, Line);
                panel.Add(head);

                string dimensions = texture.width + "x" + texture.height;
                head.Add(LabelText(_asset.Name + "  -  " + dimensions, 12, Fg1, true));

                var controls = Row();
                controls.style.alignItems = Align.Center;
                head.Add(controls);

                float zoom = 1f;
                var zoomLabel = LabelText("100%", 11, Fg2, true);
                zoomLabel.style.width = 48;
                zoomLabel.style.unityTextAlign = TextAnchor.MiddleCenter;

                var scroll = new ScrollView(ScrollViewMode.VerticalAndHorizontal);
                scroll.style.flexGrow = 1;
                scroll.style.backgroundColor = Bg0;
                panel.Add(scroll);

                var imageWrap = new VisualElement();
                imageWrap.style.minWidth = 920;
                imageWrap.style.minHeight = 636;
                imageWrap.style.alignItems = Align.Center;
                imageWrap.style.justifyContent = Justify.Center;
                imageWrap.style.paddingTop = 18;
                imageWrap.style.paddingBottom = 18;
                imageWrap.style.paddingLeft = 18;
                imageWrap.style.paddingRight = 18;
                scroll.Add(imageWrap);

                var image = new Image();
                image.image = texture;
                image.scaleMode = ScaleMode.ScaleToFit;
                imageWrap.Add(image);

                void ApplyZoom()
                {
                    image.style.width = Mathf.Max(1f, texture.width * zoom);
                    image.style.height = Mathf.Max(1f, texture.height * zoom);
                    zoomLabel.text = Mathf.RoundToInt(zoom * 100f) + "%";
                }

                var zoomOut = SecondaryButton("-", () =>
                {
                    zoom = Mathf.Max(0.25f, zoom - 0.25f);
                    ApplyZoom();
                });
                var zoomIn = SecondaryButton("+", () =>
                {
                    zoom = Mathf.Min(4f, zoom + 0.25f);
                    ApplyZoom();
                });
                var actual = SecondaryButton("100%", () =>
                {
                    zoom = 1f;
                    ApplyZoom();
                });
                var close = SecondaryButton("x", CloseImageOverlay);

                controls.Add(zoomOut);
                zoomLabel.style.marginLeft = 6;
                controls.Add(zoomLabel);
                zoomIn.style.marginLeft = 6;
                controls.Add(zoomIn);
                actual.style.marginLeft = 8;
                controls.Add(actual);
                close.style.marginLeft = 10;
                controls.Add(close);

                ApplyZoom();
            }

            private void CloseImageOverlay()
            {
                if (_imageOverlay != null)
                {
                    _imageOverlay.RemoveFromHierarchy();
                    _imageOverlay = null;
                }
            }
        }

        private List<AssetModel> FilteredAssets()
        {
            IEnumerable<AssetModel> result = _assets;

            if (_activeCategory != CategoryAll)
                result = result.Where(asset => asset.Category == _activeCategory);

            if (_styleFilters.Count > 0)
                result = result.Where(asset => _styleFilters.Contains(asset.Style));
            if (_licenseFilters.Count > 0)
                result = result.Where(asset => _licenseFilters.Contains(asset.License));
            if (_colorFilters.Count > 0)
                result = result.Where(asset => _colorFilters.Contains(asset.ColorTone));

            if (!string.IsNullOrWhiteSpace(_query))
            {
                string q = _query.Trim().ToLowerInvariant();
                result = result.Where(asset =>
                    Contains(asset.Name, q)
                    || Contains(asset.Id, q)
                    || Contains(asset.Author, q)
                    || Contains(asset.SourceTitle, q)
                    || asset.Tags.Any(tag => Contains(tag, q)));
            }

            switch (_sort)
            {
                case "name":
                    result = result.OrderBy(asset => asset.Name);
                    break;
                case "license":
                    result = result.OrderBy(asset => asset.License).ThenBy(asset => asset.Name);
                    break;
                case "kind":
                    result = result.OrderBy(asset => asset.Kind).ThenBy(asset => asset.Name);
                    break;
                default:
                    result = result.OrderByDescending(asset => asset.Priority).ThenBy(asset => asset.Name);
                    break;
            }

            return result.ToList();
        }

        private void AddOrSwapInventory(AssetModel asset)
        {
            if (asset == null || string.IsNullOrEmpty(asset.Id))
                return;

            if (_inventory.Contains(asset.Id))
                return;

            if (!string.IsNullOrEmpty(asset.Primitive))
            {
                for (int i = 0; i < _inventory.Count; i++)
                {
                    AssetModel existing = AssetById(_inventory[i]);
                    if (existing != null && existing.Primitive == asset.Primitive)
                    {
                        _inventory[i] = asset.Id;
                        return;
                    }
                }
            }

            _inventory.Add(asset.Id);
        }

        private void AddToInventory(string id)
        {
            AssetModel asset = AssetById(id);
            if (asset != null)
                AddOrSwapInventory(asset);
        }

        private void AddInventoryIds(JArray ids)
        {
            if (ids == null)
                return;

            foreach (JToken id in ids)
                AddToInventory(id.Value<string>());
        }

        private void ClearInventory()
        {
            _inventory.Clear();
            RefreshAll();
        }

        private void ConfirmAndClose()
        {
            LoombridgeAssetPicker.ConfirmSelection(BuildSelectionMap());
            _suppressDestroyCancel = true;
            Close();
        }

        private void CancelAndClose()
        {
            LoombridgeAssetPicker.CancelDecision();
            _suppressDestroyCancel = true;
            Close();
        }

        private Dictionary<string, string> BuildSelectionMap()
        {
            var selection = new Dictionary<string, string>();
            var usedKeys = new HashSet<string>();

            for (int i = 0; i < _inventory.Count; i++)
            {
                AssetModel asset = AssetById(_inventory[i]);
                if (asset == null)
                    continue;

                string key = !string.IsNullOrEmpty(asset.Primitive)
                    ? asset.Primitive
                    : "asset_" + i;

                if (usedKeys.Contains(key))
                    key = key + "_" + i;

                selection[key] = asset.Id;
                usedKeys.Add(key);
            }

            return selection;
        }

        private AssetModel AssetById(string id)
        {
            if (string.IsNullOrEmpty(id))
                return null;
            return _assets.FirstOrDefault(asset => asset.Id == id);
        }

        private int CategoryCount(string category)
        {
            return category == CategoryAll
                ? _assets.Count
                : _assets.Count(asset => asset.Category == category);
        }

        private static void RefreshChipRow(VisualElement row, List<string> values, HashSet<string> active, string emptyText)
        {
            if (row == null)
                return;

            row.Clear();
            if (values.Count == 0)
            {
                row.Add(LabelText(emptyText, 11, Fg3, false));
                return;
            }

            foreach (string value in values)
            {
                var chip = new Button(() =>
                {
                    if (active.Contains(value))
                        active.Remove(value);
                    else
                        active.Add(value);

                    LoombridgeAssetBrowser browser = GetWindow<LoombridgeAssetBrowser>(utility: false);
                    browser.RefreshAll();
                });
                chip.text = value;
                chip.style.marginRight = 4;
                chip.style.marginBottom = 4;
                chip.style.paddingLeft = 8;
                chip.style.paddingRight = 8;
                chip.style.height = 22;
                chip.style.fontSize = 11;
                chip.style.backgroundColor = active.Contains(value) ? AccentDark : Bg0;
                chip.style.color = Fg1;
                Border(chip, active.Contains(value) ? Accent : Line);
                Radius(chip, 10);
                row.Add(chip);
            }
        }

        private void ToggleFilter(HashSet<string> set, string value)
        {
            if (set.Contains(value))
                set.Remove(value);
            else
                set.Add(value);
            RefreshAll();
        }

        private static VisualElement ActiveFilterChip(string text, Action onRemove)
        {
            var chip = Row();
            chip.style.alignItems = Align.Center;
            chip.style.marginLeft = 4;
            chip.style.marginBottom = 4;
            chip.style.paddingLeft = 8;
            chip.style.paddingRight = 4;
            chip.style.height = 22;
            chip.style.backgroundColor = Bg2;
            Border(chip, Line);
            Radius(chip, 10);
            chip.Add(LabelText(text, 10, Fg1, false));
            var remove = new Button(onRemove) { text = "x" };
            remove.style.marginLeft = 4;
            remove.style.width = 16;
            remove.style.height = 16;
            remove.style.backgroundColor = Bg3;
            remove.style.color = Fg1;
            Radius(remove, 8);
            chip.Add(remove);
            return chip;
        }

        private static void AddSpec(VisualElement parent, string label, string value)
        {
            var spec = new VisualElement();
            spec.style.width = 132;
            spec.style.minHeight = 54;
            spec.style.paddingTop = 8;
            spec.style.paddingBottom = 8;
            spec.style.paddingLeft = 10;
            spec.style.paddingRight = 10;
            spec.style.marginRight = 1;
            spec.style.marginBottom = 1;
            spec.style.backgroundColor = Bg0;
            parent.Add(spec);
            spec.Add(LabelText(label.ToUpperInvariant(), 9, Fg3, true));
            var valueLabel = LabelText(value, 11, Fg0, false);
            valueLabel.style.whiteSpace = WhiteSpace.Normal;
            valueLabel.style.marginTop = 3;
            spec.Add(valueLabel);
        }

        private static VisualElement Section(VisualElement parent, string title)
        {
            var section = new VisualElement();
            section.style.paddingTop = 10;
            section.style.paddingBottom = 10;
            section.style.paddingLeft = 12;
            section.style.paddingRight = 12;
            BorderBottom(section, Line);
            parent.Add(section);
            section.Add(LabelText(title.ToUpperInvariant(), 10, Fg3, true));
            return section;
        }

        private static Label FilterHeader(string text)
        {
            var label = LabelText(text, 11, Fg2, true);
            label.style.marginTop = 10;
            label.style.marginBottom = 6;
            return label;
        }

        private static VisualElement ChipRow()
        {
            var row = Row();
            row.style.flexWrap = Wrap.Wrap;
            row.style.marginBottom = 2;
            return row;
        }

        private static Button PrimaryButton(string text, Action action, bool danger = false)
        {
            var button = new Button(action) { text = text };
            button.style.height = 28;
            button.style.paddingLeft = 12;
            button.style.paddingRight = 12;
            button.style.fontSize = 12;
            button.style.unityFontStyleAndWeight = FontStyle.Bold;
            button.style.backgroundColor = danger ? Danger : Accent;
            button.style.color = danger ? Color.white : new Color(0.08f, 0.15f, 0.15f);
            Border(button, danger ? Danger : Accent);
            Radius(button, 6);
            return button;
        }

        private static Button SecondaryButton(string text, Action action)
        {
            var button = new Button(action) { text = text };
            button.style.height = 24;
            button.style.paddingLeft = 8;
            button.style.paddingRight = 8;
            button.style.fontSize = 11;
            button.style.backgroundColor = Color.clear;
            button.style.color = Fg1;
            Border(button, Line);
            Radius(button, 5);
            return button;
        }

        private static Label TabLabel(string text, bool active)
        {
            var label = LabelText(text, 12, active ? Fg0 : Fg2, false);
            label.style.paddingLeft = 10;
            label.style.paddingRight = 10;
            label.style.paddingTop = 4;
            label.style.paddingBottom = 4;
            label.style.backgroundColor = active ? Bg2 : Color.clear;
            Radius(label, 5);
            return label;
        }

        private static VisualElement Pill(string text, Color background, Color color)
        {
            var pill = LabelText(text, 9, color, true);
            pill.style.marginRight = 4;
            pill.style.marginBottom = 4;
            pill.style.paddingLeft = 6;
            pill.style.paddingRight = 6;
            pill.style.paddingTop = 2;
            pill.style.paddingBottom = 2;
            pill.style.backgroundColor = background;
            Radius(pill, 9);
            return pill;
        }

        private static VisualElement Dot(Color color)
        {
            var dot = new VisualElement();
            dot.style.width = 8;
            dot.style.height = 8;
            dot.style.marginRight = 6;
            dot.style.backgroundColor = color;
            Radius(dot, 4);
            return dot;
        }

        private static VisualElement Row()
        {
            var row = new VisualElement();
            row.style.flexDirection = FlexDirection.Row;
            return row;
        }

        private static Label LabelText(string text, int size, Color color, bool monoOrBold)
        {
            var label = new Label(text ?? "");
            label.style.fontSize = size;
            label.style.color = color;
            if (monoOrBold)
                label.style.unityFontStyleAndWeight = FontStyle.Bold;
            return label;
        }

        private static Label TruncatedLabel(string text, int size, Color color, bool monoOrBold)
        {
            var label = LabelText(text, size, color, monoOrBold);
            label.style.flexShrink = 1;
            label.style.overflow = Overflow.Hidden;
            label.style.textOverflow = TextOverflow.Ellipsis;
            label.style.whiteSpace = WhiteSpace.NoWrap;
            return label;
        }

        private static void Border(VisualElement element, Color color)
        {
            element.style.borderTopWidth = 1;
            element.style.borderRightWidth = 1;
            element.style.borderBottomWidth = 1;
            element.style.borderLeftWidth = 1;
            element.style.borderTopColor = color;
            element.style.borderRightColor = color;
            element.style.borderBottomColor = color;
            element.style.borderLeftColor = color;
        }

        private static void BorderTop(VisualElement element, Color color)
        {
            element.style.borderTopWidth = 1;
            element.style.borderTopColor = color;
        }

        private static void BorderRight(VisualElement element, Color color)
        {
            element.style.borderRightWidth = 1;
            element.style.borderRightColor = color;
        }

        private static void BorderBottom(VisualElement element, Color color)
        {
            element.style.borderBottomWidth = 1;
            element.style.borderBottomColor = color;
        }

        private static void Radius(VisualElement element, float radius)
        {
            element.style.borderTopLeftRadius = radius;
            element.style.borderTopRightRadius = radius;
            element.style.borderBottomLeftRadius = radius;
            element.style.borderBottomRightRadius = radius;
        }

        private static string FormatSortLabel(string value)
        {
            switch (value)
            {
                case "name":
                    return "Name";
                case "license":
                    return "License";
                case "kind":
                    return "Kind";
                default:
                    return "Priority";
            }
        }

        private static List<string> DistinctNonEmpty(IEnumerable<string> values)
        {
            return values
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Distinct()
                .OrderBy(value => value)
                .ToList();
        }

        private static void AddStrings(List<string> target, JArray values)
        {
            if (values == null)
                return;

            foreach (JToken value in values)
            {
                string text = value.Value<string>();
                if (!string.IsNullOrWhiteSpace(text) && !target.Contains(text))
                    target.Add(text);
            }
        }

        private static bool Contains(string value, string query)
        {
            return !string.IsNullOrEmpty(value) && value.ToLowerInvariant().Contains(query);
        }

        private static bool IsPlaceholderBadge(string badge)
        {
            return badge != null && badge.IndexOf("PLACEHOLDER", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static string CategoryForPrimitive(string primitive, string kind)
        {
            if (kind == "audio" || primitive == "sfx_collectible")
                return "audio";
            switch (primitive)
            {
                case "player":
                case "enemy":
                    return "characters";
                case "tile":
                case "background":
                case "parallax_background":
                    return "environments";
                case "vfx":
                    return "vfx";
                case "collectible":
                case "decor":
                    return "props";
                default:
                    return "props";
            }
        }

        private static string LabelForCategory(string category)
        {
            switch (category)
            {
                case CategoryAll:
                    return "All Assets";
                case "characters":
                    return "Characters";
                case "environments":
                    return "Environments";
                case "props":
                    return "Props & Items";
                case "weapons":
                    return "Weapons";
                case "vfx":
                    return "VFX";
                case "audio":
                    return "Audio";
                case "animations":
                    return "Animations";
                case "materials":
                    return "Materials";
                case "ui":
                    return "UI Kits";
                default:
                    return ObjectNames.NicifyVariableName(category ?? "Assets");
            }
        }

        private static string IconForCategory(string category)
        {
            switch (category)
            {
                case "characters":
                    return "♙";
                case "environments":
                    return "▵";
                case "props":
                    return "◇";
                case "weapons":
                    return "╱";
                case "vfx":
                    return "✣";
                case "audio":
                    return "⌁";
                case "animations":
                    return "⌇";
                case "materials":
                    return "▦";
                case "ui":
                    return "□";
                default:
                    return "▦";
            }
        }

        private static string Initials(string text)
        {
            if (string.IsNullOrWhiteSpace(text))
                return "AS";
            string[] parts = text.Split(new[] { ' ', '-', '_' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 1)
                return parts[0].Substring(0, Math.Min(2, parts[0].Length)).ToUpperInvariant();
            return (parts[0].Substring(0, 1) + parts[1].Substring(0, 1)).ToUpperInvariant();
        }

        private static Color PaletteFor(AssetModel asset)
        {
            if (asset.Kind == "audio")
                return new Color(0.18f, 0.25f, 0.32f);
            if (asset.Primitive == "player")
                return new Color(0.17f, 0.32f, 0.48f);
            if (asset.Primitive == "tile" || asset.Primitive == "background")
                return new Color(0.18f, 0.34f, 0.26f);
            if (asset.Primitive == "collectible")
                return new Color(0.5f, 0.36f, 0.12f);
            if (asset.Primitive == "decor")
                return new Color(0.28f, 0.36f, 0.23f);
            return Bg2;
        }

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
                        UnityEngine.Object.DestroyImmediate(tex);
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
                    UnityEngine.Object.DestroyImmediate(tex);
            }
            _textureCache.Clear();
        }

        private void OnDestroy()
        {
            CancelLiveWork();
            DisposeTextures();
            if (!_suppressDestroyCancel && LoombridgeAssetPicker.Status == LoombridgeAssetPicker.StatusPending)
                LoombridgeAssetPicker.CancelDecision();
        }
    }

}
