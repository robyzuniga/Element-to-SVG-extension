// In-page element picker: hover to highlight, click to select, then export the
// selection through the serializer and preview / download the SVG.
(() => {
  'use strict';

  const api = (globalThis.__elementToSvg ||= {});
  if (api.picker) {
    api.picker.toggle();
    return;
  }

  const UI_ATTR = api.UI_ATTR || 'data-el2svg-ui';
  const STORAGE_KEY = 'el2svg:options';
  const options = { mode: 'styled', text: 'text', background: true, embedImages: true };

  const BLOCKED_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick'];

  let active = false;
  let host;
  let shadow;
  let hoverBox;
  let hoverLabel;
  let toolbar;
  let previewEl;
  let cursorStyle;
  let hovered = null;
  let rawTarget = null;
  let descent = []; // elements we climbed out of with ↑, so ↓ can return
  let selected = [];
  let lastResult = null;
  let rafPending = false;
  let exportRun = 0;

  // ---------------------------------------------------------------------------
  // Lifecycle

  function start() {
    active = true;
    buildUi();
    for (const type of BLOCKED_EVENTS) window.addEventListener(type, onBlocked, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule, true);
    loadOptions();
  }

  function stop() {
    active = false;
    for (const type of BLOCKED_EVENTS) window.removeEventListener(type, onBlocked, true);
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule, true);
    host?.remove();
    cursorStyle?.remove();
    hovered = rawTarget = lastResult = null;
    descent = [];
    selected = [];
  }

  api.picker = { toggle: () => (active ? stop() : start()) };

  async function loadOptions() {
    try {
      const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
      Object.assign(options, stored);
    } catch {}
    syncControls();
  }

  function saveOptions() {
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: options });
    } catch {}
  }

  // ---------------------------------------------------------------------------
  // Helpers

  const isOurs = (e) => e.composedPath().includes(host);

  function parentOf(node) {
    return node.parentElement || node.getRootNode()?.host || null;
  }

  const CONTENT_SELECTOR = 'img,svg,canvas,video,picture,input,textarea,select,iframe,object,embed';

  /** True for invisible click-through layers (stretched links, transparent shields) with nothing to draw. */
  function isEmptyLayer(el) {
    if (el === document.documentElement || el === document.body || el.shadowRoot) return false;
    if (el.matches(CONTENT_SELECTOR) || el.textContent.trim() || el.querySelector(CONTENT_SELECTOR)) return false;
    const cs = getComputedStyle(el);
    const paints =
      !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(cs.backgroundColor) ||
      cs.backgroundImage !== 'none' ||
      cs.boxShadow !== 'none' ||
      ['Top', 'Right', 'Bottom', 'Left'].some(
        (s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none',
      );
    return !paints;
  }

  /** The element under the pointer, piercing open shadow roots; whole <svg> icons rather than their paths. */
  function targetOf(e) {
    let t = e.composedPath()[0];
    if (!(t instanceof Element)) t = e.target;
    if (t instanceof Element && isEmptyLayer(t)) {
      // A stretched overlay (e.g. `<a class="absolute inset-0">`) stands for its container;
      // any other empty layer is skipped in favour of what's visible beneath it.
      const parent = parentOf(t);
      const a = t.getBoundingClientRect();
      const b = parent?.getBoundingClientRect();
      const covers =
        b && ['left', 'top', 'right', 'bottom'].every((k) => Math.abs(a[k] - b[k]) <= 4);
      const below = covers
        ? parent
        : document
            .elementsFromPoint(e.clientX, e.clientY)
            .find((el) => el !== host && !el.hasAttribute(UI_ATTR) && !isEmptyLayer(el));
      if (below) t = below;
    }
    while (t instanceof SVGElement && t.ownerSVGElement) t = t.ownerSVGElement;
    return t instanceof Element ? t : null;
  }

  function describe(el) {
    let s = el.localName;
    if (el.id) s += `#${el.id}`;
    const classes = [...(el.classList || [])].slice(0, 2);
    if (classes.length) s += `.${classes.join('.')}`;
    return s;
  }

  function place(box, rect) {
    Object.assign(box.style, {
      transform: `translate(${rect.left}px, ${rect.top}px)`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  function schedule() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      render();
    });
  }

  function slug(str) {
    return (
      str
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'element'
    );
  }

  function fileBase() {
    const page = slug(document.title || location.hostname);
    const el = selected.length === 1 ? slug(describe(selected[0])) : `${selected.length}-elements`;
    return `${page}--${el}`;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.setAttribute(UI_ATTR, '');
    shadow.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      shadow.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  // ---------------------------------------------------------------------------
  // Event handlers

  function onMove(e) {
    if (isOurs(e)) {
      if (!previewEl) hoverBox.hidden = true;
      return;
    }
    const t = targetOf(e);
    if (!t || t === rawTarget) return;
    rawTarget = hovered = t;
    descent = [];
    schedule();
  }

  function onBlocked(e) {
    if (isOurs(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'click' || previewEl) return;
    const t = targetOf(e);
    if (!t) return;
    // Respect ↑/↓ navigation if the pointer hasn't moved to another element.
    const el = t === rawTarget && hovered ? hovered : t;
    if (e.shiftKey || e.metaKey || e.ctrlKey) toggleSelected(el);
    else selected = [el];
    render();
  }

  function onKey(e) {
    if (previewEl) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closePreview();
      }
      return;
    }
    const handled = {
      Escape: () => stop(),
      ArrowUp: () => {
        const p = hovered && parentOf(hovered);
        if (p) {
          descent.push(hovered);
          hovered = p;
        }
      },
      ArrowDown: () => {
        if (descent.length) hovered = descent.pop();
        else {
          const child = [...(hovered?.children || [])].find((c) => !c.hasAttribute(UI_ATTR) && !isEmptyLayer(c));
          if (child) hovered = child;
        }
      },
      ' ': () => hovered && toggleSelected(hovered),
      Enter: () => exportSvg(),
    }[e.key];
    if (!handled) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    handled();
    if (active) render();
  }

  function toggleSelected(el) {
    const i = selected.indexOf(el);
    if (i >= 0) selected.splice(i, 1);
    else selected.push(el);
  }

  // ---------------------------------------------------------------------------
  // Rendering of overlay + toolbar state

  function render() {
    if (!active) return;
    selected = selected.filter((el) => el.isConnected);

    if (hovered?.isConnected && !previewEl) {
      const rect = hovered.getBoundingClientRect();
      place(hoverBox, rect);
      hoverBox.hidden = false;
      hoverLabel.textContent = `${describe(hovered)}  ${Math.round(rect.width)} × ${Math.round(rect.height)}`;
      hoverLabel.classList.toggle('inside', rect.top < 22);
    } else {
      hoverBox.hidden = true;
    }

    const layer = shadow.querySelector('.selections');
    while (layer.children.length > selected.length) layer.lastElementChild.remove();
    while (layer.children.length < selected.length) {
      const box = document.createElement('div');
      box.className = 'box selected';
      box.innerHTML = '<span class="badge"></span>';
      layer.append(box);
    }
    selected.forEach((el, i) => {
      const box = layer.children[i];
      place(box, el.getBoundingClientRect());
      box.firstElementChild.textContent = selected.length > 1 ? String(i + 1) : '';
    });

    const n = selected.length;
    toolbar.querySelector('.count').textContent = n ? `${n} selected` : 'Nothing selected';
    toolbar.querySelector('[data-act="export"]').disabled = n === 0;
    toolbar.querySelector('[data-act="clear"]').disabled = n === 0;
  }

  function syncControls() {
    if (!shadow) return;
    for (const seg of shadow.querySelectorAll('.seg')) {
      for (const btn of seg.querySelectorAll('button')) {
        btn.setAttribute('aria-pressed', String(options[seg.dataset.opt] === btn.dataset.v));
      }
    }
    for (const input of shadow.querySelectorAll('input[data-opt]')) input.checked = !!options[input.dataset.opt];
  }

  // ---------------------------------------------------------------------------
  // Export + preview

  async function exportSvg() {
    if (!selected.length) return;
    const run = ++exportRun;
    const btn = toolbar.querySelector('[data-act="export"]');
    btn.disabled = true;
    btn.textContent = 'Rendering…';
    status('Rendering…');
    try {
      const result = await api.toSvg(selected, options);
      if (run !== exportRun || !active) return;
      lastResult = result;
      showPreview(result);
    } catch (err) {
      console.error('Element to SVG:', err);
      flash(`Export failed: ${err.message || err}`);
    } finally {
      btn.textContent = 'Export SVG';
      if (active) render();
    }
  }

  function showPreview(result) {
    if (!previewEl) {
      previewEl = document.createElement('div');
      previewEl.className = 'backdrop';
      previewEl.innerHTML = `
        <div class="modal" role="dialog" aria-label="SVG preview">
          <header>
            <strong>SVG preview</strong>
            <span class="meta"></span>
            <div class="seg" data-opt="mode" role="group" aria-label="Style">
              <button data-v="styled">Styled</button><button data-v="wireframe">Wireframe</button>
            </div>
            <div class="seg" data-opt="text" role="group" aria-label="Text">
              <button data-v="text">Text</button><button data-v="blocks">Blocks</button>
            </div>
            <button class="icon" data-act="close" title="Back to picking (Esc)" aria-label="Close preview">✕</button>
          </header>
          <div class="stage"><div class="art"></div></div>
          <footer>
            <span class="status" role="status"></span>
            <button data-act="copy">Copy SVG</button>
            <button data-act="png">Download PNG</button>
            <button class="primary" data-act="download">Download SVG</button>
          </footer>
        </div>`;
      previewEl.addEventListener('click', (e) => {
        if (e.target === previewEl) closePreview();
        const btn = e.target.closest('button');
        const seg = btn?.closest('.seg');
        if (seg) {
          options[seg.dataset.opt] = btn.dataset.v;
          optionsChanged();
        }
        const act = btn?.dataset.act;
        if (act === 'close') closePreview();
        if (act === 'copy') onCopy();
        if (act === 'png') onPng();
        if (act === 'download') onDownload();
      });
      shadow.append(previewEl);
      hoverBox.hidden = true;
      toolbar.hidden = true;
      syncControls();
    }
    const doc = new DOMParser().parseFromString(result.svg, 'image/svg+xml');
    const art = previewEl.querySelector('.art');
    art.replaceChildren(document.importNode(doc.documentElement, true));
    const { elements, text, images } = result.stats;
    previewEl.querySelector('.meta').textContent =
      `${result.width} × ${result.height} · ${formatBytes(new Blob([result.svg]).size)} · ` +
      `${elements} boxes, ${text} text runs, ${images} images`;
    previewEl.querySelector('.status').textContent = result.empty
      ? 'Nothing visible in this element. Press Esc, then ↑ to select its parent.'
      : '';
  }

  function closePreview() {
    previewEl?.remove();
    previewEl = null;
    toolbar.hidden = false;
    render();
  }

  function status(msg) {
    const el = previewEl?.querySelector('.status');
    if (el) el.textContent = msg;
  }

  function flash(msg) {
    const hint = toolbar.querySelector('.hint');
    const prev = hint.textContent;
    hint.textContent = msg;
    hint.classList.add('error');
    setTimeout(() => {
      hint.textContent = prev;
      hint.classList.remove('error');
    }, 4000);
  }

  function onDownload() {
    if (!lastResult) return;
    download(new Blob([lastResult.svg], { type: 'image/svg+xml' }), `${fileBase()}.svg`);
    status('Saved SVG');
  }

  async function onCopy() {
    if (!lastResult) return;
    status((await copyText(lastResult.svg)) ? 'Copied SVG markup' : 'Copy failed');
  }

  async function onPng() {
    if (!lastResult) return;
    const scale = 2;
    const url = URL.createObjectURL(new Blob([lastResult.svg], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = lastResult.width * scale;
      canvas.height = lastResult.height * scale;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('canvas is empty');
      download(blob, `${fileBase()}@2x.png`);
      status('Saved PNG (2×)');
    } catch (err) {
      status(`PNG export failed: ${err.message || err}`);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ---------------------------------------------------------------------------
  // UI construction

  function buildUi() {
    host = document.createElement('div');
    host.setAttribute(UI_ATTR, '');
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="selections"></div>
      <div class="box hover" hidden><span class="label"></span></div>
      <div class="toolbar" role="toolbar" aria-label="Element to SVG">
        <div class="head">
          <span class="logo" aria-hidden="true"></span>
          <strong>Element → SVG</strong>
          <span class="count"></span>
          <button class="icon" data-act="quit" title="Quit (Esc)" aria-label="Quit">✕</button>
        </div>
        <div class="row">
          <div class="seg" data-opt="mode" role="group" aria-label="Style">
            <button data-v="styled">Styled</button><button data-v="wireframe">Wireframe</button>
          </div>
          <div class="seg" data-opt="text" role="group" aria-label="Text">
            <button data-v="text">Text</button><button data-v="blocks">Blocks</button>
          </div>
        </div>
        <div class="row">
          <label><input type="checkbox" data-opt="background"> Background</label>
          <label><input type="checkbox" data-opt="embedImages"> Embed images</label>
        </div>
        <div class="row actions">
          <button data-act="clear">Clear</button>
          <button class="primary" data-act="export">Export SVG</button>
        </div>
        <p class="hint">Click to select · ⇧-click to add · ↑/↓ parent/child · Space toggle · Enter export · Esc quit</p>
      </div>`;
    hoverBox = shadow.querySelector('.box.hover');
    hoverLabel = hoverBox.querySelector('.label');
    toolbar = shadow.querySelector('.toolbar');

    toolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const seg = btn.closest('.seg');
      if (seg) {
        options[seg.dataset.opt] = btn.dataset.v;
        optionsChanged();
      }
      if (btn.dataset.act === 'quit') stop();
      if (btn.dataset.act === 'clear') {
        selected = [];
        render();
      }
      if (btn.dataset.act === 'export') exportSvg();
    });
    toolbar.addEventListener('change', (e) => {
      const opt = e.target.dataset.opt;
      if (!opt) return;
      options[opt] = e.target.checked;
      optionsChanged();
    });
    makeDraggable(toolbar, toolbar.querySelector('.head'));

    cursorStyle = document.createElement('style');
    cursorStyle.setAttribute(UI_ATTR, '');
    cursorStyle.textContent = '* { cursor: crosshair !important; }';

    document.documentElement.append(host);
    (document.head || document.documentElement).append(cursorStyle);
    syncControls();
    render();
  }

  function optionsChanged() {
    syncControls();
    saveOptions();
    if (previewEl) exportSvg();
  }

  function makeDraggable(panel, handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const x = Math.min(Math.max(0, ev.clientX - dx), innerWidth - rect.width);
        const y = Math.min(Math.max(0, ev.clientY - dy), innerHeight - rect.height);
        Object.assign(panel.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }

    .selections, .box { position: fixed; top: 0; left: 0; pointer-events: none; z-index: 2147483646; }
    .box { border-radius: 2px; }
    .box.hover { outline: 2px solid #2563eb; background: rgba(37, 99, 235, 0.12); }
    .box.selected { outline: 2px dashed #db2777; background: rgba(219, 39, 119, 0.08); }
    .label, .badge {
      position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px;
      font: 600 11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 0 6px; border-radius: 4px; white-space: nowrap; color: #fff; background: #2563eb;
    }
    .label.inside { bottom: auto; top: 2px; left: 2px; margin: 0; }
    .badge { background: #db2777; }
    .badge:empty { display: none; }

    .toolbar, .modal {
      --bg: #ffffff; --fg: #111827; --muted: #6b7280; --line: #e5e7eb; --chip: #f3f4f6; --accent: #2563eb;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg);
      border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
    }
    @media (prefers-color-scheme: dark) {
      .toolbar, .modal { --bg: #1f2937; --fg: #f9fafb; --muted: #9ca3af; --line: #374151; --chip: #111827; --accent: #3b82f6; }
    }
    .toolbar {
      position: fixed; right: 16px; bottom: 16px; width: 330px; max-width: calc(100vw - 32px);
      padding: 10px 12px 8px; z-index: 2147483647; display: grid; gap: 8px;
    }
    .head { display: flex; align-items: center; gap: 8px; cursor: move; user-select: none; }
    .head strong { font-weight: 650; }
    .logo {
      width: 18px; height: 18px; border-radius: 5px; flex: none;
      background: linear-gradient(135deg, #2563eb, #db2777);
      box-shadow: inset 0 0 0 3px var(--bg), inset 0 0 0 4px rgba(255,255,255,0.6);
    }
    .count { color: var(--muted); margin-left: auto; font-size: 12px; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .row label { display: inline-flex; gap: 5px; align-items: center; color: var(--fg); cursor: pointer; }
    .row input { margin: 0; accent-color: var(--accent); }
    .actions { justify-content: flex-end; }
    .hint { margin: 0; font-size: 11px; color: var(--muted); }
    .hint.error { color: #dc2626; }

    button {
      font: inherit; color: var(--fg); background: var(--chip); border: 1px solid var(--line);
      border-radius: 7px; padding: 5px 10px; cursor: pointer;
    }
    button:hover:not(:disabled) { border-color: var(--muted); }
    button:disabled { opacity: 0.45; cursor: default; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
    button.icon { background: none; border: none; padding: 2px 6px; color: var(--muted); }
    .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; padding: 2px; background: var(--chip); }
    .seg button { border: none; background: none; padding: 3px 9px; border-radius: 6px; color: var(--muted); }
    .seg button[aria-pressed="true"] { background: var(--bg); color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,0.15); }

    .backdrop {
      position: fixed; inset: 0; z-index: 2147483646; background: rgba(17, 24, 39, 0.55);
      display: grid; place-items: center; padding: 24px;
    }
    .modal {
      width: min(960px, 100%); max-height: calc(100vh - 48px); display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden;
    }
    .modal header, .modal footer { display: flex; align-items: center; gap: 8px; padding: 10px 14px; }
    .modal header { border-bottom: 1px solid var(--line); flex-wrap: wrap; }
    .modal footer { border-top: 1px solid var(--line); justify-content: flex-end; }
    .meta { color: var(--muted); font-size: 12px; margin-right: auto; }
    .status { color: var(--muted); font-size: 12px; margin-right: auto; }
    .stage {
      overflow: auto; padding: 24px; display: grid; place-items: center; min-height: 160px;
      background-color: #fff;
      background-image: conic-gradient(#eef0f3 25%, transparent 0 50%, #eef0f3 0 75%, transparent 0);
      background-size: 16px 16px;
    }
    .art svg { display: block; max-width: 100%; height: auto; box-shadow: 0 0 0 1px rgba(0,0,0,0.08); }
  `;

  start();
})();
