'use strict';
/**
 * front.js - the front of a G30 5 Series LCI with M Sport package, face-on, traced from a photo
 * (coordinates in that photo's pixels: centre line x = 608, bonnet edge y ~ 318, bumper bottom y ~ 735).
 * draw(cv, G, t, x, y, w, h, v) fits it into the box. The active grille shutters sit where they are on
 * the car: the upper one behind the kidneys (seen through the double bars), the lower one behind the
 * centre air intake (seen through the honeycomb mesh). v.upper / v.lower: 0 = shut .. 1 = open;
 * v.upperDim / v.lowerDim: the DME has that shutter.
 *
 * GPU-safe: fill (triangulated) / line / polyline / roundRect / circle only.
 */

const CX = 608;
const CROP = { x: 128, y: 300, w: 960, h: 445 };
const mirror = (pts) => pts.map(([x, y]) => [2 * CX - x, y]).reverse();

// --- shapes, left half (the right half is mirrored) ---------------------------------------------
const BODY = [   // the front's silhouette: bumper bottom, flank, wing, bonnet edge
    [CX, 318], [440, 320], [300, 334], [222, 372], [178, 408], [150, 470], [142, 560], [146, 650], [158, 722], [200, 738], [CX, 742]];
const KIDNEY = [ // one kidney opening (convex), inner edge upright, outer edge rounding out
    [598, 432], [598, 526], [588, 534], [412, 534], [390, 528], [377, 513], [371, 482], [373, 452], [383, 436], [402, 428], [588, 428]];
const LAMP = [   // headlight housing: thin outside, running down to the kidney inside
    [182, 432], [205, 420], [250, 410], [312, 414], [358, 426], [366, 438], [366, 468], [352, 474], [255, 480], [196, 474], [180, 460]];
const DRL_UP = [[190, 448], [215, 438], [258, 433], [300, 436]];           // the L-shaped daytime light, upper stroke
const DRL_LOW = [[252, 470], [300, 468], [352, 462]];                       // lower stroke
const LASER = [[262, 424], [312, 424], [352, 432]];                         // the blue accent over it
const SIDE = [   // side air intake (M bumper)
    [188, 548], [352, 562], [348, 600], [322, 662], [196, 664], [184, 640]];
const LOWER = [  // centre lower intake, the lower shutter behind it (full shape, symmetric)
    [430, 612], [CX, 612], [786, 612], [836, 646], [852, 668], [826, 698], [CX, 700], [390, 698], [364, 668], [380, 646]];
const PLATE = [470, 545, 276, 56];                                          // x, y, w, h
const LIP = [[300, 712], [CX, 716]];                                         // bumper lip line

const both = (half) => half.concat(mirror(half));

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
const bounds = (poly) => {
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    return { l: Math.min(...xs), r: Math.max(...xs), t: Math.min(...ys), b: Math.max(...ys) };
};
/** The polygon grown outwards by d (about its centre; fine for these rounded boxes). */
function grow(poly, d) {
    const b = bounds(poly), cx = (b.l + b.r) / 2, cy = (b.t + b.b) / 2, hw = (b.r - b.l) / 2, hh = (b.b - b.t) / 2;
    return poly.map(([x, y]) => [cx + (x - cx) * (hw + d) / hw, cy + (y - cy) * (hh + d) / hh]);
}

/**
 * The shutter behind an opening: radiator, then n louvres turning about their long axis (shut: a closed wall
 * of grey blades; open: edge-on slivers with the radiator and air showing). In photo pixels via T.
 */
function louvres(cv, G, t, T, poly, n, open, dim) {
    const b = bounds(poly), pitch = (b.b - b.t) / n, air = t.accent2 || '#81c4ff';
    cv.fill(poly.map(T), '#06080b');
    for (let y = b.t + 4; y < b.b - 2; y += 5) {          // radiator fins
        const s = spanAt(poly, y);
        if (s) cv.line(...T([s[0] + 2, y]), ...T([s[1] - 2, y]), 1, G.withAlpha('#ffffff', 0.05));
    }
    if (open > 0.02) cv.fill(poly.map(T), G.withAlpha(air, (dim ? 0.06 : 0.22) * open));
    const face = Math.max(0.10, Math.cos(open * Math.PI / 2));
    const hi = dim ? '#4a505a' : '#7c8591', lo = dim ? '#2c3037' : '#4b525c';
    for (let i = 0; i < n; i++) {
        const cy = b.t + pitch * (i + 0.5), h = pitch * face * 0.96;
        const y0 = Math.max(b.t + 0.5, cy - h / 2), y1 = Math.min(b.b - 0.5, cy + h / 2);
        const s0 = spanAt(poly, y0), s1 = spanAt(poly, y1), sm = spanAt(poly, cy);
        if (!s0 || !s1 || !sm) continue;
        cv.fill([[s0[0], y0], [s0[1], y0], [sm[1], cy], [sm[0], cy]].map(T), hi);
        cv.fill([[sm[0], cy], [sm[1], cy], [s1[1], y1], [s1[0], y1]].map(T), lo);
    }
}

/** The kidney's double vertical bars in gloss black, each pair narrowing to a point at the bottom. */
function kidneyBars(cv, G, T, poly, pairs, inner) {
    const b = bounds(poly), w = b.r - b.l;
    for (let i = 0; i < pairs; i++) {
        // spaced from the inner edge out; the outer edge curves, so the bars follow the span at each height
        const u = (i + 0.55) / (pairs + 0.1);
        const at = (y, du) => { const s = spanAt(poly, y); if (!s) return null; const x = inner < 0 ? s[0] + (s[1] - s[0]) * (u + du) : s[1] - (s[1] - s[0]) * (u + du); return [x, y]; };
        const top = b.t + 2, bot = b.b - 2, gap = 5 / w, bw = 14 / w;
        for (const side of [-1, 1]) {
            const a0 = at(top, side * gap / 2), a1 = at(top, side * (gap / 2 + bw)), c0 = at(bot, side * gap * 0.2), c1 = at(bot, side * (gap * 0.2 + bw * 0.8));
            if (!a0 || !a1 || !c0 || !c1) continue;
            cv.fill([a0, a1, c1, c0].map(T), '#101215');
            cv.line(...T(a0), ...T(c0), 1.4, G.withAlpha('#ffffff', 0.26));      // the gloss edge
            cv.line(...T(a1), ...T(c1), 1, G.withAlpha('#ffffff', 0.08));
        }
    }
}

/** Honeycomb mesh over an opening: staggered rows of small hex cells (outlined), clipped to the opening. */
function mesh(cv, G, T, poly, cell, col, fillCol) {
    const b = bounds(poly), rowH = cell * 0.75;
    let row = 0;
    for (let y = b.t + rowH / 2; y < b.b; y += rowH, row++) {
        const s = spanAt(poly, y);
        if (!s) continue;
        for (let x = s[0] + (row % 2 ? cell / 2 : 0) + cell / 2; x < s[1] - cell / 3; x += cell) {
            const r = cell * 0.42, hx = [];
            for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + k * Math.PI / 3; hx.push([x + Math.cos(a) * r, y + Math.sin(a) * r * 0.8]); }
            if (fillCol) cv.fill(hx.map(T), fillCol);
            cv.polyline(hx.concat([hx[0]]).map(T), 1, col);
        }
    }
}

function draw(cv, G, t, x, y, w, h, v) {
    const s = Math.min(w / CROP.w, h / CROP.h);
    const ox = x + (w - CROP.w * s) / 2 - CROP.x * s, oy = y + (h - CROP.h * s) / 2 - CROP.y * s;
    const T = ([px, py]) => [ox + px * s, oy + py * s];
    const up = Math.max(0, Math.min(1, v.upper == null ? 0.35 : v.upper));
    const low = Math.max(0, Math.min(1, v.lower == null ? 0.35 : v.lower));
    const paint = v.paint || '#2b3038', paintHi = G.withAlpha('#ffffff', 0.10);

    // body, the bonnet a shade lighter above the lights
    cv.fill(both(BODY).map(T), paint);
    cv.fill([[222, 372], [300, 334], [440, 320], [CX, 318], [776, 320], [916, 334], [994, 372], [1034, 410], [850, 426], [CX, 422], [366, 426], [182, 410]].map(T),
        G.withAlpha('#ffffff', 0.05));
    cv.polyline([[196, 476], [180, 545], [184, 664], [240, 700], [CX, 708], [976, 700], [1032, 664], [1036, 545], [1020, 476]].map(T), 1.5,
        G.withAlpha('#ffffff', 0.06));
    cv.polyline(both(BODY).slice(0, 6).map(T), 2, paintHi);
    cv.polyline(mirror(BODY).slice(-6).map(T), 2, paintHi);
    cv.polyline([[440, 322], [CX, 320], [776, 322]].map(T), 2, paintHi);
    cv.line(...T([300, 380]), ...T([400, 424]), 1.5, G.withAlpha('#000000', 0.25));       // bonnet creases
    cv.line(...T([916, 380]), ...T([816, 424]), 1.5, G.withAlpha('#000000', 0.25));

    // headlights
    for (const m of [false, true]) {
        const f = m ? mirror : (p) => p;
        const lamp = f(LAMP);
        cv.fill(grow(lamp, 2).map(T), '#0b0c0f');
        cv.fill(lamp.map(T), '#14171c');
        cv.polyline(f(LASER).map(T), 2.5 * s + 1, t.accent2 || '#5aa0ff');
        cv.polyline(f(DRL_UP).map(T), 4 * s + 1.5, '#eef4ff');
        cv.polyline(f(DRL_LOW).map(T), 4 * s + 1.5, '#eef4ff');
        cv.circle(...T(m ? [2 * CX - 225, 455] : [225, 455]), 9 * s, '#262a31');            // projector
    }

    // side intakes (mesh, no shutter behind)
    for (const m of [false, true]) {
        const p = m ? mirror(SIDE) : SIDE;
        cv.fill(grow(p, 3).map(T), '#0a0b0e');
        cv.fill(p.map(T), '#050608');
        mesh(cv, G, T, p, 15, G.withAlpha('#ffffff', 0.10));
    }

    // upper shutter behind the kidneys, the shared black surround, the bars in front
    const kL = KIDNEY, kR = mirror(KIDNEY);
    cv.fill([[372, 424], [CX, 424], [844, 424], [856, 470], [844, 538], [CX, 540], [372, 538], [360, 470]].map(T), '#0a0b0e');
    for (const [k, inner] of [[kL, 1], [kR, -1]]) {
        louvres(cv, G, t, T, k, 5, up, v.upperDim);
        kidneyBars(cv, G, T, k, 5, inner);
        cv.polyline(k.concat([k[0]]).map(T), 2, G.withAlpha('#ffffff', 0.18));            // the frame's gloss line
    }
    cv.circle(...T([CX, 470]), 7 * s, '#1b1e23');                                          // the badge in between

    // number plate
    cv.roundRect(...T([PLATE[0], PLATE[1]]), PLATE[2] * s, PLATE[3] * s, 3 * s, '#d9dde3');
    cv.roundRect(...T([PLATE[0], PLATE[1]]), 18 * s, PLATE[3] * s, 3 * s, '#2b4fa8');

    // lower shutter behind the centre intake, the honeycomb in front
    cv.fill(grow(LOWER, 4).map(T), '#0a0b0e');
    louvres(cv, G, t, T, LOWER, 4, low, v.lowerDim);
    mesh(cv, G, T, LOWER, 17, G.withAlpha('#000000', 0.85));
    mesh(cv, G, T, LOWER, 17, G.withAlpha('#ffffff', 0.07));
    cv.polyline(LIP.concat(mirror(LIP)).map(T), 2, G.withAlpha('#000000', 0.4));
    return { T, s };
}

module.exports = { draw, CROP, CX, shapes: { BODY: both(BODY), KIDNEY, LAMP, SIDE, LOWER, PLATE } };
