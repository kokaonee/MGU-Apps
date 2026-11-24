'use strict';
/**
 * rofs.js - the ONLY file system access of File Explorer, read-only by construction.
 *
 * Uses nothing but readdir / lstat / stat / readlink / realpath / open('r') / read / close. Every other module
 * of the app goes through this one (test_file_explorer.js checks the sources for that). No write call, no
 * child_process.
 *
 * Safety while reading:
 *   - only regular files are opened (devices, pipes and sockets are refused by stat before any open)
 *   - at most CHUNK bytes per read; big files are read window by window
 *   - every call has a timeout; a path that timed out is never opened again in this run (a stuck read in
 *     /proc or /sys must not tie up more of Node's thread pool)
 *   - one open file at a time (reads queue up)
 *   - no recursion anywhere, so symlink loops cannot hang anything
 *
 *   list(dir)                 -> { dir, entries: [{ name, path, type, size, mtime, target, ttype, error }], total, cut, error }
 *   read(file, { tail | off }) -> { file, size, virtual, off, buf, eof, mtime }
 *   info(p)                   -> { path, type, size, mtime, mode, uid, gid, target, real, error }
 *   canRead(p)                -> 'yes' | 'no access' | 'missing' | ...
 */
const fs = require('fs');
const path = require('path');

const CHUNK = 64 * 1024;
const MAX_ENTRIES = 3000;
const TIMEOUT_MS = 3000;
const blocked = new Set();
let chain = Promise.resolve();
/** one open file at a time: reads queue up */
function serial(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }

function err(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

/** fn(cb) with a timeout; a late answer is dropped (late(v) may release it). */
function timed(what, fn, late) {
    return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => { done = true; blocked.add(what); reject(err('ETIMEDOUT', 'timed out')); }, TIMEOUT_MS);
        fn((e, v) => {
            clearTimeout(timer);
            if (done) { if (late) late(e ? null : v); return; }
            done = true;
            if (e) reject(e); else resolve(v);
        });
    });
}
const lstat = (p) => timed(p, (cb) => fs.lstat(p, cb));
const stat = (p) => timed(p, (cb) => fs.stat(p, cb));
const readdir = (p) => timed(p, (cb) => fs.readdir(p, cb));
const readlink = (p) => timed(p, (cb) => fs.readlink(p, cb));
const realpath = (p) => timed(p, (cb) => fs.realpath(p, cb));

function typeOf(s) {
    if (s.isSymbolicLink()) return 'link';
    if (s.isDirectory()) return 'dir';
    if (s.isFile()) return 'file';
    if (s.isCharacterDevice() || s.isBlockDevice()) return 'device';
    if (s.isFIFO()) return 'pipe';
    if (s.isSocket()) return 'socket';
    return '?';
}
const mtimeOf = (s) => (s.mtimeMs != null ? s.mtimeMs : +s.mtime);

function errText(e) {
    const c = e && e.code;
    return c === 'EACCES' ? 'no access' : c === 'EPERM' ? 'not permitted' : c === 'ENOENT' ? 'missing'
        : c === 'ETIMEDOUT' ? 'timed out' : c === 'ENOTDIR' ? 'not a folder' : c === 'ELOOP' ? 'link loop'
        : c === 'BLOCKED' ? 'timed out before' : c === 'EDEVICE' ? 'device / pipe / socket' : c === 'BUSY' ? 'busy'
        : c || String(e && e.message || e);
}

async function mapLimit(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    const worker = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } };
    const ws = [];
    for (let k = 0; k < Math.min(n, items.length); k++) ws.push(worker());
    await Promise.all(ws);
    return out;
}

const isDirish = (e) => e.type === 'dir' || (e.type === 'link' && e.ttype === 'dir');

async function list(dir) {
    dir = path.resolve(dir);
    if (blocked.has(dir)) return { dir, entries: [], total: 0, cut: false, error: errText(err('BLOCKED')) };
    let names;
    try { names = await readdir(dir); } catch (e) { return { dir, entries: [], total: 0, cut: false, error: errText(e) }; }
    names.sort();
    const total = names.length;
    names = names.slice(0, MAX_ENTRIES);
    const entries = await mapLimit(names, 16, async (name) => {
        const p = path.join(dir, name);
        try {
            const s = await lstat(p);
            const e = { name, path: p, type: typeOf(s), size: s.size, mtime: mtimeOf(s) };
            if (e.type === 'link') {
                try { e.target = await readlink(p); } catch (x) { e.target = '?'; }
                try { const t = await stat(p); e.ttype = typeOf(t); e.size = t.size; } catch (x) { e.ttype = 'broken'; }
            }
            return e;
        } catch (x) { return { name, path: p, type: '?', error: errText(x) }; }
    });
    entries.sort((a, b) => (isDirish(b) - isDirish(a)) || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
    return { dir, entries, total, cut: total > MAX_ENTRIES, error: null };
}

async function info(p) {
    p = path.resolve(p);
    try {
        const l = await lstat(p);
        const o = { path: p, type: typeOf(l), size: l.size, mtime: mtimeOf(l), mode: l.mode, uid: l.uid, gid: l.gid, error: null };
        if (o.type === 'link') {
            try { o.target = await readlink(p); } catch (e) { o.target = '?'; }
            try { const s = await stat(p); o.ttype = typeOf(s); o.size = s.size; } catch (e) { o.ttype = 'broken'; }
        }
        try { o.real = await realpath(p); } catch (e) { o.real = null; }
        return o;
    } catch (e) { return { path: p, error: errText(e) }; }
}

/** Read one window of a regular file. opts: { tail: true } the last CHUNK bytes, else { off } (default 0). */
function read(file, opts) { return serial(() => readOne(file, opts)); }
async function readOne(file, opts) {
    const o = opts || {};
    file = path.resolve(file);
    if (blocked.has(file)) throw err('BLOCKED');
    {
        const s = await stat(file);
        if (s.isDirectory()) throw err('EISDIR', 'is a folder');
        if (!s.isFile()) throw err('EDEVICE');
        const size = s.size;
        // /proc and /sys report 0 bytes: the size is unknown, read from the start
        const virtual = size === 0 && /^\/(proc|sys)\//.test(file);
        let off, len;
        if (virtual) { off = Math.max(0, o.off || 0); len = CHUNK; }
        else {
            off = o.tail ? Math.max(0, size - CHUNK) : Math.max(0, Math.min(o.off || 0, size));
            len = Math.min(CHUNK, size - off);
        }
        const fd = await timed(file, (cb) => fs.open(file, 'r', cb), (lateFd) => { if (lateFd != null) fs.close(lateFd, () => {}); });
        let timedOut = false, buf;
        try {
            buf = len <= 0 ? Buffer.alloc(0) : await timed(file, (cb) => {
                const b = Buffer.alloc(len);
                fs.read(fd, b, 0, len, off, (e, n) => cb(e, e ? null : b.slice(0, n)));
            }, () => fs.close(fd, () => {}));
        } catch (e) { timedOut = e.code === 'ETIMEDOUT'; throw e; } finally { if (!timedOut) fs.close(fd, () => {}); }
        const eof = virtual ? buf.length < len : off + buf.length >= size;
        return { file, size: virtual ? null : size, virtual, off, buf, eof, mtime: mtimeOf(s) };
    }
}

/** Whether p can be listed / read (a quick probe for the Info page). */
async function canRead(p) {
    try {
        const s = await stat(p);
        if (s.isDirectory()) { await readdir(p); return 'yes'; }
        if (!s.isFile()) return 'device';
        await timed(p, (cb) => fs.open(p, 'r', (e, fd) => { if (!e) fs.close(fd, () => {}); cb(e); }));
        return 'yes';
    } catch (e) { return errText(e); }
}

module.exports = Object.freeze({ list, read, info, canRead, errText, isDirish, CHUNK, MAX_ENTRIES, TIMEOUT_MS, blockedCount: () => blocked.size });
