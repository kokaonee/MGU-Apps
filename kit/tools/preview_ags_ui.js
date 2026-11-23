'use strict';
/**
 * preview_ags_ui.js - draw AGS Control's ui.js pages straight to PNG as the kit would where it runs the
 * screen (cv.own: buttons on the canvas). Local addition, not upstream.
 *   node kit/tools/preview_ags_ui.js [outDir]
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..', 'runtime');
const { Canvas } = require(path.join(R, 'canvas'));
const { Recorder, play } = require(path.join(R, 'record'));
const G = require(path.join(R, 'gauges'));
const { theme } = require(path.join(R, 'themes'));
const UI = require(path.join(__dirname, '..', '..', 'apps', 'ags_control', 'ui'));

const out = path.resolve(process.argv[2] || 'preview_ags');
fs.mkdirSync(out, { recursive: true });
const t = theme('m_tricolour');

const base = {
    armed: true, standing: true, mode: 'open', word: 'OPEN', sub: 'Held by the app  ·  sent 4 s ago  ·  DME takeovers 2',
    paint: 'sapphire', speed: 0, coolant: 88, posDeg: 83.5, carMode: 'Sport', upper: 1, lower: 1, upperDim: false, lowerDim: false,
    rows: [
        ['DIAGNOSTIC LINK', 'yes', 'good'], ['SHUTTER MODULE (DME)', 'answers', 'good'], ['CAR MODE', 'Sport'],
        ['SENT TO CAR', 'OPEN  ·  4 s ago  ·  #12'], ['DME TAKEOVERS', '2  ·  every ~60 s  ·  next in 38 s'],
        ['ERRORS', 'none'], ['READ-BACK', 'OPEN 83.5 deg | upper: 100% / 11240 steps | lower: 100% / 11330 steps'],
    ],
    log: { page: 0, pages: 3, total: 61, rows: [
        '18:02:11 mode open (user)', '18:02:11 sent OPEN v0 n0 P', '18:02:13 rb 83.5deg 100/100%',
        '18:03:12 DME takeover upper, re-sent', '18:03:40 mode closed (user)', '18:03:40 sent CLOSED v0 n0 P',
        '18:04:02 closed ignored: v12 (moving)', '18:04:05 drove off v14 -> OEM', '18:04:05 hand back (oem)'] },
};
const cases = {
    shutters_open: { page: 'Shutters' },
    shutters_closed: { page: 'Shutters', mode: 'closed', word: 'CLOSED', upper: 0, lower: 0, posDeg: 0 },
    shutters_oem_moving: { page: 'Shutters', mode: 'oem', word: 'OEM', sub: 'DME in control', standing: false, speed: 37,
        notice: 'Open / Closed only at standstill (37 km/h)', upper: 0.35, lower: 0.35, upperDim: true, lowerDim: true, posDeg: null },
    paint_sapphire: { page: 'Shutters', paint: 'sapphire', mode: 'closed', word: 'CLOSED', upper: 0, lower: 0, posDeg: 0 },
    paint_alpine: { page: 'Shutters', paint: 'alpine' },
    paint_phytonic: { page: 'Shutters', paint: 'phytonic', mode: 'oem', word: 'OEM', sub: 'DME in control', upper: 0.35, lower: 0.35, upperDim: true, lowerDim: true },
    shutters_sim: { page: 'Shutters', armed: false, sub: 'Simulated  ·  "Car control" is off in Settings', subWarn: true },
    status: { page: 'Status' },
    log: { page: 'Log' },
};
for (const [name, c] of Object.entries(cases)) {
    // recorded as the GPU renderer gets it (only its ops), then played into a canvas
    const rec = new Recorder(UI.W, UI.H, {});
    rec.own = true;
    rec.target = () => {};
    UI.draw(rec, G, t, Object.assign({}, base, c), {});
    const cv = new Canvas(UI.W, UI.H);
    play(rec.words(), cv);
    fs.writeFileSync(path.join(out, name + '.png'), cv.png());
    console.log('wrote ' + name);
}
