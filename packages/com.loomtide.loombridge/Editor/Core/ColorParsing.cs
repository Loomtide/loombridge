using Newtonsoft.Json.Linq;
using UnityEngine;

namespace UnityBridge.Core
{
    /// <summary>
    /// Shared parser for the bridge's { r, g, b, a } color parameter format.
    ///
    /// This is the ONE definition of the color wire format's channel defaults:
    /// every missing channel defaults to 1 (i.e. an empty object is opaque white),
    /// matching the long-standing behavior of asset.create_material, asset.create_sprite,
    /// and ui.add_text/add_image. New ops that accept a color MUST parse it through
    /// here so "same color format as existing ops" stays literally true.
    /// </summary>
    public static class ColorParsing
    {
        /// <summary>
        /// Parse an { r, g, b, a } JObject into a Color. Missing channels default to 1
        /// (r/g/b/a alike), so {} == opaque white — identical to create_material.
        /// </summary>
        public static Color ParseColor(JObject colorObj)
        {
            return new Color(
                colorObj.Value<float?>("r") ?? 1f,
                colorObj.Value<float?>("g") ?? 1f,
                colorObj.Value<float?>("b") ?? 1f,
                colorObj.Value<float?>("a") ?? 1f);
        }
    }
}
