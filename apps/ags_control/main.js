'use strict';
/**
 * AGS Control - control the active grille shutters (radiator shutters) through the DME.
 * Show use at standstill: Open / Closed (<= 3 km/h) and OEM (DME in control). Driving off hands back to OEM.
 * Runs via "autostart" in the background so driving off is caught with the app closed too.
 * Logic: controller.js. Screen: ui.js (canvas, tabs Shutters / Status / Log, buttons drawn where the kit runs
 * the screen; elsewhere the HMI bar has Open / Closed / OEM / Next page / Log / Settings).
 * The LOGS (menu) and QR screens stay as they were. Menu texts are kept ASCII (HMI fonts).
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Canvas } = require('./kit/canvas');
const UI = require('./ui');
const { Ags, fesShort } = require('./controller');
const { TLog } = require('./tlog');
const qrview = require('./qrview');

const LOG_ROWS = 12;

const SHORT = { open: 'OPEN', closed: 'CLOSED', oem: 'OEM', '?': '...' };
const BTN = { open: 'BTN_OPEN', closed: 'BTN_CLOSED', oem: 'BTN_OEM' };
const OPEN_DEG = 83.5;        // measured full open on the G30 545e (I_AKKS_ISTPOS)
const OEM_SHOWN = 0.35;       // DME in control and no fresh read-back: drawn half open, dimmed
const RB_FRESH_MS = 20000;

async function background(bg) {
    // head unit clock runs on UTC: shift log times by the chosen zone
    const tlog = new TLog(bg.dataDir || null, () => { const v = Number(bg.settings.get('logTz')); return isFinite(v) ? v : 60; });
    const ags = new Ags({ settings: bg.settings, signals: bg.signals, log: bg.log, spec: bg.spec, tlog });
    await ags.start();
    return ags;
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, log } = ctx;
        const ags = ctx.background || await background(ctx);

        Object.keys(BTN).forEach((m) => ui.onClick(BTN[m], () => ags.setMode(m)));
        let logPage = 0;
        ui.onClick('BTN_LOGS', () => { logPage = 0; renderLog(); ui.open('LOGS'); });
        ui.onClick('BTN_LOG_NEWER', () => { logPage = Math.max(0, logPage - 1); renderLog(); });
        ui.onClick('BTN_LOG_OLDER', () => { logPage++; renderLog(); });
        ui.onClick('BTN_LOG_CLEAR', () => { ags.tlog.clear(); ags.tlog.add('log cleared'); logPage = 0; renderLog(); });

        // the log as plain-text QR codes (qrview.js): a snapshot when opened, so the pages stay put while scanning
        let qrSize = 1, qrPage = 0, qrList = null;   // Medium first
        const qrLoad = () => {
            qrList = qrview.pages(ags.tlog.lines, qrview.SIZES[qrSize].version, 'AGS log v' + (ctx.spec && ctx.spec.version || '?'));
            qrPage = Math.min(qrPage, qrList.length - 1);
        };
        ui.onClick('BTN_LOG_QR', () => { qrPage = 0; qrLoad(); ui.open('QR'); });
        ui.onClick('BTN_QR_NEWER', () => { if (!qrList) qrLoad(); qrPage = Math.max(0, qrPage - 1); });
        ui.onClick('BTN_QR_OLDER', () => { if (!qrList) qrLoad(); qrPage = Math.min(qrList.length - 1, qrPage + 1); });
        ui.onClick('BTN_QR_SIZE', () => { qrSize = (qrSize + 1) % qrview.SIZES.length; qrPage = 0; qrLoad(); });
        ui.onClick('BTN_QR_REFRESH', () => { qrPage = 0; qrLoad(); });
        ctx.loop('QR', 2, async () => {
            if (!qrList) qrLoad();
            const sz = qrview.SIZES[qrSize];
            const cv = ctx.canvas(1600, 520);
            qrview.draw(cv, qrList[qrPage], { page: qrPage, pages: qrList.length, version: sz.version, label: sz.label });
            return ui.image('QR_GFX', cv);
        });

        // ------------------------------------------------------------ the canvas screen
        let page = 'Shutters', logView = 0, loop = null;
        const anim = { upper: OEM_SHOWN, lower: OEM_SHOWN };
        const repaint = () => (loop && loop.kick ? loop.kick() : null);
        const acts = {
            open: () => { ags.setMode('open'); repaint(); },
            closed: () => { ags.setMode('closed'); repaint(); },
            oem: () => { ags.setMode('oem'); repaint(); },
            read: () => { const p = ags.readBack(); repaint(); return Promise.resolve(p).then(repaint); },
            logNewer: () => { logView = Math.max(0, logView - 1); repaint(); },
            logOlder: () => { logView++; repaint(); },
            logQr: () => { qrPage = 0; qrLoad(); return ui.open('QR'); },
            logClear: () => { ags.tlog.clear(); ags.tlog.add('log cleared'); logView = 0; repaint(); },
        };

        function view() {
            const s = ags.status(), v = { page, armed: s.armed, standing: s.standing, mode: s.mode };
            v.word = SHORT[s.mode] || '...';
            v.speed = s.speed; v.coolant = s.coolant; v.carMode = fesShort(s.fesRaw);
            const rb = s.readback && s.readback.at && Date.now() - s.readback.at < RB_FRESH_MS ? s.readback : null;
            v.posDeg = s.readback && s.readback.posDeg != null ? s.readback.posDeg : null;
            if (!s.armed) { v.sub = 'Simulated  ·  "Car control" is off in Settings'; v.subWarn = true; }
            else if (s.refused) { v.sub = 'DME refused  ·  retrying (' + s.refused.count + 'x)'; v.subWarn = true; }
            else if (s.coolBlocked) { v.sub = 'Closed paused  ·  ' + (s.coolant === null ? 'no coolant value' : 'coolant ' + s.coolant + ' °C'); v.subWarn = true; }
            else if (s.mode === 'oem') v.sub = 'DME in control';
            else v.sub = 'Held by the app' + (s.sentAgo != null ? '  ·  sent ' + s.sentAgo + ' s ago' : '') + '  ·  DME takeovers ' + s.lostLog.length;
            v.notice = s.notice || (s.standing ? null : s.speed === null ? 'No speed signal  ·  Open / Closed blocked' : 'Open / Closed only at standstill');

            // the picture: the flaps this app drives follow what was sent, the others (and OEM) stay the DME's
            const flaps = String(ags.settings ? ags.settings.get('flaps') : 'both') || 'both';
            const held = s.sent === 'open' ? 1 : s.sent === 'closed' ? 0 : null;
            const oemPos = rb && rb.posDeg != null ? Math.min(1, rb.posDeg / OPEN_DEG) : OEM_SHOWN;
            for (const f of ['upper', 'lower']) {
                const mine = held !== null && (flaps === 'both' || flaps === f);
                const tgt = mine ? held : oemPos;
                anim[f] += (tgt - anim[f]) * 0.25;
                if (Math.abs(tgt - anim[f]) < 0.003) anim[f] = tgt;
                v[f] = anim[f]; v[f + 'Dim'] = !mine;
            }

            if (page === 'Status') {
                const last = s.lostLog[s.lostLog.length - 1];
                v.rows = [
                    ['DIAGNOSTIC LINK', s.link ? 'yes' : 'no' + (s.tasuError ? ' (' + s.tasuError + ')' : ''), s.link ? 'good' : 'bad'],
                    ['SHUTTER MODULE (DME)', !s.probe.done ? 'not asked yet' : s.probe.present ? 'answers' : 'no answer',
                        !s.probe.done ? '' : s.probe.present ? 'good' : 'bad'],
                    ['CAR MODE', fesShort(s.fesRaw)],
                    ['SENT TO CAR', (s.refused ? 'refused by the DME, retrying (' + s.refused.count + 'x)' : SHORT[s.sent] || '-')
                        + (s.armed ? '' : '  ·  simulated') + (s.armed && s.sendCount ? '  ·  ' + s.sentAgo + ' s ago  ·  #' + s.sendCount : ''),
                        s.refused ? 'warn' : ''],
                    ['DME TAKEOVERS', !s.lostLog.length ? 'none' : s.lostLog.length + (s.period ? '  ·  every ~' + Math.round(s.period / 1000)
                        + ' s  ·  next in ' + s.nextIn + ' s' + (s.fast ? '  ·  fast check' : '') : '')
                        + '  ·  last ' + Math.round((Date.now() - last.at) / 1000) + ' s ago: ' + last.why],
                    ['ERRORS', !s.lastErr ? 'none' : (s.error ? 'now: ' : s.errCount + ', last: ') + s.lastErr.msg, s.error ? 'bad' : s.lastErr ? 'warn' : ''],
                    ['READ-BACK', s.readback ? s.readback.text : 'not read yet'],
                ];
            }
            if (page === 'Log') {
                const pg = ags.tlog.page(logView, UI.LOG_ROWS);
                logView = pg.page;
                v.log = pg;
            }
            return v;
        }

        const render = async () => {
            try {
                const t = ctx.theme();
                const cv = ctx.canvas(UI.W, UI.H) || new Canvas(UI.W, UI.H);
                UI.draw(cv, G, t, view(), acts);
                await ui.image('MAIN_GFX', cv);
            } catch (e) { log.warn('render: ' + e); }
        };
        loop = ctx.loop('MAIN', 10, render);

        // where the kit runs the screen the buttons are on the canvas; the bar keeps Settings
        ['BTN_OPEN', 'BTN_CLOSED', 'BTN_OEM', 'BTN_LOGS'].forEach((b) => ctx.hideButton && ctx.hideButton(b));
        ui.onClick('BTN_PAGE', () => { page = UI.PAGES[(UI.PAGES.indexOf(page) + 1) % UI.PAGES.length]; repaint(); });
        if (ctx.onTab) ctx.onTab((i) => { if (UI.PAGES[i]) { page = UI.PAGES[i]; if (page === 'Log') logView = 0; } repaint(); });

        // the LOGS menu screen (bar fallback)
        const shown = {};
        const put = async (name, text) => { if (shown[name] === text) return; shown[name] = text; await ui.text(name, text); };
        async function renderLog() {
            const pg = ags.tlog.page(logPage, LOG_ROWS);
            logPage = pg.page;
            await put('LOG_HDR', 'Page ' + (pg.page + 1) + '/' + pg.pages + ', newest first, ' + pg.total + ' entries');
            for (let i = 0; i < LOG_ROWS; i++) await put('LOG_' + i, pg.rows[i] || ' ');
        }
        ags.tlog.onChange(() => { if (logPage === 0) renderLog().catch(() => {}); repaint(); });
        ags.on('change', repaint);
    },
});
