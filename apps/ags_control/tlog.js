'use strict';
/**
 * tlog.js - short telemetry log for the LOG screen, kept on disk so it survives a head unit restart.
 * One entry = "HH:MM:SS text", text kept short (the HMI list shows ~55 characters per line).
 */
const fs = require('fs');
const path = require('path');

const MAX_LINES = 400;
const MAX_TEXT = 46;            // + 9 for the time = ~55 characters on screen
const SAVE_DELAY_MS = 5000;

class TLog {
    /** dir: data directory or null (memory only); offsetMin: () => minutes to add to the head unit clock (UTC) */
    constructor(dir, offsetMin) {
        this.file = dir ? path.join(dir, 'ags_log.txt') : null;
        this.offsetMin = offsetMin || (() => 0);
        this.lines = [];
        this._timer = null;
        this.listeners = [];
        if (this.file) {
            try { this.lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).slice(-MAX_LINES); } catch (e) { /* first start */ }
        }
    }

    clock(ms) {
        const d = new Date((ms || Date.now()) + this.offsetMin() * 60000);
        return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
    }

    add(text) {
        let t = String(text).replace(/[^\x20-\x7E]/g, '?');
        if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT - 1) + '~';
        this.lines.push(this.clock() + ' ' + t);
        if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
        this._save();
        this.listeners.forEach((f) => { try { f(); } catch (e) { /* ignore */ } });
    }

    clear() { this.lines = []; this._save(true); this.listeners.forEach((f) => f()); }

    /** page 0 = newest; returns { rows: [...], page, pages, total } */
    page(n, size) {
        const total = this.lines.length;
        const pages = Math.max(1, Math.ceil(total / size));
        const p = Math.max(0, Math.min(n, pages - 1));
        const newestFirst = this.lines.slice().reverse();
        return { rows: newestFirst.slice(p * size, p * size + size), page: p, pages, total };
    }

    onChange(f) { this.listeners.push(f); }

    _save(now) {
        if (!this.file) return;
        const write = () => {
            this._timer = null;
            try { fs.writeFileSync(this.file, this.lines.join('\n') + '\n'); } catch (e) { /* read-only or full: keep in memory */ }
        };
        if (now) { clearTimeout(this._timer); write(); return; }
        if (!this._timer) this._timer = setTimeout(write, SAVE_DELAY_MS);
    }
}

module.exports = { TLog, MAX_TEXT };
