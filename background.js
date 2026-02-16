



// ─── Screenshot Cache ────────────────────────────────────────────────
// Cropped screenshots keyed by annotation ID, persisted in chrome.storage.local
// so they survive MV3 service worker restarts (workers go idle after ~30s).
// Keys are prefixed with "sc:" to avoid collisions.
const SC_PREFIX = "sc:";

async function screenshotCacheSet(annotationId, dataUrl) {
  await chrome.storage.local.set({ [SC_PREFIX + annotationId]: dataUrl });
}

async function screenshotCacheGet(annotationId) {
  const result = await chrome.storage.local.get(SC_PREFIX + annotationId);
  return result[SC_PREFIX + annotationId] || null;
}

async function screenshotCacheDelete(annotationId) {
  await chrome.storage.local.remove(SC_PREFIX + annotationId);
}

async function screenshotCacheClear() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(SC_PREFIX));
  if (keys.length > 0) await chrome.storage.local.remove(keys);
}

// ─── Per-Tab Active State ────────────────────────────────────────────
// The extension is inactive by default in every tab. Clicking the extension
// icon toggles it for THAT tab only. State is tracked in a Set of tab IDs
// (in-memory) and also as tab-specific icon/title via chrome.action APIs.
const activeTabs = new Set();

// ─── Icon Management ─────────────────────────────────────────────────
// Per-tab icon: active icon for tabs where extension is on, disabled for others.

async function updateIconForTab(tabId, enabled) {
  try {
    if (enabled) {
      await chrome.action.setIcon({
        tabId,
        path: {
          16: "icons/icon16.png",
          48: "icons/icon48.png",
          128: "icons/icon128.png",
        },
      });
      await chrome.action.setTitle({ tabId, title: "Ligma — Click to disable" });
    } else {
      await chrome.action.setIcon({
        tabId,
        path: {
          16: "icons/icon16-disabled.png",
          48: "icons/icon48-disabled.png",
          128: "icons/icon128-disabled.png",
        },
      });
      await chrome.action.setTitle({ tabId, title: "Ligma — Click to enable" });
    }
  } catch {
    // Tab may have been closed
  }
}

// ─── URL Helpers ─────────────────────────────────────────────────────

function isRestrictedUrl(url) {
  return (
    !url ||
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("devtools://")
  );
}

// ─── Per-Tab Activate / Deactivate ──────────────────────────────────

async function activateTab(tabId) {
  activeTabs.add(tabId);
  await updateIconForTab(tabId, true);
  try {
    await chrome.tabs.sendMessage(tabId, { type: "activate" });
  } catch {
    // Content script not injected yet — inject it now
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["dist/content.js"],
      });
    } catch {
      // Can't inject — tab is not scriptable
    }
  }
}

async function deactivateTab(tabId) {
  activeTabs.delete(tabId);
  await updateIconForTab(tabId, false);
  try {
    await chrome.tabs.sendMessage(tabId, { type: "deactivate" });
  } catch {
    // Content script not injected — nothing to deactivate
  }
}

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  activeTabs.delete(tabId);
});

// Re-apply active icon after navigation (Chrome resets per-tab icon on navigate)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" && activeTabs.has(tabId)) {
    updateIconForTab(tabId, true);
  }
});

// Deactivate when the user types a new URL in the address bar.
// Refresh, link clicks, and other navigation types keep the extension active.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return; // main frame only
  if (details.transitionType === "typed" && activeTabs.has(details.tabId)) {
    deactivateTab(details.tabId);
  }
});

// ─── Auto-reload content scripts on extension update / dev reload ────
// When the service worker starts (which happens on install, update, AND
// dev reload from chrome://extensions), re-inject the content script
// into all existing tabs so the user doesn't have to manually refresh.

async function reinjectAllTabs() {
  // On extension reload/install, reinject content scripts into all tabs.
  // All tabs start inactive (default). The in-memory activeTabs set is
  // empty after a service worker restart, which is correct.
  activeTabs.clear();

  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || isRestrictedUrl(tab.url)) continue;
      try {
        // Clean up for re-injection by properly unmounting React FIRST.
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            if (window.__agReactRoot) {
              try { window.__agReactRoot.unmount(); } catch {}
              delete window.__agReactRoot;
            }
            const old = document.getElementById("agentation-ext-root");
            if (old) old.remove();
            document.querySelectorAll("[data-feedback-toolbar]").forEach((el) => el.remove());
            document.querySelectorAll("[data-annotation-popup]").forEach((el) => el.remove());
            document.querySelectorAll("[data-annotation-marker]").forEach((el) => el.remove());
            document.querySelectorAll("[class*='styles-module__toolbarContainer']").forEach((el) => el.remove());
            document.querySelectorAll("[class*='styles-module__settingsPanel']").forEach((el) => el.remove());
            document.querySelectorAll("[class*='styles-module__hoverHighlight']").forEach((el) => el.remove());
            if (window.__agPreCaptureListener) {
              document.removeEventListener("mousedown", window.__agPreCaptureListener, true);
              delete window.__agPreCaptureListener;
            }
            delete window.__agShadowRoot;
            delete window.__agGetStyleById;
            delete window.__annotationScreenshots;
            delete window.__agSetIsActive;
            const overrideStyle = document.getElementById("agentation-ext-overrides");
            if (overrideStyle) overrideStyle.remove();
            document.body.classList.remove("sentinel-deactivated");
            document.body.classList.remove("sentinel-send-disabled");
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        // Re-inject content script (stays dormant until user activates)
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["dist/content.js"],
        });
        // Ensure disabled icon for this tab
        await updateIconForTab(tab.id, false);
      } catch (e) {
        // Ignore tabs we can't inject into
      }
    }
  } catch (e) {
    // Query failed
  }
}

// Fire on install/update (covers Chrome Web Store updates and first install)
chrome.runtime.onInstalled.addListener(() => {
  reinjectAllTabs();
});

// Also fire immediately when the service worker starts.
// During dev, clicking "reload" in chrome://extensions restarts the
// service worker, which triggers this top-level code.
reinjectAllTabs();

// Set the global default icon to disabled so new tabs show inactive state.
chrome.action.setIcon({
  path: {
    16: "icons/icon16-disabled.png",
    48: "icons/icon48-disabled.png",
    128: "icons/icon128-disabled.png",
  },
});
chrome.action.setTitle({ title: "Ligma — Click to enable" });

// ─── Extension Icon Click → Per-Tab Toggle ───────────────────────────
// Clicking the extension icon toggles it for the current tab only.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || isRestrictedUrl(tab.url)) return;

  if (activeTabs.has(tab.id)) {
    await deactivateTab(tab.id);
  } else {
    await activateTab(tab.id);
  }
});

// ─── Screenshot Capture (Split: capture on mousedown, crop on annotate) ──
//
// Step 1: "captureFullTab" — fires on mousedown (before popover renders).
//         Returns the full-tab PNG data URL for the content script to buffer.
//
// Step 2: "cropScreenshot" — fires in onAnnotationAdd with the buffered
//         screenshot + bounding box. Crops and returns the annotation image.

async function handleCaptureFullTab(sender) {
  const tab = sender.tab;
  if (!tab?.id) return { success: false, error: "No tab" };

  const fullDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });

  return { success: true, dataUrl: fullDataUrl };
}

async function handleCropScreenshot(msg) {
  const { fullDataUrl, boundingBox, devicePixelRatio, annotationId } = msg;
  const dpr = devicePixelRatio || 1;

  // Decode the full screenshot into an ImageBitmap
  const response = await fetch(fullDataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  // Compute crop rectangle in device pixels
  const sx = Math.round(boundingBox.x * dpr);
  const sy = Math.round(boundingBox.y * dpr);
  const sw = Math.round(boundingBox.width * dpr);
  const sh = Math.round(boundingBox.height * dpr);

  // Clamp to image bounds
  const clampedSx = Math.max(0, Math.min(sx, bitmap.width - 1));
  const clampedSy = Math.max(0, Math.min(sy, bitmap.height - 1));
  const clampedSw = Math.min(sw, bitmap.width - clampedSx);
  const clampedSh = Math.min(sh, bitmap.height - clampedSy);

  if (clampedSw <= 0 || clampedSh <= 0) {
    bitmap.close();
    return { success: false, error: "Bounding box out of viewport" };
  }

  // Crop using OffscreenCanvas
  const canvas = new OffscreenCanvas(clampedSw, clampedSh);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return { success: false, error: "Failed to create canvas context" };
  }
  ctx.drawImage(
    bitmap,
    clampedSx, clampedSy, clampedSw, clampedSh,
    0, 0, clampedSw, clampedSh
  );
  bitmap.close();

  // Convert to PNG data URL
  const croppedBlob = await canvas.convertToBlob({ type: "image/png" });
  const arrayBuffer = await croppedBlob.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < uint8.length; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  const base64 = btoa(binary);
  const dataUrl = `data:image/png;base64,${base64}`;

  // Cache the cropped screenshot so it can be embedded in Linear issues
  // without re-sending the large data URL through chrome.runtime.sendMessage.
  // Persisted in chrome.storage.local to survive service worker restarts.
  if (annotationId) {
    screenshotCacheSet(annotationId, dataUrl).catch(() => {});
  }

  return { success: true, dataUrl };
}

// ─── Linear API Key Validation ──────────────────────────────────────
// Validates a Linear API key by calling the viewer query from the
// service worker (which has host_permissions for cross-origin fetch).
async function handleValidateLinearKey(msg) {
  const { apiKey } = msg;
  if (!apiKey || !apiKey.startsWith("lin_api_")) {
    return { valid: false };
  }
  try {
    const resp = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({ query: "{ viewer { id } }" }),
    });
    if (!resp.ok) return { valid: false };
    const json = await resp.json();
    return { valid: !!json?.data?.viewer?.id };
  } catch {
    return { valid: false };
  }
}

// ─── Linear Teams & Projects ────────────────────────────────────────
// Fetches team list and project list from Linear API for settings dropdowns.

async function handleFetchLinearTeams(msg) {
  const { apiKey } = msg;
  if (!apiKey) return { success: false, teams: [] };
  try {
    const resp = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({
        query: "{ teams { nodes { id name key } } }",
      }),
    });
    if (!resp.ok) return { success: false, teams: [] };
    const json = await resp.json();
    const teams = json?.data?.teams?.nodes || [];
    return { success: true, teams };
  } catch {
    return { success: false, teams: [] };
  }
}

async function handleFetchLinearProjects(msg) {
  const { apiKey, teamId } = msg;
  if (!apiKey) return { success: false, projects: [] };
  try {
    // Fetch projects with state, optionally filtered by team.
    // We include state so the content script can filter out Completed/Canceled.
    const query = teamId
      ? `{ team(id: "${teamId}") { projects { nodes { id name state } } } }`
      : "{ projects { nodes { id name state } } }";
    const resp = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({ query }),
    });
    if (!resp.ok) return { success: false, projects: [] };
    const json = await resp.json();
    const allProjects = teamId
      ? json?.data?.team?.projects?.nodes || []
      : json?.data?.projects?.nodes || [];
    // Filter out projects with Completed or Canceled status
    // Linear project states are lowercase (planned, started, paused, completed, canceled, backlog)
    const projects = allProjects.filter((p) => {
      const state = (p.state || "").toLowerCase();
      return state !== "completed" && state !== "canceled";
    });
    return { success: true, projects };
  } catch {
    return { success: false, projects: [] };
  }
}

// ─── Linear Labels ──────────────────────────────────────────────────
// Fetches team-level labels from Linear API for the Issue Label dropdown.

async function handleFetchLinearLabels(msg) {
  const { apiKey, teamId } = msg;
  if (!apiKey || !teamId) return { success: false, labels: [] };
  try {
    // Fetch labels scoped to the team
    const query = `{ team(id: "${teamId}") { labels { nodes { id name color } } } }`;
    const resp = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({ query }),
    });
    if (!resp.ok) return { success: false, labels: [] };
    const json = await resp.json();
    const labels = json?.data?.team?.labels?.nodes || [];
    return { success: true, labels };
  } catch {
    return { success: false, labels: [] };
  }
}

// ─── Linear Workflow States ─────────────────────────────────────────
// Fetches workflow states for a team and returns the first state in the
// "backlog" category (sorted by position). Used to default new issues
// to Backlog instead of Triage.

async function handleFetchLinearWorkflowStates(msg) {
  const { apiKey, teamId } = msg;
  if (!apiKey || !teamId) return { success: false, stateId: null };
  try {
    const query = `{ team(id: "${teamId}") { states { nodes { id name type position } } } }`;
    const resp = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({ query }),
    });
    if (!resp.ok) return { success: false, stateId: null };
    const json = await resp.json();
    const states = json?.data?.team?.states?.nodes || [];
    const backlogStates = states
      .filter((s) => s.type === "backlog")
      .sort((a, b) => a.position - b.position);
    const stateId = backlogStates.length > 0 ? backlogStates[0].id : null;
    return { success: true, stateId };
  } catch {
    return { success: false, stateId: null };
  }
}

// ─── Linear Issue Creation ──────────────────────────────────────────
// Creates a single Linear issue via the GraphQL API.
// Called once per annotation from the content script's send handler.
// Builds the full markdown description here (including cached screenshot)
// so large base64 data never crosses chrome.runtime.sendMessage.

function buildIssueDescription(fields, screenshotUrl) {
  let md = "";
  md += `**Page:** ${fields.pageUrl}\n`;
  md += `**Element:** ${fields.element || "N/A"}\n`;
  md += `**Location:** \`${fields.location || "N/A"}\`\n`;
  md += `**Feedback:** ${fields.feedback}\n`;

  md += `\n---\n\n`;

  md += `**Viewport:** ${fields.viewport}\n`;
  md += `**Browser:** ${fields.browser}\n`;

  if (screenshotUrl) {
    md += `\n![Screenshot](${screenshotUrl})\n`;
  }

  return md;
}

/**
 * Upload a base64 data URL to Linear's file storage entirely within
 * background.js. Returns the hosted assetUrl on success, null on failure.
 */
async function uploadScreenshotToLinear(apiKey, dataUrl) {
  try {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      console.error("[Ligma] uploadScreenshot: invalid data URL format");
      return null;
    }
    const contentType = match[1];
    const base64Data = match[2];

    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const gqlResp = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({
        query: `mutation FileUpload($size: Int!, $filename: String!, $contentType: String!) {
          fileUpload(size: $size, filename: $filename, contentType: $contentType) {
            success
            uploadFile { uploadUrl assetUrl headers { key value } }
          }
        }`,
        variables: {
          size: bytes.length,
          filename: "screenshot.png",
          contentType,
        },
      }),
    });

    if (!gqlResp.ok) {
      console.error(`[Ligma] uploadScreenshot: fileUpload HTTP ${gqlResp.status}`);
      return null;
    }
    const gqlJson = await gqlResp.json();
    const uploadFile = gqlJson?.data?.fileUpload?.uploadFile;
    if (!uploadFile) {
      console.error("[Ligma] uploadScreenshot: no uploadFile in response", JSON.stringify(gqlJson));
      return null;
    }

    // Use only the headers Linear returns — do NOT add Content-Length
    // (fetch sets it automatically; manually setting it causes 400 errors)
    const putHeaders = {};
    for (const h of uploadFile.headers) {
      putHeaders[h.key] = h.value;
    }

    const putResp = await fetch(uploadFile.uploadUrl, {
      method: "PUT",
      headers: putHeaders,
      body: new Blob([bytes], { type: contentType }),
    });

    if (!putResp.ok) {
      const errText = await putResp.text().catch(() => "");
      console.error(`[Ligma] uploadScreenshot: PUT failed HTTP ${putResp.status}`, errText.slice(0, 500));
      return null;
    }

    return uploadFile.assetUrl;
  } catch (err) {
    console.error("[Ligma] uploadScreenshot: exception", err);
    return null;
  }
}

async function handleCreateLinearIssue(msg) {
  const { apiKey, teamId, projectId, labelId, stateId, title, annotationId, fields } = msg;
  if (!apiKey || !teamId) {
    return { success: false, error: "Missing API key or team ID" };
  }
  try {
    // Look up cached screenshot and upload to Linear's file storage
    const cachedDataUrl = annotationId ? await screenshotCacheGet(annotationId) : null;
    let screenshotUrl = null;
    if (cachedDataUrl) {
      screenshotUrl = await uploadScreenshotToLinear(apiKey, cachedDataUrl);
    }
    const description = buildIssueDescription(fields || {}, screenshotUrl);

    // Clean up cache after use
    if (annotationId) screenshotCacheDelete(annotationId).catch(() => {});

    // Build the mutation input
    const input = {
      teamId,
      title,
      description,
    };
    if (projectId) input.projectId = projectId;
    if (labelId) input.labelIds = [labelId];
    if (stateId) input.stateId = stateId;

    const mutation = `
      mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            url
          }
        }
      }
    `;

    const resp = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({
        query: mutation,
        variables: { input },
      }),
    });

    if (!resp.ok) {
      return { success: false, error: `HTTP ${resp.status}` };
    }

    const json = await resp.json();
    const result = json?.data?.issueCreate;

    if (result?.success && result.issue) {
      return {
        success: true,
        issue: {
          id: result.issue.id,
          identifier: result.issue.identifier,
          url: result.issue.url,
        },
      };
    }

    return {
      success: false,
      error: json?.errors?.[0]?.message || "Issue creation failed",
    };
  } catch (err) {
    return { success: false, error: err?.message || "Network error" };
  }
}

// ─── Message Router ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "captureFullTab") {
    handleCaptureFullTab(sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (msg.type === "cropScreenshot") {
    handleCropScreenshot(msg)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (msg.type === "getEnabled") {
    const tabId = sender.tab?.id;
    sendResponse({ enabled: tabId ? activeTabs.has(tabId) : false });
    return true;
  }
  if (msg.type === "validateLinearKey") {
    handleValidateLinearKey(msg)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ valid: false }));
    return true;
  }
  if (msg.type === "fetchLinearTeams") {
    handleFetchLinearTeams(msg)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ success: false, teams: [] }));
    return true;
  }
  if (msg.type === "fetchLinearProjects") {
    handleFetchLinearProjects(msg)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ success: false, projects: [] }));
    return true;
  }
  if (msg.type === "fetchLinearLabels") {
    handleFetchLinearLabels(msg)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ success: false, labels: [] }));
    return true;
  }
  if (msg.type === "fetchLinearWorkflowStates") {
    handleFetchLinearWorkflowStates(msg)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ success: false, stateId: null }));
    return true;
  }
  if (msg.type === "createLinearIssue") {
    handleCreateLinearIssue(msg)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (msg.type === "clearScreenshotCache") {
    screenshotCacheClear().then(() => sendResponse({ success: true })).catch(() => sendResponse({ success: false }));
    return true;
  }
});
