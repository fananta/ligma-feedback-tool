import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { readFileSync } from "fs";

// Read the extension version from manifest.json
const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "manifest.json"), "utf-8")
);
const EXT_VERSION = manifest.version;

/**
 * Vite plugin that patches the Agentation library for Chrome extension use:
 * 1. Redirects style injection from document.head → Shadow DOM root
 * 2. Patches getElementById for style dedup checks inside Shadow DOM
 * 3. Changes default marker color to purple
 * 4. Defaults autoClearAfterCopy to true
 * 5. Rewires Send button to call copyOutput() instead of sendToWebhook()
 * 6. Removes webhook URL guard from Send button disabled state + "S" key handler
 */
function agentationPatchPlugin(): Plugin {
  return {
    name: "agentation-patch",
    enforce: "pre",
    transform(code, id) {
      // Only patch files inside node_modules/agentation — NOT our own src/ files
      if (!id.includes("node_modules/agentation")) return;

      let transformed = code;

      // 1. Redirect style injection: document.head.appendChild → shadow root
      transformed = transformed.replaceAll(
        "document.head.appendChild",
        "(window.__agShadowRoot || document.head).appendChild"
      );

      // 2. Redirect getElementById for style dedup checks → shadow root querySelector
      transformed = transformed.replaceAll(
        "document.getElementById(",
        "(window.__agGetStyleById || document.getElementById.bind(document))("
      );

      // 3. Change default annotation color from blue (#3c82f7) to purple (#AF52DE)
      transformed = transformed.replace(
        `annotationColor: "#3c82f7"`,
        `annotationColor: "#AF52DE"`
      );

      // 3b. Marker hover shows delete instead of edit, click deletes
      transformed = transformed.replace(
        `markerClickBehavior: "edit"`,
        `markerClickBehavior: "delete"`
      );

      // 3c. Show trash icon on marker hover instead of X
      transformed = transformed.replaceAll(
        `showDeleteHover ? /* @__PURE__ */ jsx3(IconXmark, { size: isMulti ? 18 : 16 })`,
        `showDeleteHover ? /* @__PURE__ */ jsx3(IconTrash, { size: isMulti ? 18 : 16 })`
      );

      // 4. (Removed — autoClearAfterCopy stays false so Copy preserves annotations.
      //    Send clears via our custom __ligmaSendHandler → __agClearAll.)

      // 5. Rewire Send button: call our custom send handler on window
      //    instead of the built-in sendToWebhook() which requires a webhook URL.
      //    Our handler in content.tsx creates Linear issues per annotation.
      //    Matches 2 call sites: button onClick and "S" keyboard handler.
      transformed = transformed.replaceAll(
        "sendToWebhook()",
        "(window.__ligmaSendHandler ? window.__ligmaSendHandler() : void 0)"
      );

      // 6. Simplify Send button disabled condition — remove webhook URL check
      transformed = transformed.replace(
        `disabled: !hasAnnotations || !isValidUrl(settings.webhookUrl) && !isValidUrl(webhookUrl || "") || sendState === "sending"`,
        `disabled: !hasAnnotations`
      );

      // 7. Remove webhook URL guard from "S" keyboard shortcut handler
      transformed = transformed.replace(
        /const hasValidWebhook[^;]+;\s*if \(annotations\.length > 0 && hasValidWebhook && sendState === "idle"\)/,
        "if (annotations.length > 0)"
      );

      // 8. Toolbar always expanded: start with isActive = true
      transformed = transformed.replace(
        "isActive, setIsActive] = useState2(false)",
        "isActive, setIsActive] = useState2(true)"
      );

      // 9. Prevent toolbar collapse: neutralize setIsActive(false) calls
      //    (Escape key handler + close button onClick)
      transformed = transformed.replaceAll(
        "setIsActive(false)",
        "void 0"
      );

      // 10. Expose setIsActive on window so the extension icon toggle handler
      //     can properly activate/deactivate Agentation (unmounting the overlay
      //     and removing document-level event listeners).
      transformed = transformed.replace(
        "isActive, setIsActive] = useState2(true)",
        "isActive, setIsActive] = useState2(true); window.__agSetIsActive = setIsActive"
      );

      // 11. Rename brand: keep slash (purple), add space, replace "agentation" with "Ligma"
      transformed = transformed.replace(
        `"agentation"`,
        `" Ligma"`
      );

      // 12. Replace version string with Chrome extension version from manifest.json
      transformed = transformed.replace(
        `"v",
                                    "2.2.1"`,
        `"v",
                                    "${EXT_VERSION}"`
      );

      // 13. Expose setSendState on window so the custom send handler in
      //     content.tsx can control the send button's visual state
      //     (idle → sending → sent/failed → idle).
      transformed = transformed.replace(
        `sendState, setSendState] = useState2("idle")`,
        `sendState, setSendState] = useState2("idle"); window.__agSetSendState = setSendState`
      );

      // 13b. Expose clearAll and annotations on window so the extension can
      //     auto-clear after sending and read live annotation data for copy/send.
      //     Insert assignments right before hasAnnotations (which is after clearAll is defined).
      transformed = transformed.replace(
        `const hasAnnotations = annotations.length > 0`,
        `window.__agClearAll = clearAll;\n  window.__agAnnotations = annotations;\n  const hasAnnotations = annotations.length > 0`
      );

      // 14. Change tooltip: "Copy feedback" → "Copy"
      transformed = transformed.replace(
        `"Copy feedback"`,
        `"Copy"`
      );

      // 15. Change tooltip: "Send Annotations" → "Send"
      transformed = transformed.replace(
        `"Send Annotations"`,
        `"Send"`
      );

      // 16. Remove keyboard shortcut indicator from Copy tooltip ("C")
      transformed = transformed.replace(
        /jsx3\("span",\s*\{\s*className:\s*styles_module_default2\.shortcut,\s*children:\s*"C"\s*\}\)/,
        `null`
      );

      // 17. Remove keyboard shortcut indicator from Clear All tooltip ("X")
      transformed = transformed.replace(
        /jsx3\("span",\s*\{\s*className:\s*styles_module_default2\.shortcut,\s*children:\s*"X"\s*\}\)/,
        `null`
      );

      // 18. Remove keyboard shortcut indicator from Send tooltip ("S")
      transformed = transformed.replace(
        /jsx3\("span",\s*\{\s*className:\s*styles_module_default2\.shortcut,\s*children:\s*"S"\s*\}\)/,
        `null`
      );

      // 19. Remove "C" keyboard shortcut handler (copy)
      transformed = transformed.replace(
        /if \(e\.key === "c" \|\| e\.key === "C"\) \{\s*if \(annotations\.length > 0\) \{\s*e\.preventDefault\(\);\s*hideTooltipsUntilMouseLeave\(\);\s*copyOutput\(\);\s*\}\s*\}/,
        `/* C shortcut removed */`
      );

      // 20. Remove "X" keyboard shortcut handler (clear all)
      transformed = transformed.replace(
        /if \(e\.key === "x" \|\| e\.key === "X"\) \{\s*if \(annotations\.length > 0\) \{\s*e\.preventDefault\(\);\s*hideTooltipsUntilMouseLeave\(\);\s*clearAll\(\);\s*\}\s*\}/,
        `/* X shortcut removed */`
      );

      if (transformed !== code) {
        return { code: transformed, map: null };
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), agentationPatchPlugin()],
  build: {
    lib: {
      entry: resolve(__dirname, "src/content.tsx"),
      name: "AgentationExtension",
      formats: ["iife"],
      fileName: () => "content.js",
    },
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    minify: false,
    sourcemap: false,
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});
