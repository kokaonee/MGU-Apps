'use strict';
/**
 * model.js - File Explorer's state: the folder shown, the file viewer, the Logs and Info tabs.
 * No drawing, no direct file access (rofs.js / sysinfo.js), so it runs in the tests as it does on the car.
 *
 * Tabs: 0 Files (folder list, or the viewer when a file is open), 1 Logs (the kit apps' logs + places),
 * 2 Info (user, groups, folders, IPs, what is readable).
 * The UI tells the model how many rows fit (listRows / textRows) and calls the actions; onChange() repaints.
 */
const path = require('path');
const TB = require('./textbuf');

const TABS = ['Files', 'Logs', 'Info'];

class Explorer {
    constructor(o) {
        this.rofs = o.rofs;
        this.sys = o.sysinfo;
        this.settings = o.settings || { get: () => null };
        this.dataDir = o.dataDir || process.cwd();
        this.onChange = o.onChange || (() => {});
        this.log = o.log || { info() {}, warn() {} };
        this.tab = 0;
        this.cwd = null;
        this.listing = null;            // rofs.list() result
        this.loading = false;
        this.history = [];              // [{ dir, top, sel }]
        this.top = [0, 0, 0];           // first row shown per tab
        this.sel = [0, 0, 0];           // selected row per tab (the HMI bar's Up / Down / Open, the controller)
        this.listRows = 9;
        this.textRows = 12;
        this.viewer = null;
        this.logs = null;
        this.info = null;
        this.notice = null;
    }

    changed() { try { this.onChange(); } catch (e) { /* ignore */ } }
    note(s) { this.notice = s ? { text: s, at: Date.now() } : null; this.changed(); }
    showHidden() { return this.settings.get('hidden') !== 'hide'; }

    start(dir) {
        this.loadLogs();
        this.loadInfo();
        return this.cd(dir || this.dataDir, false);
    }

    /* ---------------------------------------------------------------- folders */
    async cd(dir, push) {
        dir = path.resolve(dir);
        if (push !== false && this.cwd) this.history.push({ dir: this.cwd, top: this.top[0], sel: this.sel[0] });
        if (this.history.length > 50) this.history.shift();
        this.cwd = dir; this.loading = true; this.viewer = null;
        this.top[0] = 0; this.sel[0] = 0;
        this.changed();
        const l = await this.rofs.list(dir);
        if (this.cwd !== dir) return;   // moved on meanwhile
        this.listing = l; this.loading = false;
        this.changed();
    }
    refresh() {
        if (this.tab === 1) return this.loadLogs();
        if (this.tab === 2) return this.loadInfo();
        if (this.viewer) return this.reload();
        const top = this.top[0], sel = this.sel[0];
        return this.cd(this.cwd, false).then(() => { this.top[0] = top; this.sel[0] = sel; this.clamp(); this.changed(); });
    }
    up() {
        if (!this.cwd || this.cwd === '/') return null;
        const from = this.cwd;
        return this.cd(path.dirname(this.cwd)).then(() => {
            // land on the folder we came from
            const i = this.rows().findIndex((r) => r.path === from);
            if (i >= 0) { this.sel[0] = i; this.top[0] = Math.max(0, i - Math.floor(this.listRows / 2)); this.clamp(); this.changed(); }
        });
    }
    /** Back: QR -> viewer -> folder before -> parent folder. */
    back() {
        if (this.viewer && this.viewer.qr) { this.viewer.qr = null; this.changed(); return null; }
        if (this.viewer) return this.closeViewer();
        if (this.tab !== 0) { this.tab = 0; this.changed(); return null; }
        const h = this.history.pop();
        if (h) return this.cd(h.dir, false).then(() => { this.top[0] = h.top; this.sel[0] = h.sel; this.clamp(); this.changed(); });
        return this.up();
    }

    entries() {
        const l = this.listing;
        if (!l) return [];
        return this.showHidden() ? l.entries : l.entries.filter((e) => e.name[0] !== '.');
    }

    /** The rows of the list tabs: { kind, title, sub, right, warn, run } */
    rows() {
        if (this.tab === 1) return this.logRows();
        const out = [];
        if (this.cwd && this.cwd !== '/') out.push({ kind: 'up', title: '..', sub: 'up to ' + path.dirname(this.cwd), path: path.dirname(this.cwd), run: () => this.up() });
        this.entries().forEach((e) => {
            const dirish = this.rofs.isDirish(e);
            const kind = e.type === 'link' ? (dirish ? 'linkdir' : 'link') : e.type;
            const sub = e.error ? e.error : e.type === 'link' ? '-> ' + e.target + (e.ttype === 'broken' ? '  (broken)' : '')
                : e.type === 'device' || e.type === 'pipe' || e.type === 'socket' ? e.type + ' (not opened)' : '';
            out.push({
                kind, title: e.name, sub, path: e.path, warn: !!e.error || e.ttype === 'broken',
                right: dirish || e.error ? '' : e.size != null && (e.type === 'file' || e.type === 'link') ? size(e.size) : '',
                when: e.mtime, run: () => this.open(e),
            });
        });
        return out;
    }

    open(e) {
        if (this.rofs.isDirish(e)) return this.cd(e.path);
        if (e.type === 'file' || (e.type === 'link' && e.ttype === 'file')) return this.openFile(e.path);
        this.note(e.name + ': ' + (e.error || (e.type === 'link' ? 'broken link' : e.type + ' - not opened (read-only safety)')));
        return null;
    }

    /* ---------------------------------------------------------------- viewer */
    isLog(file) { return /\.log(\.\d+)?$|\.txt$|log/i.test(path.basename(file)); }

    /** where: { tail } | { off }; default: logs and big files from the end */
    async openFile(file, where) {
        this.tab = 0;
        const v = this.viewer = { file, name: path.basename(file), loading: true, top: 0, lines: [], filter: false, qr: null, err: null };
        this.changed();
        await this.load(v, where || { tail: true });
    }
    async load(v, where, topAt) {
        v.loading = true; this.changed();
        try {
            const r = await this.rofs.read(v.file, where);
            if (this.viewer !== v) return;
            v.size = r.size; v.virtual = r.virtual; v.off = r.off; v.len = r.buf.length; v.eof = r.eof; v.mtime = r.mtime; v.err = null;
            v.binary = TB.isBinary(r.buf);
            v.lines = v.binary ? TB.hexLines(r.buf, r.off) : TB.textLines(r.buf, { cutHead: r.off > 0 });
            v.flines = v.binary ? [] : TB.filterLines(v.lines);
            if (v.binary) v.filter = false;
            v.qr = null;
            v.top = topAt === 'start' ? 0 : topAt != null ? topAt : where.tail ? Infinity : 0;
            v.buf = r.buf;
        } catch (e) {
            if (this.viewer !== v) return;
            v.err = this.rofs.errText(e);
        }
        v.loading = false;
        this.clamp();
        this.changed();
    }
    reload() { const v = this.viewer; if (!v) return null; return this.load(v, v.off ? { off: v.off } : { off: 0 }, v.top); }
    closeViewer() {
        const f = this.viewer && this.viewer.file;
        this.viewer = null;
        const i = this.rows().findIndex((r) => r.path === f);
        if (i >= 0) this.sel[0] = i;
        this.clamp(); this.changed();
        return null;
    }
    /** the lines shown: all, or the issues only */
    shown() {
        const v = this.viewer;
        if (!v) return [];
        return v.filter ? v.flines.map((x) => x.l) : v.lines;
    }
    canOlder() { const v = this.viewer; return !!(v && !v.loading && v.off > 0); }
    canNewer() { const v = this.viewer; return !!(v && !v.loading && v.len != null && !v.eof); }
    older() {
        const v = this.viewer;
        if (!this.canOlder()) return null;
        const chunk = this.rofs.CHUNK, oldOff = v.off, off = Math.max(0, oldOff - chunk);
        // continue upwards: show the end of the earlier window (where the old one started)
        return this.load(v, { off }).then(() => {
            if (this.viewer !== v || v.binary || !v.buf) { this.clamp(); return; }
            const nl = countNl(v.buf, oldOff - off);
            v.top = Math.max(0, nl - this.textRows + 1); this.clamp(); this.changed();
        });
    }
    newer() { const v = this.viewer; if (!this.canNewer()) return null; return this.load(v, { off: v.off + v.len }, 'start'); }
    toEnd() { const v = this.viewer; if (!v) return null; return this.load(v, { tail: true }); }
    toStart() { const v = this.viewer; if (!v) return null; return this.load(v, { off: 0 }, 'start'); }
    toggleFilter() {
        const v = this.viewer;
        if (!v || v.binary) return;
        // keep the place: the first shown line that is (or follows) the current top line
        const curIdx = v.filter ? (v.flines[v.top] ? v.flines[v.top].i : 0) : v.top;
        v.filter = !v.filter;
        if (v.filter) { const k = v.flines.findIndex((x) => x.i >= curIdx); v.top = k < 0 ? Infinity : k; } else v.top = curIdx;
        v.qr = null;
        this.clamp(); this.changed();
    }

    /* ---------------------------------------------------------------- QR of the shown lines */
    qrOpen() { const v = this.viewer; if (!v || v.loading) return; v.qr = { start: Math.min(v.top, Math.max(0, this.shown().length - 1)), size: 0, stack: [] }; this.changed(); }
    qrNext(end) { const v = this.viewer; if (!v || !v.qr || end >= this.shown().length) return; v.qr.stack.push(v.qr.start); v.qr.start = end; this.changed(); }
    qrPrev() { const v = this.viewer; if (!v || !v.qr || !v.qr.stack.length) return; v.qr.start = v.qr.stack.pop(); this.changed(); }
    qrSize() { const v = this.viewer; if (!v || !v.qr) return; v.qr.size = (v.qr.size + 1) % 2; this.changed(); }

    /* ---------------------------------------------------------------- Logs tab */
    async loadLogs() {
        this.logs = Object.assign({}, this.logs || {}, { loading: true }); this.changed();
        let r;
        try { r = await this.sys.findLogs(); } catch (e) { r = { error: String(e), logs: [] }; }
        this.logs = { loading: false, error: r.error, list: r.logs };
        this.clamp(); this.changed();
    }
    places() {
        return [
            ['This app\'s data', this.dataDir], ['All OAP apps', this.sys.OAP_ROOT], ['RAM files', '/tmp'],
            ['System logs', '/var/log'], ['Process info', '/proc/self'], ['Root', '/'],
        ];
    }
    logRows() {
        const out = [];
        const lg = this.logs || {};
        if (lg.loading && !lg.list) out.push({ kind: 'head', title: 'Looking for logs ...' });
        if (lg.error) out.push({ kind: 'head', title: lg.error, warn: true });
        (lg.list || []).forEach((l) => out.push(l.error
            ? { kind: 'head', title: l.dir || l.app, sub: l.file + ': ' + l.error, warn: true }
            : { kind: 'log', title: l.name, sub: l.file, right: size(l.size), when: l.mtime, path: l.file, run: () => this.openFile(l.file, { tail: true }) }));
        if (lg.list && !lg.list.length && !lg.error) out.push({ kind: 'head', title: 'No kit app logs readable under ' + this.sys.OAP_ROOT });
        this.places().forEach((p) => out.push({ kind: 'place', title: p[0], sub: p[1], path: p[1], run: () => { this.tab = 0; return this.cd(p[1]); } }));
        return out;
    }

    /* ---------------------------------------------------------------- Info tab */
    async loadInfo() {
        this.info = Object.assign({}, this.info || {}, { loading: true }); this.changed();
        try { this.info = Object.assign(await this.sys.gather({ dataDir: this.dataDir }), { loading: false }); } catch (e) { this.info = { loading: false, rows: [['ERROR', String(e), 'bad']] }; }
        this.changed();
    }

    /* ---------------------------------------------------------------- scrolling and selection */
    listLen() { return this.rows().length; }
    clamp() {
        const t = this.tab;
        if (t === 0 && this.viewer) {
            const v = this.viewer, n = this.shown().length;
            v.top = Math.max(0, Math.min(v.top, Math.max(0, n - this.textRows)));
            return;
        }
        if (t === 2) return;
        const n = this.listLen();
        this.sel[t] = Math.max(0, Math.min(this.sel[t], n - 1));
        this.top[t] = Math.max(0, Math.min(this.top[t], Math.max(0, n - this.listRows)));
    }
    /** scroll by d rows (+ = further down); false at the end */
    scroll(d) {
        const t = this.tab;
        if (t === 2) return false;
        if (t === 0 && this.viewer) {
            const v = this.viewer, before = v.top;
            v.top += d; this.clamp();
            if (v.top !== before) { this.changed(); return true; }
            return false;
        }
        const before = this.top[t];
        this.top[t] += d; this.clamp();
        if (this.top[t] !== before) { this.changed(); return true; }
        return false;
    }
    /** whether scroll(sign) would move */
    scrollable(sign) {
        const t = this.tab;
        if (t === 2) return false;
        const top = t === 0 && this.viewer ? this.viewer.top : this.top[t];
        const n = t === 0 && this.viewer ? this.shown().length : this.listLen();
        const rows = t === 0 && this.viewer ? this.textRows : this.listRows;
        return sign > 0 ? top < n - rows : top > 0;
    }
    /** keep row i in view (the controller's focus) */
    follow(i) {
        const t = this.tab;
        if (t === 2 || (t === 0 && this.viewer)) return;
        this.sel[t] = i;
        let top = this.top[t];
        if (i <= top && top > 0) top = i - 1;
        else if (i >= top + this.listRows - 1) top = i - this.listRows + 2;
        if (top !== this.top[t]) { this.top[t] = top; this.clamp(); this.changed(); }
    }
    /** the HMI bar's Up / Down: the selection, or the text by a page */
    move(d) {
        const t = this.tab;
        if (t === 0 && this.viewer) return this.scroll(d * Math.max(1, this.textRows - 1));
        if (t === 2) return false;
        this.sel[t] += d; this.clamp();
        const i = this.sel[t];
        if (i < this.top[t]) this.top[t] = i;
        if (i >= this.top[t] + this.listRows) this.top[t] = i - this.listRows + 1;
        this.clamp(); this.changed();
        return true;
    }
    activate() {
        const t = this.tab;
        if (t === 2 || (t === 0 && this.viewer)) return null;
        const r = this.rows()[this.sel[t]];
        return r && r.run ? r.run() : null;
    }
    setTab(i) { if (i >= 0 && i < TABS.length) { this.tab = i; this.clamp(); this.changed(); } }
}

function countNl(buf, end) { let n = 0; for (let i = 0; i < Math.min(end, buf.length); i++) if (buf[i] === 10) n++; return n; }

function size(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(1) + ' GB';
}

module.exports = { Explorer, TABS, size };
