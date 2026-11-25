(() => {
  "use strict";

  // Consume the capability before any request or user interaction. It never goes
  // in a query string, DOM node, storage, request body, or diagnostic message.
  let token = "";
  try {
    token = new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
  } finally {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  const $ = (id) => document.getElementById(id);
  const article = $("document");
  const MAX_BLOCKS = 32;
  const MAX_QUOTE = 16000;
  const MAX_COMMENTS = 50;
  const MAX_BODY_BYTES = 256 * 1024;
  const POLL_MS = 1500;
  const BLOCK_SELECTOR = "[data-block-id][data-source-start][data-source-end]";
  const drafts = [];
  let current = null;
  let connected = false;
  let finished = false;
  let fatalConnection = false;
  let pollTimer = null;
  let pollPromise = null;
  let stateGeneration = 0;
  let selectionTimer = null;
  let placementFrame = null;
  let selectionCandidate = null;
  let composer = null;
  let reanchorId = null;
  let sending = false;
  let finishing = false;
  let latestBatch = null;
  let lastSubmission = null;
  let renderedSubmission = null;
  let renderedReplies = null;
  let mermaidPromise = null;
  let diagramSequence = 0;
  const mediaZoom = new WeakMap();
  const imageUrls = new Set();

  class ApiError extends Error {
    constructor(message, status = 0) {
      super(message);
      this.status = status;
    }
  }

  async function api(path, body) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    try {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        credentials: "omit",
        mode: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        if (response.ok) throw new ApiError("The server returned an unreadable response.");
      }
      if (!response.ok) {
        const message = data && (data.message || data.error);
        throw new ApiError(typeof message === "string" ? message : `Request failed (${response.status}).`, response.status);
      }
      return data;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function announce(message) {
    $("announcement").textContent = message;
  }

  function notice(message) {
    $("interaction-message").textContent = message;
    $("interaction-message").hidden = !message;
  }

  function isWaiting(batch) {
    return Boolean(batch && ["pending", "delivered"].includes(batch.status));
  }

  function uncertain() {
    return Boolean(lastSubmission && lastSubmission.status === "uncertain");
  }

  function awaitingApplication() {
    return isWaiting(latestBatch) || isWaiting(lastSubmission);
  }

  function editingLocked() {
    return finished || sending || finishing || uncertain();
  }

  function staleCount() {
    return drafts.filter((draft) => !current || draft.hash !== current.hash).length;
  }

  function setConnectionError(error) {
    if (finished) return;
    connected = false;
    const unauthorized = [401, 403].includes(error.status);
    fatalConnection = unauthorized;
    const message = unauthorized
      ? "This review link is not authorized. Reopen the original capability link from the target session."
      : `Connection interrupted. Your drafts remain in this tab. ${error.message || "The local server did not respond."}`;
    $("connection-message").textContent = message;
    $("connection-banner").hidden = false;
    $("retry-connection").hidden = unauthorized;
    updateControls();
  }

  function schedulePoll() {
    window.clearTimeout(pollTimer);
    if (!finished && !fatalConnection && token) {
      pollTimer = window.setTimeout(refreshState, POLL_MS);
    }
  }

  function refreshState() {
    if (finished || fatalConnection || !token) return Promise.resolve(null);
    if (pollPromise) return pollPromise;
    window.clearTimeout(pollTimer);
    const generation = stateGeneration;
    pollPromise = (async () => {
      try {
        const next = await api("/api/state");
        if (!next || typeof next.hash !== "string" || typeof next.html !== "string") {
          throw new ApiError("The document state is incomplete.");
        }
        // A POST can invalidate a GET snapshot that began before it. Never
        // replace a newly accepted batch with an older applied batch.
        if (finished || generation !== stateGeneration) return null;
        connected = true;
        $("connection-banner").hidden = true;
        applyState(next);
        return next;
      } catch (error) {
        if (generation === stateGeneration) setConnectionError(error);
        return null;
      } finally {
        pollPromise = null;
        schedulePoll();
      }
    })();
    return pollPromise;
  }

  function applyState(next) {
    const sourceChanged = current && next.hash !== current.hash;
    const firstRender = current === null;
    current = next;
    $("document-title").textContent = next.title || "Untitled document";
    $("file-path").textContent = next.filePath || "Local Markdown document";
    $("target-session").textContent = next.targetSession || "Current session";
    document.title = `${next.title || "Markdown"} · Review`;
    if (firstRender || sourceChanged) {
      for (const url of imageUrls) URL.revokeObjectURL(url);
      imageUrls.clear();
      // Document HTML comes from the local renderer with raw HTML disabled.
      article.innerHTML = next.html;
      article.setAttribute("aria-busy", "false");
      protectDocumentLinks();
      populateKeyboardPassages();
      renderMermaidDiagrams();
      renderImages();
      selectionCandidate = null;
      positionSelectionOffer();
      if (sourceChanged) {
        notice("The source changed. Existing drafts are kept; reselect stale passages before applying.");
        announce("Document updated. Check stale draft anchors before applying feedback.");
        if (composer) updateComposer();
      }
      renderDrafts();
    }
    latestBatch = next.latestBatch || null;
    renderReplies(next.reviewedBatches || []);
    if (latestBatch) reconcileBatch(latestBatch);
    if (next.finished) {
      showFinished(false);
      return;
    }
    updateControls();
    renderSubmission();
  }

  function protectDocumentLinks() {
    for (const link of article.querySelectorAll("a[href]")) {
      try {
        const url = new URL(link.getAttribute("href"), window.location.href);
        if (!["http:", "https:", "mailto:"].includes(url.protocol)) {
          link.removeAttribute("href");
          continue;
        }
        if (url.origin !== window.location.origin) {
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        }
      } catch {
        link.removeAttribute("href");
      }
    }
  }

  function loadMermaid() {
    if (!mermaidPromise) {
      mermaidPromise = import("/vendor/mermaid/mermaid.esm.min.mjs").then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          theme: "neutral",
          fontFamily: "system-ui, sans-serif",
          // Document directives must not override the preview's rendering policy.
          secure: [...new Set([...Object.keys(mermaid.mermaidAPI.getConfig()), "secure", "suppressErrorRendering"])],
        });
        return mermaid;
      });
    }
    return mermaidPromise;
  }

  function setMediaView(block, view) {
    block.dataset.view = view;
    block.querySelector("pre, .image-source").hidden = view !== "code";
    block.querySelector(".mermaid-preview, .image-preview").hidden = view === "code";
    for (const button of block.querySelectorAll("[data-diagram-view], [data-image-view]")) {
      button.setAttribute("aria-pressed", String((button.dataset.diagramView || button.dataset.imageView) === view));
    }
    if (view !== "code" && mediaZoom.get(block)?.fitted) fitMedia(block);
    clearSelectionOffer();
    if (composer) positionComposer();
  }

  function mediaFitScale(block, width) {
    const preview = block.querySelector(".mermaid-preview, .image-preview");
    const styles = window.getComputedStyle(preview);
    const available = preview.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
    return Math.min(1, Math.max(1, available) / width);
  }

  function setMediaScale(block, scale, fitted) {
    const state = mediaZoom.get(block);
    if (!state || block.dataset.view === "code") return;
    const minimum = Math.min(0.1, mediaFitScale(block, state.width));
    state.scale = Math.max(minimum, Math.min(3, scale));
    state.fitted = fitted;
    block.querySelector(".mermaid-preview svg, .image-preview img").setAttribute("width", String(state.width * state.scale));
    block.querySelector('[data-diagram-zoom="out"], [data-image-zoom="out"]').disabled = state.scale <= minimum + 0.000001;
    block.querySelector('[data-diagram-zoom="in"], [data-image-zoom="in"]').disabled = state.scale >= 3 - 0.000001;
    const fitButton = block.querySelector('[data-diagram-zoom="fit"], [data-image-zoom="fit"]');
    fitButton.disabled = false;
    fitButton.setAttribute("aria-pressed", String(fitted));
    if (fitted) block.querySelector(".mermaid-preview, .image-preview").scrollLeft = 0;
    clearSelectionOffer();
    if (composer) positionComposer();
  }

  function fitMedia(block) {
    const state = mediaZoom.get(block);
    if (state) setMediaScale(block, mediaFitScale(block, state.width), true);
  }

  function zoomMedia(block, action) {
    const state = mediaZoom.get(block);
    if (!state) return;
    if (action === "fit") fitMedia(block);
    else setMediaScale(block, state.scale * (action === "in" ? 1.25 : 0.8), false);
    const label = block.classList.contains("image-block") ? "Image" : "Diagram";
    announce(`${label} zoom ${Math.round(state.scale * 100)} percent.`);
  }

  function commentOnMedia(block) {
    if (editingLocked()) return;
    const range = document.createRange();
    range.selectNodeContents(block.querySelector("pre, .image-source"));
    const captured = captureRange(range);
    if (captured?.error) { notice(captured.error); return; }
    if (!captured) { notice("This image or diagram has no source text to comment on."); return; }
    const rect = block.getBoundingClientRect();
    captured.placement = {
      top: rect.top + window.scrollY,
      right: rect.right + window.scrollX,
      bottom: rect.bottom + window.scrollY,
    };
    openSelection(captured);
  }

  function renderMermaidDiagrams() {
    for (const block of article.querySelectorAll(".mermaid-block")) {
      for (const button of block.querySelectorAll("[data-diagram-view]")) {
        button.addEventListener("click", () => setMediaView(block, button.dataset.diagramView));
      }
      for (const button of block.querySelectorAll("[data-diagram-zoom]")) {
        button.addEventListener("click", () => zoomMedia(block, button.dataset.diagramZoom));
      }
      block.querySelector("[data-diagram-comment]").addEventListener("click", () => commentOnMedia(block));
      void renderMermaidDiagram(block);
    }
  }

  async function renderMermaidDiagram(block) {
    let mount = null;
    try {
      const mermaid = await loadMermaid();
      if (!block.isConnected) return;
      mount = makeElement("div", "mermaid-render-target");
      mount.setAttribute("aria-hidden", "true");
      document.body.append(mount);
      const { svg } = await mermaid.render(`review-diagram-${++diagramSequence}`, block.querySelector("code").textContent, mount);
      if (!block.isConnected) return;
      // Mermaid's strict renderer sanitizes the SVG. Do not bind diagram actions.
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
      if (parsed.querySelector("parsererror") || parsed.documentElement.localName !== "svg") {
        throw new Error("Mermaid returned an invalid SVG.");
      }
      const diagram = document.importNode(parsed.documentElement, true);
      if (diagram.viewBox.baseVal.width > 0) {
        diagram.setAttribute("width", String(diagram.viewBox.baseVal.width));
        diagram.removeAttribute("height");
        diagram.removeAttribute("style");
      }
      for (const link of diagram.querySelectorAll("a")) {
        link.removeAttribute("href");
        link.removeAttributeNS("http://www.w3.org/1999/xlink", "href");
      }
      block.querySelector(".mermaid-preview").replaceChildren(diagram);
      if (diagram.viewBox.baseVal.width > 0) {
        mediaZoom.set(block, { width: diagram.viewBox.baseVal.width, scale: 1, fitted: true });
        fitMedia(block);
      }
      block.querySelector('[data-diagram-view="graph"]').disabled = false;
    } catch (error) {
      if (!block.isConnected) return;
      const message = block.querySelector(".mermaid-error");
      message.textContent = `Diagram could not be rendered: ${error.message || "Unknown rendering error"}. Code remains available for review.`;
      message.hidden = false;
      setMediaView(block, "code");
    } finally {
      mount?.remove();
    }
  }

  function renderImages() {
    for (const block of article.querySelectorAll(".image-block")) {
      for (const button of block.querySelectorAll("[data-image-view], [data-image-comment], [data-image-zoom]")) {
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (button.hasAttribute("data-image-comment")) commentOnMedia(block);
          else if (button.dataset.imageZoom) zoomMedia(block, button.dataset.imageZoom);
          else setMediaView(block, button.dataset.imageView);
        });
      }
      if (block.dataset.imageUrl) void renderImage(block);
    }
  }

  async function renderImage(block) {
    let url = null;
    try {
      const response = await fetch(block.dataset.imageUrl, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        credentials: "omit",
        mode: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new ApiError(error.error || `Image request failed (${response.status}).`, response.status);
      }
      const bytes = await response.blob();
      if (!block.isConnected) return;
      const image = block.querySelector("img");
      url = URL.createObjectURL(bytes);
      imageUrls.add(url);
      await new Promise((resolve, reject) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", () => reject(new Error("The image could not be decoded")), { once: true });
        image.src = url;
      });
      if (!block.isConnected) return;
      image.hidden = false;
      mediaZoom.set(block, { width: image.naturalWidth, scale: 1, fitted: true });
      fitMedia(block);
      block.querySelector('[role="status"]').remove();
      block.querySelector('[data-image-view="image"]').disabled = false;
    } catch (error) {
      if (url) {
        block.querySelector("img").removeAttribute("src");
        URL.revokeObjectURL(url);
        imageUrls.delete(url);
      }
      if (!block.isConnected) return;
      const message = block.querySelector(".image-error");
      const reason = (error.message || "Unknown image error").replace(/\.$/, "");
      message.textContent = `Image could not be displayed: ${reason}. Code remains available for review.`;
      message.hidden = false;
      setMediaView(block, "code");
    }
  }

  function reconcileBatch(batch) {
    if (lastSubmission && lastSubmission.id === batch.id) {
      lastSubmission.status = batch.status;
      lastSubmission.message = typeof batch.message === "string" ? batch.message : "";
      if (!lastSubmission.rejected) removeSubmittedDrafts(lastSubmission);
    } else if (!lastSubmission || lastSubmission.external) {
      const reviewed = current.reviewedBatches?.find(item => item.id === batch.id);
      lastSubmission = {
        id: batch.id,
        status: batch.status,
        message: typeof batch.message === "string" ? batch.message : "",
        comments: reviewed?.comments || [],
        hash: reviewed?.hash || null,
        external: true,
      };
    }
  }

  function removeSubmittedDrafts(batch) {
    if (batch.removedDrafts) return;
    batch.removedDrafts = true;
    const sentIds = new Set(batch.comments.map((comment) => comment.id));
    for (let index = drafts.length - 1; index >= 0; index -= 1) {
      if (sentIds.has(drafts[index].id)) drafts.splice(index, 1);
    }
    renderDrafts();
  }

  function lineHint(blocks) {
    if (!blocks.length) return "Source anchor unavailable";
    const start = Math.min(...blocks.map((block) => block.startLine));
    const end = Math.max(...blocks.map((block) => block.endLine));
    return start === end ? `Line ${start}` : `Lines ${start}–${end}`;
  }

  function populateKeyboardPassages() {
    const options = [];
    for (const block of article.querySelectorAll(BLOCK_SELECTOR)) {
      const range = document.createRange();
      range.selectNodeContents(block);
      const text = sourceRangeText(range).trim();
      if (!text || block.querySelector(BLOCK_SELECTOR)) continue;
      const option = document.createElement("option");
      option.value = block.dataset.blockId;
      option.textContent = `Line ${block.dataset.sourceStart}: ${Array.from(text).slice(0, 90).join("").replace(/\s+/g, " ")}`;
      options.push(option);
    }
    $("keyboard-passage").replaceChildren(...options);
  }

  function useKeyboardPassage() {
    if (editingLocked()) return;
    const id = $("keyboard-passage").value;
    const block = [...article.querySelectorAll(BLOCK_SELECTOR)].find((item) => item.dataset.blockId === id);
    if (!block) return;
    const media = block.closest(".mermaid-block, .image-block");
    if (media) setMediaView(media, "code");
    const range = document.createRange();
    range.selectNodeContents(block);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const captured = captureRange(range);
    if (captured && captured.error) notice(captured.error);
    else if (captured) {
      $("keyboard-picker").open = false;
      selectionCandidate = captured;
      if (reanchorId) openSelection(captured);
      else {
        positionSelectionOffer();
        $("comment-selection").focus({ preventScroll: true });
        updateControls();
      }
    }
  }

  function captureSelection() {
    const selection = window.getSelection();
    if (!current || !selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
    return captureRange(selection.getRangeAt(0));
  }

  function captureRange(range) {
    if (!current || range.collapsed || !article.contains(range.startContainer) || !article.contains(range.endContainer)) return null;
    const inDiagramUi = (node) => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest("[data-review-ui]");
    if (inDiagramUi(range.startContainer) || inDiagramUi(range.endContainer)) {
      return { error: "Use Comment on image or Comment on diagram, or switch to Code to select a specific passage." };
    }
    const quote = sourceRangeText(range);
    if (!quote.trim()) return null;
    if (quote.length > MAX_QUOTE) return { error: "Select a shorter passage (up to 16,000 characters)." };

    const startPoint = range.cloneRange();
    const endPoint = range.cloneRange();
    startPoint.collapse(true);
    endPoint.collapse(false);
    const blocks = new Map();
    const root = range.commonAncestorContainer;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = root.nodeType === Node.TEXT_NODE ? root : walker.nextNode();
    while (node) {
      if (node.textContent.length && !inDiagramUi(node)) {
        const point = document.createRange();
        point.setStart(node, 0);
        point.collapse(true);
        if (point.compareBoundaryPoints(Range.START_TO_START, endPoint) >= 0) break;
        point.setStart(node, node.textContent.length);
        point.collapse(true);
        if (point.compareBoundaryPoints(Range.START_TO_START, startPoint) > 0) {
          const block = node.parentElement.closest(BLOCK_SELECTOR);
          if (block && article.contains(block)) {
            const startLine = Number(block.dataset.sourceStart);
            const endLine = Number(block.dataset.sourceEnd);
            if (block.dataset.blockId && Number.isSafeInteger(startLine) && Number.isSafeInteger(endLine)
                && startLine > 0 && endLine >= startLine) {
              blocks.set(block.dataset.blockId, { id: block.dataset.blockId, startLine, endLine });
              if (blocks.size > MAX_BLOCKS) return { error: "Select a smaller passage (up to 32 source blocks)." };
            }
          }
        }
      }
      node = root.nodeType === Node.TEXT_NODE ? null : walker.nextNode();
    }
    if (!blocks.size) return { error: "This passage has no source anchor. Select text inside a document paragraph or heading." };

    // Clone the actual range, rather than looking up quote text with indexOf.
    // This disambiguates repeated text and handles inline markup and Unicode.
    const before = range.cloneRange();
    before.selectNodeContents(article);
    before.setEnd(range.startContainer, range.startOffset);
    const after = range.cloneRange();
    after.selectNodeContents(article);
    after.setStart(range.endContainer, range.endOffset);
    const rect = range.getBoundingClientRect();
    const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
    const fallbackRect = startElement?.closest(BLOCK_SELECTOR)?.getBoundingClientRect();
    const placementRect = rect.width || rect.height ? rect : fallbackRect;
    return {
      hash: current.hash,
      placement: placementRect ? {
        top: placementRect.top + window.scrollY,
        right: placementRect.right + window.scrollX,
        bottom: placementRect.bottom + window.scrollY,
      } : null,
      anchor: {
        quote,
        prefix: Array.from(sourceRangeText(before)).slice(-160).join(""),
        suffix: Array.from(sourceRangeText(after)).slice(0, 160).join(""),
        blocks: [...blocks.values()],
      },
    };
  }

  function sourceRangeText(range) {
    const content = range.cloneContents();
    for (const element of content.querySelectorAll("[data-review-ui]")) element.remove();
    return content.textContent;
  }

  const styleRules = new Map();

  function styleRule(selector) {
    if (styleRules.has(selector)) return styleRules.get(selector);
    function search(rules) {
      for (const rule of rules) {
        if (rule.selectorText === selector) return rule;
        if (rule.cssRules) {
          const nested = search(rule.cssRules);
          if (nested) return nested;
        }
      }
      return null;
    }
    for (const sheet of document.styleSheets) {
      const rule = search(sheet.cssRules);
      if (rule) {
        styleRules.set(selector, rule);
        return rule;
      }
    }
    return null;
  }

  function setStyleRule(selector, property, value) {
    const rule = styleRule(selector);
    if (!rule) return;
    if (value === null) rule.style.removeProperty(property);
    else rule.style.setProperty(property, value);
  }

  function schedulePlacement() {
    window.cancelAnimationFrame(placementFrame);
    placementFrame = window.requestAnimationFrame(() => {
      placementFrame = null;
      positionSelectionOffer();
      positionComposer();
    });
  }

  function positionSelectionOffer() {
    const actions = $("selection-actions");
    if (!selectionCandidate || !selectionCandidate.anchor || !selectionCandidate.placement || editingLocked() || composer) {
      actions.hidden = true;
      return;
    }
    const { right, bottom } = selectionCandidate.placement;
    actions.hidden = false;
    const width = actions.offsetWidth;
    const height = actions.offsetHeight;
    const left = Math.min(window.innerWidth - width - 10, Math.max(10, right - window.scrollX + 8));
    const top = Math.min(window.innerHeight - height - 10, Math.max(10, bottom - window.scrollY + 8));
    setStyleRule(".selection-actions", "left", `${left}px`);
    setStyleRule(".selection-actions", "top", `${top}px`);
  }

  function positionComposer() {
    const form = $("composer");
    if (!composer || form.hidden || window.matchMedia("(max-width: 760px)").matches) {
      setStyleRule(".composer", "margin-top", null);
      return;
    }
    setStyleRule(".composer", "margin-top", "20px");
    if (!composer.placement) return;
    const naturalTop = form.getBoundingClientRect().top + window.scrollY;
    const offset = Math.max(20, 20 + composer.placement.top - naturalTop);
    setStyleRule(".composer", "margin-top", `${offset}px`);
  }

  function offerSelection() {
    if (editingLocked()) return;
    const captured = captureSelection();
    if (!captured) return;
    if (captured.error) {
      selectionCandidate = null;
      positionSelectionOffer();
      notice(captured.error);
      return;
    }
    selectionCandidate = captured;
    notice("");
    positionSelectionOffer();
    updateControls();
  }

  function validSelection(captured) {
    if (editingLocked() || !captured || !captured.anchor) return false;
    if (captured.hash !== current.hash) {
      notice("The source changed after that selection. Please select the passage again.");
      return false;
    }
    return true;
  }

  function clearSelectionOffer() {
    selectionCandidate = null;
    window.getSelection()?.removeAllRanges();
    positionSelectionOffer();
  }

  function addQuickDraft(action) {
    const captured = selectionCandidate;
    if (!validSelection(captured)) return;
    if (reanchorId) {
      openSelection(captured);
      return;
    }
    if (drafts.length >= MAX_COMMENTS) {
      notice("There are already 50 drafts. Apply or remove some drafts first.");
      return;
    }
    const instructions = {
      delete: "Delete this selected passage.",
      refine: "Refine this selected passage for clarity and concision while preserving its intended meaning.",
    };
    const labels = { delete: "Delete", refine: "Refine" };
    drafts.push({ id: crypto.randomUUID(), ...captured.anchor, kind: "edit", comment: instructions[action], hash: captured.hash });
    clearSelectionOffer();
    renderDrafts();
    updateControls();
    notice(`${labels[action]} instruction saved as a draft. Apply feedback when ready.`);
    announce(`${labels[action]} instruction saved as a draft. It has not been sent.`);
  }

  function openSelection(captured, kind = "edit") {
    if (!validSelection(captured)) return;
    if (reanchorId) {
      const draft = drafts.find((item) => item.id === reanchorId);
      if (draft) {
        Object.assign(draft, captured.anchor, { hash: captured.hash });
        renderDrafts();
        notice("Passage reselected. Your comment text was kept.");
        announce("Draft anchor updated to the current source.");
      }
      reanchorId = null;
      selectionCandidate = null;
      positionSelectionOffer();
      updateControls();
      return;
    }
    if (!composer && drafts.length >= MAX_COMMENTS) {
      notice("A review batch can contain up to 50 comments. Apply or remove some drafts first.");
      return;
    }
    if (composer && !closeComposer()) return;
    // Selecting elsewhere starts a new comment, never silently changes the
    // anchor or identity of an existing saved comment being edited.
    if (drafts.length >= MAX_COMMENTS) {
      notice("There are already 50 drafts. Apply or remove some drafts first.");
      return;
    }
    composer = { id: null, kind, initialKind: kind, anchor: captured.anchor, hash: captured.hash, placement: captured.placement, initialText: "" };
    $("comment-text").value = "";
    selectionCandidate = null;
    positionSelectionOffer();
    notice("");
    updateComposer();
    positionComposer();
    $("comment-text").focus({ preventScroll: true });
    updateControls();
  }

  function updateComposer() {
    $("composer").hidden = !composer;
    if (!composer) return;
    $("composer-heading").textContent = composer.kind === "question" ? (composer.id ? "Edit question" : "Ask a question") : (composer.id ? "Refine comment" : "New comment");
    $("comment-kind").value = composer.kind;
    $("comment-help").textContent = composer.kind === "question" ? "An answer is required. Any additional document changes must be reported." : "Describe the requested change; your agent will report its outcome.";
    $("composer-quote").textContent = composer.anchor.quote;
    $("composer-anchor").textContent = lineHint(composer.anchor.blocks);
    $("composer-stale").hidden = composer.hash === current.hash;
    $("delete-comment").hidden = !composer.id;
    $("save-comment").textContent = composer.id ? "Save refinement" : "Save draft";
  }

  function closeComposer(confirmDiscard = true) {
    if (!composer) return true;
    if (confirmDiscard && ($("comment-text").value !== composer.initialText || composer.kind !== composer.initialKind)
        && !window.confirm("Discard the unsaved changes in this composer? Saved drafts will be kept.")) return false;
    composer = null;
    $("comment-text").value = "";
    setStyleRule(".composer", "margin-top", null);
    updateComposer();
    updateControls();
    return true;
  }

  function draftPlacement(draft) {
    if (!current || draft.hash !== current.hash) return null;
    const ids = new Set(draft.blocks.map((block) => block.id));
    const block = [...article.querySelectorAll(BLOCK_SELECTOR)].find((item) => ids.has(item.dataset.blockId));
    if (!block) return null;
    const rect = block.getBoundingClientRect();
    return { top: rect.top + window.scrollY, right: rect.right + window.scrollX, bottom: rect.bottom + window.scrollY };
  }

  function refineDraft(id) {
    if (editingLocked() || !closeComposer()) return;
    const draft = drafts.find((item) => item.id === id);
    if (!draft) return;
    reanchorId = null;
    composer = {
      id: draft.id,
      kind: draft.kind || "edit",
      initialKind: draft.kind || "edit",
      hash: draft.hash,
      anchor: { quote: draft.quote, prefix: draft.prefix, suffix: draft.suffix, blocks: draft.blocks },
      placement: draftPlacement(draft),
      initialText: draft.comment,
    };
    $("comment-text").value = draft.comment;
    updateComposer();
    positionComposer();
    updateControls();
    $("comment-text").focus({ preventScroll: true });
  }

  function deleteDraft(id) {
    if (editingLocked()) return;
    if (composer && composer.id === id) composer = null;
    const index = drafts.findIndex((draft) => draft.id === id);
    if (index < 0) return;
    drafts.splice(index, 1);
    if (reanchorId === id) reanchorId = null;
    $("comment-text").value = "";
    setStyleRule(".composer", "margin-top", null);
    updateComposer();
    renderDrafts();
    updateControls();
    announce("Draft deleted.");
    $("comments-heading").focus({ preventScroll: true });
  }

  function reanchorDraft(id) {
    if (editingLocked() || !closeComposer()) return;
    reanchorId = id;
    notice("");
    updateControls();
    article.focus({ preventScroll: true });
    announce("Select a replacement passage in the document for this draft.");
  }

  function saveDraft(event) {
    event.preventDefault();
    if (!composer || editingLocked()) return;
    const comment = $("comment-text").value.trim();
    if (!comment) {
      $("comment-text").focus();
      return;
    }
    const saved = { id: composer.id || crypto.randomUUID(), ...composer.anchor, kind: composer.kind, comment, hash: composer.hash };
    const index = drafts.findIndex((draft) => draft.id === saved.id);
    if (index >= 0) drafts[index] = saved;
    else if (drafts.length < MAX_COMMENTS) drafts.push(saved);
    else {
      notice("There are already 50 drafts. Remove one before saving another.");
      return;
    }
    closeComposer(false);
    renderDrafts();
    updateControls();
    notice(saved.hash === current.hash ? "Draft saved. Apply feedback when your comments are ready." : "Draft saved with an older source anchor. Reselect its passage before applying.");
    announce("Comment saved as a draft. It has not been sent.");
    $("comments-heading").focus({ preventScroll: true });
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function focusAnchor(comment) {
    if (!current || comment.hash !== current.hash) {
      notice("This passage belongs to an older source version. Use the quote and line hints as reference; reselect the current passage for a new draft.");
      return;
    }
    const ids = new Set(comment.blocks.map((block) => block.id));
    const block = [...article.querySelectorAll(BLOCK_SELECTOR)].find((item) => ids.has(item.dataset.blockId));
    if (!block) {
      notice("That source anchor is no longer visible. Reselect the passage to update it.");
      return;
    }
    const media = block.closest(".mermaid-block, .image-block");
    if (media) setMediaView(media, "code");
    block.classList.add("anchor-highlight");
    block.setAttribute("tabindex", "-1");
    block.scrollIntoView({ block: "center" });
    block.focus({ preventScroll: true });
    window.setTimeout(() => block.classList.remove("anchor-highlight"), 1800);
  }

  function makeCommentCard(comment, editable, reply = null) {
    const card = makeElement("li", "comment-card");
    card.dataset.commentId = comment.id;
    const isStale = Boolean(current && comment.hash !== current.hash);
    if (editable && isStale) card.classList.add("is-stale");
    const top = makeElement("div", "comment-card-heading");
    const anchor = makeElement("button", "anchor-button", lineHint(comment.blocks));
    anchor.type = "button";
    anchor.disabled = isStale;
    anchor.setAttribute("aria-label", `${lineHint(comment.blocks)}, show passage in document`);
    anchor.addEventListener("click", () => focusAnchor(comment));
    top.append(anchor, makeElement("span", `draft-label${isStale ? " stale-label" : ""}`, editable ? (isStale ? "Stale anchor" : "Draft") : "Submitted"));
    card.append(top, makeElement("blockquote", "quote", comment.quote), makeElement("p", "comment-body", comment.comment));
    card.append(makeElement("p", "field-hint", comment.kind === "question" ? "Question - answer required" : "Edit request"));
    if (reply) {
      const response = makeElement("section", "agent-reply");
      response.setAttribute("aria-label", "Agent reply");
      response.append(
        makeElement("strong", "reply-status", { answered: "Answered", applied: comment.kind === "question" ? "Answered + Updated" : "Applied", failed: "Failed" }[reply.status]),
        makeElement("h4", "", "Answer"),
        makeElement("p", "reply-answer", reply.answer),
        makeElement("h4", "", "Action taken"),
        makeElement("p", "reply-action", reply.action),
      );
      card.append(response);
    }
    if (editable) {
      if (isStale) card.append(makeElement("p", "stale-note", "Source changed. Reselect this passage, or remove this draft and select again."));
      const actions = makeElement("div", "comment-actions");
      const refine = makeElement("button", "text-button", "Refine");
      refine.type = "button";
      refine.id = `refine-${comment.id}`;
      refine.dataset.draftAction = "refine";
      refine.addEventListener("click", () => refineDraft(comment.id));
      actions.append(refine);
      if (isStale) {
        const reselect = makeElement("button", "text-button", "Reselect passage");
        reselect.type = "button";
        reselect.id = `reselect-${comment.id}`;
        reselect.dataset.draftAction = "reselect";
        reselect.addEventListener("click", () => reanchorDraft(comment.id));
        actions.append(reselect);
      }
      const remove = makeElement("button", "text-button remove-button", "Delete");
      remove.type = "button";
      remove.id = `delete-${comment.id}`;
      remove.dataset.draftAction = "delete";
      remove.addEventListener("click", () => deleteDraft(comment.id));
      actions.append(remove);
      card.append(actions);
    }
    return card;
  }

  function renderReplies(batches) {
    const key = JSON.stringify([current.hash, batches]);
    if (key === renderedReplies) return;
    renderedReplies = key;
    $("replies").hidden = batches.length === 0;
    const cards = [];
    for (const batch of [...batches].reverse()) {
      const replies = new Map(batch.replies.map(reply => [reply.id, reply]));
      for (const comment of batch.comments) cards.push(makeCommentCard({ ...comment, hash: batch.hash }, false, replies.get(comment.id)));
    }
    $("reply-list").replaceChildren(...cards);
  }

  function renderDrafts() {
    const activeId = document.activeElement && document.activeElement.id;
    const fragment = document.createDocumentFragment();
    for (const draft of drafts) fragment.append(makeCommentCard(draft, true));
    $("draft-list").replaceChildren(fragment);
    $("draft-count").textContent = String(drafts.length);
    $("empty-state").hidden = drafts.length > 0 || Boolean(composer) || finished || Boolean(current?.reviewedBatches?.length);
    if (activeId) {
      const replacement = document.getElementById(activeId);
      if (replacement && replacement !== document.activeElement) replacement.focus({ preventScroll: true });
    }
  }

  const STATUS_LABELS = {
    sending: "Sending",
    uncertain: "Unconfirmed",
    pending: "Queued",
    delivered: "Delivered",
    applied: "Applied",
    completed: "Completed",
    failed: "Failed",
  };

  function retryComments(batch) {
    const reviewed = current.reviewedBatches?.find(item => item.id === batch.id);
    if (!reviewed) return batch.comments;
    const failed = new Set(reviewed.replies.filter(reply => reply.status === "failed").map(reply => reply.id));
    return batch.comments.filter(comment => failed.has(comment.id));
  }

  function renderSubmission() {
    const batch = lastSubmission;
    $("submission").hidden = !batch;
    if (!batch) return;
    $("submission-status").textContent = STATUS_LABELS[batch.status] || batch.status;
    $("submission-status").dataset.status = batch.status;
    const explanations = {
      sending: "Sending this batch. Please wait before trying again.",
      uncertain: "Delivery could not be confirmed. Retry this exact batch; its ID stays the same to prevent duplicate feedback. Draft editing is paused until it is resolved.",
      pending: "Feedback is queued for the target session. Another batch and Finish are paused until the target reports its answers and actions.",
      delivered: "Feedback reached the target session. Waiting for its answers and action reports; a source update alone is not a reply.",
      applied: "The target session marked this feedback as applied. Review the updated document before sending more.",
      completed: "The target session replied to this feedback. Read the answers and action reports below.",
      failed: batch.rejected ? "The server did not accept this batch. Your drafts have been kept." : "Some feedback could not be fulfilled. Read the explanations below; failed comments can be restored as drafts.",
    };
    $("submission-message").textContent = [explanations[batch.status] || "", batch.message || ""].filter(Boolean).join(" ");
    $("submission-id").textContent = `Batch ${batch.id}`;
    $("retry-submit").hidden = batch.status !== "uncertain" || finished;
    $("retry-submit").disabled = sending || finishing || !connected;
    $("restore-submitted").hidden = batch.status !== "failed" || batch.rejected || batch.restored || !retryComments(batch).length || finished;
    $("restore-submitted").disabled = editingLocked() || drafts.length + retryComments(batch).length > MAX_COMMENTS;
    $("submitted-details").hidden = batch.comments.length === 0 || Boolean(current.reviewedBatches?.some(reviewed => reviewed.id === batch.id));
    const renderKey = `${batch.id}:${current ? current.hash : ""}`;
    if (renderedSubmission !== renderKey) {
      const newBatch = !renderedSubmission || !renderedSubmission.startsWith(`${batch.id}:`);
      $("submitted-list").replaceChildren(...batch.comments.map((comment) => makeCommentCard({ ...comment, hash: batch.hash }, false)));
      $("submitted-summary").textContent = `${batch.comments.length} submitted ${batch.comments.length === 1 ? "comment" : "comments"}`;
      if (newBatch) $("submitted-details").open = true;
      renderedSubmission = renderKey;
    }
  }

  function updateControls() {
    const locked = editingLocked();
    const waiting = awaitingApplication();
    const stale = staleCount();
    $("finish").disabled = !current || !connected || locked || waiting;
    $("finish").textContent = finished ? "Review finished" : finishing ? "Finishing…" : "Finish review";
    $("apply-feedback").disabled = !current || !connected || locked || waiting || !drafts.length || stale > 0 || Boolean(composer) || Boolean(reanchorId);
    $("apply-feedback").textContent = sending ? "Sending feedback…" : waiting ? "Awaiting reply" : "Apply feedback";
    const selectionDisabled = locked || !selectionCandidate || !selectionCandidate.anchor;
    $("comment-selection").disabled = selectionDisabled;
    $("ask-selection").disabled = selectionDisabled;
    $("delete-selection").disabled = selectionDisabled;
    $("refine-selection").disabled = selectionDisabled;
    for (const button of article.querySelectorAll("[data-diagram-comment], [data-image-comment]")) button.disabled = locked;
    positionSelectionOffer();
    $("comment-text").disabled = locked && !finished;
    $("comment-kind").disabled = locked;
    $("comment-text").readOnly = finished;
    $("keyboard-passage").disabled = locked;
    $("use-keyboard-passage").disabled = locked || !$("keyboard-passage").options.length;
    $("save-comment").disabled = locked || !$("comment-text").value.trim();
    $("cancel-composer").disabled = locked;
    $("delete-comment").disabled = locked;
    $("cancel-reanchor").disabled = locked;
    $("reanchor-notice").hidden = !reanchorId || finished;
    $("empty-state").hidden = drafts.length > 0 || Boolean(composer) || finished || Boolean(current?.reviewedBatches?.length);
    for (const button of $("draft-list").querySelectorAll("[data-draft-action]")) button.disabled = locked;
    let hint = "Save a comment to start your review.";
    if (finished) hint = "This review has ended. No more comments will be sent.";
    else if (uncertain()) hint = "Resolve the unconfirmed submission before sending or finishing.";
    else if (waiting) hint = "Waiting for the target session to acknowledge this batch.";
    else if (!connected) hint = "Reconnect to the local server before applying feedback.";
    else if (stale) hint = `${stale} ${stale === 1 ? "draft has a stale anchor" : "drafts have stale anchors"}. Reselect each passage, or remove and select again.`;
    else if (reanchorId) hint = "Select a replacement passage, or cancel reselect.";
    else if (composer) hint = "Save or cancel the open comment before applying.";
    else if (drafts.length) hint = `${drafts.length} ${drafts.length === 1 ? "comment is" : "comments are"} ready to send. Nothing has been sent yet.`;
    $("apply-hint").textContent = hint;
    const status = finished ? "finished" : !connected ? "offline" : sending ? "sending" : waiting ? "pending" : uncertain() ? "uncertain" : "ready";
    $("session-status").dataset.status = status;
    $("session-status").textContent = { finished: "Finished", offline: "Disconnected", sending: "Sending", pending: "Awaiting target", uncertain: "Action needed", ready: "Reviewing" }[status];
    $("source-status").textContent = finished
      ? "Review finished. Polling stopped. This tab retains the document, submission, and replies for reference."
      : stale ? "Source updated. Stale drafts are kept in this tab until you reselect or remove them."
        : "Drafts stay in this tab. Nothing is sent until you apply feedback.";
    renderSubmission();
  }

  function commentPayload(draft) {
    return { id: draft.id, kind: draft.kind || "edit", quote: draft.quote, prefix: draft.prefix, suffix: draft.suffix, blocks: draft.blocks, comment: draft.comment };
  }

  async function applyFeedback() {
    if ($("apply-feedback").disabled) return;
    const comments = drafts.map(commentPayload);
    const payload = { id: crypto.randomUUID(), hash: current.hash, comments };
    if (new TextEncoder().encode(JSON.stringify(payload)).length > MAX_BODY_BYTES) {
      notice("This batch is too large to send (256 KiB maximum). Shorten quotes or comments, or remove drafts and send a smaller batch.");
      return;
    }
    lastSubmission = { ...payload, status: "sending", message: "", payload };
    await submitBatch(lastSubmission);
  }

  async function submitBatch(batch) {
    if (sending || finishing || finished) return;
    stateGeneration += 1;
    sending = true;
    batch.status = "sending";
    batch.message = "";
    updateControls();
    try {
      const response = await api("/api/feedback", batch.payload);
      if (!response || response.id !== batch.id || !["pending", "delivered", "completed", "applied", "failed"].includes(response.status)) {
        throw new ApiError("The server did not confirm this submission ID.");
      }
      const known = latestBatch && latestBatch.id === batch.id ? latestBatch : null;
      batch.status = known && ["completed", "applied", "failed"].includes(known.status) ? known.status : response.status;
      batch.message = known && known.message || "";
      removeSubmittedDrafts(batch);
      announce("Feedback submitted. Waiting for the target session to report its outcome.");
    } catch (error) {
      // If a concurrent state poll already observed this ID, delivery is known.
      if (latestBatch && latestBatch.id === batch.id) {
        batch.status = latestBatch.status;
        batch.message = latestBatch.message || "";
        removeSubmittedDrafts(batch);
      } else if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
        batch.status = "failed";
        batch.rejected = true;
        batch.message = error.message;
        notice(error.status === 409 ? "The server rejected this batch. The document or active batch changed; check the refreshed state before retrying." : "Feedback was not accepted. Your drafts are still available.");
      } else {
        batch.status = "uncertain";
        batch.message = error.name === "AbortError" ? "The request timed out." : error.message;
        announce("Submission not confirmed. Use Retry same submission; do not create a duplicate batch.");
      }
    } finally {
      stateGeneration += 1;
      sending = false;
      updateControls();
      if (!finished) {
        // Drain an older poll before requesting the post-submission state.
        if (pollPromise) await pollPromise;
        await refreshState();
      }
    }
  }

  function restoreSubmission() {
    const batch = lastSubmission;
    if (!batch || batch.status !== "failed" || batch.rejected || batch.restored || editingLocked()) return;
    const comments = retryComments(batch);
    if (drafts.length + comments.length > MAX_COMMENTS) {
      notice("Remove some drafts before restoring this batch (50-comment limit).");
      return;
    }
    for (const comment of comments) drafts.push({ ...comment, id: crypto.randomUUID(), hash: batch.hash });
    batch.restored = true;
    renderDrafts();
    updateControls();
    notice("Failed comments restored as drafts. Reselect any stale passages before applying again.");
  }

  function showFinished(discardDrafts) {
    finished = true;
    window.clearTimeout(pollTimer);
    window.clearTimeout(selectionTimer);
    window.cancelAnimationFrame(placementFrame);
    selectionCandidate = null;
    positionSelectionOffer();
    reanchorId = null;
    const unsentComposer = !discardDrafts && composer && $("comment-text").value.trim();
    if (unsentComposer) $("composer-heading").textContent = "Unsent comment — copy to keep";
    else {
      composer = null;
      $("composer").hidden = true;
    }
    if (discardDrafts) drafts.splice(0);
    $("connection-banner").hidden = true;
    renderDrafts();
    updateControls();
    notice(discardDrafts || !drafts.length && !unsentComposer ? "Review finished. This window can be closed." : "This review was finished elsewhere. Drafts and composer text were not sent. Copy any notes you want to keep before closing this tab.");
    announce("Review finished. Polling has stopped.");
  }

  async function finishReview() {
    if ($("finish").disabled) return;
    const hasUnsent = drafts.length > 0 || Boolean(composer && $("comment-text").value.trim());
    if (hasUnsent && !window.confirm("Finish this review and discard all unsent drafts and composer text? No unsent comments will be delivered.")) return;
    finishing = true;
    updateControls();
    try {
      await api("/api/finish", {});
      showFinished(true);
    } catch (error) {
      notice(`Finish was not confirmed. Your drafts were kept. ${error.message || "Check the connection and try Finish review again."}`);
      if (!finished) await refreshState();
    } finally {
      finishing = false;
      updateControls();
    }
  }

  $("theme").addEventListener("change", (event) => {
    if (event.target.value === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = event.target.value;
  });
  $("composer").addEventListener("submit", saveDraft);
  $("comment-text").addEventListener("input", updateControls);
  $("comment-kind").addEventListener("change", () => {
    if (!composer) return;
    composer.kind = $("comment-kind").value;
    updateComposer();
  });
  $("comment-text").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      saveDraft(event);
    }
  });
  $("cancel-composer").addEventListener("click", () => {
    if (closeComposer()) article.focus({ preventScroll: true });
  });
  $("delete-comment").addEventListener("click", () => {
    if (composer && composer.id) deleteDraft(composer.id);
  });
  $("cancel-reanchor").addEventListener("click", () => {
    reanchorId = null;
    updateControls();
    announce("Reselect canceled. The original draft is unchanged.");
  });
  for (const id of ["comment-selection", "ask-selection", "delete-selection", "refine-selection"]) {
    $(id).addEventListener("pointerdown", (event) => event.preventDefault());
  }
  $("comment-selection").addEventListener("click", () => openSelection(selectionCandidate));
  $("ask-selection").addEventListener("click", () => openSelection(selectionCandidate, "question"));
  $("delete-selection").addEventListener("click", () => addQuickDraft("delete"));
  $("refine-selection").addEventListener("click", () => addQuickDraft("refine"));
  $("use-keyboard-passage").addEventListener("click", useKeyboardPassage);
  $("apply-feedback").addEventListener("click", applyFeedback);
  $("retry-submit").addEventListener("click", () => {
    if (lastSubmission && lastSubmission.status === "uncertain" && connected) submitBatch(lastSubmission);
  });
  $("restore-submitted").addEventListener("click", restoreSubmission);
  $("finish").addEventListener("click", finishReview);
  $("retry-connection").addEventListener("click", refreshState);
  article.addEventListener("pointerup", () => window.setTimeout(offerSelection, 0));
  article.addEventListener("keyup", (event) => {
    if (event.key === "Shift" || (event.key === "Enter" && !event.shiftKey)) offerSelection();
  });
  document.addEventListener("selectionchange", () => {
    window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(() => {
      if (finished) return;
      const captured = captureSelection();
      if (captured && captured.error) {
        selectionCandidate = null;
        notice(captured.error);
      } else selectionCandidate = captured;
      updateControls();
      schedulePlacement();
    }, 80);
  });
  window.addEventListener("scroll", schedulePlacement, { passive: true });
  window.addEventListener("resize", () => {
    for (const block of article.querySelectorAll('.mermaid-block[data-view="graph"], .image-block[data-view="image"]')) {
      if (mediaZoom.get(block)?.fitted) fitMedia(block);
    }
    schedulePlacement();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || editingLocked()) return;
    if ($("keyboard-picker").open) {
      $("keyboard-picker").open = false;
      $("keyboard-picker").querySelector("summary").focus();
      event.preventDefault();
    } else if (reanchorId) {
      reanchorId = null;
      updateControls();
      announce("Reselect canceled.");
    } else if (composer && closeComposer()) {
      event.preventDefault();
      article.focus({ preventScroll: true });
    } else if (selectionCandidate) {
      selectionCandidate = null;
      positionSelectionOffer();
      event.preventDefault();
      article.focus({ preventScroll: true });
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (!finished && (drafts.length || composer && $("comment-text").value.trim() || uncertain())) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  if (!token) {
    fatalConnection = true;
    $("connection-message").textContent = "The capability token is missing. Open the original review link from the target session; do not reload the cleaned URL.";
    $("connection-banner").hidden = false;
    $("retry-connection").hidden = true;
    article.replaceChildren(makeElement("p", "document-placeholder", "A private review link is required to load this document."));
    article.setAttribute("aria-busy", "false");
    updateControls();
  } else {
    refreshState();
  }
})();
