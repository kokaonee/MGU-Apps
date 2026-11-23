'use strict';
/**
 * ui.js - the AGS Control screen, a pure draw(cv, G, t, v, act) in the house style of the
 * kit's other apps (Engine Config): page tabs, the grey content panel, a picture, the big
 * state word and red/outline buttons drawn on the canvas where the kit runs the screen.
 *
 * Pages: 'Shutters' (the car's front with both shutters, the state, Open / Closed / OEM),
 * 'Status' (link, DME, takeovers, errors, read-back) and 'Log' (the telemetry log, paged).
 * v = view built in main.js; act = press callbacks.
 *
 * GPU-safe: only fillRect / gradientRect / roundRect / strokeRoundRect / fill / line / circle / text.
 */

const W = 1600, H = 520;
const PAGES = ['Shutters', 'Status', 'Log'];
const LOG_ROWS = 9;

const clamp01 = (x) => Math.max(0, Math.min(1, x));

function draw(cv, G, t, v, act) {
    act = act || {};
    cv.clear(t.bg);
    const page = PAGES.indexOf(v.page) >= 0 ? v.page : PAGES[0];
    G.frame(cv, t, PAGES, PAGES.indexOf(page), [
        v.armed ? null : { text: 'SIM', color: t.warn || '#d29922' },
        v.standing === false && v.speed != null ? { text: 'MOVING', color: t.warn || '#d29922' } : null,
    ]);
    G.panel(cv, t, 24, G.TOP, W - 48, G.BOTTOM - G.TOP, null);
    const bottom = G.pageBottom(cv) - (cv.own ? G.MARGIN : 0);
    if (page === 'Status') return drawStatus(cv, G, t, v, act, bottom);
    if (page === 'Log') return drawLog(cv, G, t, v, act, bottom);
    return drawShutters(cv, G, t, v, act, bottom);
}

/* ---------------------------------------------------------------- Shutters page -- */

const STATE_COL = (t, s) => s === 'OPEN' ? (t.accent2 || '#81c4ff') : s === 'CLOSED' ? (t.crit || '#ef2b2d') : t.text;

function drawShutters(cv, G, t, v, act, bottom) {
    // the car's front on the left, the state on the right, the buttons across the bottom
    const btnTop = cv.own ? bottom - 56 : bottom;
    drawFront(cv, G, t, 40, G.TOP + 14, 900, btnTop - G.TOP - 34, v);

    const x0 = 1000, warn = t.warn || '#d29922';
    cv.text(v.word, x0, G.TOP + 92, 64, STATE_COL(t, v.word), { font: 'bold', spacing: 3 });
    cv.text(v.sub || '', x0, G.TOP + 130, 19, v.subWarn ? warn : t.dim, { font: 'label' });
    if (v.notice) cv.text(v.notice, x0, G.TOP + 160, 19, warn, { font: 'label' });

    const tiles = [
        ['SPEED', v.speed == null ? '--' : Math.round(v.speed) + ' km/h', v.standing === false],
        ['COOLANT', v.coolant == null ? '--' : v.coolant + ' °C', false],
        ['POSITION', v.posDeg == null ? '--' : v.posDeg.toFixed(1) + '°', false],
        ['CAR MODE', v.carMode || '--', false],
    ];
    const tw = 262, th = 84, gx = 18, gy = 16, ty0 = G.TOP + 186;
    tiles.forEach(([label, value, hot], i) => {
        const tx = x0 + (i % 2) * (tw + gx), ty = ty0 + Math.floor(i / 2) * (th + gy);
        cv.roundRect(tx, ty, tw, th, 10, G.withAlpha('#ffffff', 0.05));
        cv.text(label, tx + 18, ty + 30, 15, t.dim, { font: 'bold', spacing: 1.5 });
        cv.text(value, tx + 18, ty + 68, 28, value === '--' ? t.dim : hot ? warn : t.text, { font: 'bold' });
    });

    if (!cv.own) return cv;
    const moving = v.standing === false;
    const btns = [
        { k: 'open', label: 'Open', run: act.open, busy: moving },
        { k: 'closed', label: 'Closed', run: act.closed, busy: moving },
        { k: 'oem', label: 'OEM', run: act.oem, busy: false },
    ];
    const bw = 300, bh = 56, gap = 30;
    let bx = (W - (btns.length * bw + (btns.length - 1) * gap)) / 2;
    for (const b of btns) {
        const on = b.k === v.mode;
        const o = on ? { color: t.crit || '#ef2b2d', primary: true, key: 'ags_' + b.k, busy: b.busy } : { key: 'ags_' + b.k, busy: b.busy };
        G.button(cv, t, bx, bottom - bh, bw, bh, b.label, b.run || (() => {}), o);
        bx += bw + gap;
    }
    return cv;
}

/** Points of a convex polygon with rounded corners (corners clockwise, radius r). */
function rounded(corners, r, steps) {
    const n = corners.length, out = [];
    steps = steps || 6;
    for (let i = 0; i < n; i++) {
        const p = corners[i], a = corners[(i + n - 1) % n], b = corners[(i + 1) % n];
        const da = Math.hypot(a[0] - p[0], a[1] - p[1]), db = Math.hypot(b[0] - p[0], b[1] - p[1]);
        const rr = Math.min(r, da / 2, db / 2);
        const pa = [p[0] + (a[0] - p[0]) / da * rr, p[1] + (a[1] - p[1]) / da * rr];
        const pb = [p[0] + (b[0] - p[0]) / db * rr, p[1] + (b[1] - p[1]) / db * rr];
        for (let s = 0; s <= steps; s++) {        // quadratic curve pa -> p -> pb
            const u = s / steps, k0 = (1 - u) * (1 - u), k1 = 2 * u * (1 - u), k2 = u * u;
            out.push([k0 * pa[0] + k1 * p[0] + k2 * pb[0], k0 * pa[1] + k1 * p[1] + k2 * pb[1]]);
        }
    }
    return out;
}

/** The horizontal span [x0, x1] of a convex polygon at height y (null outside). */
function spanAt(poly, y) {
    let x0 = Infinity, x1 = -Infinity;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if ((a[1] - y) * (b[1] - y) > 0 || a[1] === b[1]) continue;
        const x = a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    }
    return x0 <= x1 ? [x0, x1] : null;
}

/** A convex polygon shrunk towards its centre by d px (good enough for these near-rectangles). */
function inset(poly, d) {
    const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length, cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const hw = (Math.max(...xs) - Math.min(...xs)) / 2, hh = (Math.max(...ys) - Math.min(...ys)) / 2;
    return poly.map((p) => [cx + (p[0] - cx) * (hw - d) / hw, cy + (p[1] - cy) * (hh - d) / hh]);
}

/**
 * One shutter opening: the radiator behind it, n louvres turning about their long axis
 * (open 0 = shut wall .. 1 = edge on), cut to the opening's outline. dim: the DME has it (OEM).
 */
function louvres(cv, G, t, poly, n, open, dim, bars) {
    const ys = poly.map((p) => p[1]);
    const top = Math.min(...ys), bot = Math.max(...ys), pitch = (bot - top) / n;
    const air = t.accent2 || '#81c4ff';
    cv.fill(poly, '#07090d');
    // radiator core behind: fine vertical fins, lit blue as far as air goes through
    for (let y = top + 3; y < bot - 3; y += 6) {
        const s = spanAt(poly, y);
        if (s) cv.line(s[0] + 3, y, s[1] - 3, y, 1, G.withAlpha('#ffffff', 0.05));
    }
    if (open > 0.02) cv.fill(poly, G.withAlpha(air, 0.10 * open));
    // the louvres: each one's face shrinks to a sliver as it turns open
    const face = Math.max(0.10, Math.cos(open * Math.PI / 2));
    const hi = dim ? '#5b6270' : '#9aa3b0', lo = dim ? '#353a44' : '#5d6572';
    for (let i = 0; i < n; i++) {
        const cy = top + pitch * (i + 0.5), h = pitch * face * 0.98;
        const y0 = Math.max(top + 0.5, cy - h / 2), y1 = Math.min(bot - 0.5, cy + h / 2);
        const s0 = spanAt(poly, y0), s1 = spanAt(poly, y1), sm = spanAt(poly, cy);
        if (!s0 || !s1 || !sm) continue;
        cv.fill([[s0[0], y0], [s0[1], y0], [sm[1], cy], [sm[0], cy]], hi);
        cv.fill([[sm[0], cy], [sm[1], cy], [s1[1], y1], [s1[0], y1]], lo);
        if (open > 0.15) cv.line(sm[0], cy, sm[1], cy, 1.5, G.withAlpha('#000000', 0.5));   // the pivot
    }
    // the grille's own bars in front (kidney: vertical slats)
    if (bars) {
        const xs = poly.map((p) => p[0]), l = Math.min(...xs), r = Math.max(...xs);
        for (let x = l + bars; x < r - 4; x += bars) {
            let a = null, b = null;
            for (let y = top; y <= bot; y += 2) { const s = spanAt(poly, y); if (s && x > s[0] + 2 && x < s[1] - 2) { if (a === null) a = y; b = y; } }
            if (a !== null) cv.line(x, a, x, b, 3, G.withAlpha('#c8ced8', 0.28));
        }
    }
}

/** A chrome / black surround: the outline drawn a few px larger behind the opening. */
function surround(cv, G, poly, d, col) {
    cv.fill(inset(poly, -d), col);
}

/** The front of the car with the upper (kidneys) and lower (bumper) shutters. */
function drawFront(cv, G, t, x, y, w, h, v) {
    const cx = x + w / 2, s = Math.min(w / 900, h / 360), oy = y + (h - 360 * s) / 2;
    const P = (px, py) => [cx + px * s, oy + py * s];
    const body = G.withAlpha('#ffffff', 0.16), edge = G.withAlpha('#ffffff', 0.35);

    // bonnet and bumper lines, headlights (silhouette only)
    cv.line(...P(-420, 40), ...P(-150, 8), 2, body);
    cv.line(...P(150, 8), ...P(420, 40), 2, body);
    cv.line(...P(-150, 8), ...P(150, 8), 2, body);
    cv.line(...P(-440, 330), ...P(-300, 355), 2, body);
    cv.line(...P(300, 355), ...P(440, 330), 2, body);
    cv.line(...P(-300, 355), ...P(300, 355), 2, body);
    for (const side of [-1, 1]) {
        const lamp = [P(side * 152, 58), P(side * 400, 66), P(side * 420, 100), P(side * 160, 112)];
        if (side > 0) lamp.reverse();
        cv.fill(lamp, G.withAlpha('#ffffff', 0.07));
        cv.line(...P(side * 175, 96), ...P(side * 395, 88), 3, G.withAlpha('#e8f2ff', 0.55));   // daytime light bar
    }

    const upOpen = clamp01(v.upper == null ? 0.35 : v.upper), lowOpen = clamp01(v.lower == null ? 0.35 : v.lower);
    // kidneys: inner edge upright, outer edge leaning out at the bottom
    for (const side of [-1, 1]) {
        let k = [[side * 12, 44], [side * 138, 44], [side * 150, 196], [side * 12, 196]].map((p) => P(p[0], p[1]));
        if (side < 0) k.reverse();
        k = rounded(k, 26 * s, 6);
        surround(cv, G, k, 7 * s, '#b9c0ca');
        surround(cv, G, k, 3 * s, '#2a2e35');
        louvres(cv, G, t, k, 6, upOpen, v.upperDim, 18 * s);
    }
    // lower shutter in the bumper
    let low = rounded([P(-200, 236), P(200, 236), P(222, 316), P(-222, 316)], 22 * s, 6);
    surround(cv, G, low, 4 * s, '#1a1d22');
    louvres(cv, G, t, low, 4, lowOpen, v.lowerDim, 0);
    cv.line(...P(-232, 318), ...P(232, 318), 1.5, edge);

    // labels with the flap's state
    const lab = (txt, px, py, on, open) => {
        const c = on ? STATE_COL(t, open > 0.6 ? 'OPEN' : open < 0.1 ? 'CLOSED' : '') : t.dim;
        cv.text(txt, ...P(px, py), 15, c, { align: 'center', font: 'bold', spacing: 1.5 });
    };
    lab('UPPER', -280, 160, !v.upperDim, upOpen);
    lab('LOWER', 0, 346, !v.lowerDim, lowOpen);
}

/* ------------------------------------------------------------------ Status page -- */

function drawStatus(cv, G, t, v, act, bottom) {
    const rows = v.rows || [];
    const btnTop = cv.own ? bottom - 56 : bottom;
    const step = Math.min(46, (btnTop - G.TOP - 40) / Math.max(1, rows.length));
    rows.forEach(([label, value, kind], i) => {
        const y = G.TOP + 44 + i * step;
        if (i % 2 === 0) cv.fillRect(48, y - step + 14, W - 96, step, G.withAlpha('#ffffff', 0.025));
        cv.text(label, 72, y, 17, t.dim, { font: 'bold', spacing: 1.2 });
        const c = kind === 'bad' ? (t.crit || '#ef2b2d') : kind === 'warn' ? (t.warn || '#d29922') : kind === 'good' ? (t.go || '#2fd27a') : t.text;
        cv.text(value, 470, y, 21, c, { font: 'label', literal: true });
    });
    if (cv.own) G.button(cv, t, (W - 360) / 2, bottom - 56, 360, 56, 'Read shutters', act.read || (() => {}), { key: 'ags_read' });
    return cv;
}

/* --------------------------------------------------------------------- Log page -- */

function drawLog(cv, G, t, v, act, bottom) {
    const lg = v.log || { rows: [], page: 0, pages: 1, total: 0 };
    const btnTop = cv.own ? bottom - 56 : bottom;
    cv.text('Page ' + (lg.page + 1) + ' / ' + lg.pages + '  ·  newest first  ·  ' + lg.total + ' entries', 72, G.TOP + 38, 16, t.dim,
        { font: 'bold', spacing: 1.2, literal: true });
    const step = Math.min(36, (btnTop - G.TOP - 70) / LOG_ROWS);
    for (let i = 0; i < LOG_ROWS; i++) {
        const row = lg.rows[i];
        if (!row) continue;
        const y = G.TOP + 76 + i * step;
        const sp = row.indexOf(' ');
        const time = sp > 0 ? row.slice(0, sp) : '', text = sp > 0 ? row.slice(sp + 1) : row;
        const bad = /err|refus|NRC|fail/i.test(text), hot = /takeover|drove off|ignored/i.test(text);
        cv.text(time, 72, y, 19, t.dim, { font: 'label', literal: true });
        cv.text(text, 200, y, 20, bad ? (t.crit || '#ef2b2d') : hot ? (t.warn || '#d29922') : t.text, { font: 'label', literal: true });
    }
    if (!cv.own) return cv;
    const btns = [
        ['Newer', act.logNewer, { busy: lg.page <= 0 }],
        ['Older', act.logOlder, { busy: lg.page >= lg.pages - 1 }],
        ['QR code', act.logQr, {}],
        ['Clear', act.logClear, { confirm: true, color: t.crit || '#ef2b2d' }],
    ];
    const bw = 250, gap = 26;
    let bx = (W - (btns.length * bw + (btns.length - 1) * gap)) / 2;
    btns.forEach(([label, run, o], i) => {
        G.button(cv, t, bx, bottom - 56, bw, 56, label, run || (() => {}), Object.assign({ key: 'ags_log' + i }, o));
        bx += bw + gap;
    });
    return cv;
}

module.exports = { draw, W, H, PAGES, LOG_ROWS };
