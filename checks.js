// Self-contained page audit. Runs inside the browser via page.evaluate().
// Must not close over any module scope.
export function auditFn(opts) {
  const LIMIT = (opts && opts.limit) || 8;
  const out = { overflow: [], tapTargets: [], contrast: [], missingAlt: [], tinyText: [], clipped: [] };
  const vw = window.innerWidth;

  const sel = (el) => {
    if (el.id) return '#' + el.id;
    let s = el.tagName.toLowerCase();
    const cn = el.getAttribute && el.getAttribute('class');
    if (cn) {
      const c = cn.trim().split(/\s+/).slice(0, 2).join('.');
      if (c) s += '.' + c;
    }
    return s;
  };
  const txt = (el) => ((el.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 60);

  const parseRGB = (s) => {
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    if (p.some(isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  };
  const bgOf = (el) => {
    let n = el;
    while (n && n.nodeType === 1) {
      const c = parseRGB(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.5) return c;
      n = n.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const hasOwnText = (el) => {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim().length > 1) return true;
    return false;
  };

  const INTERACTIVE = 'a,button,input,select,textarea,[role="button"],[role="link"],[onclick]';
  const seen = new Set();

  for (const el of document.querySelectorAll('*')) {
    let cs;
    try { cs = getComputedStyle(el); } catch { continue; }
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;

    // 1. Horizontal overflow — the #1 responsive bug
    if ((r.right > vw + 1 || r.left < -1) && cs.position !== 'fixed' && out.overflow.length < LIMIT) {
      const key = 'o' + sel(el);
      if (!seen.has(key)) {
        seen.add(key);
        out.overflow.push({ el: sel(el), text: txt(el), left: Math.round(r.left), right: Math.round(r.right), viewport: vw, overhang_px: Math.round(Math.max(r.right - vw, -r.left)) });
      }
    }

    // 2. Tap targets below 44x44
    if (el.matches(INTERACTIVE) && (r.width < 44 || r.height < 44) && r.width > 0 && r.height > 0 && out.tapTargets.length < LIMIT) {
      out.tapTargets.push({ el: sel(el), text: txt(el), size: Math.round(r.width) + 'x' + Math.round(r.height), min: '44x44' });
    }

    // 3. Text contrast (WCAG AA)
    if (hasOwnText(el) && out.contrast.length < LIMIT) {
      const fg = parseRGB(cs.color);
      if (fg && fg.a > 0.5) {
        const size = parseFloat(cs.fontSize);
        const bold = parseInt(cs.fontWeight, 10) >= 700;
        const large = size >= 24 || (size >= 18.66 && bold);
        const need = large ? 3.0 : 4.5;
        const got = ratio(fg, bgOf(el));
        if (got < need) {
          out.contrast.push({ el: sel(el), text: txt(el), ratio: Math.round(got * 100) / 100, required: need, font_px: Math.round(size) });
        }
      }
    }

    // 4. Images missing alt (alt="" is a valid decorative marker)
    if (el.tagName === 'IMG' && el.getAttribute('alt') === null && out.missingAlt.length < LIMIT) {
      out.missingAlt.push({ el: sel(el), src: (el.getAttribute('src') || '').slice(0, 80) });
    }

    // 5. Text below 12px
    if (hasOwnText(el) && out.tinyText.length < LIMIT) {
      const size = parseFloat(cs.fontSize);
      if (size && size < 12) out.tinyText.push({ el: sel(el), text: txt(el), font_px: Math.round(size * 10) / 10 });
    }

    // 6. Content clipped by overflow:hidden
    if (out.clipped.length < LIMIT && /hidden|clip/.test(cs.overflow) && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) && hasOwnText(el)) {
      out.clipped.push({ el: sel(el), text: txt(el), content: el.scrollWidth + 'x' + el.scrollHeight, box: el.clientWidth + 'x' + el.clientHeight });
    }
  }

  const counts = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { viewport: vw, total_issues: total, counts, findings: out };
}
