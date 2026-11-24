'use strict';
/**
 * ui.js - File Explorer's page, a pure draw(cv, G, t, m, o): m = the Explorer (model.js), o = { act, focusRow,
 * large, tz }. Tabs Files / Logs / Info; Files shows the folder or, with a file open, the viewer (or its QR code).
 *
 * Where the kit runs the screen (cv.own) the buttons and rows are touch / controller targets and the list or
 * the text scrolls (cv.scroll); elsewhere the HMI bar has Up / Down / Open / Back / Next page / QR, and the
 * selected row is marked.
 * Sets m.listRows / m.textRows to what fits. GPU-safe ops only (fillRect / roundRect / strokeRoundRect / line / text).
 */
const QR = require('./qrpage');
const { TABS, size } = require('./model');

const W = 1600, H = 520;
const BTN_H = 48;

function draw(cv, G, t, m, o) {
    o = o || {};
    const act = o.act || {};
    cv.clear(t.bg);
    const v = m.viewer;
    G.frame(cv, t, TABS, m.tab, [
        m.loading || (v && v.loading) ? { text: 'LOADING', color: t.dim } : null,
        { text: 'READ-ONLY', color: t.go || '#2fd27a' },
    ]);
    G.panel(cv, t, 24, G.TOP, W - 48, G.BOTTOM - G.TOP, null);
    const bottom = G.pageBottom(cv) - (cv.own ? G.MARGIN : 0);
    const L = { bottom, own: !!cv.own, large: !!o.large, tz: o.tz || 0, act, focusRow: o.focusRow };
    if (m.tab === 2) drawInfo(cv, G, t, m, L);
    else if (m.tab === 0 && v && v.qr) drawQr(cv, G, t, m, L);
    else if (m.tab === 0 && v) drawViewer(cv, G, t, m, L);
    else drawList(cv, G, t, m, L);
    // a short notice (an entry that can't be opened ...), 5 s
    if (m.notice && Date.now() - m.notice.at < 5000) {
        const nw = Math.min(1200, cv.textWidth(m.notice.text, 20, { font: 'label' }) + 60);
        cv.roundRect((W - nw) / 2, bottom - 54, nw, 46, 23, G.withAlpha('#000000', 0.85));
        cv.strokeRoundRect((W - nw) / 2, bottom - 54, nw, 46, 23, 1.5, t.warn || '#d29922');
        cv.text(fit(cv, m.notice.text, 20, nw - 40, 'label'), W / 2, bottom - 24, 20, t.warn || '#d29922', { align: 'center', font: 'label', literal: true });
    }
    return cv;
}

/* ------------------------------------------------------------------ helpers -- */

function fit(cv, s, size, w, font) {
    s = String(s);
    if (cv.textWidth(s, size, { font, literal: true }) <= w) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cv.textWidth(s.slice(0, mid) + '...', size, { font, literal: true }) <= w) lo = mid; else hi = mid - 1; }
    return s.slice(0, lo) + '...';
}
/** cut from the left (paths: the end matters) */
function fitLeft(cv, s, size, w, font) {
    s = String(s);
    if (cv.textWidth(s, size, { font, literal: true }) <= w) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cv.textWidth('...' + s.slice(s.length - mid), size, { font, literal: true }) <= w) lo = mid; else hi = mid - 1; }
    return '...' + s.slice(s.length - lo);
}
const wrapCache = new Map();
/** line -> rows that fit w (at most max; the last one cut) */
function wrap(cv, s, size, w, max) {
    const key = size + '|' + w + '|' + s;
    const hit = wrapCache.get(key);
    if (hit) return hit;
    const out = [];
    let rest = s;
    while (rest.length && out.length < max) {
        if (cv.textWidth(rest, size, { font: 'label', literal: true }) <= w) { out.push(rest); rest = ''; break; }
        let lo = 1, hi = rest.length;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cv.textWidth(rest.slice(0, mid), size, { font: 'label', literal: true }) <= w) lo = mid; else hi = mid - 1; }
        // break at a space if there is one in the last third
        const sp = rest.lastIndexOf(' ', lo);
        const cut = sp > lo * 0.66 ? sp + 1 : lo;
        out.push(rest.slice(0, cut)); rest = rest.slice(cut);
    }
    if (rest.length && out.length) out[out.length - 1] = fit(cv, out[out.length - 1] + rest, size, w, 'label');
    if (!out.length) out.push('');
    if (wrapCache.size > 400) wrapCache.clear();
    wrapCache.set(key, out);
    return out;
}
function when(ms, tz) {
    if (!ms) return '';
    const d = new Date(ms + tz * 60000), now = new Date(Date.now() + tz * 60000);
    const p = (n) => (n < 10 ? '0' : '') + n;
    const dm = p(d.getUTCDate()) + '.' + p(d.getUTCMonth() + 1) + '.';
    return d.getUTCFullYear() === now.getUTCFullYear() ? dm + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) : dm + d.getUTCFullYear();
}
/** toolbar buttons from x: [[label, run, opts]] -> next x */
function buttons(cv, G, t, x, y, list, w) {
    list.forEach(([label, run, opt], i) => {
        const bw = w || Math.max(120, cv.textWidth(String(label).toUpperCase(), BTN_H * 0.4, { font: 'bold', spacing: 1.5 }) + 50);
        G.button(cv, t, x, y, bw, BTN_H, label, run || (() => {}), Object.assign({ key: 'fx_' + label + i }, opt || {}));
        x += bw + 12;
    });
    return x;
}
function scrollBar(cv, G, t, x, y, h, first, shown, total) {
    if (total <= shown) return null;
    cv.roundRect(x, y, 8, h, 4, G.withAlpha('#ffffff', 0.08));
    const th = Math.max(30, h * shown / total), ty = y + (h - th) * (first / Math.max(1, total - shown));
    cv.roundRect(x, ty, 8, th, 4, G.withAlpha('#ffffff', 0.45));
    return { x: x - 6, y, w: 20, h };
}

/* --------------------------------------------------------------- icons -- */
function icon(cv, G, t, kind, x, y) {
    const amber = '#e0a43a', blue = t.accent2 || '#81c4ff', dim = t.dim;
    if (kind === 'dir' || kind === 'linkdir' || kind === 'up' || kind === 'place') {
        cv.roundRect(x, y + 3, 12, 6, 2, kind === 'place' ? blue : amber);
        cv.roundRect(x, y + 6, 28, 18, 3, kind === 'place' ? blue : amber);
        if (kind === 'up') cv.text('..', x + 14, y + 22, 16, '#000000', { align: 'center', font: 'bold', literal: true });
    } else if (kind === 'file' || kind === 'link' || kind === 'log') {
        cv.roundRect(x + 3, y, 22, 26, 3, kind === 'log' ? blue : G.withAlpha('#ffffff', 0.75));
        for (let i = 0; i < 3; i++) cv.fillRect(x + 7, y + 7 + i * 5, 14, 2, '#3a3d44');
    } else if (kind === 'head') {
        cv.circle(x + 14, y + 13, 5, dim);
    } else {
        cv.strokeRoundRect(x + 2, y + 2, 24, 22, 4, 2, dim);
    }
    if (kind === 'link' || kind === 'linkdir') cv.text('>', x + 30, y + 24, 16, blue, { font: 'bold', literal: true });
}

/* ------------------------------------------------------- Files / Logs list -- */
function drawList(cv, G, t, m, L) {
    const act = L.act, files = m.tab === 0;
    const rowH = L.large ? 58 : 46, ts = L.large ? 24 : 21, ss = L.large ? 19 : 17;
    const ty = G.TOP + 12;
    let x = 48;
    if (L.own) {
        x = files ? buttons(cv, G, t, x, ty, [['Up', act.up, { busy: !m.cwd || m.cwd === '/' }], ['Back', act.back, { busy: !m.history.length }], ['Reload', act.refresh]])
            : buttons(cv, G, t, x, ty, [['Reload', act.refresh]]);
        x += 10;
    }
    const head = files ? (m.cwd || '') : 'Kit app logs, newest first  ·  places';
    cv.text(fitLeft(cv, head, 22, W - 60 - x - 260, 'bold'), x, ty + 33, 22, t.text, { font: 'bold', literal: true });
    const l = m.listing;
    const stat = files ? (l ? (l.error ? l.error : m.entries().length + ' entries' + (l.cut ? ' (first ' + l.entries.length + ' of ' + l.total + ')' : '')) : '')
        : (m.logs && m.logs.list ? m.logs.list.length + ' logs' : '');
    cv.text(stat, W - 60, ty + 33, 18, l && l.error && files ? (t.crit || '#ef2b2d') : t.dim, { align: 'right', font: 'label', literal: true });

    const y0 = ty + BTN_H + 14, avail = L.bottom - y0;
    m.listRows = Math.max(3, Math.floor(avail / rowH));
    m.clamp();
    const rows = m.rows(), tab = m.tab;
    if (L.focusRow != null && L.focusRow < rows.length) m.follow(L.focusRow);
    const first = m.top[tab];
    if (files && l && l.error) {
        cv.text('Can\'t open this folder: ' + l.error, 72, y0 + 50, 22, t.crit || '#ef2b2d', { font: 'label', literal: true });
    }
    const xR = W - 70;
    for (let k = 0; k < m.listRows; k++) {
        const i = first + k, r = rows[i];
        if (!r) break;
        const y = y0 + k * rowH;
        if (k % 2 === 0) cv.fillRect(44, y, W - 104, rowH, G.withAlpha('#ffffff', 0.025));
        if (!L.own && i === m.sel[tab]) {
            cv.roundRect(44, y + 2, W - 104, rowH - 4, 8, G.withAlpha(t.sel || t.accent2 || '#81c4ff', 0.22));
            cv.strokeRoundRect(44, y + 2, W - 104, rowH - 4, 8, 2, t.sel || t.accent2 || '#81c4ff');
        }
        icon(cv, G, t, r.kind, 60, y + (rowH - 26) / 2);
        const base = y + rowH / 2 + ts * 0.36;
        const rightW = 300;
        const titleW = Math.min(cv.textWidth(r.title, ts, { font: 'bold', literal: true }), r.sub ? 640 : xR - 110 - rightW);
        const head = r.kind === 'head';
        cv.text(fit(cv, r.title, ts, titleW + 1, 'bold'), 110, base, ts, r.warn ? (t.warn || '#d29922') : head ? t.dim : t.text, { font: 'bold', literal: true });
        if (r.sub) cv.text(fit(cv, r.sub, ss, xR - 110 - titleW - 30 - rightW, 'label'), 110 + titleW + 24, base, ss, r.warn ? (t.warn || '#d29922') : t.dim, { font: 'label', literal: true });
        if (r.right) cv.text(r.right, xR - 170, base, ss, t.text, { align: 'right', font: 'label', literal: true });
        if (r.when) cv.text(when(r.when, L.tz), xR, base, ss, t.dim, { align: 'right', font: 'label', literal: true });
        if (r.run && L.own) cv.target(44, y, W - 104, rowH, r.run, 'row:' + i);
    }
    if (!rows.length && !(files && l && l.error)) cv.text(m.loading ? 'Loading ...' : 'Empty', 110, y0 + 40, 21, t.dim, { font: 'label' });
    const bar = scrollBar(cv, G, t, W - 52, y0, m.listRows * rowH, first, m.listRows, rows.length);
    if (L.own && rows.length > m.listRows) cv.scroll = { y: y0, bar };
}

/* ------------------------------------------------------------------ viewer -- */
function lineColor(t, lv) { return lv === 'bad' ? (t.crit || '#ef2b2d') : lv === 'warn' ? (t.warn || '#d29922') : t.text; }

function viewerInfo(m) {
    const v = m.viewer;
    if (v.err) return v.err;
    if (v.len == null) return 'reading ...';
    const win = v.virtual ? 'bytes ' + size(v.off) + ' - ' + size(v.off + v.len) + (v.eof ? ' (end)' : '')
        : v.size === 0 ? 'empty' : size(v.off) + ' - ' + size(v.off + v.len) + ' of ' + size(v.size);
    return win + (v.binary ? '  ·  binary (hex)' : '  ·  ' + v.lines.length + ' lines') + (v.filter ? '  ·  issues: ' + v.flines.length : '');
}

function drawViewer(cv, G, t, m, L) {
    const v = m.viewer, act = L.act, TB = require('./textbuf');
    const ty = G.TOP + 12;
    let x = 48;
    if (L.own) {
        x = buttons(cv, G, t, x, ty, [
            ['Back', act.back],
            ['Older', act.older, { busy: !m.canOlder() }],
            ['Newer', act.newer, { busy: !m.canNewer() }],
            ['End', act.toEnd, { busy: !v.len && !v.err }],
            ['Issues', act.filter, { busy: v.binary || v.loading, primary: v.filter, color: v.filter ? (t.crit || '#ef2b2d') : null }],
            ['QR', act.qr, { busy: v.loading || !!v.err || !m.shown().length }],
        ], 128);
        x += 6;
    }
    cv.text(fitLeft(cv, v.file, 21, W - 60 - x, 'bold'), x, ty + 20, 21, t.text, { font: 'bold', literal: true });
    cv.text(fit(cv, viewerInfo(m), 17, W - 60 - x, 'label'), x, ty + 44, 17, v.err ? (t.crit || '#ef2b2d') : t.dim, { font: 'label', literal: true });

    const lh = L.large ? 36 : 29, ts = L.large ? 22 : 18;
    const y0 = ty + BTN_H + 16, avail = L.bottom - y0;
    m.textRows = Math.max(3, Math.floor(avail / lh));
    m.clamp();
    const lines = m.shown(), tw = W - 60 - 70 - 14;
    if (v.err) { cv.text('Can\'t read this file: ' + v.err, 72, y0 + 40, 22, t.crit || '#ef2b2d', { font: 'label', literal: true }); return; }
    if (!lines.length) { cv.text(v.loading ? 'Reading ...' : v.filter ? 'No FATAL / ERROR / WARN lines in this window' : 'Empty', 72, y0 + 30, 20, t.dim, { font: 'label', literal: true }); }
    // rows: wrapped lines from the top line on; at the very end anchored to the bottom so the last line shows
    const atEnd = v.top >= Math.max(0, lines.length - m.textRows) && lines.length > m.textRows;
    let out = [];
    if (!atEnd) {
        for (let i = v.top; i < lines.length && out.length < m.textRows; i++) {
            const lv = v.binary ? '' : TB.level(lines[i]);
            wrap(cv, lines[i], ts, tw, 4).forEach((s, k) => out.push({ s, lv, cont: k > 0 }));
        }
        out = out.slice(0, m.textRows);
    } else {
        for (let i = lines.length - 1; i >= 0 && out.length < m.textRows; i--) {
            const lv = v.binary ? '' : TB.level(lines[i]);
            out = wrap(cv, lines[i], ts, tw, 4).map((s, k) => ({ s, lv, cont: k > 0 })).concat(out);
        }
        out = out.slice(-m.textRows);
    }
    out.forEach((r, k) => {
        const y = y0 + k * lh + lh * 0.72;
        if (r.lv) cv.fillRect(56, y0 + k * lh + 3, 4, lh - 6, lineColor(t, r.lv));
        cv.text(r.s, 72 + (r.cont ? 24 : 0), y, ts, r.cont && !r.lv ? t.dim : lineColor(t, r.lv), { font: 'label', literal: true });
    });
    const bar = scrollBar(cv, G, t, W - 52, y0, m.textRows * lh, v.top, m.textRows, lines.length);
    if (L.own && lines.length > m.textRows) cv.scroll = { y: y0, bar };
}

/* ---------------------------------------------------------------------- QR -- */
function drawQr(cv, G, t, m, L) {
    const v = m.viewer, act = L.act, sz = QR.SIZES[v.qr.size];
    const lines = m.shown();
    const head = v.name + ' @' + size(v.off) + (v.filter ? ' issues' : '') + ' ' + (v.qr.start + 1) + '-';
    let pg = QR.build(lines, v.qr.start, sz.version, head);
    pg = QR.build(lines, v.qr.start, sz.version, head + pg.end + '/' + lines.length);
    m.qrEnd = pg.end;
    cv.fillRect(28, G.TOP + 4, W - 56, L.bottom - G.TOP - 4, '#000000');
    const side = QR.draw(cv, pg, { x: 40, y: G.TOP + 8, h: L.bottom - G.TOP - 12, version: sz.version });
    const x = 40 + side + 34;
    cv.text('QR code - lines ' + (pg.start + 1) + ' - ' + pg.end + ' of ' + lines.length + (v.filter ? ' (issues only)' : ''), x, G.TOP + 44, 24, '#ffffff', { font: 'bold', literal: true });
    cv.text('Size ' + sz.label + '  ·  scan with the phone camera, copy the text', x, G.TOP + 74, 18, '#bbbbbb', { font: 'label', literal: true });
    let y = G.TOP + 94;
    if (L.own) {
        buttons(cv, G, t, x, y, [
            ['Back', act.back],
            ['Prev', act.qrPrev, { busy: !v.qr.stack.length }],
            ['Next', act.qrNext, { busy: pg.end >= lines.length, primary: pg.end < lines.length }],
            ['Size', act.qrSize],
        ], 140);
        y += BTN_H + 14;
    }
    const lh = 24, maxRows = Math.floor((L.bottom - y - 10) / lh), tw = W - 60 - x;
    pg.lines.slice(0, maxRows).forEach((l, i) => cv.text(fit(cv, l, 17, tw, 'label'), x, y + 18 + i * lh, 17, '#dddddd', { font: 'label', literal: true }));
    if (pg.lines.length > maxRows) cv.text('+ ' + (pg.lines.length - maxRows) + ' more lines in the code', x, L.bottom - 6, 16, '#999999', { font: 'label', literal: true });
}

/* -------------------------------------------------------------------- Info -- */
function drawInfo(cv, G, t, m, L) {
    const inf = m.info || {}, rows = inf.rows || [];
    const btnTop = L.own ? L.bottom - BTN_H : L.bottom;
    if (!rows.length) cv.text(inf.loading ? 'Gathering ...' : 'No info', 72, G.TOP + 60, 21, t.dim, { font: 'label' });
    const step = Math.min(40, (btnTop - G.TOP - 30) / Math.max(1, rows.length));
    rows.forEach(([label, value, kind], i) => {
        const y = G.TOP + 36 + i * step;
        if (i % 2 === 0) cv.fillRect(48, y - step + 12, W - 96, step, G.withAlpha('#ffffff', 0.025));
        cv.text(label, 72, y, 16, t.dim, { font: 'bold', spacing: 1.2, literal: true });
        const c = kind === 'bad' ? (t.crit || '#ef2b2d') : kind === 'warn' ? (t.warn || '#d29922') : kind === 'good' ? (t.go || '#2fd27a') : t.text;
        cv.text(fit(cv, value, 19, W - 96 - 300, 'label'), 300, y, 19, c, { font: 'label', literal: true });
    });
    if (L.own) G.button(cv, t, (W - 300) / 2, L.bottom - BTN_H, 300, BTN_H, 'Reload', L.act.refresh || (() => {}), { key: 'fx_info_reload' });
}

/** px a scroll step of one row is (list rows / text lines), for ctx.onScroll */
function rowPx(m, large) { return m.tab === 0 && m.viewer ? (large ? 36 : 29) : (large ? 58 : 46); }

module.exports = { draw, W, H, wrap, fit, rowPx };
