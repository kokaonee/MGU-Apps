'use strict';
/**
 * File Explorer - browse the head unit's folders and read files (logs above all) on the central display.
 * Strictly read-only: every file access goes through rofs.js (readdir / stat / open 'r' / read only).
 *
 * Tabs: Files (folders; a tapped file opens in the viewer: Older / Newer windows of 64 KB, End, Issues filter,
 * QR code of the shown lines for the phone), Logs (every kit app's <id>.log this process may read, places),
 * Info (user / groups the app runs as, IPs, which places are readable).
 * State: model.js; drawing: ui.js. Menu texts ASCII (HMI fonts).
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Canvas } = require('./kit/canvas');
const rofs = require('./rofs');
const sysinfo = require('./sysinfo');
const { Explorer, TABS } = require('./model');
const UI = require('./ui');

mgu.run({
    async start(ctx) {
        const { ui, log, settings } = ctx;
        let loop = null;
        const repaint = () => (loop && loop.kick ? loop.kick() : null);
        const m = new Explorer({ rofs, sysinfo, settings, dataDir: ctx.dataDir, onChange: repaint, log });

        const safe = (name, f) => () => {
            try {
                return Promise.resolve(f()).then(repaint, (e) => { log.warn(name + ': ' + (e && e.stack || e)); m.note(name + ': ' + (e && e.message || e)); });
            } catch (e) { log.warn(name + ': ' + (e && e.stack || e)); m.note(name + ': ' + (e && e.message || e)); return null; }
        };
        const act = {
            up: safe('up', () => m.up()),
            back: safe('back', () => m.back()),
            refresh: safe('reload', () => m.refresh()),
            older: safe('older', () => m.older()),
            newer: safe('newer', () => m.newer()),
            toEnd: safe('end', () => m.toEnd()),
            filter: safe('issues', () => m.toggleFilter()),
            qr: safe('qr', () => m.qrOpen()),
            qrPrev: safe('qr', () => m.qrPrev()),
            qrNext: safe('qr', () => m.qrNext(m.qrEnd)),
            qrSize: safe('qr', () => m.qrSize()),
        };
        const large = () => settings.get('textSize') === 'large';
        const tz = () => { const v = Number(settings.get('logTz')); return isFinite(v) ? v : 60; };

        // the controller on a row: keep it in view
        const focusRow = () => {
            const k = ctx.display && ctx.display.focusKey;
            const r = /^tgt:row:(\d+)$/.exec(k || '');
            return r ? Number(r[1]) : null;
        };

        const render = async () => {
            try {
                const t = ctx.theme();
                const cv = ctx.canvas(UI.W, UI.H) || new Canvas(UI.W, UI.H);
                UI.draw(cv, G, t, m, { act, focusRow: focusRow(), large: large(), tz: tz() });
                await ui.image('MAIN_GFX', cv);
            } catch (e) { log.warn('render: ' + (e && e.stack || e)); }
        };
        loop = ctx.loop('MAIN', 4, render);

        // a finger dragged on the list / text, or the controller turned on it: whole rows
        let acc = 0;
        if (ctx.onScroll) ctx.onScroll((dy) => {
            const sign = dy > 0 ? 1 : -1;
            if (!m.scrollable(sign)) { acc = 0; return false; }
            acc += dy;
            const px = UI.rowPx(m, large()), d = acc > 0 ? Math.floor(acc / px) : Math.ceil(acc / px);
            if (d) { acc -= d * px; m.scroll(d); }
            return true;
        });
        if (ctx.onTab) ctx.onTab((i) => { if (i < TABS.length) m.setTab(i); repaint(); });
        if (ctx.onLayout) ctx.onLayout(repaint);
        if (settings.onChange) settings.onChange(() => { m.clamp(); repaint(); });

        // the HMI bar (where the kit does not run the screen)
        ui.onClick('BTN_UP', safe('up', () => m.move(-1)));
        ui.onClick('BTN_DOWN', safe('down', () => m.move(1)));
        ui.onClick('BTN_OPEN', safe('open', () => m.activate()));
        ui.onClick('BTN_BACK', act.back);
        ui.onClick('BTN_PAGE', safe('page', () => m.setTab((m.tab + 1) % TABS.length)));
        ui.onClick('BTN_QR', safe('qr', () => (m.viewer && m.viewer.qr ? m.qrNext(m.qrEnd) : m.qrOpen())));
        ['BTN_UP', 'BTN_DOWN', 'BTN_OPEN', 'BTN_BACK', 'BTN_QR'].forEach((b) => ctx.hideButton && ctx.hideButton(b));

        log.info('file explorer: uid ' + (process.getuid ? process.getuid() : '?') + ', data ' + ctx.dataDir);
        await m.start(ctx.dataDir);
    },
});
