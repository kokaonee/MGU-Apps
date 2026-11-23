'use strict';
/**
 * qrview.js - the telemetry log as plain-text QR codes: a phone camera shows the lines as text,
 * so they can be copied instead of photographed. Uncompressed on purpose (the kit's own "QR log"
 * packs with deflate, which a phone cannot read).
 *
 *   pages(lines, version, head)  lines (oldest first) cut into codes from the newest back:
 *                                [{ text, first, last, n }], page 0 = newest; each page reads alone
 *   draw(cv, page, info, opts)   the code (left) and the page's lines (right) on a 1600 x 520 canvas
 */
const qr = require('./kit/qr');

const SIZES = [
    { id: 'large', version: 15, label: 'Large' },     // 77 modules: easiest to scan
    { id: 'medium', version: 20, label: 'Medium' },   // 97: ~25 lines (version 25 at 4 px did not decode reliably)
];
const MAX_PAGES = 30;

function pages(lines, version, head) {
    const cap = qr.capacity(version, 'L');
    const top = (i, n) => (head || 'AGS log') + ' ' + i + '/' + n + '\n';
    const room = cap - Buffer.byteLength(top(MAX_PAGES, MAX_PAGES));
    const out = [];
    let end = lines.length;
    while (end > 0 && out.length < MAX_PAGES) {
        let bytes = 0, start = end;
        while (start > 0) {
            const b = Buffer.byteLength(lines[start - 1]) + 1;
            if (bytes + b > room) break;
            bytes += b; start--;
        }
        if (start === end) { end--; continue; }        // a single line too long: left out
        out.push(lines.slice(start, end));
        end = start;
    }
    if (!out.length) out.push(['(log is empty)']);
    return out.map((ls, i) => ({ text: top(i + 1, out.length) + ls.join('\n'), first: ls[0], last: ls[ls.length - 1], n: ls.length, lines: ls }));
}

const cache = { key: null, code: null };
function encoded(text, version) {
    const key = version + '|' + text;
    if (cache.key !== key) { cache.key = key; cache.code = qr.encode(Buffer.from(text, 'utf8'), { version, ecl: 'L' }); }
    return cache.code;
}

/** info: { page, pages, size } ; draws black-on-white with a 4-module quiet zone, whole pixels per module */
function draw(cv, pg, info, opts) {
    const o = opts || {}, W = 1600, H = 520;
    cv.clear('#000000');
    // the smallest version the page fits in (bigger modules, easier to scan), at most the chosen size
    let v = 5;
    while (v < info.version && qr.capacity(v, 'L') < Buffer.byteLength(pg.text)) v++;
    const q = encoded(pg.text, v);
    const n = q.size + 8;
    const px = Math.max(2, Math.floor((H - 10) / n));
    const side = n * px, ox = 10, oy = Math.floor((H - side) / 2);
    cv.fillRect(ox, oy, side, side, '#ffffff');
    for (let y = 0; y < q.size; y++) {
        for (let x = 0; x < q.size;) {
            if (!q.get(x, y)) { x++; continue; }
            let e = x + 1;
            while (e < q.size && q.get(e, y)) e++;
            cv.fillRect(ox + (x + 4) * px, oy + (y + 4) * px, (e - x) * px, px, '#000000');
            x = e;
        }
    }
    const tx = ox + side + 30;
    const lit = { literal: true };
    cv.text('Log as QR - page ' + (info.page + 1) + ' of ' + info.pages + ' (page 1 = newest)', tx, 40, 26, '#ffffff', { literal: true, font: 'bold' });
    cv.text('Size ' + info.label + ', ' + pg.n + ' lines. Scan with the phone camera, copy the text.', tx, 76, 20, '#bbbbbb', lit);
    // the page's lines, newest at the bottom like in the code; as many as fit
    const lh = 24, maxRows = Math.floor((H - 110) / lh);
    const rows = pg.lines.slice(-maxRows);
    rows.forEach((l, i) => cv.text(l, tx, 112 + i * lh, 19, '#dddddd', lit));
    if (o.note) cv.text(o.note, tx, H - 8, 18, '#ff9966', lit);
}

module.exports = { pages, draw, SIZES };
