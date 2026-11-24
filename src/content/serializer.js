// DOM → SVG converter.
//
// Walks the rendered DOM under the selected elements and rebuilds it with SVG
// primitives using live layout data (getBoundingClientRect, text ranges) and
// computed styles. Exposed as globalThis.__elementToSvg.toSvg(elements, options).
(() => {
  'use strict';

  const api = (globalThis.__elementToSvg ||= {});
  if (api.toSvg) return;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
  const XML_NS = 'http://www.w3.org/XML/1998/namespace';
  const UI_ATTR = 'data-el2svg-ui';

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base',
  ]);
  const REPLACED_TAGS = new Set([
    'img', 'svg', 'canvas', 'video', 'audio', 'input', 'textarea', 'select', 'iframe', 'embed', 'object',
  ]);

  const DEFAULTS = {
    mode: 'styled', // 'styled' | 'wireframe'
    text: 'text', // 'text' | 'blocks'
    background: true, // paint the nearest opaque ancestor background behind the selection
    embedImages: true, // inline images as data: URLs so the SVG is self-contained
  };

  const WIREFRAME = {
    stroke: '#94a3b8',
    fill: '#f1f5f9',
    text: '#334155',
    bar: '#cbd5e1',
    media: '#e2e8f0',
  };

  // ---------------------------------------------------------------------------
  // Small helpers

  const round = (n) => Math.round(n * 100) / 100;

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === '') continue;
        node.setAttribute(key, typeof value === 'number' ? round(value) : value);
      }
    }
    return node;
  }

  function uid(ctx, prefix) {
    ctx.n += 1;
    return `el2svg-${prefix}-${ctx.n}`;
  }

  /** Split a CSS value on top-level commas (ignoring commas inside parentheses). */
  function splitTop(value, sep = ',') {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of value) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === sep && depth === 0) {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  const px = (cs, prop) => parseFloat(cs[prop]) || 0;

  function absUrl(url) {
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return url;
    }
  }

  // ---------------------------------------------------------------------------
  // Colors

  const colorCache = new Map();
  let colorCtx;

  /** Parse any computed CSS color into sRGB bytes + alpha. */
  function parseColor(value) {
    if (!value) return null;
    if (colorCache.has(value)) return colorCache.get(value);
    let out;
    const m = value.match(
      /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/,
    );
    if (m) {
      const a = m[4] === undefined ? 1 : parseFloat(m[4]) / (m[5] ? 100 : 1);
      out = { r: +m[1], g: +m[2], b: +m[3], a };
    } else if (value === 'transparent') {
      out = { r: 0, g: 0, b: 0, a: 0 };
    } else {
      // oklch(), color(display-p3 …), etc. — let the canvas convert to sRGB.
      if (!colorCtx) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        colorCtx = canvas.getContext('2d', { willReadFrequently: true });
      }
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = '#000';
      colorCtx.fillStyle = value;
      colorCtx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = colorCtx.getImageData(0, 0, 1, 1).data;
      out = { r, g, b, a: a / 255 };
    }
    colorCache.set(value, out);
    return out;
  }

  const visibleColor = (value) => (parseColor(value)?.a ?? 0) > 0;

  function hex({ r, g, b }) {
    return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  }

  /** Set fill/stroke (+ -opacity) from a CSS color. Uses hex + opacity for wide tool support. */
  function applyColor(node, cssColor, attr = 'fill') {
    const c = parseColor(cssColor);
    if (!c || c.a === 0) {
      node.setAttribute(attr, 'none');
      return false;
    }
    node.setAttribute(attr, hex(c));
    if (c.a < 1) node.setAttribute(`${attr}-opacity`, round(c.a));
    return true;
  }

  // ---------------------------------------------------------------------------
  // Geometry: boxes, radii, shapes

  function borderWidths(cs) {
    return {
      t: px(cs, 'borderTopWidth'),
      r: px(cs, 'borderRightWidth'),
      b: px(cs, 'borderBottomWidth'),
      l: px(cs, 'borderLeftWidth'),
    };
  }

  function insetBox(box, t, r, b, l) {
    return { x: box.x + l, y: box.y + t, w: Math.max(0, box.w - l - r), h: Math.max(0, box.h - t - b) };
  }

  function paddingBox(cs, box) {
    const bw = borderWidths(cs);
    return insetBox(box, bw.t, bw.r, bw.b, bw.l);
  }

  function contentBox(cs, box) {
    const bw = borderWidths(cs);
    return insetBox(
      box,
      bw.t + px(cs, 'paddingTop'),
      bw.r + px(cs, 'paddingRight'),
      bw.b + px(cs, 'paddingBottom'),
      bw.l + px(cs, 'paddingLeft'),
    );
  }

  /** Corner radii as [[rx, ry] × tl, tr, br, bl], scaled down like CSS does when they overflow. */
  function radii(cs, w, h) {
    const len = (v, ref) => (v.endsWith('%') ? (parseFloat(v) * ref) / 100 : parseFloat(v) || 0);
    const corner = (v) => {
      const [a, b = a] = v.split(' ');
      return [len(a, w), len(b, h)];
    };
    const r = [
      cs.borderTopLeftRadius,
      cs.borderTopRightRadius,
      cs.borderBottomRightRadius,
      cs.borderBottomLeftRadius,
    ].map(corner);
    const f = Math.min(
      1,
      w / (r[0][0] + r[1][0]) || 1,
      w / (r[3][0] + r[2][0]) || 1,
      h / (r[0][1] + r[3][1]) || 1,
      h / (r[1][1] + r[2][1]) || 1,
    );
    return r.map(([x, y]) => [x * f, y * f]);
  }

  const hasRadius = (r) => !!r && r.some(([x, y]) => x > 0 && y > 0);

  function insetRadii(r, t, ri, b, l) {
    const c = (v, d) => Math.max(0, v - d);
    return [
      [c(r[0][0], l), c(r[0][1], t)],
      [c(r[1][0], ri), c(r[1][1], t)],
      [c(r[2][0], ri), c(r[2][1], b)],
      [c(r[3][0], l), c(r[3][1], b)],
    ];
  }

  /** A rect, rounded rect, or path for boxes with uneven corners. */
  function shape(box, r, attrs = {}) {
    const { x, y, w, h } = box;
    if (!hasRadius(r)) return svgEl('rect', { x, y, width: w, height: h, ...attrs });
    const same = r.every(([a, b]) => a === r[0][0] && b === r[0][1]);
    if (same) {
      return svgEl('rect', { x, y, width: w, height: h, rx: r[0][0], ry: r[0][1], ...attrs });
    }
    const [[tlx, tly], [trx, try_], [brx, bry], [blx, bly]] = r.map((c) => c.map(round));
    const n = round;
    const d =
      `M${n(x + tlx)},${n(y)} H${n(x + w - trx)} ` +
      `A${trx},${try_} 0 0 1 ${n(x + w)},${n(y + try_)} V${n(y + h - bry)} ` +
      `A${brx},${bry} 0 0 1 ${n(x + w - brx)},${n(y + h)} H${n(x + blx)} ` +
      `A${blx},${bly} 0 0 1 ${n(x)},${n(y + h - bly)} V${n(y + tly)} ` +
      `A${tlx},${tly} 0 0 1 ${n(x + tlx)},${n(y)} Z`;
    return svgEl('path', { d, ...attrs });
  }

  function clipPath(ctx, box, r) {
    const id = uid(ctx, 'clip');
    const cp = svgEl('clipPath', { id });
    cp.append(shape(box, r));
    ctx.defs.append(cp);
    return id;
  }

  function clipped(ctx, box, r) {
    return svgEl('g', { 'clip-path': `url(#${clipPath(ctx, box, r)})` });
  }

  // ---------------------------------------------------------------------------
  // Shadows

  function parseShadows(value) {
    if (!value || value === 'none') return [];
    return splitTop(value).map((s) => {
      const inset = /\binset\b/.test(s);
      const color = s.match(/[a-z-]+\([^)]*\)|#[0-9a-f]{3,8}\b/i)?.[0] || 'rgb(0, 0, 0)';
      const nums = s
        .replace(color, '')
        .replace('inset', '')
        .trim()
        .split(/\s+/)
        .map(parseFloat)
        .filter((n) => !Number.isNaN(n));
      const [x = 0, y = 0, blur = 0, spread = 0] = nums;
      return { inset, color, x, y, blur, spread };
    });
  }

  /** How far outer box-shadows reach beyond the box, per side. */
  function shadowReach(cs) {
    const reach = { t: 0, r: 0, b: 0, l: 0 };
    for (const s of parseShadows(cs.boxShadow)) {
      if (s.inset || !visibleColor(s.color)) continue;
      const e = s.blur + s.spread;
      reach.t = Math.max(reach.t, e - s.y);
      reach.b = Math.max(reach.b, e + s.y);
      reach.l = Math.max(reach.l, e - s.x);
      reach.r = Math.max(reach.r, e + s.x);
    }
    return reach;
  }

  function paintShadows(cs, box, r, g, ctx) {
    const shadows = parseShadows(cs.boxShadow).filter((s) => !s.inset && visibleColor(s.color));
    // The first shadow in the list is painted on top.
    for (const s of shadows.reverse()) {
      const sbox = {
        x: box.x + s.x - s.spread,
        y: box.y + s.y - s.spread,
        w: Math.max(0, box.w + 2 * s.spread),
        h: Math.max(0, box.h + 2 * s.spread),
      };
      const sr = r.map(([a, b]) => [a ? Math.max(0, a + s.spread) : 0, b ? Math.max(0, b + s.spread) : 0]);
      const node = shape(sbox, sr);
      applyColor(node, s.color);
      if (s.blur > 0) {
        const id = uid(ctx, 'shadow');
        const pad = s.blur * 1.5;
        const filter = svgEl('filter', {
          id,
          filterUnits: 'userSpaceOnUse',
          x: sbox.x - pad,
          y: sbox.y - pad,
          width: sbox.w + 2 * pad,
          height: sbox.h + 2 * pad,
        });
        filter.append(svgEl('feGaussianBlur', { stdDeviation: s.blur / 2 }));
        ctx.defs.append(filter);
        node.setAttribute('filter', `url(#${id})`);
      }
      g.append(node);
    }
  }

  // ---------------------------------------------------------------------------
  // Gradients

  function angleToDeg(v) {
    const n = parseFloat(v);
    if (v.endsWith('rad')) return (n * 180) / Math.PI;
    if (v.endsWith('turn')) return n * 360;
    if (v.endsWith('grad')) return n * 0.9;
    return n;
  }

  /** Parse color stops into [{offset 0–1, color}], distributing missing positions like CSS. */
  function parseStops(args, length) {
    const stops = [];
    for (const arg of args) {
      const color = arg.match(/^([a-z-]+\([^)]*\)|#[0-9a-f]{3,8}\b|[a-z]+)/i)?.[0];
      if (!color) continue; // color hint (bare length) — ignored
      const positions = arg
        .slice(color.length)
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((p) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / length));
      if (!positions.length) stops.push({ color, offset: null });
      for (const offset of positions) stops.push({ color, offset });
    }
    if (!stops.length) return stops;
    if (stops[0].offset === null) stops[0].offset = 0;
    if (stops[stops.length - 1].offset === null) stops[stops.length - 1].offset = 1;
    for (let i = 1; i < stops.length; i++) {
      if (stops[i].offset !== null) continue;
      let j = i;
      while (stops[j].offset === null) j++;
      const from = stops[i - 1].offset;
      const step = (stops[j].offset - from) / (j - i + 1);
      for (let k = i; k < j; k++) stops[k].offset = from + step * (k - i + 1);
    }
    let prev = 0;
    for (const s of stops) prev = s.offset = Math.min(1, Math.max(prev, s.offset));
    return stops;
  }

  function appendStops(gradient, stops) {
    for (const s of stops) {
      const c = parseColor(s.color) || { r: 0, g: 0, b: 0, a: 0 };
      gradient.append(
        svgEl('stop', {
          offset: round(s.offset),
          'stop-color': hex(c),
          'stop-opacity': c.a < 1 ? round(c.a) : undefined,
        }),
      );
    }
  }

  /** Build an SVG paint server for a CSS gradient. Returns its id, or null if unsupported. */
  function gradient(value, box, ctx) {
    let m = value.match(/^linear-gradient\((.*)\)$/s);
    if (m) {
      const args = splitTop(m[1]);
      let angle = 180;
      if (/^-?[\d.]+(deg|rad|turn|grad)$/.test(args[0])) {
        angle = angleToDeg(args.shift());
      } else if (args[0]?.startsWith('to ')) {
        const dir = args.shift();
        const sx = dir.includes('right') ? 1 : dir.includes('left') ? -1 : 0;
        const sy = dir.includes('bottom') ? 1 : dir.includes('top') ? -1 : 0;
        if (sx && sy) {
          // Corner keywords: the gradient line is perpendicular to the diagonal between the other corners.
          angle = (Math.atan2(sx * box.h, -(sy * box.w)) * 180) / Math.PI;
        } else if (sx) {
          angle = sx > 0 ? 90 : 270;
        } else {
          angle = sy > 0 ? 180 : 0;
        }
      }
      const rad = (angle * Math.PI) / 180;
      const dx = Math.sin(rad);
      const dy = -Math.cos(rad);
      const len = Math.abs(box.w * dx) + Math.abs(box.h * dy);
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const id = uid(ctx, 'grad');
      const lg = svgEl('linearGradient', {
        id,
        gradientUnits: 'userSpaceOnUse',
        x1: cx - (dx * len) / 2,
        y1: cy - (dy * len) / 2,
        x2: cx + (dx * len) / 2,
        y2: cy + (dy * len) / 2,
      });
      appendStops(lg, parseStops(args, len || 1));
      ctx.defs.append(lg);
      return id;
    }

    m = value.match(/^radial-gradient\((.*)\)$/s);
    if (m) {
      const args = splitTop(m[1]);
      let cx = 0.5;
      let cy = 0.5;
      if (args[0] && /\b(at|circle|ellipse|closest|farthest)\b/.test(args[0])) {
        const at = args.shift().split(/\bat\b/)[1]?.trim().split(/\s+/) || [];
        const pct = (v, d) => (v?.endsWith('%') ? parseFloat(v) / 100 : d);
        cx = pct(at[0], at[0] === 'left' ? 0 : at[0] === 'right' ? 1 : 0.5);
        cy = pct(at[1], at[1] === 'top' ? 0 : at[1] === 'bottom' ? 1 : 0.5);
      }
      const id = uid(ctx, 'grad');
      // Ellipse, farthest-corner, in bounding-box units.
      const rg = svgEl('radialGradient', { id, cx, cy, r: Math.SQRT1_2 });
      appendStops(rg, parseStops(args, Math.hypot(box.w, box.h) / 2 || 1));
      ctx.defs.append(rg);
      return id;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Images

  const dataUrlCache = new Map();

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  /** Resolve a URL to a data: URL, via the background worker for cross-origin resources. */
  function toDataUrl(url, sourceImg) {
    if (url.startsWith('data:')) return Promise.resolve(url);
    if (!dataUrlCache.has(url)) {
      dataUrlCache.set(
        url,
        (async () => {
          if (url.startsWith('blob:')) {
            try {
              return await blobToDataUrl(await (await fetch(url)).blob());
            } catch {}
          }
          try {
            const res = await globalThis.chrome?.runtime?.sendMessage?.({ type: 'el2svg:fetch-data-url', url });
            if (res?.dataUrl) return res.dataUrl;
          } catch {}
          try {
            const res = await fetch(url);
            if (res.ok) return await blobToDataUrl(await res.blob());
          } catch {}
          if (sourceImg?.complete && sourceImg.naturalWidth) {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = sourceImg.naturalWidth;
              canvas.height = sourceImg.naturalHeight;
              canvas.getContext('2d').drawImage(sourceImg, 0, 0);
              return canvas.toDataURL('image/png');
            } catch {}
          }
          return null;
        })(),
      );
    }
    return dataUrlCache.get(url);
  }

  async function resolveHref(url, ctx, sourceImg) {
    const abs = absUrl(url);
    if (!ctx.opts.embedImages) return abs;
    return (await toDataUrl(abs, sourceImg)) || abs;
  }

  function setHref(node, href) {
    node.setAttributeNS(XLINK_NS, 'xlink:href', href);
  }

  async function naturalSize(href) {
    const img = new Image();
    img.src = href;
    try {
      await img.decode();
      return img.naturalWidth ? { w: img.naturalWidth, h: img.naturalHeight } : null;
    } catch {
      return null;
    }
  }

  /** preserveAspectRatio alignment from a CSS position like "50% 0%". */
  function alignFor(position) {
    const [x = '50%', y = '50%'] = (position || '').split(' ');
    const axis = (v, a) => {
      const n = parseFloat(v);
      if (v === `${a === 'x' ? 'left' : 'top'}` || n === 0) return 'Min';
      if (v === `${a === 'x' ? 'right' : 'bottom'}` || n === 100) return 'Max';
      return 'Mid';
    };
    return `x${axis(x, 'x')}Y${axis(y, 'y')}`;
  }

  function mediaPlaceholder(g, box, r) {
    g.append(shape(box, r, { fill: WIREFRAME.media, stroke: WIREFRAME.stroke, 'stroke-width': 1 }));
    const { x, y, w, h } = box;
    g.append(
      svgEl('path', {
        d: `M${round(x)},${round(y)} L${round(x + w)},${round(y + h)} M${round(x + w)},${round(y)} L${round(x)},${round(y + h)}`,
        stroke: WIREFRAME.stroke,
        'stroke-width': 1,
        fill: 'none',
      }),
    );
  }

  function pushImage(g, box, src, fit, position, natural, ctx, sourceImg) {
    let par = 'none';
    let ibox = box;
    const align = alignFor(position);
    if (fit === 'contain') par = `${align} meet`;
    else if (fit === 'cover') par = `${align} slice`;
    else if ((fit === 'none' || fit === 'scale-down') && natural) {
      if (fit === 'scale-down' && (natural.w > box.w || natural.h > box.h)) {
        par = `${align} meet`;
      } else {
        const [px_ = '50%', py_ = '50%'] = (position || '').split(' ');
        const off = (v, free) => (v.endsWith('%') ? (free * parseFloat(v)) / 100 : parseFloat(v) || 0);
        ibox = {
          x: box.x + off(px_, box.w - natural.w),
          y: box.y + off(py_, box.h - natural.h),
          w: natural.w,
          h: natural.h,
        };
      }
    }
    const image = svgEl('image', {
      x: ibox.x,
      y: ibox.y,
      width: ibox.w,
      height: ibox.h,
      preserveAspectRatio: par,
    });
    setHref(image, absUrl(src));
    g.append(image);
    ctx.stats.images++;
    ctx.tasks.push(resolveHref(src, ctx, sourceImg).then((href) => setHref(image, href)));
  }

  // ---------------------------------------------------------------------------
  // Backgrounds and borders

  function backgroundBox(cs, box, r) {
    const clip = splitTop(cs.backgroundClip)[0];
    const bw = borderWidths(cs);
    if (clip === 'padding-box') {
      return [paddingBox(cs, box), insetRadii(r, bw.t, bw.r, bw.b, bw.l)];
    }
    if (clip === 'content-box') {
      const t = bw.t + px(cs, 'paddingTop');
      const ri = bw.r + px(cs, 'paddingRight');
      const b = bw.b + px(cs, 'paddingBottom');
      const l = bw.l + px(cs, 'paddingLeft');
      return [contentBox(cs, box), insetRadii(r, t, ri, b, l)];
    }
    return [box, r];
  }

  function paintBackgroundUrl(url, index, cs, box, r, g, ctx) {
    const pick = (list) => {
      const parts = splitTop(list);
      return parts[index] ?? parts[parts.length - 1] ?? '';
    };
    const size = pick(cs.backgroundSize);
    const position = pick(cs.backgroundPosition);
    const repeat = pick(cs.backgroundRepeat);
    const holder = clipped(ctx, box, r);
    g.append(holder);
    ctx.stats.images++;

    ctx.tasks.push(
      (async () => {
        const href = await resolveHref(url, ctx);
        const nat = (await naturalSize(href)) || { w: box.w, h: box.h };
        let iw;
        let ih;
        if (size === 'cover' || size === 'contain') {
          const s = (size === 'cover' ? Math.max : Math.min)(box.w / nat.w, box.h / nat.h);
          iw = nat.w * s;
          ih = nat.h * s;
        } else {
          const [a = 'auto', b = 'auto'] = size.split(' ');
          const len = (v, ref) => (v === 'auto' ? null : v.endsWith('%') ? (ref * parseFloat(v)) / 100 : parseFloat(v));
          iw = len(a, box.w);
          ih = len(b, box.h);
          if (iw === null && ih === null) [iw, ih] = [nat.w, nat.h];
          else if (iw === null) iw = (ih * nat.w) / nat.h;
          else if (ih === null) ih = (iw * nat.h) / nat.w;
        }
        if (!iw || !ih) return;
        const [posX = '0%', posY = '0%'] = position.split(' ');
        const off = (v, free) => (v.endsWith('%') ? (free * parseFloat(v)) / 100 : parseFloat(v) || 0);
        const ix = box.x + off(posX, box.w - iw);
        const iy = box.y + off(posY, box.h - ih);

        const [rx, ry = rx] = repeat.split(' ');
        const repeatX = repeat === 'repeat-x' || (repeat !== 'repeat-y' && rx !== 'no-repeat');
        const repeatY = repeat === 'repeat-y' || (repeat !== 'repeat-x' && ry !== 'no-repeat');

        const image = svgEl('image', { x: 0, y: 0, width: iw, height: ih, preserveAspectRatio: 'none' });
        setHref(image, href);
        if (!repeatX && !repeatY) {
          image.setAttribute('x', round(ix));
          image.setAttribute('y', round(iy));
          holder.append(image);
          return;
        }
        const id = uid(ctx, 'pattern');
        const pattern = svgEl('pattern', { id, patternUnits: 'userSpaceOnUse', x: ix, y: iy, width: iw, height: ih });
        pattern.append(image);
        ctx.defs.append(pattern);
        holder.append(
          svgEl('rect', {
            x: repeatX ? box.x : ix,
            y: repeatY ? box.y : iy,
            width: repeatX ? box.w : iw,
            height: repeatY ? box.h : ih,
            fill: `url(#${id})`,
          }),
        );
      })(),
    );
  }

  function readBorders(cs) {
    return ['Top', 'Right', 'Bottom', 'Left'].map((side) => {
      const width = px(cs, `border${side}Width`);
      const style = cs[`border${side}Style`];
      const color = cs[`border${side}Color`];
      const visible = width > 0 && style !== 'none' && style !== 'hidden' && visibleColor(color);
      return { width, style, color, visible };
    });
  }

  function dashFor(node, style, w) {
    if (style === 'dashed') node.setAttribute('stroke-dasharray', `${round(w * 3)} ${round(w * 3)}`);
    if (style === 'dotted') {
      node.setAttribute('stroke-dasharray', `0 ${round(w * 2)}`);
      node.setAttribute('stroke-linecap', 'round');
    }
  }

  function paintBorders(borders, box, r, g) {
    if (!borders.some((s) => s.visible)) return;
    const [top] = borders;
    const uniform = borders.every(
      (s) => s.visible && s.width === top.width && s.style === top.style && s.color === top.color,
    );
    if (uniform) {
      const w = top.width;
      const half = w / 2;
      const node = shape(
        { x: box.x + half, y: box.y + half, w: Math.max(0, box.w - w), h: Math.max(0, box.h - w) },
        r.map(([x, y]) => [Math.max(0, x - half), Math.max(0, y - half)]),
        { fill: 'none', 'stroke-width': w },
      );
      applyColor(node, top.color, 'stroke');
      dashFor(node, top.style, w);
      g.append(node);
      return;
    }

    // Uneven borders: one trapezoid per side (mitred corners, radius ignored).
    const { x, y, w, h } = box;
    const [t, ri, b, l] = borders.map((s) => (s.visible ? s.width : 0));
    const outer = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    const inner = [[x + l, y + t], [x + w - ri, y + t], [x + w - ri, y + h - b], [x + l, y + h - b]];
    borders.forEach((side, i) => {
      if (!side.visible) return;
      const j = (i + 1) % 4;
      if (side.style === 'dashed' || side.style === 'dotted') {
        const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        const a = mid(outer[i], inner[i]);
        const c = mid(outer[j], inner[j]);
        const line = svgEl('line', { x1: a[0], y1: a[1], x2: c[0], y2: c[1], 'stroke-width': side.width });
        applyColor(line, side.color, 'stroke');
        dashFor(line, side.style, side.width);
        g.append(line);
        return;
      }
      const pts = [outer[i], outer[j], inner[j], inner[i]].map((p) => p.map(round).join(',')).join(' ');
      const poly = svgEl('polygon', { points: pts });
      applyColor(poly, side.color);
      g.append(poly);
    });
  }

  function paintBox(node, cs, box, r, g, ctx) {
    const borders = readBorders(cs);
    const clipText = splitTop(cs.backgroundClip)[0] === 'text';

    if (ctx.opts.mode === 'wireframe') {
      if (clipText) ctx.textPaint.set(node, WIREFRAME.text);
      const hasBg = !clipText && (visibleColor(cs.backgroundColor) || cs.backgroundImage !== 'none');
      const hasBorder = borders.some((s) => s.visible);
      const hasShadow = parseShadows(cs.boxShadow).some((s) => visibleColor(s.color));
      if (hasBg || hasBorder || hasShadow || ctx.roots.has(node)) {
        g.append(
          shape(box, r, {
            fill: hasBg ? WIREFRAME.fill : 'none',
            stroke: WIREFRAME.stroke,
            'stroke-width': 1,
          }),
        );
      }
      return;
    }

    paintShadows(cs, box, r, g, ctx);

    const [bgBox, bgRadii] = backgroundBox(cs, box, r);
    if (!clipText && visibleColor(cs.backgroundColor)) {
      const bg = shape(bgBox, bgRadii);
      applyColor(bg, cs.backgroundColor);
      g.append(bg);
    }

    const layers = cs.backgroundImage === 'none' ? [] : splitTop(cs.backgroundImage);
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      const url = layer.match(/^url\(\s*["']?(.*?)["']?\s*\)$/)?.[1];
      if (url) {
        if (!clipText) paintBackgroundUrl(url, i, cs, bgBox, bgRadii, g, ctx);
        continue;
      }
      const id = gradient(layer, box, ctx);
      if (!id) continue;
      // background-clip: text → the gradient becomes the fill of the text inside.
      if (clipText) ctx.textPaint.set(node, `url(#${id})`);
      else g.append(shape(bgBox, bgRadii, { fill: `url(#${id})` }));
    }

    paintBorders(borders, box, r, g);
  }

  // ---------------------------------------------------------------------------
  // Text

  const metricsCache = new Map();
  let measureCtx;

  function fontString(cs) {
    const style = cs.fontStyle.startsWith('oblique') ? 'oblique' : cs.fontStyle;
    return `${style} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  }

  function fontMetrics(cs) {
    const font = fontString(cs);
    if (metricsCache.has(font)) return metricsCache.get(font);
    measureCtx ||= document.createElement('canvas').getContext('2d');
    measureCtx.font = font;
    const size = parseFloat(cs.fontSize) || 16;
    const m = measureCtx.measureText('Hxgjy');
    const ascent = m.fontBoundingBoxAscent ?? size * 0.8;
    const descent = m.fontBoundingBoxDescent ?? size * 0.2;
    const xHeight = measureCtx.measureText('x').actualBoundingBoxAscent || size * 0.5;
    const out = { ascent, descent, height: ascent + descent, xHeight, size };
    metricsCache.set(font, out);
    return out;
  }

  function measureWidth(cs, str) {
    measureCtx ||= document.createElement('canvas').getContext('2d');
    measureCtx.font = fontString(cs);
    return measureCtx.measureText(str).width;
  }

  const lineRange = document.createRange();

  /** Split a text node into its rendered lines: [{start, end, top, height, left, right}]. */
  function measureLines(node) {
    const data = node.data;
    const lines = [];
    const place = (r, start, end) => {
      if (!r.width || !r.height) return;
      const last = lines[lines.length - 1];
      if (last && Math.abs(r.top - last.top) < Math.max(1, last.height / 2)) {
        last.end = end;
        last.left = Math.min(last.left, r.left);
        last.right = Math.max(last.right, r.right);
      } else {
        lines.push({ start, end, top: r.top, height: r.height, left: r.left, right: r.right });
      }
    };
    const re = /\S+/g;
    let m;
    while ((m = re.exec(data))) {
      const start = m.index;
      const end = start + m[0].length;
      lineRange.setStart(node, start);
      lineRange.setEnd(node, end);
      const rects = lineRange.getClientRects();
      if (rects.length === 1) {
        place(rects[0], start, end);
      } else if (rects.length > 1) {
        // The word itself wraps (long URLs, CJK runs): fall back to per-character.
        for (let i = start; i < end; ) {
          const step = data.codePointAt(i) > 0xffff ? 2 : 1;
          lineRange.setStart(node, i);
          lineRange.setEnd(node, i + step);
          const r = lineRange.getClientRects()[0];
          if (r) place(r, i, i + step);
          i += step;
        }
      }
    }
    return lines;
  }

  /** Right content edge of the block that truncates this text with an ellipsis, if any. */
  function ellipsisEdge(node) {
    for (let el = node.parentElement; el; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.textOverflow === 'ellipsis' && cs.overflowX !== 'visible') {
        return el.getBoundingClientRect().right - px(cs, 'borderRightWidth') - px(cs, 'paddingRight');
      }
      if (!cs.display.startsWith('inline')) return null;
    }
    return null;
  }

  /** Shorten a measured line so that it plus an ellipsis fits before `limit`. */
  function truncateLine(node, line, limit) {
    const data = node.data;
    let end = line.start;
    let right = line.left;
    for (let i = line.start; i < line.end; ) {
      const step = data.codePointAt(i) > 0xffff ? 2 : 1;
      lineRange.setStart(node, i);
      lineRange.setEnd(node, i + step);
      const r = lineRange.getClientRects()[0];
      if (r && r.right > limit) break;
      i += step;
      if (r) [end, right] = [i, r.right];
    }
    while (end > line.start && /\s/.test(data[end - 1])) end--;
    return { ...line, end, right, ellipsis: true };
  }

  function transformText(str, transform) {
    if (transform === 'uppercase') return str.toUpperCase();
    if (transform === 'lowercase') return str.toLowerCase();
    if (transform === 'capitalize') return str.replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toUpperCase());
    return str;
  }

  // System font keywords mean nothing outside a browser (and some don't resolve in SVG at all),
  // so follow them with the concrete fonts they usually stand for.
  const SYSTEM_FONTS = [
    [/^(system-ui|-apple-system|BlinkMacSystemFont|ui-sans-serif)$/i, ['SF Pro Text', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif']],
    [/^(ui-monospace|SFMono-Regular)$/i, ['SF Mono', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace']],
    [/^ui-serif$/i, ['New York', 'Georgia', 'serif']],
    [/^ui-rounded$/i, ['SF Pro Rounded', 'Arial Rounded MT Bold', 'sans-serif']],
  ];
  const fontFamilyCache = new Map();

  function fontFamily(value) {
    if (fontFamilyCache.has(value)) return fontFamilyCache.get(value);
    const names = splitTop(value).map((f) => f.replace(/^["']|["']$/g, ''));
    const out = [];
    for (const name of names) {
      const expansion = SYSTEM_FONTS.find(([re]) => re.test(name))?.[1];
      for (const f of expansion ? [name, ...expansion] : [name]) {
        if (!out.some((o) => o.toLowerCase() === f.toLowerCase())) out.push(f);
      }
    }
    const generic = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-\w+|-apple-system|BlinkMacSystemFont)$/i;
    const result = out.map((f) => (generic.test(f) || !/\s/.test(f) ? f : `'${f}'`)).join(', ');
    fontFamilyCache.set(value, result);
    return result;
  }

  function textElement(cs, fill, ctx) {
    const text = svgEl('text', {
      'font-family': fontFamily(cs.fontFamily),
      'font-size': parseFloat(cs.fontSize),
      'font-weight': cs.fontWeight !== '400' ? cs.fontWeight : undefined,
      'font-style': cs.fontStyle !== 'normal' ? cs.fontStyle : undefined,
      'letter-spacing': cs.letterSpacing !== 'normal' ? parseFloat(cs.letterSpacing) : undefined,
      'word-spacing': px(cs, 'wordSpacing') || undefined,
      'text-decoration': cs.textDecorationLine !== 'none' ? cs.textDecorationLine : undefined,
    });
    if (ctx.opts.mode === 'wireframe') text.setAttribute('fill', WIREFRAME.text);
    else if (fill.startsWith('url(')) text.setAttribute('fill', fill);
    else applyColor(text, fill);
    return text;
  }

  function textBar(x, baseline, width, m, fill, ctx) {
    const h = Math.max(2, m.xHeight * 1.1);
    const bar = svgEl('rect', { x, y: baseline - m.xHeight * 1.05, width, height: h, rx: h / 2 });
    if (ctx.opts.mode === 'wireframe' || fill.startsWith('url(')) bar.setAttribute('fill', WIREFRAME.bar);
    else {
      applyColor(bar, fill);
      bar.setAttribute('fill-opacity', round(0.35 * (parseColor(fill)?.a ?? 1)));
    }
    return bar;
  }

  function textFill(node, cs, ctx) {
    const fill = cs.webkitTextFillColor || cs.color;
    if (visibleColor(fill)) return fill;
    // Gradient text (background-clip: text) — look for the painting ancestor.
    for (let el = node.parentElement, i = 0; el && i < 4; el = el.parentElement, i++) {
      if (ctx.textPaint.has(el)) return ctx.textPaint.get(el);
    }
    return null;
  }

  function renderText(node, parent, cs, ctx) {
    if (cs.visibility !== 'visible' || !node.data.trim()) return;
    const fill = textFill(node, cs, ctx);
    if (!fill) return;
    let lines = measureLines(node);
    if (!lines.length) return;
    const edge = ellipsisEdge(node);
    if (edge !== null && lines.some((l) => l.right > edge + 0.5)) {
      const ellipsisWidth = measureWidth(cs, '…');
      lines = lines
        .filter((l) => l.left < edge)
        .map((l) => (l.right > edge + 0.5 ? truncateLine(node, l, edge - ellipsisWidth) : l));
    }

    const preserve =
      /^(pre|break-spaces)/.test(cs.whiteSpace) || /^(preserve|break-spaces)/.test(cs.whiteSpaceCollapse || '');
    const m = fontMetrics(cs);
    ctx.stats.text++;

    if (ctx.opts.text === 'blocks') {
      const g = svgEl('g');
      for (const line of lines) {
        const baseline = line.top + (line.height - m.height) / 2 + m.ascent - ctx.oy;
        g.append(textBar(line.left - ctx.ox, baseline, line.right - line.left, m, fill, ctx));
      }
      parent.append(g);
      return;
    }

    const text = textElement(cs, fill, ctx);
    if (preserve) {
      text.setAttributeNS(XML_NS, 'xml:space', 'preserve');
      text.setAttribute('style', 'white-space: pre');
    }
    for (const line of lines) {
      let str = node.data.slice(line.start, line.end);
      if (!preserve) str = str.replace(/\s+/g, ' ');
      str = transformText(str, cs.textTransform);
      if (line.ellipsis) str += '…';
      const baseline = line.top + (line.height - m.height) / 2 + m.ascent;
      const target = lines.length === 1 ? text : text.appendChild(svgEl('tspan'));
      target.setAttribute('x', round(line.left - ctx.ox));
      target.setAttribute('y', round(baseline - ctx.oy));
      if (str.length > 1 && !line.ellipsis) {
        // Pin the measured width so the layout survives font substitution.
        target.setAttribute('textLength', round(line.right - line.left));
        target.setAttribute('lengthAdjust', 'spacing');
      }
      target.textContent = str;
    }
    parent.append(text);
  }

  /** Draw a single line of text (form control values, list markers). */
  function drawLabel(parent, str, cs, fill, ctx, x, baseline, anchor = 'start') {
    if (ctx.opts.text === 'blocks') {
      const width = measureWidth(cs, str);
      const left = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
      parent.append(textBar(left, baseline, width, fontMetrics(cs), fill, ctx));
      return;
    }
    const text = textElement(cs, fill, ctx);
    text.setAttribute('x', round(x));
    text.setAttribute('y', round(baseline));
    if (anchor !== 'start') text.setAttribute('text-anchor', anchor);
    text.setAttributeNS(XML_NS, 'xml:space', 'preserve');
    text.textContent = str;
    parent.append(text);
  }

  // ---------------------------------------------------------------------------
  // List markers (approximate — pseudo-elements can't be measured directly)

  function toRoman(n) {
    const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
      [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let out = '';
    for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
    return out;
  }

  function toAlpha(n) {
    let out = '';
    while (n > 0) { n--; out = String.fromCharCode(97 + (n % 26)) + out; n = Math.floor(n / 26); }
    return out;
  }

  function markerText(li, type) {
    const list = li.parentElement;
    let n = list?.localName === 'ol' ? (parseInt(list.getAttribute('start'), 10) || 1) : 1;
    for (let sib = li.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.localName === 'li') n++;
    }
    if (li.hasAttribute('value')) n = parseInt(li.getAttribute('value'), 10) || n;
    if (type === 'decimal') return `${n}.`;
    if (type === 'decimal-leading-zero') return `${String(n).padStart(2, '0')}.`;
    if (type === 'lower-alpha' || type === 'lower-latin') return `${toAlpha(n)}.`;
    if (type === 'upper-alpha' || type === 'upper-latin') return `${toAlpha(n).toUpperCase()}.`;
    if (type === 'lower-roman') return `${toRoman(n)}.`;
    if (type === 'upper-roman') return `${toRoman(n).toUpperCase()}.`;
    return null;
  }

  function renderMarker(li, cs, box, g, ctx) {
    const type = cs.listStyleType;
    if (type === 'none' || cs.listStylePosition !== 'outside' || cs.listStyleImage !== 'none') return;
    const fill = ctx.opts.mode === 'wireframe' ? WIREFRAME.text : cs.color;
    if (!visibleColor(fill)) return;
    const m = fontMetrics(cs);
    const cb = contentBox(cs, box);
    const lineHeight = cs.lineHeight === 'normal' ? m.height : parseFloat(cs.lineHeight);
    const baseline = cb.y + (lineHeight - m.height) / 2 + m.ascent;

    if (type === 'disc' || type === 'circle' || type === 'square') {
      const d = m.size * 0.35;
      const cx = cb.x - m.size * 0.7;
      const cy = baseline - m.xHeight / 2;
      const bullet =
        type === 'square'
          ? svgEl('rect', { x: cx - d / 2, y: cy - d / 2, width: d, height: d })
          : svgEl('circle', { cx, cy, r: type === 'circle' ? d / 2 - d * 0.1 : d / 2 });
      if (type === 'circle') {
        bullet.setAttribute('stroke-width', round(d * 0.2));
        applyColor(bullet, fill, 'stroke');
      } else {
        applyColor(bullet, fill);
      }
      g.append(bullet);
      return;
    }

    const str = markerText(li, type);
    if (!str) return;
    const gap = measureWidth(cs, ' ');
    drawLabel(g, str, cs, fill, ctx, cb.x - gap, baseline, 'end');
  }

  // ---------------------------------------------------------------------------
  // Inline SVG

  const SVG_INHERITED = [
    'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
    'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'color', 'font-family',
    'font-size', 'font-weight', 'font-style', 'text-anchor', 'visibility', 'clip-rule',
  ];
  const SVG_OWN = {
    opacity: '1', 'stop-color': 'rgb(0, 0, 0)', 'stop-opacity': '1', 'clip-path': 'none', mask: 'none',
    'dominant-baseline': 'auto', transform: 'none', 'transform-origin': '', 'transform-box': '',
  };

  /**
   * Bake computed styles into a cloned SVG subtree so it renders without the page's CSS.
   * `inheritRoot: false` leaves inherited props off the root, for <symbol>s etc. that should
   * inherit from the <use> referencing them rather than from where they were defined.
   */
  function inlineSvgStyles(original, clone, inheritRoot = true) {
    const originals = [original, ...original.querySelectorAll('*')];
    const clones = [clone, ...clone.querySelectorAll('*')];
    const parentStyles = new Map();
    originals.forEach((orig, i) => {
      const target = clones[i];
      if (!target || !(orig instanceof SVGElement)) return;
      const cs = getComputedStyle(orig);
      const isRoot = orig === original;
      const parentCs = isRoot ? null : parentStyles.get(orig.parentNode);
      parentStyles.set(orig, cs);
      const decls = [];
      for (const prop of SVG_INHERITED) {
        if (isRoot && !inheritRoot) break;
        const v = cs.getPropertyValue(prop);
        if (v && (!parentCs || parentCs.getPropertyValue(prop) !== v)) decls.push(`${prop}:${v}`);
      }
      // Transforms set via the attribute already survive the clone.
      const hasTransform = cs.transform !== 'none' && !orig.hasAttribute('transform');
      for (const [prop, initial] of Object.entries(SVG_OWN)) {
        if (prop.startsWith('transform') && !hasTransform) continue;
        const v = cs.getPropertyValue(prop);
        if (v && v !== initial) decls.push(`${prop}:${v}`);
      }
      if (cs.display === 'none' && orig.localName !== 'symbol') decls.push('display:none');
      target.removeAttribute('class');
      if (decls.length) target.setAttribute('style', decls.join(';'));
      else target.removeAttribute('style');
    });
  }

  function sanitizeSvg(root) {
    for (const s of root.querySelectorAll('script')) s.remove();
    for (const node of [root, ...root.querySelectorAll('*')]) {
      for (const attr of [...node.attributes]) {
        if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      }
    }
  }

  /** Copy <symbol>/<linearGradient>/… referenced from outside the cloned SVG into <defs>. */
  function copyExternalRefs(root, ctx) {
    const ids = new Set();
    for (const node of [root, ...root.querySelectorAll('*')]) {
      const href = node.getAttribute('href') || node.getAttributeNS(XLINK_NS, 'href');
      if (href?.startsWith('#')) ids.add(href.slice(1));
      for (const attr of node.attributes) {
        for (const m of attr.value.matchAll(/url\(\s*["']?#([^"')]+)["']?\s*\)/g)) ids.add(m[1]);
      }
    }
    for (const id of ids) {
      if (ctx.sharedDefs.has(id) || root.querySelector(`[id="${CSS.escape(id)}"]`)) continue;
      const target = document.getElementById(id);
      if (!target || !(target instanceof SVGElement)) continue;
      ctx.sharedDefs.add(id);
      const copy = target.cloneNode(true);
      inlineSvgStyles(target, copy, false);
      sanitizeSvg(copy);
      ctx.defs.append(copy);
      copyExternalRefs(copy, ctx);
    }
  }

  function renderInlineSvg(svg, cs, box, g, ctx) {
    const cb = contentBox(cs, box);
    const clone = svg.cloneNode(true);
    inlineSvgStyles(svg, clone);
    sanitizeSvg(clone);
    clone.removeAttribute('id');
    clone.setAttribute('x', round(cb.x));
    clone.setAttribute('y', round(cb.y));
    clone.setAttribute('width', round(cb.w));
    clone.setAttribute('height', round(cb.h));
    clone.setAttribute('overflow', cs.overflow === 'visible' ? 'visible' : 'hidden');
    g.append(clone);
    copyExternalRefs(clone, ctx);
    ctx.stats.images++;
  }

  // ---------------------------------------------------------------------------
  // Form controls

  function renderFormControl(node, cs, box, g, ctx) {
    const tag = node.localName;
    const type = (node.type || '').toLowerCase();
    const cb = contentBox(cs, box);
    const wire = ctx.opts.mode === 'wireframe';

    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      if (cs.appearance === 'none') return;
      const s = Math.min(box.w, box.h);
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const accent = wire ? WIREFRAME.text : cs.accentColor === 'auto' ? '#1a73e8' : cs.accentColor;
      const on = node.checked;
      const frame =
        type === 'radio'
          ? svgEl('circle', { cx, cy, r: s / 2 - 0.5 })
          : svgEl('rect', { x: cx - s / 2 + 0.5, y: cy - s / 2 + 0.5, width: s - 1, height: s - 1, rx: 2 });
      frame.setAttribute('stroke-width', 1);
      if (on && type === 'checkbox') {
        applyColor(frame, accent);
        applyColor(frame, accent, 'stroke');
      } else {
        frame.setAttribute('fill', '#ffffff');
        frame.setAttribute('stroke', on ? hex(parseColor(accent)) : '#767676');
      }
      g.append(frame);
      if (on && type === 'checkbox') {
        const k = s / 16;
        g.append(
          svgEl('path', {
            d: `M${round(cx - 4.5 * k)},${round(cy)} L${round(cx - 1.5 * k)},${round(cy + 3 * k)} L${round(cx + 4.5 * k)},${round(cy - 3.5 * k)}`,
            fill: 'none',
            stroke: '#ffffff',
            'stroke-width': round(2 * k),
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
          }),
        );
      } else if (on) {
        const dot = svgEl('circle', { cx, cy, r: s / 4 });
        applyColor(dot, accent);
        g.append(dot);
      }
      return;
    }

    if (tag === 'input' && type === 'color') {
      const swatch = svgEl('rect', { x: cb.x, y: cb.y, width: cb.w, height: cb.h, rx: 2 });
      swatch.setAttribute('fill', wire ? WIREFRAME.media : node.value);
      g.append(swatch);
      return;
    }

    if (tag === 'input' && type === 'range') {
      const min = parseFloat(node.min) || 0;
      const max = parseFloat(node.max) || 100;
      const frac = Math.min(1, Math.max(0, (parseFloat(node.value) - min) / (max - min || 1)));
      const cy = box.y + box.h / 2;
      const accent = wire ? WIREFRAME.text : cs.accentColor === 'auto' ? '#1a73e8' : cs.accentColor;
      const thumbX = box.x + 8 + (box.w - 16) * frac;
      g.append(svgEl('rect', { x: box.x + 2, y: cy - 2, width: box.w - 4, height: 4, rx: 2, fill: '#d1d5db' }));
      const done = svgEl('rect', { x: box.x + 2, y: cy - 2, width: Math.max(0, thumbX - box.x - 2), height: 4, rx: 2 });
      applyColor(done, accent);
      const thumb = svgEl('circle', { cx: thumbX, cy, r: 8 });
      applyColor(thumb, accent);
      g.append(done, thumb);
      return;
    }

    let text = '';
    let color = cs.webkitTextFillColor || cs.color;
    if (tag === 'select') {
      text = node.selectedOptions?.[0]?.text ?? '';
    } else if (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) {
      text = node.value || { submit: 'Submit', reset: 'Reset' }[type] || '';
    } else if (tag === 'input' && type === 'file') {
      text = node.files?.length ? `${node.files.length} file(s)` : 'Choose file';
    } else if (tag === 'input' || tag === 'textarea') {
      text = node.value;
      if (type === 'password') text = '•'.repeat(text.length);
      if (!text && node.placeholder) {
        text = node.placeholder;
        color = getComputedStyle(node, '::placeholder').color;
      }
    }

    if (tag === 'select' && cs.appearance !== 'none') {
      const ax = box.x + box.w - 12;
      const ay = box.y + box.h / 2;
      const chevron = svgEl('path', {
        d: `M${round(ax - 4)},${round(ay - 2)} L${round(ax)},${round(ay + 2)} L${round(ax + 4)},${round(ay - 2)}`,
        fill: 'none',
        'stroke-width': 1.5,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      });
      applyColor(chevron, wire ? WIREFRAME.text : cs.color, 'stroke');
      g.append(chevron);
    }

    if (!text || !visibleColor(color)) return;
    const holder = clipped(ctx, paddingBox(cs, box), null);
    g.append(holder);
    const m = fontMetrics(cs);
    const align = cs.textAlign;
    const isButton = tag === 'input' && ['button', 'submit', 'reset', 'file'].includes(type);
    const anchor = isButton || align === 'center' ? 'middle' : align === 'right' || align === 'end' ? 'end' : 'start';
    const x = anchor === 'middle' ? cb.x + cb.w / 2 : anchor === 'end' ? cb.x + cb.w : cb.x;

    if (tag === 'textarea') {
      const lh = cs.lineHeight === 'normal' ? m.height * 1.15 : parseFloat(cs.lineHeight);
      text.split('\n').forEach((line, i) => {
        const baseline = cb.y + i * lh + (lh - m.height) / 2 + m.ascent - node.scrollTop;
        if (baseline - m.ascent > cb.y + cb.h) return;
        if (line) drawLabel(holder, line, cs, color, ctx, x, baseline, anchor);
      });
    } else {
      const baseline = cb.y + (cb.h - m.height) / 2 + m.ascent;
      drawLabel(holder, text, cs, color, ctx, x, baseline, anchor);
    }
  }

  // ---------------------------------------------------------------------------
  // Replaced elements

  function renderReplaced(node, cs, box, r, g, ctx) {
    const tag = node.localName;
    const bw = borderWidths(cs);
    const cb = contentBox(cs, box);
    const cr = insetRadii(
      r,
      bw.t + px(cs, 'paddingTop'),
      bw.r + px(cs, 'paddingRight'),
      bw.b + px(cs, 'paddingBottom'),
      bw.l + px(cs, 'paddingLeft'),
    );
    const wire = ctx.opts.mode === 'wireframe';
    const media = () => {
      const holder = clipped(ctx, cb, cr);
      g.append(holder);
      return holder;
    };

    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      renderFormControl(node, cs, box, g, ctx);
      return;
    }
    if (cb.w <= 0 || cb.h <= 0) return;

    if (wire || tag === 'iframe' || tag === 'embed' || tag === 'object' || tag === 'audio') {
      mediaPlaceholder(g, cb, cr);
      return;
    }

    if (tag === 'img') {
      const src = node.currentSrc || node.src;
      if (!src) return mediaPlaceholder(g, cb, cr);
      const natural = node.naturalWidth ? { w: node.naturalWidth, h: node.naturalHeight } : null;
      pushImage(media(), cb, src, cs.objectFit, cs.objectPosition, natural, ctx, node);
      return;
    }

    if (tag === 'svg') {
      renderInlineSvg(node, cs, box, g, ctx);
      return;
    }

    if (tag === 'canvas') {
      try {
        pushImage(media(), cb, node.toDataURL('image/png'), 'fill', '', null, ctx);
      } catch {
        mediaPlaceholder(g, cb, cr); // tainted by cross-origin content
      }
      return;
    }

    if (tag === 'video') {
      const fit = cs.objectFit === 'fill' ? 'contain' : cs.objectFit;
      try {
        if (!node.videoWidth) throw new Error('no frame');
        const canvas = document.createElement('canvas');
        canvas.width = node.videoWidth;
        canvas.height = node.videoHeight;
        canvas.getContext('2d').drawImage(node, 0, 0);
        pushImage(media(), cb, canvas.toDataURL('image/jpeg', 0.9), fit, cs.objectPosition, null, ctx);
      } catch {
        if (node.poster) pushImage(media(), cb, node.poster, fit, cs.objectPosition, null, ctx);
        else mediaPlaceholder(g, cb, cr);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tree walk

  function layerName(node, ctx) {
    let name = node.localName;
    if (node.id) name += `-${node.id}`;
    else if (node.classList?.length) name += `.${node.classList[0]}`;
    name = name.replace(/[^\w.-]/g, '_');
    if (!/^[A-Za-z_]/.test(name)) name = `_${name}`;
    const count = (ctx.ids.get(name) || 0) + 1;
    ctx.ids.set(name, count);
    return count === 1 ? name : `${name}_${count}`;
  }

  /** Children in the flat tree: shadow roots and slotted content included. */
  function childNodesOf(node) {
    if (node.shadowRoot) return [...node.shadowRoot.childNodes];
    if (node.localName === 'slot') {
      const assigned = node.assignedNodes({ flatten: true });
      return assigned.length ? assigned : [...node.childNodes];
    }
    return [...node.childNodes];
  }

  /** Approximate CSS painting order: negative z, normal flow, then positioned by z-index. */
  function paintOrder(nodes, parentCs) {
    const neg = [];
    const flow = [];
    const pos = [];
    const flexParent = /flex|grid/.test(parentCs.display);
    for (const n of nodes) {
      if (n.nodeType !== Node.ELEMENT_NODE) {
        flow.push(n);
        continue;
      }
      const cs = getComputedStyle(n);
      const z = parseInt(cs.zIndex, 10);
      const positioned = cs.position !== 'static';
      if ((positioned || flexParent) && !Number.isNaN(z)) (z < 0 ? neg : pos).push({ n, z });
      else if (positioned) pos.push({ n, z: 0 });
      else flow.push(n);
    }
    const byZ = (a, b) => a.z - b.z;
    return [...neg.sort(byZ).map((o) => o.n), ...flow, ...pos.sort(byZ).map((o) => o.n)];
  }

  function isVisuallyHidden(cs, box) {
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)') return true;
    if (/^inset\(50%/.test(cs.clipPath)) return true;
    const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
    return clips && (box.w <= 1 || box.h <= 1);
  }

  function renderChildren(node, parent, ctx, cs) {
    for (const child of paintOrder(childNodesOf(node), cs)) renderNode(child, parent, ctx, cs);
  }

  function renderNode(node, parent, ctx, parentCs) {
    if (node.nodeType === Node.TEXT_NODE) {
      renderText(node, parent, parentCs, ctx);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (SKIP_TAGS.has(node.localName) || node.hasAttribute(UI_ATTR)) return;

    const cs = getComputedStyle(node);
    if (cs.display === 'none') return;
    if (cs.display === 'contents') {
      renderChildren(node, parent, ctx, cs);
      return;
    }
    const opacity = parseFloat(cs.opacity);
    if (opacity === 0) return;

    const rect = node.getBoundingClientRect();
    const box = { x: rect.left - ctx.ox, y: rect.top - ctx.oy, w: rect.width, h: rect.height };
    if (isVisuallyHidden(cs, box)) return;

    ctx.stats.elements++;
    const g = svgEl('g', { id: layerName(node, ctx) });
    if (opacity < 1) g.setAttribute('opacity', round(opacity));
    const visible = cs.visibility === 'visible';
    const r = radii(cs, box.w, box.h);

    if (visible && box.w > 0 && box.h > 0) paintBox(node, cs, box, r, g, ctx);

    if (REPLACED_TAGS.has(node.localName)) {
      if (visible) renderReplaced(node, cs, box, r, g, ctx);
    } else {
      if (visible && cs.display === 'list-item') renderMarker(node, cs, box, g, ctx);
      let target = g;
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const bw = borderWidths(cs);
        target = clipped(ctx, paddingBox(cs, box), insetRadii(r, bw.t, bw.r, bw.b, bw.l));
      }
      renderChildren(node, target, ctx, cs);
      if (target !== g && target.childNodes.length) g.append(target);
    }

    if (g.childNodes.length) parent.append(g);
  }

  // ---------------------------------------------------------------------------
  // Entry point

  /** Drop duplicates and elements nested inside other selected elements; sort in document order. */
  function topLevel(elements) {
    const unique = [...new Set(elements)].filter((e) => e?.isConnected);
    return unique
      .filter((e) => !unique.some((o) => o !== e && o.contains(e)))
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  function parentOf(node) {
    return node.parentElement || node.getRootNode()?.host || null;
  }

  function effectiveBackground(node) {
    for (let el = parentOf(node); el; el = parentOf(el)) {
      const bg = getComputedStyle(el).backgroundColor;
      if (visibleColor(bg)) return bg;
    }
    return 'rgb(255, 255, 255)';
  }

  async function toSvg(elements, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const roots = topLevel(elements);
    if (!roots.length) throw new Error('Nothing selected');

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const root of roots) {
      const rect = root.getBoundingClientRect();
      const reach = opts.mode === 'styled' ? shadowReach(getComputedStyle(root)) : { t: 0, r: 0, b: 0, l: 0 };
      minX = Math.min(minX, rect.left - reach.l);
      minY = Math.min(minY, rect.top - reach.t);
      maxX = Math.max(maxX, rect.right + reach.r);
      maxY = Math.max(maxY, rect.bottom + reach.b);
    }
    const ox = Math.floor(minX);
    const oy = Math.floor(minY);
    const width = Math.max(1, Math.ceil(maxX) - ox);
    const height = Math.max(1, Math.ceil(maxY) - oy);

    const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, fill: 'none' });
    svg.setAttributeNS(XMLNS_NS, 'xmlns', SVG_NS);
    svg.setAttributeNS(XMLNS_NS, 'xmlns:xlink', XLINK_NS);
    const defs = svgEl('defs');
    svg.append(defs);

    const ctx = {
      ox,
      oy,
      opts,
      defs,
      roots: new Set(roots),
      tasks: [],
      ids: new Map(),
      n: 0,
      sharedDefs: new Set(),
      textPaint: new WeakMap(),
      stats: { elements: 0, text: 0, images: 0 },
    };

    if (opts.background) {
      const bg = svgEl('rect', { id: 'background', x: 0, y: 0, width, height });
      if (opts.mode === 'wireframe') bg.setAttribute('fill', '#ffffff');
      else applyColor(bg, effectiveBackground(roots[0]));
      svg.append(bg);
    }

    for (const root of roots) {
      const parent = parentOf(root);
      renderNode(root, svg, ctx, getComputedStyle(parent || root));
    }

    await Promise.all(ctx.tasks.map((t) => t.catch((err) => console.warn('Element to SVG:', err))));
    if (!defs.childNodes.length) defs.remove();
    const empty = !svg.querySelector('g');

    const markup = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
    return { svg: markup, width, height, empty, stats: ctx.stats };
  }

  api.toSvg = toSvg;
  api.UI_ATTR = UI_ATTR;
})();
