'use strict';
/**
 * qrpage.js - the viewer's lines as a plain-text QR code: the phone camera shows the text, which can be
 * copied and sent on (no app, no decoder needed). Uncompressed on purpose.
 *
 *   SIZES                         Large (version 15, easiest to scan) / Medium (version 20, ~860 bytes)
 *   build(lines, start, ver, head) -> { text, start, end, n }   lines[start..end) that fit, after the head line
 *   draw(cv, page, o)             the code in the box o = { x, y, h } (white quiet zone, whole pixels a module)
 */
const qr = require('./kit/qr');

const SIZES = [{ version: 15, label: 'Large' }, { version: 20, label: 'Medium' }];

function build(lines, start, version, head) {
    const cap = qr.capacity(version, 'L');
    const top = (head || '') + '\n';
    let bytes = Buffer.byteLength(top), end = start;
    while (end < lines.length) {
        const b = Buffer.byteLength(lines[end]) + 1;
        if (bytes + b > cap) break;
        bytes += b; end++;
    }
    let body = lines.slice(start, end);
    if (end === start && start < lines.length) {          // one line longer than a code: cut
        body = [lines[start].slice(0, Math.max(0, cap - Buffer.byteLength(top) - 1))];
        end = start + 1;
    }
    return { text: top + body.join('\n'), start, end, n: end - start, lines: body };
}

const cache = { key: null, code: null };
function encoded(text, version) {
    const key = version + '|' + text;
    if (cache.key !== key) { cache.key = key; cache.code = qr.encode(Buffer.from(text, 'utf8'), { version, ecl: 'L' }); }
    return cache.code;
}

/** Smallest version the text fits in, at most maxVer (bigger modules scan better). Returns the side in px. */
function draw(cv, page, o) {
    let v = 5;
    const len = Buffer.byteLength(page.text);
    while (v < o.version && qr.capacity(v, 'L') < len) v++;
    const q = encoded(page.text, v);
    const n = q.size + 8;
    const px = Math.max(2, Math.floor(o.h / n));
    const side = n * px, ox = o.x, oy = o.y + Math.floor((o.h - side) / 2);
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
    return side;
}

module.exports = { SIZES, build, draw };
