'use strict';
/**
 * ui.js - the AGS Control screen, a pure draw(cv, G, t, v, act) in the house style of the
 * kit's other apps (Engine Config): page tabs, the grey content panel, a picture, the big
 * state word and red/outline buttons drawn on the canvas where the kit runs the screen.
 *
 * Pages: 'Shutters' (the car's front with both shutters, the state, Open / Closed / OEM),
 * 'Status' (link, DME, takeovers, errors, read-back) and 'Log' (the telemetry log, paged).
 * v = view built in main.js; act = press callbacks.
 *
 * The car's front (G30 LCI, M Sport) with both shutters: front.js.
 * GPU-safe: only fillRect / gradientRect / roundRect / strokeRoundRect / fill / line / polyline / circle / text.
 */

const FRONT = require('./front');

const W = 1600, H = 520;
const PAGES = ['Shutters', 'Status', 'Log'];
const LOG_ROWS = 9;


function draw(cv, G, t, v, act) {
    act = act || {};
    cv.clear(t.bg);
    const page = PAGES.indexOf(v.page) >= 0 ? v.page : PAGES[0];
    G.frame(cv, t, PAGES, PAGES.indexOf(page), [
        v.armed ? null : { text: 'SIM', color: t.warn || '#d29922' },
        v.standing === false && v.speed != null ? { text: 'MOVING', color: t.warn || '#d29922' } : null,
    ]);
    G.panel(cv, t, 24, G.TOP, W - 48, G.BOTTOM - G.TOP, null);
    const bottom = G.pageBottom(cv) - (cv.own ? G.MARGIN : 0);
    if (page === 'Status') return drawStatus(cv, G, t, v, act, bottom);
    if (page === 'Log') return drawLog(cv, G, t, v, act, bottom);
    return drawShutters(cv, G, t, v, act, bottom);
}

/* ---------------------------------------------------------------- Shutters page -- */

const STATE_COL = (t, s) => s === 'OPEN' ? (t.accent2 || '#81c4ff') : s === 'CLOSED' ? (t.crit || '#ef2b2d') : t.text;

function drawShutters(cv, G, t, v, act, bottom) {
    // the car's front on the left, the state on the right, the buttons across the bottom
    const btnTop = cv.own ? bottom - 56 : bottom;
    FRONT.draw(cv, G, t, 40, G.TOP + 10, 920, btnTop - G.TOP - 22, v);

    const x0 = 1000, warn = t.warn || '#d29922';
    cv.text(v.word, x0, G.TOP + 92, 64, STATE_COL(t, v.word), { font: 'bold', spacing: 3 });
    cv.text(v.sub || '', x0, G.TOP + 130, 19, v.subWarn ? warn : t.dim, { font: 'label' });
    if (v.notice) cv.text(v.notice, x0, G.TOP + 160, 19, warn, { font: 'label' });

    const tiles = [
        ['SPEED', v.speed == null ? '--' : Math.round(v.speed) + ' km/h', v.standing === false],
        ['COOLANT', v.coolant == null ? '--' : v.coolant + ' °C', false],
        ['POSITION', v.posDeg == null ? '--' : v.posDeg.toFixed(1) + '°', false],
        ['CAR MODE', v.carMode || '--', false],
    ];
    const tw = 262, th = 84, gx = 18, gy = 16, ty0 = G.TOP + 186;
    tiles.forEach(([label, value, hot], i) => {
        const tx = x0 + (i % 2) * (tw + gx), ty = ty0 + Math.floor(i / 2) * (th + gy);
        cv.roundRect(tx, ty, tw, th, 10, G.withAlpha('#ffffff', 0.05));
        cv.text(label, tx + 18, ty + 30, 15, t.dim, { font: 'bold', spacing: 1.5 });
        cv.text(value, tx + 18, ty + 68, 28, value === '--' ? t.dim : hot ? warn : t.text, { font: 'bold' });
    });

    if (!cv.own) return cv;
    const moving = v.standing === false;
    const btns = [
        { k: 'open', label: 'Open', run: act.open, busy: moving },
        { k: 'closed', label: 'Closed', run: act.closed, busy: moving },
        { k: 'oem', label: 'OEM', run: act.oem, busy: false },
    ];
    const bw = 300, bh = 56, gap = 30;
    let bx = (W - (btns.length * bw + (btns.length - 1) * gap)) / 2;
    for (const b of btns) {
        const on = b.k === v.mode;
        const o = on ? { color: t.crit || '#ef2b2d', primary: true, key: 'ags_' + b.k, busy: b.busy } : { key: 'ags_' + b.k, busy: b.busy };
        G.button(cv, t, bx, bottom - bh, bw, bh, b.label, b.run || (() => {}), o);
        bx += bw + gap;
    }
    return cv;
}

/* ------------------------------------------------------------------ Status page -- */

function drawStatus(cv, G, t, v, act, bottom) {
    const rows = v.rows || [];
    const btnTop = cv.own ? bottom - 56 : bottom;
    const step = Math.min(46, (btnTop - G.TOP - 40) / Math.max(1, rows.length));
    rows.forEach(([label, value, kind], i) => {
        const y = G.TOP + 44 + i * step;
        if (i % 2 === 0) cv.fillRect(48, y - step + 14, W - 96, step, G.withAlpha('#ffffff', 0.025));
        cv.text(label, 72, y, 17, t.dim, { font: 'bold', spacing: 1.2 });
        const c = kind === 'bad' ? (t.crit || '#ef2b2d') : kind === 'warn' ? (t.warn || '#d29922') : kind === 'good' ? (t.go || '#2fd27a') : t.text;
        cv.text(value, 470, y, 21, c, { font: 'label', literal: true });
    });
    if (cv.own) G.button(cv, t, (W - 360) / 2, bottom - 56, 360, 56, 'Read shutters', act.read || (() => {}), { key: 'ags_read' });
    return cv;
}

/* --------------------------------------------------------------------- Log page -- */

function drawLog(cv, G, t, v, act, bottom) {
    const lg = v.log || { rows: [], page: 0, pages: 1, total: 0 };
    const btnTop = cv.own ? bottom - 56 : bottom;
    cv.text('Page ' + (lg.page + 1) + ' / ' + lg.pages + '  ·  newest first  ·  ' + lg.total + ' entries', 72, G.TOP + 38, 16, t.dim,
        { font: 'bold', spacing: 1.2, literal: true });
    const step = Math.min(36, (btnTop - G.TOP - 70) / LOG_ROWS);
    for (let i = 0; i < LOG_ROWS; i++) {
        const row = lg.rows[i];
        if (!row) continue;
        const y = G.TOP + 76 + i * step;
        const sp = row.indexOf(' ');
        const time = sp > 0 ? row.slice(0, sp) : '', text = sp > 0 ? row.slice(sp + 1) : row;
        const bad = /err|refus|NRC|fail/i.test(text), hot = /takeover|drove off|ignored/i.test(text);
        cv.text(time, 72, y, 19, t.dim, { font: 'label', literal: true });
        cv.text(text, 200, y, 20, bad ? (t.crit || '#ef2b2d') : hot ? (t.warn || '#d29922') : t.text, { font: 'label', literal: true });
    }
    if (!cv.own) return cv;
    const btns = [
        ['Newer', act.logNewer, { busy: lg.page <= 0 }],
        ['Older', act.logOlder, { busy: lg.page >= lg.pages - 1 }],
        ['QR code', act.logQr, {}],
        ['Clear', act.logClear, { confirm: true, color: t.crit || '#ef2b2d' }],
    ];
    const bw = 250, gap = 26;
    let bx = (W - (btns.length * bw + (btns.length - 1) * gap)) / 2;
    btns.forEach(([label, run, o], i) => {
        G.button(cv, t, bx, bottom - 56, bw, 56, label, run || (() => {}), Object.assign({ key: 'ags_log' + i }, o));
        bx += bw + gap;
    });
    return cv;
}

module.exports = { draw, W, H, PAGES, LOG_ROWS };
