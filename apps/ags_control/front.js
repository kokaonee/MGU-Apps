'use strict';
/**
 * front.js - the front of a G30 5 Series LCI with M Sport package, face-on (outlines: front_shapes.js,
 * traced from a reference photo). draw(cv, G, t, x, y, w, h, v) fits it into the box.
 * The active grille shutters sit where they are on the car: the upper one behind the kidneys (seen through
 * the double bars), the lower one behind the centre air intake (seen through the honeycomb).
 * v.upper / v.lower: 0 = shut .. 1 = open; v.upperDim / v.lowerDim: the DME has that shutter;
 * v.paint: a key of PAINTS.
 *
 * GPU-safe: fill (triangulated) / line / polyline / roundRect only. Gradients are drawn as bands:
 * the shape cut into horizontal (or vertical) strips, each filled in its colour.
 */
const S = require('./front_shapes');

const CX = S.CX;
const BOX = { x: 134, y: 160, w: 950, h: 556 };       // what is drawn, in photo pixels
const BONNET = 314;                                     // the bonnet's top edge (photo y)

/** Paint: [highlight, base, shadow]. */
const PAINTS = {
    red: ['#ff3b2e', '#c8140c', '#5a0603'],
    alpine: ['#ffffff', '#e4e7ea', '#8d9298'],
    mineral: ['#f4f5f3', '#cfd1cf', '#7c807e'],
    sapphire: ['#5c6470', '#1d2027', '#060608'],
    carbon: ['#3d5a86', '#16233a', '#05080e'],
    phytonic: ['#3f78c8', '#173f7d', '#06142c'],
    sophisto: ['#8d939b', '#4f555d', '#1b1d21'],
    bernina: ['#b9b3a6', '#7b766c', '#34312c'],
};

/* ------------------------------------------------------------------ geometry helpers -- */

const mirror = (pts) => pts.map(([x, y]) => [2 * CX - x, y]).reverse();
const bounds = (poly) => {
    let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
    for (const [x, y] of poly) { l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y); }
    return { l, r, t, b };
};
/** Sutherland-Hodgman: keep the part of poly where k * (p[axis] - v) >= 0. */
function cut(poly, axis, v, k) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const ia = k * (a[axis] - v) >= 0, ib = k * (b[axis] - v) >= 0;
        if (ia) out.push(a);
        if (ia !== ib) {
            const u = (v - a[axis]) / (b[axis] - a[axis]);
            out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
        }
    }
    return out;
}
const band = (poly, axis, v0, v1) => cut(cut(poly, axis, v0, 1), axis, v1, -1);
/** The horizontal span [x0, x1] of a (convex-ish) polygon at height y. */
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
/** Convex hull (monotone chain), clockwise on screen. */
function hull(pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (const q of p.slice().reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
}
/** The polygon grown by d about its centre (fine for these rounded boxes). */
function grow(poly, d) {
    const b = bounds(poly), cx = (b.l + b.r) / 2, cy = (b.t + b.b) / 2, hw = (b.r - b.l) / 2, hh = (b.b - b.t) / 2;
    return poly.map(([x, y]) => [cx + (x - cx) * (hw + d) / hw, cy + (y - cy) * (hh + d) / hh]);
}

/* ------------------------------------------------------------------- colour helpers -- */

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const toHex = (a) => '#' + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
/** Colour at u (0..1) along stops [[pos, '#rrggbb'], ...]. */
function at(stops, u) {
    let i = 0;
    while (i < stops.length - 2 && u > stops[i + 1][0]) i++;
    const [p0, c0] = stops[i], [p1, c1] = stops[i + 1];
    const k = Math.max(0, Math.min(1, (u - p0) / ((p1 - p0) || 1))), a = hex(c0), b = hex(c1);
    return toHex(a.map((v, j) => v + (b[j] - v) * k));
}
/** Fill poly with a gradient along axis (1 = top to bottom, 0 = left to right) in n bands. */
function grad(cv, T, poly, axis, stops, n) {
    const b = bounds(poly), v0 = axis ? b.t : b.l, v1 = axis ? b.b : b.r;
    for (let i = 0; i < n; i++) {
        const a = v0 + (v1 - v0) * i / n, z = v0 + (v1 - v0) * (i + 1) / n + (i < n - 1 ? 1.4 : 0);
        const p = band(poly, axis, a, z);
        if (p.length >= 3) cv.fill(p.map(T), at(stops, (i + 0.5) / n));
    }
}
/** One colour with an alpha changing from a0 (at `from`) to a1 (at `to`) along axis: overlay shading. */
function shade(cv, G, T, poly, axis, col, a0, a1, n, from, to) {
    for (let i = 0; i < n; i++) {
        const a = from + (to - from) * i / n, z = from + (to - from) * (i + 1) / n;
        const p = band(poly, axis, Math.min(a, z), Math.max(a, z));
        const al = a0 + (a1 - a0) * (i + 0.5) / n;
        if (p.length >= 3 && al > 0.004) cv.fill(p.map(T), G.withAlpha(col, al));
    }
}

/* ----------------------------------------------------------------------- the parts -- */

/**
 * A shutter behind an opening: the radiator, then n louvres turning about their long axis (shut: a closed wall of
 * blades; open: edge-on slivers, the radiator and the air showing).
 */
function louvres(cv, G, t, T, poly, n, open, dim) {
    const b = bounds(poly), pitch = (b.b - b.t) / n, air = t.accent2 || '#81c4ff';
    cv.fill(poly.map(T), '#05070a');
    for (let y = b.t + 3; y < b.b - 2; y += 4) {             // radiator fins
        const s = spanAt(poly, y);
        if (s) cv.line(...T([s[0] + 2, y]), ...T([s[1] - 2, y]), 0.8, G.withAlpha('#ffffff', 0.06));
    }
    if (open > 0.02) cv.fill(poly.map(T), G.withAlpha(air, (dim ? 0.07 : 0.24) * open));
    const face = Math.max(0.10, Math.cos(open * Math.PI / 2));
    const hi = dim ? '#41464e' : '#737b86', mid = dim ? '#30343a' : '#525860', lo = dim ? '#22252a' : '#363a41';
    for (let i = 0; i < n; i++) {
        const cy = b.t + pitch * (i + 0.5), h = pitch * face * 0.97;
        const y0 = Math.max(b.t + 0.5, cy - h / 2), y1 = Math.min(b.b - 0.5, cy + h / 2), ym = cy - h * 0.15;
        const s0 = spanAt(poly, y0), s1 = spanAt(poly, y1), sm = spanAt(poly, ym);
        if (!s0 || !s1 || !sm) continue;
        cv.fill([[s0[0], y0], [s0[1], y0], [sm[1], ym], [sm[0], ym]].map(T), hi);
        cv.fill([[sm[0], ym], [sm[1], ym], [s1[1], y1], [s1[0], y1]].map(T), open > 0.5 ? lo : mid);
        cv.line(...T([s1[0], y1]), ...T([s1[1], y1]), 1, G.withAlpha('#000000', 0.6));
    }
}

/** The kidney's double bars in gloss black: n bars, each two slats, upright, cut to the opening. */
function kidneyBars(cv, G, T, poly, n) {
    const b = bounds(poly), mid = spanAt(poly, (b.t + b.b) / 2);
    const inside = (x, y) => { const s = spanAt(poly, y); return s && x > s[0] + 1 && x < s[1] - 1; };
    const ends = (x) => {
        let t = b.t, e = b.b;
        while (t < e && !inside(x, t)) t += 1;
        while (e > t && !inside(x, e)) e -= 1;
        return [t + 1, e - 1];
    };
    const pitch = (mid[1] - mid[0]) / n;
    for (let i = 0; i < n; i++) {
        const xc = mid[0] + pitch * (i + 0.5);
        for (const k of [-1, 1]) {
            const x0 = xc + k * 2, x1 = xc + k * (2 + pitch * 0.30);
            const [t0, e0] = ends(x0), [t1, e1] = ends(x1);
            if (e0 - t0 < 6 || e1 - t1 < 6) continue;
            cv.fill([[x0, t0], [x1, t1], [x1, e1], [x0, e0]].map(T), '#0c0d10');
            // gloss: a light streak down the slat's face, brighter at the top
            const xm = x0 + (x1 - x0) * 0.4, ym = (t0 + e0) / 2;
            cv.line(...T([xm, t0 + 3]), ...T([xm, ym]), 1.6, G.withAlpha('#ffffff', 0.32));
            cv.line(...T([xm, ym]), ...T([xm, e0 - 3]), 1.2, G.withAlpha('#ffffff', 0.10));
        }
    }
}

/** Honeycomb mesh over an opening: staggered hex cells, outlined, clipped to the opening's span. */
function mesh(cv, G, T, poly, cell, col, lw) {
    const b = bounds(poly), rowH = cell * 0.74;
    let row = 0;
    for (let y = b.t + rowH * 0.6; y < b.b - rowH * 0.3; y += rowH, row++) {
        const s = spanAt(poly, y);
        if (!s) continue;
        for (let x = s[0] + (row % 2 ? cell / 2 : 0) + cell * 0.55; x < s[1] - cell * 0.45; x += cell) {
            const r = cell * 0.46, hx = [];
            for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + k * Math.PI / 3; hx.push([x + Math.cos(a) * r, y + Math.sin(a) * r * 0.78]); }
            cv.polyline(hx.concat([hx[0]]).map(T), lw || 1, col);
        }
    }
}

/* -------------------------------------------------------------------------- draw -- */

function draw(cv, G, t, x, y, w, h, v) {
    const sc = Math.min(w / BOX.w, h / BOX.h);
    const ox = x + (w - BOX.w * sc) / 2 - BOX.x * sc, oy = y + (h - BOX.h * sc) / 2 - BOX.y * sc;
    const T = ([px, py]) => [ox + px * sc, oy + py * sc];
    const up = Math.max(0, Math.min(1, v.upper == null ? 0.35 : v.upper));
    const low = Math.max(0, Math.min(1, v.lower == null ? 0.35 : v.lower));
    const [pHi, pBase, pLo] = PAINTS[v.paint] || PAINTS.sapphire;
    const both = (half) => [half, mirror(half)];

    // --- greenhouse: roof and pillars in paint, the windscreen dark with a reflection ---
    const glass = hull(S.glass), gb = bounds(glass);
    grad(cv, T, glass, 1, [[0, pBase], [1, pLo]], 6);
    const screen = hull(cut(glass, 1, gb.t + 22, 1).map(([px, py]) => [CX + (px - CX) * 0.955, py]));
    grad(cv, T, screen, 1, [[0, '#262c35'], [0.5, '#12161c'], [1, '#07090c']], 10);
    const sb = bounds(screen);
    cv.fill([[sb.l + 120, sb.t + 2], [sb.l + 210, sb.t + 2], [sb.l + 120, sb.b - 4], [sb.l + 40, sb.b - 4]].map(T), G.withAlpha('#ffffff', 0.04));
    cv.fill([[sb.r - 230, sb.t + 2], [sb.r - 200, sb.t + 2], [sb.r - 300, sb.b - 4], [sb.r - 340, sb.b - 4]].map(T), G.withAlpha('#ffffff', 0.03));

    // --- mirrors (gloss black caps) ---
    for (const m of both(S.mirror)) {
        grad(cv, T, m, 1, [[0, '#2b2f36'], [0.35, '#0d0f12'], [1, '#050506']], 6);
        const mb = bounds(m);
        cv.line(...T([mb.l + 10, mb.t + 6]), ...T([mb.r - 18, mb.t + 5]), 2, G.withAlpha('#ffffff', 0.35));
    }

    // --- body: paint from the bonnet's highlight to the bumper's shadow, darker towards the flanks ---
    // (the outline without the A-pillars above the bonnet: the greenhouse has them)
    const body = cut(S.body, 1, BONNET, 1), bb = bounds(body);
    grad(cv, T, body, 1, [[0, pHi], [0.18, pBase], [0.55, pBase], [0.82, pLo], [1, '#060606']], 44);
    shade(cv, G, T, body, 0, '#000000', 0.5, 0, 16, bb.l, bb.l + 120);
    shade(cv, G, T, body, 0, '#000000', 0.5, 0, 16, bb.r, bb.r - 120);
    // the bonnet's reflection band and its creases
    shade(cv, G, T, body, 1, '#ffffff', 0.0, 0.10, 8, 330, 358);
    shade(cv, G, T, body, 1, '#ffffff', 0.10, 0.0, 8, 358, 385);
    cv.polyline(body.concat([body[0]]).map(T), 1.2, G.withAlpha('#ffffff', 0.14));        // keeps a dark paint off the background
    cv.polyline(glass.concat([glass[0]]).map(T), 1.2, G.withAlpha('#ffffff', 0.10));

    // --- headlights: dark housing, the L-shaped daytime light and the blue accent ---
    for (const side of [0, 1]) {
        const f = side ? mirror : (p) => p;
        const lamp = f(S.lamp);
        cv.fill(grow(lamp, 2.5).map(T), '#060708');
        grad(cv, T, lamp, 1, [[0, '#2a2f37'], [0.5, '#121519'], [1, '#08090b']], 6);
        for (const p of S.blue) cv.fill(f(p).map(T), '#3f86ff');
        for (const p of S.drl) {
            cv.fill(grow(f(p), 1.5).map(T), G.withAlpha('#cfe2ff', 0.35));       // a little glow
            cv.fill(f(p).map(T), '#f5f8ff');
        }
    }

    // --- side air intakes (black, honeycomb) ---
    for (const p of both(S.side)) {
        cv.fill(grow(p, 2).map(T), '#030304');
        grad(cv, T, p, 1, [[0, '#15171b'], [1, '#050506']], 5);
        mesh(cv, G, T, p, 13, G.withAlpha('#ffffff', 0.08), 1);
    }

    // --- kidneys: upper shutter behind, gloss black frame, double bars in front ---
    for (const [k, side] of [[S.kidney, 1], [mirror(S.kidney), -1]]) {
        cv.fill(grow(k, 5).map(T), '#050506');
        louvres(cv, G, t, T, k, 6, up, v.upperDim);
        kidneyBars(cv, G, T, k, 7);
        const kb = bounds(k), g = grow(k, 4);
        cv.polyline(g.filter(([, py]) => py < kb.t + 30).sort((a, b) => a[0] - b[0]).map(T), 1.8, G.withAlpha('#ffffff', 0.45));
    }

    // --- centre intake: lower shutter behind the honeycomb ---
    cv.fill(grow(S.lower, 3).map(T), '#030304');
    louvres(cv, G, t, T, S.lower, 5, low, v.lowerDim);
    mesh(cv, G, T, S.lower, 19, '#050506', 3.2);
    mesh(cv, G, T, S.lower, 19, G.withAlpha('#ffffff', 0.10), 1);
    return { T, sc };
}

module.exports = { draw, PAINTS, BOX };
