'use strict';
/**
 * textbuf.js - a read window (Buffer) as display lines. Pure, no I/O.
 *
 *   isBinary(buf)              many control bytes / NULs in the first 4 KB
 *   textLines(buf, o)          lines, ASCII only (the HMI fonts), tabs as spaces, long lines cut in pieces;
 *                              o.cutHead: the window starts mid-file (first line marked as partial)
 *   hexLines(buf, base)        16 bytes a row: offset, hex, ASCII
 *   level(line)                'bad' (FATAL / ERROR / uncaught), 'warn' (WARN), ''
 *   filterLines(lines, kind)   'issues': the bad and warn lines (plus the stack lines after them)
 */
const PIECE = 300;

function isBinary(buf) {
    const n = Math.min(buf.length, 4096);
    if (!n) return false;
    let bad = 0;
    for (let i = 0; i < n; i++) {
        const b = buf[i];
        if (b === 0) return true;
        if (b < 9 || (b > 13 && b < 32 && b !== 27)) bad++;
    }
    return bad / n > 0.05;
}

function clean(s) {
    return s.replace(/\r$/, '').replace(/\t/g, '    ')
        .replace(/[ä]/g, 'ae').replace(/[ö]/g, 'oe').replace(/[ü]/g, 'ue')
        .replace(/[Ä]/g, 'Ae').replace(/[Ö]/g, 'Oe').replace(/[Ü]/g, 'Ue').replace(/[ß]/g, 'ss')
        .replace(/[°]/g, 'deg').replace(/[\x00-\x1f\x7f]/g, '.').replace(/[^\x20-\x7e]/g, '?');
}

function textLines(buf, o) {
    const opt = o || {};
    const raw = buf.toString('utf8').split('\n');
    if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop();
    const out = [];
    raw.forEach((r, i) => {
        let s = clean(r);
        if (i === 0 && opt.cutHead) s = '[...] ' + s;
        if (s.length <= PIECE) { out.push(s); return; }
        for (let k = 0; k < s.length; k += PIECE) out.push((k ? '  > ' : '') + s.slice(k, k + PIECE));
    });
    return out;
}

function hexLines(buf, base) {
    const out = [];
    for (let i = 0; i < buf.length; i += 16) {
        const row = buf.slice(i, i + 16);
        let hex = '', asc = '';
        for (let k = 0; k < 16; k++) {
            if (k < row.length) { hex += (row[k] < 16 ? '0' : '') + row[k].toString(16) + ' '; asc += row[k] >= 32 && row[k] < 127 ? String.fromCharCode(row[k]) : '.'; }
            else hex += '   ';
            if (k === 7) hex += ' ';
        }
        out.push(('0000000' + ((base || 0) + i).toString(16)).slice(-8) + '  ' + hex + ' |' + asc + '|');
    }
    return out;
}

const BAD = /\bFATAL\b|\bERROR\b|\bSDK_ERROR\b|uncaught|Unhandled|\bTypeError\b|\bReferenceError\b|\bRangeError\b|\bSyntaxError\b|\bE[A-Z]{3,}:|\bfailed\b/i;
const WARN = /\bWARN(ING)?\b|\bSDK_WARN\b/i;
function level(line) { return BAD.test(line) ? 'bad' : WARN.test(line) ? 'warn' : ''; }

/** The lines worth sending: bad / warn lines and the stack lines ("    at ...") right after them. */
function filterLines(lines) {
    const out = [];
    let inStack = false;
    lines.forEach((l, i) => {
        const lv = level(l);
        if (lv) { out.push({ i, l }); inStack = true; return; }
        if (inStack && /^\s+at |^\s+>|^\s*\.\.\./.test(l)) { out.push({ i, l }); return; }
        inStack = false;
    });
    return out;
}

module.exports = { isBinary, textLines, hexLines, level, filterLines, clean, PIECE };
