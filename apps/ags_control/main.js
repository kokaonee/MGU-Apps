'use strict';
/**
 * AGS Control - control the active grille shutters (radiator shutters) through the DME.
 * Show use at standstill: Open / Closed (<= 3 km/h) and OEM (DME in control). Driving off hands back to OEM.
 * Runs via "autostart" in the background so driving off is caught with the app closed too.
 * Logic: controller.js. Texts are kept ASCII (HMI fonts).
 */
const mgu = require('./kit/mgu');
const { Ags, fesShort } = require('./controller');
const { TLog } = require('./tlog');
const qrview = require('./qrview');

const LOG_ROWS = 12;

const LABEL = { open: 'Open (standstill)', closed: 'Closed (standstill)', oem: 'OEM (automatic)' };
const SHORT = { open: 'OPEN', closed: 'CLOSED', oem: 'OEM', '?': '...' };
const BTN = { open: 'BTN_OPEN', closed: 'BTN_CLOSED', oem: 'BTN_OEM' };

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
        ui.onClick('BTN_READ', () => ags.readBack());
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

        function lineState(s) {
            let t = 'Mode: ' + SHORT[s.mode];
            t += '   Sent to car: ' + (s.refused ? 'REFUSED by DME, retrying (' + s.refused.count + 'x)' : SHORT[s.sent]) + (s.armed ? '' : ' [SIMULATED]');
            if (s.armed && s.sendCount) t += '   Last send ' + s.sentAgo + ' s ago (#' + s.sendCount + ')';
            if (s.coolBlocked) t += '   CLOSED paused: ' + (s.coolant === null ? 'no coolant value' : 'coolant ' + s.coolant + ' C');
            if (s.notice) t = '>> ' + s.notice + '   ' + t;
            else if (!s.standing && s.mode === 'oem') t += '   (Open / Closed only at standstill)';
            return t;
        }

        function lineInfo(s) {
            const p = [];
            p.push('Link: ' + (s.link ? 'yes' : 'no') + (s.tasuError ? ' (' + s.tasuError + ')' : ''));
            p.push('AKKS: ' + (!s.probe.done ? '?' : s.probe.present ? 'ok' : 'no answer'));
            p.push('Car mode: ' + fesShort(s.fesRaw));
            p.push('Coolant: ' + (s.coolant === null ? '-' : s.coolant + ' C'));
            p.push('Speed: ' + (s.speed === null ? '-' : Math.round(s.speed) + ' km/h'));
            return p.join('   ');
        }

        function lineErr(s) {
            if (!s.lastErr) return 'Errors: none';
            return (s.error ? 'ERROR NOW: ' : 'Errors: ' + s.errCount + ', last ') + s.lastErr.msg;
        }

        function lineEvents(s) {
            if (!s.lostLog.length) return 'DME takeovers: none' + (s.smart ? ' (smart hold)' : '');
            const last = s.lostLog[s.lostLog.length - 1];
            let t = 'DME takeovers: ' + s.lostLog.length;
            if (s.period) t += ', every ~' + Math.round(s.period / 1000) + ' s, next in ' + s.nextIn + ' s' + (s.fast ? ' [FAST CHECK]' : '');
            return t + '   last ' + Math.round((Date.now() - last.at) / 1000) + ' s ago: ' + last.why;
        }

        let busy = false;
        const shown = {};
        async function renderLog() {
            const pg = ags.tlog.page(logPage, LOG_ROWS);
            logPage = pg.page;
            await put('LOG_HDR', 'Page ' + (pg.page + 1) + '/' + pg.pages + ', newest first, ' + pg.total + ' entries');
            for (let i = 0; i < LOG_ROWS; i++) await put('LOG_' + i, pg.rows[i] || ' ');
        }
        ags.tlog.onChange(() => { if (logPage === 0) renderLog().catch(() => {}); });
        const put = async (name, text) => { if (shown[name] === text) return; shown[name] = text; await ui.text(name, text); };
        async function render() {
            if (busy) return;
            busy = true;
            try {
                const s = ags.status();
                await put('TXT_STATE', lineState(s));
                await put('TXT_INFO', lineInfo(s));
                await put('TXT_EVENTS', lineEvents(s));
                await put('TXT_ERR', lineErr(s));
                await put('TXT_READ', s.readback ? 'Read-back: ' + s.readback.text : 'Read-back: not read yet');
                for (const m of Object.keys(BTN)) await put(BTN[m], (s.mode === m ? '> ' : '') + LABEL[m]);
            } catch (e) { log.warn('render: ' + e); } finally { busy = false; }
        }

        ags.on('change', () => render());
        setInterval(render, 1000);
        render();
    },
});
