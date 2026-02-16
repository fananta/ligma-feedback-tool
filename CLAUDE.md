# Ligma Extension — Development Context

## What This Is

Chrome extension (Manifest V3) that wraps the [agentation](https://www.npmjs.com/package/agentation) open-source feedback toolbar library. Users annotate page elements with comments, capture cropped screenshots per annotation, and either copy to clipboard (rich HTML with inline images) or send directly to Linear as issues.

## Architecture

```
manifest.json          → Extension manifest (MV3)
background.js          → Service worker (Linear API, screenshot capture/crop, per-tab state)
src/content.tsx        → Content script source (React 18, Shadow DOM, annotation lifecycle)
vite.config.ts         → Build config + agentation library patch plugin
dist/content.js        → Built content script (IIFE bundle, committed to repo)
popup.html / popup.js  → Minimal popup (not actively used)
icons/                 → Extension icons (active + disabled variants, 16/48/128px)
```

### Content Script (`src/content.tsx`)
- Mounts React 18 via `createRoot` inside a Shadow DOM (`#agentation-ext-root`)
- The `Agentation` component (aliased from `PageFeedbackToolbarCSS`) renders inside Shadow DOM with portals to `document.body` for markers/popovers
- Reads live annotation state from `window.__agAnnotations` (exposed by Vite patch) — no parallel data store
- Screenshot store: `screenshotStore` Map keyed by annotation ID, synced to `chrome.storage.local` via background.js
- Callbacks: `onAnnotationAdd` → capture screenshot, `onAnnotationDelete` → delete screenshot, `onAnnotationsClear` → clear all screenshots, `onCopy` → custom clipboard with screenshots
- Send handler (`window.__ligmaSendHandler`): creates Linear issues per annotation via background.js messages
- Settings panel: injected into agentation's settings UI with Linear API key, team/project/label dropdowns
- localStorage override on mount forces `markerClickBehavior: "delete"` and `autoClearAfterCopy: false`

### Vite Patch Plugin (`vite.config.ts`)
The `agentationPatchPlugin()` does string replacements on the agentation library at build time. **This is fragile and version-coupled.** Current patches (numbered 1-20):

1. Redirect `document.head.appendChild` → Shadow DOM root
2. Redirect `document.getElementById` → Shadow DOM querySelector shim
3. Change default marker color to purple (`#AF52DE`)
3b. Default `markerClickBehavior` to `"delete"`
3c. Swap `IconXmark` → `IconTrash` for marker hover
5. Rewire Send button to call `window.__ligmaSendHandler()`
6. Remove webhook URL check from Send button disabled state
7. Remove webhook URL guard from "S" keyboard shortcut
8. Toolbar starts expanded (`isActive = true`)
9. Prevent toolbar collapse (neutralize `setIsActive(false)`)
10. Expose `setIsActive` on window for extension toggle
11. Rename brand "agentation" → "Ligma"
12. Replace version string with manifest version
13. Expose `setSendState` on window
13b. Expose `clearAll` and `annotations` array on window
14-15. Shorten tooltip text
16-18. Remove keyboard shortcut indicators (C, X, S)
19-20. Remove keyboard shortcut handlers (C, X)

### Background Service Worker (`background.js`)
- Per-tab activation state via in-memory `Set` + icon management
- Screenshot pipeline: `captureFullTab` on mousedown → `cropScreenshot` on annotate → OffscreenCanvas crop → cache in `chrome.storage.local` with `sc:` prefix
- Linear API: validate key, fetch teams/projects/labels, create issues with uploaded screenshots
- Auto-reinjects content scripts on extension reload/install
- Deactivates on typed URL navigation (not refreshes/link clicks)

### Window Globals
These are set by Vite patches or content.tsx and used for cross-boundary communication:

| Global | Set By | Purpose |
|--------|--------|---------|
| `__agAnnotations` | Vite patch | Live annotations array (React state) |
| `__agClearAll` | Vite patch | Clear all annotations function |
| `__agSetIsActive` | Vite patch | Toggle toolbar active state |
| `__agSetSendState` | Vite patch | Control send button state |
| `__agShadowRoot` | content.tsx | Shadow DOM root for style injection |
| `__agGetStyleById` | content.tsx | Shadow DOM getElementById shim |
| `__agReactRoot` | content.tsx | React root for cleanup on reinject |
| `__agPreCaptureListener` | content.tsx | Mousedown listener ref for cleanup |
| `__ligmaSendHandler` | content.tsx | Custom send-to-Linear handler |
| `__annotationScreenshots` | content.tsx | Screenshot store Map |

## Build & Release

```bash
npm install          # Install dependencies
npm run build        # Build dist/content.js (Vite IIFE bundle)
npm run dev          # Watch mode
```

The repo commits `dist/content.js` so users can load unpacked without building. After any code change:

1. `npm run build`
2. Test in Chrome (reload extension from `chrome://extensions`)
3. Commit including `dist/content.js`
4. To release: create a zip and attach to a GitHub release:
   ```bash
   # Create zip with correct folder name
   cd /tmp && rm -rf ligma-feedback-tool && mkdir ligma-feedback-tool
   cp -r <project>/{.gitignore,README.md,background.js,manifest.json,package.json,package-lock.json,popup.html,popup.js,tsconfig.json,vite.config.ts,src,icons,dist} /tmp/ligma-feedback-tool/
   cd /tmp && zip -r ligma-feedback-tool.zip ligma-feedback-tool/
   gh release create v<VERSION> /tmp/ligma-feedback-tool.zip --title "Ligma v<VERSION>" --notes "..."
   ```

## Key Dependencies

- `agentation` ^2.2.1 — feedback toolbar UI (heavily patched at build time)
- `react` ^19.2.4 + `react-dom` ^19.2.4
- Vite 6 + TypeScript 5

## Chrome Storage Keys

| Key | Purpose |
|-----|---------|
| `sentinel-linear-api-key` | Linear API key |
| `sentinel-linear-team-id` | Selected team |
| `sentinel-linear-project-id` | Selected project |
| `sentinel-linear-label-id` | Selected label |
| `sc:<annotationId>` | Cropped screenshot data URL |

## localStorage Keys

| Key | Purpose |
|-----|---------|
| `feedback-annotations-<pathname>` | Agentation's persisted annotations |
| `feedback-toolbar-settings` | Agentation settings (markerClickBehavior, colors, etc.) |

## Common Pitfalls

- **Vite patches are fragile**: If `agentation` updates, patches may fail silently (string not found = no replacement). Always verify `dist/content.js` after updating the dependency.
- **localStorage overrides**: The library persists settings to localStorage. Vite patches only change defaults in source — existing localStorage values take precedence. That's why `mount()` forces `markerClickBehavior: "delete"` via localStorage override.
- **Service worker lifecycle**: MV3 service workers go idle after ~30s. Screenshots are persisted to `chrome.storage.local` (not in-memory) to survive restarts.
- **Shadow DOM + portals**: The toolbar renders in Shadow DOM but markers/popovers portal to `document.body`. CSS overrides in content.tsx target both locations.
- **`onAnnotationUpdate` callback doesn't fire**: Known issue. That's why we read directly from `window.__agAnnotations` instead of maintaining a parallel data store.
