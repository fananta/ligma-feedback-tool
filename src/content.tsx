import React from "react";
import { createRoot } from "react-dom/client";
import { Agentation } from "agentation";

// ─── Shadow DOM Style Injection Helper ─────────────────────────────
// Agentation uses document.getElementById to check if styles are already injected.
// Shadow DOM doesn't have getElementById, so we provide a shim that uses querySelector.
(window as any).__agGetStyleById = (id: string): HTMLElement | null => {
  const shadowRoot = (window as any).__agShadowRoot as ShadowRoot | undefined;
  if (shadowRoot) {
    return shadowRoot.querySelector(`#${CSS.escape(id)}`);
  }
  return document.getElementById(id);
};

// ─── Create Shadow DOM Host ────────────────────────────────────────
const HOST_ID = "agentation-ext-root";
const OVERRIDE_STYLE_ID = "agentation-ext-overrides";

// ─── Screenshot Store ──────────────────────────────────────────────
// Per-annotation cropped screenshots, keyed by annotation ID.
// Accessible via window.__annotationScreenshots for future integrations.
const screenshotStore = new Map<string, string>();
(window as any).__annotationScreenshots = screenshotStore;

/**
 * Read the library's live annotations array (exposed via Vite patch on window).
 * This is always in sync — edits, deletes, and adds all update it.
 */
function getAnnotations(): any[] {
  return (window as any).__agAnnotations || [];
}

/**
 * Build custom plain text output for clipboard.
 * Order: Page, Element, Feedback, Location, Viewport, Browser (no divider).
 */
function buildPlainTextOutput(): string {
  const page = window.location.pathname + window.location.search + window.location.hash;
  const viewport = `${window.innerWidth}×${window.innerHeight}`;
  const ua = navigator.userAgent;

  const blocks: string[] = [];

  for (const a of getAnnotations()) {
    let block = "";
    block += `Page: ${page}\n`;
    block += `Element: ${a.element}\n`;
    block += `Location: ${a.fullPath || a.elementPath || ""}\n`;
    block += `Feedback: ${a.comment}\n`;
    block += `Viewport: ${viewport}\n`;
    block += `Browser: ${ua}\n`;

    blocks.push(block);
  }

  return blocks.join("\n---\n\n");
}

/**
 * Build custom HTML output for rich clipboard paste.
 * Order: Page, Element, Feedback, Location, Viewport, Browser (no divider).
 * Includes real <img> tags for screenshots so they render in Linear/Notion/etc.
 */
function buildHtmlOutput(): string {
  const page = window.location.pathname + window.location.search + window.location.hash;
  const viewport = `${window.innerWidth}×${window.innerHeight}`;
  const ua = navigator.userAgent;

  const sections: string[] = [];

  getAnnotations().forEach((a: any, index: number) => {
    let html = "";
    html += `<p><strong>Page:</strong> ${page}</p>\n`;
    html += `<p><strong>Element:</strong> ${a.element}</p>\n`;
    html += `<p><strong>Location:</strong> <span style="font-weight:normal">${(a.fullPath || a.elementPath || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</span></p>\n`;
    html += `<p><strong>Feedback:</strong> ${a.comment}</p>\n`;
    html += `<p><strong>Viewport:</strong> ${viewport}</p>\n`;
    html += `<p><strong>Browser:</strong> ${ua}</p>\n`;

    // Include screenshot inline with this annotation
    const dataUrl = screenshotStore.get(a.id);
    if (dataUrl) {
      html += `<div style="margin:8px 0"><img src="${dataUrl}" alt="Annotation ${index + 1} Screenshot" style="max-width:100%;border:1px solid #ddd;border-radius:4px"></div>\n`;
    }

    sections.push(html);
  });

  let output = sections.join("<hr>\n");

  return output;
}

/**
 * onCopy handler: replaces Agentation's default clipboard content with our
 * custom format. Writes both rich HTML (with inline images) and plain text.
 */
async function handleCopyWithScreenshots(_markdown: string) {
  if (getAnnotations().length === 0) return;

  const plainText = buildPlainTextOutput();
  const html = buildHtmlOutput();

  // Write both HTML and plain text to clipboard using the rich clipboard API
  try {
    const htmlBlob = new Blob([html], { type: "text/html" });
    const textBlob = new Blob([plainText], { type: "text/plain" });
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": htmlBlob,
        "text/plain": textBlob,
      }),
    ]);
  } catch (e) {
    // Fallback to plain text if ClipboardItem isn't supported
    try {
      await navigator.clipboard.writeText(plainText);
    } catch (e2) {
      // Clipboard write failed — non-critical
    }
  }
}

// ─── Extension Context Guard ────────────────────────────────────────
// After the extension is reloaded/updated, the old content script's
// chrome.runtime becomes stale. Any sendMessage call will throw
// "Extension context invalidated". This guard prevents those errors.
function isExtensionContextValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

// ─── Pre-capture Screenshot Buffer ──────────────────────────────────
// We capture a full-tab screenshot on mousedown (before Agentation's click
// handler fires and renders the annotation popover). When onAnnotationAdd
// fires, we crop from this buffered screenshot instead of taking a new one.
let pendingFullScreenshot: string | null = null;
let pendingScrollY: number = 0;

/**
 * Capture-phase mousedown listener: fires before Agentation's click handler.
 * Takes a full-tab screenshot while the page is still clean (no popover).
 * Self-removes if the extension context becomes stale (after reload/update).
 */
function setupPreCaptureListener() {
  // Remove any previous listener from an older content script injection
  if ((window as any).__agPreCaptureListener) {
    document.removeEventListener(
      "mousedown",
      (window as any).__agPreCaptureListener,
      true
    );
  }

  const listener = () => {
    // Entire listener body wrapped in try/catch to prevent ANY
    // "Extension context invalidated" errors from surfacing.
    try {
      if (!chrome.runtime?.id) {
        document.removeEventListener("mousedown", listener, true);
        return;
      }

      // Only capture if the extension is mounted and visible
      const host = document.getElementById(HOST_ID);
      if (!host || host.style.display === "none") return;

      // Remember scroll position at capture time for Y-coordinate correction
      pendingScrollY = window.scrollY;

      // Fire-and-forget: capture full tab screenshot into buffer
      chrome.runtime
        .sendMessage({ type: "captureFullTab" })
        .then((response: any) => {
          if (response?.success && response.dataUrl) {
            pendingFullScreenshot = response.dataUrl;
          }
        })
        .catch(() => {});
    } catch {
      // Extension context is dead — self-detach silently
      document.removeEventListener("mousedown", listener, true);
    }
  };

  // Store reference so cleanup / re-injection can remove it
  (window as any).__agPreCaptureListener = listener;

  document.addEventListener("mousedown", listener, true);
}

async function captureAnnotationScreenshot(annotation: any) {
  if (!annotation.boundingBox) return;

  // Use the pre-captured screenshot buffer (taken on mousedown, before popover)
  const fullScreenshot = pendingFullScreenshot;
  const capturedScrollY = pendingScrollY;
  pendingFullScreenshot = null; // Consume the buffer

  if (!fullScreenshot) return; // No buffered screenshot available
  if (!isExtensionContextValid()) return;

  try {
    // Expand bounding box by 50% in each direction for positional context
    const bb = annotation.boundingBox;
    const padX = bb.width * 0.25;  // 25% on each side = 150% total width
    const padY = bb.height * 0.25; // 25% on each side = 150% total height
    const rawY = annotation.isFixed ? bb.y : bb.y - capturedScrollY;

    const response = await chrome.runtime.sendMessage({
      type: "cropScreenshot",
      fullDataUrl: fullScreenshot,
      boundingBox: {
        x: bb.x - padX,
        y: rawY - padY,
        width: bb.width + padX * 2,
        height: bb.height + padY * 2,
      },
      devicePixelRatio: window.devicePixelRatio,
      annotationId: annotation.id,
    });
    if (response?.success && response.dataUrl) {
      screenshotStore.set(annotation.id, response.dataUrl);
    }
  } catch (e) {
    // Screenshot capture failed — non-critical, continue silently
  }
}

function mount() {
  // Prevent double-mount — check both our host AND any existing Agentation portals
  if (document.getElementById(HOST_ID)) return;
  if (document.querySelector("[data-feedback-toolbar]")) return;

  // ─── Settings Storage Keys & Helpers ─────────────────────────────────
  // Defined early so all code in mount() can access them.
  const LINEAR_KEY_STORAGE = "sentinel-linear-api-key";
  const LINEAR_TEAM_STORAGE = "sentinel-linear-team-id";
  const LINEAR_PROJECT_STORAGE = "sentinel-linear-project-id";
  const LINEAR_LABEL_STORAGE = "sentinel-linear-label-id";

  /** Read a setting from chrome.storage.local. */
  async function getSetting(key: string): Promise<string | null> {
    try {
      const result = await chrome.storage.local.get(key);
      return result[key] || null;
    } catch {
      return null;
    }
  }

  /** Write a setting to chrome.storage.local. */
  async function setSetting(key: string, value: string): Promise<void> {
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch {}
  }

  // ─── Force extension-specific settings overrides ─────────────────────
  // autoClearAfterCopy OFF — Send clears via __ligmaSendHandler → __agClearAll.
  // markerClickBehavior "delete" — hover shows delete icon, click deletes.
  try {
    const SETTINGS_KEY = "feedback-toolbar-settings";
    const stored = localStorage.getItem(SETTINGS_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    let changed = false;
    if (parsed.autoClearAfterCopy !== false) {
      parsed.autoClearAfterCopy = false;
      changed = true;
    }
    if (parsed.markerClickBehavior !== "delete") {
      parsed.markerClickBehavior = "delete";
      changed = true;
    }
    if (changed) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed));
    }
  } catch (e) {
    // localStorage may not be available — ignore
  }

  // ─── Default toolbar position: top-right ──────────────────────────
  // Agentation reads "feedback-toolbar-position" from localStorage on mount.
  // If no saved position exists, seed it with top-right coordinates.
  // Once the user drags the toolbar, their position is preserved.
  try {
    const POSITION_KEY = "feedback-toolbar-position";
    const savedPos = localStorage.getItem(POSITION_KEY);
    if (!savedPos) {
      // Place toolbar at top-right: 20px padding from edges, toolbar is 297px wide
      const defaultPos = {
        x: window.innerWidth - 297 - 20,
        y: 20,
      };
      localStorage.setItem(POSITION_KEY, JSON.stringify(defaultPos));
    }
  } catch (e) {
    // localStorage may not be available — ignore
  }

  // Create host container — zero-size, overflow visible so children render freely
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = `
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    width: 0 !important;
    height: 0 !important;
    overflow: visible !important;
    z-index: 2147483647 !important;
    pointer-events: none !important;
  `;
  document.body.appendChild(host);

  // Attach Shadow DOM
  const shadowRoot = host.attachShadow({ mode: "open" });

  // Set global reference so the Vite plugin redirects style injection here
  (window as any).__agShadowRoot = shadowRoot;

  // Ensure rem units resolve correctly inside Shadow DOM.
  // Agentation's CSS uses rem (relative to root font-size).
  // In Shadow DOM, :host is the root — we must set its font-size to match the page.
  const hostStyle = document.createElement("style");
  hostStyle.textContent = `
    :host {
      /* Reset ALL inherited CSS properties so the host page cannot
         bleed into the Shadow DOM. Agentation's CSS assumes clean
         browser defaults (16px base, normal line-height, etc.). */
      all: initial;
      font-size: 16px;
      line-height: normal;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      color: #fff;
      box-sizing: border-box;
    }

    /* Ensure box-sizing propagates to all children */
    *, *::before, *::after {
      box-sizing: border-box;
    }
  `;
  shadowRoot.appendChild(hostStyle);

  // ─── Page-level CSS overrides ────────────────────────────────────
  // Agentation renders the toolbar via createPortal to document.body,
  // so these overrides must go into document.head (not the shadow root).
  if (!document.getElementById(OVERRIDE_STYLE_ID)) {
    const overrideStyle = document.createElement("style");
    overrideStyle.id = OVERRIDE_STYLE_ID;
    overrideStyle.textContent = `
      /* ── GLOBAL DEACTIVATION ──
         When body has .sentinel-deactivated, hide ALL Agentation portal elements.
         These are rendered via React createPortal to document.body, outside
         our Shadow DOM. We use display:none to completely remove them from
         layout and prevent any interaction. This is React-safe — we never
         remove the DOM nodes, just hide them with CSS. React can still find
         and reconcile them. */
      body.sentinel-deactivated [data-feedback-toolbar],
      body.sentinel-deactivated [data-annotation-popup],
      body.sentinel-deactivated [data-annotation-marker],
      body.sentinel-deactivated .styles-module__toolbarContainer___dIhma,
      body.sentinel-deactivated .styles-module__settingsPanel___OxX3Y,
      body.sentinel-deactivated .styles-module__hoverHighlight___ogakW,
      body.sentinel-deactivated .styles-module__singleSelectOutline___QhX-O,
      body.sentinel-deactivated .styles-module__multiSelectOutline___cSJ-m,
      body.sentinel-deactivated .styles-module__hoverTooltip___bvLk7 {
        display: none !important;
      }

      /* ── Hide Pause (1st) and Hide-markers (2nd) toolbar buttons ──
         The controlsContent div contains buttonWrapper children in fixed order:
         [Pause(1), Eye(2), Copy(3), Send(4), Trash(5), Settings(6), Divider, Close(last)]
         We hide the first two with display:none so they take no space. */
      .styles-module__controlsContent___9GJWU > .styles-module__buttonWrapper___rBcdv:nth-child(1),
      .styles-module__controlsContent___9GJWU > .styles-module__buttonWrapper___rBcdv:nth-child(2) {
        display: none !important;
      }

      /* ── Enable flexbox ordering on controlsContent ── */
      .styles-module__controlsContent___9GJWU {
        display: flex !important;
      }

      /* ── Reorder visible buttons: Settings(6th) → Trash(5th) → Copy(3rd) | Divider | Send ──
         DOM order of visible children: Copy(3), Send(4), Trash(5), Settings(6), Divider, Close
         Desired visual order: Settings, Trash, Copy, Divider, Send */

      /* Settings button — 6th child → first visually */
      .styles-module__controlsContent___9GJWU > .styles-module__buttonWrapper___rBcdv:nth-child(6) {
        order: 1 !important;
      }
      /* Trash button — 5th child → second visually */
      .styles-module__controlsContent___9GJWU > .styles-module__buttonWrapper___rBcdv:nth-child(5) {
        order: 2 !important;
      }
      /* Copy button — 3rd child → third visually */
      .styles-module__controlsContent___9GJWU > .styles-module__buttonWrapper___rBcdv:nth-child(3) {
        order: 3 !important;
      }

      /* ── Divider stays before the send button ── */
      .styles-module__divider___c--s1 {
        order: 98 !important;
      }

      /* ── Force Send button visible + move after divider ──
         The send button wrapper defaults to width:0/opacity:0.
         We force it visible and use CSS order to position it after the divider. */
      .styles-module__sendButtonWrapper___UUxG6 {
        width: 34px !important;
        opacity: 1 !important;
        overflow: visible !important;
        pointer-events: auto !important;
        margin-left: 0 !important;
        order: 99 !important;
      }
      .styles-module__sendButtonWrapper___UUxG6 .styles-module__controlButton___8Q0jc {
        transform: scale(1) !important;
      }

      /* ── Hide close (X) button — last buttonWrapper in controlsContent ── */
      .styles-module__controlsContent___9GJWU > .styles-module__buttonWrapper___rBcdv:last-child {
        display: none !important;
      }

      /* ── Adjust toolbar expanded width ──
         Buttons: Settings(34) + Trash(34) + Copy(34) + Divider(5) + Send(34) = 141px
         Padding: 15px cushion each side = 30px. Total content+cushion = 183px (after rounding). */
      .styles-module__toolbarContainer___dIhma.styles-module__expanded___ofKPx {
        width: 183px !important;
      }
      .styles-module__toolbarContainer___dIhma.styles-module__expanded___ofKPx.styles-module__serverConnected___Gfbou {
        width: 183px !important;
      }

      /* ── Force toolbar always expanded (prevent collapsed state) ── */
      .styles-module__toolbarContainer___dIhma.styles-module__collapsed___Rydsn {
        width: 183px !important;
        opacity: 1 !important;
        pointer-events: auto !important;
      }

      /* ── Settings panel: hide all sections except header, hide theme toggle ── */

      /* Hide the theme toggle (light/dark mode) in settings header */
      .styles-module__themeToggle___2rUjA {
        display: none !important;
      }

      /* Hide ALL settings sections (Output Detail, React Components, Marker Colour,
         toggles, and MCP & Webhooks nav link) */
      .styles-module__settingsSection___m-YM2 {
        display: none !important;
      }

      /* Hide the automations page entirely */
      .styles-module__automationsPage___uvCq6 {
        display: none !important;
      }

      /* ── Custom Linear section injected via JS (see mount()) ── */
      .sentinel-linear-section {
        padding: 0.5rem 0.75rem 0.75rem;
      }
      .sentinel-linear-header {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        margin-bottom: 0.5rem;
      }
      .sentinel-linear-header label {
        font-size: 0.625rem;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.55);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        line-height: 1;
        margin: 0;
        padding: 0;
      }
      .sentinel-status-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.2);
        transition: background 0.3s ease;
        flex-shrink: 0;
        margin-top: 1px;
      }
      .sentinel-status-dot.valid {
        background: #34c759;
      }
      .sentinel-status-dot.invalid {
        background: #ff3b30;
      }
      .sentinel-status-dot.warning {
        background: #ffcc00;
      }
      .sentinel-linear-section input,
      .sentinel-linear-section select {
        width: 100%;
        padding: 0.375rem 0.5rem;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 0.375rem;
        color: #fff;
        font-size: 0.75rem;
        font-family: inherit;
        outline: none;
        transition: border-color 0.15s ease, opacity 0.15s ease;
      }
      .sentinel-linear-section input:focus,
      .sentinel-linear-section select:focus {
        border-color: rgba(175, 82, 222, 0.6);
      }
      .sentinel-linear-section input::placeholder {
        color: rgba(255, 255, 255, 0.3);
      }
      .sentinel-linear-section select {
        -webkit-appearance: none;
        appearance: none;
        cursor: pointer;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none'%3E%3Cpath d='M1 1l4 4 4-4' stroke='rgba(255,255,255,0.4)' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 0.5rem center;
        padding-right: 1.5rem;
      }
      .sentinel-linear-section select.sentinel-placeholder {
        color: rgba(255, 255, 255, 0.3);
      }
      .sentinel-linear-section select:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
      .sentinel-linear-section select option {
        background: #2a2a2a;
        color: #fff;
      }
      .sentinel-field-group {
        margin-top: 0.75rem;
      }
      .sentinel-field-label {
        font-size: 0.625rem;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.55);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        line-height: 1;
        margin-bottom: 0.5rem;
      }

      /* ── Disable Send button when Linear is not fully configured ──
         When body has .sentinel-send-disabled, the send button is dimmed and
         non-interactive but the badge count remains visible. */
      body.sentinel-send-disabled .styles-module__sendButtonWrapper___UUxG6 .styles-module__controlButton___8Q0jc {
        opacity: 0.3 !important;
        pointer-events: none !important;
        cursor: not-allowed !important;
      }
      /* Keep the badge fully visible and interactive-looking */
      body.sentinel-send-disabled .styles-module__sendButtonWrapper___UUxG6 .styles-module__buttonBadge___NeFWb {
        opacity: 1 !important;
      }

      /* ── Annotation popup: enlarge trash/delete icon ──
         The default 22px icon in a 28px button looks undersized in context.
         Scale up the button and icon to be more proportional with the popover. */
      .styles-module__deleteButton___4VuAE {
        width: 34px !important;
        height: 34px !important;
      }
      .styles-module__deleteButton___4VuAE svg {
        width: 26px !important;
        height: 26px !important;
      }

      /* ── Purple hover highlight + selection outline ──
         Default is blue rgba(60, 130, 247, ...). Override to purple (#AF52DE). */
      .styles-module__hoverHighlight___ogakW {
        border-color: rgba(175, 82, 222, 0.5) !important;
        background: rgba(175, 82, 222, 0.04) !important;
      }
      .styles-module__singleSelectOutline___QhX-O {
        border-color: rgba(175, 82, 222, 0.6) !important;
        background: rgba(175, 82, 222, 0.05) !important;
      }
      .styles-module__multiSelectOutline___cSJ-m {
        border-color: rgba(175, 82, 222, 0.6) !important;
        background: rgba(175, 82, 222, 0.05) !important;
      }
      .styles-module__hoverTooltip___bvLk7 {
        background: rgba(175, 82, 222, 0.9) !important;
      }
    `;
    document.head.appendChild(overrideStyle);
  }

  // ─── Send Button Gating ──────────────────────────────────────────────
  // The send button is disabled (dimmed, non-clickable) unless Linear is
  // fully configured: valid API key + team selected + project selected.
  // We track this via a CSS class on document.body so it works regardless
  // of whether the settings panel is open.
  const SEND_DISABLED_CLASS = "sentinel-send-disabled";

  // Track whether the Linear API key has been validated this session.
  // This is set to true only after a successful API validation call,
  // not just by having a key in localStorage.
  let linearKeyValidated = false;

  /** Update the send button disabled state based on Linear readiness.
   *  Requires: validated API key + team + label + project selected. */
  async function updateSendButtonGate() {
    try {
      const teamId = await getSetting(LINEAR_TEAM_STORAGE);
      const labelId = await getSetting(LINEAR_LABEL_STORAGE);
      const projectId = await getSetting(LINEAR_PROJECT_STORAGE);
      const isReady = linearKeyValidated && !!teamId && !!labelId && !!projectId;
      document.body.classList.toggle(SEND_DISABLED_CLASS, !isReady);
    } catch {
      document.body.classList.add(SEND_DISABLED_CLASS);
    }
  }

  // Run immediately on mount — starts disabled (key not yet validated)
  updateSendButtonGate();

  // Validate saved API key on mount (even before settings panel opens)
  // so the send button gate is set correctly from the start.
  getSetting(LINEAR_KEY_STORAGE).then((savedKey) => {
    if (savedKey && savedKey.startsWith("lin_api_")) {
      chrome.runtime
        .sendMessage({ type: "validateLinearKey", apiKey: savedKey })
        .then((response: any) => {
          if (response?.valid) {
            linearKeyValidated = true;
            updateSendButtonGate();
          }
        })
        .catch(() => {});
    }
  }).catch(() => {});

  // ─── Send Handler: Create Linear Issues ─────────────────────────────
  // Called by the Vite-patched send button (window.__ligmaSendHandler).
  // Creates one Linear issue per annotation, using settings from localStorage.
  // Description is built in background.js which also holds the cached
  // screenshots — no large base64 data crosses chrome.runtime.sendMessage.

  (window as any).__ligmaSendHandler = async () => {
    const setSendState = (window as any).__agSetSendState as
      | ((state: string) => void)
      | undefined;

    const annotations = getAnnotations();
    if (annotations.length === 0) return;

    // Read Linear settings from chrome.storage.local
    const apiKey = await getSetting(LINEAR_KEY_STORAGE);
    const teamId = await getSetting(LINEAR_TEAM_STORAGE);
    const projectId = await getSetting(LINEAR_PROJECT_STORAGE);
    const labelId = await getSetting(LINEAR_LABEL_STORAGE);

    if (!apiKey || !teamId) {
      setSendState?.("failed");
      setTimeout(() => setSendState?.("idle"), 2500);
      return;
    }

    setSendState?.("sending");

    let allSucceeded = true;
    const createdIssues: { identifier: string; url: string }[] = [];

    // Send each annotation as an issue. background.js builds the full
    // description (including cached screenshot) so only small text fields
    // travel through chrome.runtime.sendMessage.
    for (const annotation of annotations) {
      const feedback = annotation.comment || "No feedback provided";
      const title = `Feedback: ${feedback}`;

      try {
        const result = await chrome.runtime.sendMessage({
          type: "createLinearIssue",
          apiKey,
          teamId,
          projectId: projectId || undefined,
          labelId: labelId || undefined,
          title,
          annotationId: annotation.id,
          fields: {
            pageUrl: window.location.href,
            element: annotation.element || "N/A",
            feedback,
            location: annotation.fullPath || annotation.elementPath || "N/A",
            viewport: `${window.innerWidth}×${window.innerHeight}`,
            browser: navigator.userAgent,
          },
        });

        if (result?.success && result.issue) {
          createdIssues.push({
            identifier: result.issue.identifier,
            url: result.issue.url,
          });
        } else {
          allSucceeded = false;
        }
      } catch {
        allSucceeded = false;
      }
    }

    if (allSucceeded && createdIssues.length > 0) {
      setSendState?.("sent");
      // Auto-clear annotations after successful send
      const clearAll = (window as any).__agClearAll as (() => void) | undefined;
      if (clearAll) {
        setTimeout(() => clearAll(), 500);
      }
      // Also clear our internal stores + background.js screenshot cache
      setTimeout(() => {
        screenshotStore.clear();
        try {
          chrome.runtime.sendMessage({ type: "clearScreenshotCache" }).catch(() => {});
        } catch {}
      }, 500);
    } else {
      setSendState?.("failed");
    }

    setTimeout(() => setSendState?.("idle"), 2500);
  };

  // ─── Linear section injection ───────────────────────────────────────
  // Watch for the settings panel to appear in the DOM, then inject a
  // "Linear" section with API key input, validation status, and
  // Team / Project dropdowns that load dynamically once the key is valid.

  /** Validate a Linear API key via background.js (which has host_permissions). */
  async function validateLinearKey(key: string): Promise<boolean> {
    if (!key || !key.startsWith("lin_api_")) return false;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "validateLinearKey",
        apiKey: key,
      });
      return !!response?.valid;
    } catch {
      return false;
    }
  }

  /** Fetch teams from Linear API via background.js. */
  async function fetchLinearTeams(
    apiKey: string
  ): Promise<{ id: string; name: string; key: string }[]> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "fetchLinearTeams",
        apiKey,
      });
      return response?.success ? response.teams : [];
    } catch {
      return [];
    }
  }

  /** Fetch projects from Linear API via background.js (optionally filtered by team). */
  async function fetchLinearProjects(
    apiKey: string,
    teamId?: string
  ): Promise<{ id: string; name: string }[]> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "fetchLinearProjects",
        apiKey,
        teamId,
      });
      return response?.success ? response.projects : [];
    } catch {
      return [];
    }
  }

  /** Fetch team-level labels from Linear API via background.js. */
  async function fetchLinearLabels(
    apiKey: string,
    teamId: string
  ): Promise<{ id: string; name: string; color: string }[]> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "fetchLinearLabels",
        apiKey,
        teamId,
      });
      return response?.success ? response.labels : [];
    } catch {
      return [];
    }
  }

  let validateTimer: ReturnType<typeof setTimeout> | null = null;

  /** Populate a <select> with options, preserving saved selection. */
  function populateSelect(
    select: HTMLSelectElement,
    items: { id: string; name: string }[],
    placeholder: string,
    savedId: string | null
  ) {
    select.innerHTML = "";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = placeholder;
    defaultOpt.disabled = true;
    select.appendChild(defaultOpt);

    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = item.name;
      select.appendChild(opt);
    }

    // Restore saved selection if it still exists in the list
    if (savedId && items.some((i) => i.id === savedId)) {
      select.value = savedId;
      select.classList.remove("sentinel-placeholder");
    } else {
      select.value = "";
      defaultOpt.selected = true;
      select.classList.add("sentinel-placeholder");
    }
  }

  const settingsObserver = new MutationObserver(() => {
    // The settings panel renders to document.body as a portal
    const panel = document.querySelector(
      ".styles-module__settingsPanel___OxX3Y"
    );
    if (!panel) return;

    // Only inject once — check for our sentinel section
    if (panel.querySelector(".sentinel-linear-section")) return;

    // Find the settings page container (first .settingsPage child)
    const settingsPage = panel.querySelector(
      ".styles-module__settingsPage___6YfHH"
    );
    if (!settingsPage) return;

    // Create Linear section
    const section = document.createElement("div");
    section.className = "sentinel-linear-section";
    section.innerHTML = `
      <div class="sentinel-linear-header">
        <label>Linear</label>
        <span class="sentinel-status-dot"></span>
      </div>
      <input
        type="password"
        placeholder="API Key"
        spellcheck="false"
        autocomplete="off"
      />
      <div class="sentinel-field-group">
        <div class="sentinel-field-label">Team</div>
        <select class="sentinel-team-select sentinel-placeholder" disabled>
          <option value="" disabled selected>Team</option>
        </select>
      </div>
      <div class="sentinel-field-group">
        <div class="sentinel-field-label">Label</div>
        <select class="sentinel-label-select sentinel-placeholder" disabled>
          <option value="" disabled selected>Label</option>
        </select>
      </div>
      <div class="sentinel-field-group">
        <div class="sentinel-field-label">Project</div>
        <select class="sentinel-project-select sentinel-placeholder" disabled>
          <option value="" disabled selected>Project</option>
        </select>
      </div>
    `;

    const input = section.querySelector("input") as HTMLInputElement;
    const dot = section.querySelector(".sentinel-status-dot") as HTMLElement;
    const teamSelect = section.querySelector(
      ".sentinel-team-select"
    ) as HTMLSelectElement;
    const projectSelect = section.querySelector(
      ".sentinel-project-select"
    ) as HTMLSelectElement;
    const labelSelect = section.querySelector(
      ".sentinel-label-select"
    ) as HTMLSelectElement;

    // Track whether the current API key has been validated
    let apiKeyValid = false;

    /** Update status dot based on current state of all fields.
     *  Grey (default) = no API key
     *  Red = API key entered but invalid
     *  Yellow = API key valid but team, label, or project not selected
     *  Green = API key valid AND team AND label AND project selected */
    function updateStatusDot(keyState: "empty" | "invalid" | "valid") {
      dot.classList.remove("valid", "invalid", "warning");
      if (keyState === "empty") {
        // Grey — no class needed
      } else if (keyState === "invalid") {
        dot.classList.add("invalid");
      } else if (keyState === "valid") {
        const teamSelected = !!teamSelect.value;
        const labelSelected = !!labelSelect.value;
        const projectSelected = !!projectSelect.value;
        if (teamSelected && labelSelected && projectSelected) {
          dot.classList.add("valid");
        } else {
          dot.classList.add("warning");
        }
      }
      // Also update send button gate whenever status changes
      updateSendButtonGate();
    }

    /** Load teams, projects, and labels after API key is validated. */
    async function loadTeamsAndProjects(apiKey: string) {
      // Load saved selections
      let savedTeamId: string | null = null;
      let savedProjectId: string | null = null;
      let savedLabelId: string | null = null;
      try {
        savedTeamId = await getSetting(LINEAR_TEAM_STORAGE);
        savedProjectId = await getSetting(LINEAR_PROJECT_STORAGE);
        savedLabelId = await getSetting(LINEAR_LABEL_STORAGE);
      } catch {}

      // Fetch and populate teams (sorted alphabetically)
      const teams = await fetchLinearTeams(apiKey);
      teams.sort((a: any, b: any) => a.name.localeCompare(b.name));
      if (teams.length > 0) {
        populateSelect(teamSelect, teams, "Team", savedTeamId);
        teamSelect.disabled = false;

        // If a team is selected, load its projects and labels
        const activeTeamId = teamSelect.value || savedTeamId;
        if (activeTeamId) {
          const [projects, labels] = await Promise.all([
            fetchLinearProjects(apiKey, activeTeamId),
            fetchLinearLabels(apiKey, activeTeamId),
          ]);
          projects.sort((a: any, b: any) => a.name.localeCompare(b.name));
          populateSelect(
            projectSelect,
            projects,
            "Project",
            savedProjectId
          );
          projectSelect.disabled = false;

          labels.sort((a: any, b: any) => a.name.localeCompare(b.name));
          populateSelect(labelSelect, labels, "Label", savedLabelId);
          labelSelect.disabled = false;
        }
      }

      // Recalculate status dot after dropdowns are populated
      // (saved selections may have been restored)
      if (apiKeyValid) updateStatusDot("valid");
    }

    /** Reset dropdowns to disabled empty state. */
    function resetDropdowns() {
      teamSelect.innerHTML =
        '<option value="" disabled selected>Team</option>';
      teamSelect.disabled = true;
      teamSelect.classList.add("sentinel-placeholder");
      projectSelect.innerHTML =
        '<option value="" disabled selected>Project</option>';
      projectSelect.disabled = true;
      projectSelect.classList.add("sentinel-placeholder");
      labelSelect.innerHTML =
        '<option value="" disabled selected>Label</option>';
      labelSelect.disabled = true;
      labelSelect.classList.add("sentinel-placeholder");
    }

    // Load saved key and validate
    getSetting(LINEAR_KEY_STORAGE).then((savedKey) => {
      if (savedKey) {
        input.value = savedKey;
        validateLinearKey(savedKey).then((valid) => {
          apiKeyValid = valid;
          linearKeyValidated = valid;
          if (valid) {
            updateStatusDot("valid");
            loadTeamsAndProjects(savedKey);
          } else if (savedKey.trim().length > 0) {
            updateStatusDot("invalid");
          } else {
            updateStatusDot("empty");
          }
        });
      }
    }).catch(() => {});

    // Save on input change + debounced validation
    input.addEventListener("input", () => {
      setSetting(LINEAR_KEY_STORAGE, input.value);

      // Reset status and dropdowns while typing
      apiKeyValid = false;
      linearKeyValidated = false;
      updateStatusDot("empty");
      resetDropdowns();

      // If input is empty, keep dot grey (no class) — skip validation
      if (!input.value.trim()) {
        if (validateTimer) clearTimeout(validateTimer);
        return;
      }

      // Debounce validation (500ms after last keystroke)
      if (validateTimer) clearTimeout(validateTimer);
      validateTimer = setTimeout(() => {
        const currentValue = input.value;
        validateLinearKey(currentValue).then((valid) => {
          apiKeyValid = valid;
          linearKeyValidated = valid;
          if (valid) {
            updateStatusDot("valid");
            loadTeamsAndProjects(currentValue);
          } else if (currentValue.trim().length > 0) {
            updateStatusDot("invalid");
          } else {
            updateStatusDot("empty");
          }
        });
      }, 500);
    });

    // Team change → save + reload projects & labels + update status dot
    teamSelect.addEventListener("change", () => {
      teamSelect.classList.toggle("sentinel-placeholder", !teamSelect.value);
      setSetting(LINEAR_TEAM_STORAGE, teamSelect.value);

      // Reset and reload projects and labels for the new team
      projectSelect.innerHTML =
        '<option value="" disabled selected>Project</option>';
      projectSelect.disabled = true;
      projectSelect.classList.add("sentinel-placeholder");
      labelSelect.innerHTML =
        '<option value="" disabled selected>Label</option>';
      labelSelect.disabled = true;
      labelSelect.classList.add("sentinel-placeholder");
      chrome.storage.local.remove([LINEAR_PROJECT_STORAGE, LINEAR_LABEL_STORAGE]).catch(() => {});

      // Recalculate status dot (project is now unselected)
      if (apiKeyValid) updateStatusDot("valid");

      const apiKey = input.value;
      if (apiKey && teamSelect.value) {
        // Fetch projects and labels in parallel
        fetchLinearProjects(apiKey, teamSelect.value).then((projects) => {
          projects.sort((a: any, b: any) => a.name.localeCompare(b.name));
          populateSelect(projectSelect, projects, "Project", null);
          projectSelect.disabled = false;
        });
        fetchLinearLabels(apiKey, teamSelect.value).then((labels) => {
          labels.sort((a: any, b: any) => a.name.localeCompare(b.name));
          populateSelect(labelSelect, labels, "Label", null);
          labelSelect.disabled = false;
        });
      }
    });

    // Project change → save + update status dot
    projectSelect.addEventListener("change", () => {
      projectSelect.classList.toggle("sentinel-placeholder", !projectSelect.value);
      setSetting(LINEAR_PROJECT_STORAGE, projectSelect.value);
      if (apiKeyValid) updateStatusDot("valid");
    });

    // Label change → save + update status dot
    labelSelect.addEventListener("change", () => {
      labelSelect.classList.toggle("sentinel-placeholder", !labelSelect.value);
      setSetting(LINEAR_LABEL_STORAGE, labelSelect.value);
      if (apiKeyValid) updateStatusDot("valid");
    });

    // Prevent clicks inside from bubbling up and closing the panel
    section.addEventListener("click", (e) => e.stopPropagation());

    // Append after the header
    settingsPage.appendChild(section);
  });

  settingsObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // ─── Pre-capture listener ─────────────────────────────────────────
  // Captures a clean screenshot on mousedown, before Agentation renders
  // the annotation popover. Must be set up before React mounts Agentation.
  setupPreCaptureListener();

  // Create a minimal wrapper for React — no size/position constraints.
  // Agentation uses position:fixed on all its elements, so it doesn't need
  // a sized parent. A bare div is sufficient.
  const wrapper = document.createElement("div");
  shadowRoot.appendChild(wrapper);

  // Mount React — expose root on window so reinjectAllTabs() can call
  // root.unmount() for clean portal teardown (prevents removeChild errors).
  const root = createRoot(wrapper);
  (window as any).__agReactRoot = root;
  root.render(
    <React.StrictMode>
      <Agentation
        onAnnotationAdd={(annotation: any) => {
          captureAnnotationScreenshot(annotation);
        }}
        onAnnotationDelete={(annotation: any) => {
          screenshotStore.delete(annotation.id);
        }}
        onAnnotationsClear={() => {
          screenshotStore.clear();
        }}
        onCopy={(markdown: string) => {
          handleCopyWithScreenshots(markdown);
        }}
      />
    </React.StrictMode>
  );
}

// ─── Deactivate: fully tear down Agentation UI ─────────────────────
// Called when the extension is turned off globally. Tells Agentation to
// unmount its overlay + remove all document-level event listeners, then
// hides the Shadow DOM host AND all portal elements. The page behaves
// exactly as if the extension doesn't exist.
//
// IMPORTANT: We hide portals via CSS (visibility + pointer-events) rather
// than removing DOM nodes. React Portal elements are managed by React's
// reconciliation — manually removing them causes "removeChild" errors.
// CSS-based hiding is React-safe: React can still find and manage its nodes.
const DEACTIVATED_CLASS = "sentinel-deactivated";

function deactivate() {
  const setIsActive = (window as any).__agSetIsActive as
    | ((v: boolean) => void)
    | undefined;

  // Tell Agentation to deactivate — this unmounts the overlay and portals
  // via React reconciliation (isActive && ...), so React handles its own
  // DOM cleanup. We must NOT manually remove portal elements, as that
  // would cause "removeChild" errors when React tries to clean them up.
  if (setIsActive) {
    setIsActive(false);
  }

  // Hide the Shadow DOM host
  const host = document.getElementById(HOST_ID);
  if (host) {
    host.style.display = "none";
  }

  // Add class to body that hides ALL Agentation portal elements via CSS.
  // This catches the toolbar, annotation popups, markers, hover highlights,
  // settings panel — everything rendered via createPortal to document.body.
  document.body.classList.add(DEACTIVATED_CLASS);
}

// ─── Activate: mount if needed, then enable Agentation ──────────────
function activate() {
  // Remove the CSS hiding class so portals become visible again
  document.body.classList.remove(DEACTIVATED_CLASS);

  const host = document.getElementById(HOST_ID);

  if (host) {
    // Already mounted — show the host, then let React re-render portals
    host.style.display = "";

    const setIsActive = (window as any).__agSetIsActive as
      | ((v: boolean) => void)
      | undefined;
    if (setIsActive) {
      setIsActive(true);
    }
  } else {
    // First activation — mount everything
    mount();
  }
}

// ─── Initialize ────────────────────────────────────────────────────
// Check global enabled state before mounting. If the extension is
// disabled, the content script stays dormant (just the message listener).
function init() {
  try {
    chrome.runtime.sendMessage({ type: "getEnabled" }, (response) => {
      if (chrome.runtime.lastError) {
        // Extension context may be invalid — do nothing
        return;
      }
      if (response?.enabled) {
        mount();
      }
    });
  } catch {
    // Extension context invalid — do nothing
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// ─── Message Listener (for global activate/deactivate) ──────────────
chrome.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "deactivate") {
    deactivate();
    sendResponse({ active: false });
  } else if (msg.type === "activate") {
    activate();
    sendResponse({ active: true });
  }
  return true;
});
