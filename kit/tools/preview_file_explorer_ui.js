'use strict';
/**
 * preview_file_explorer_ui.js - draw File Explorer's pages straight to PNG as the kit would where it runs the
 * screen (cv.own: buttons on the canvas, GPU ops only), with the real model on a scratch folder. Local addition.
 *   node kit/tools/preview_file_explorer_ui.js [outDir]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
const R = path.join(ROOT, 'kit', 'runtime');
const APP = path.join(ROOT, 'apps', 'file_explorer');
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req.startsWith('./kit/')) return load.call(this, path.join(R, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const { Canvas } = require(path.join(R, 'canvas'));
const { Recorder, play } = require(path.join(R, 'record'));
const G = require(path.join(R, 'gauges'));
const { theme } = require(path.join(R, 'themes'));
const UI = require(path.join(APP, 'ui'));
const rofs = require(path.join(APP, 'rofs'));
const sysinfo = require(path.join(APP, 'sysinfo'));
const { Explorer } = require(path.join(APP, 'model'));

const out = path.resolve(process.argv[2] || 'preview_fx');
fs.mkdirSync(out, { recursive: true });
const t = theme('m_tricolour');

// scratch folder like an app's data dir
const FX = fs.mkdtempSync(path.join(os.tmpdir(), 'oap_1234-'));
const L = [];
for (let i = 0; i < 400; i++) L.push('2026-11-24T08:' + String(10 + (i % 50)).padStart(2, '0') + ':' + String(i % 60).padStart(2, '0') + '.000Z INFO loop MAIN: 3.1 ms per frame in JS (GPU renderer) #' + i);
L.splice(380, 0, '2026-11-24T08:59:01.000Z WARN render: TypeError: Cannot read properties of undefined (reading \'speed\')',
    '2026-11-24T08:59:02.000Z FATAL uncaught: TypeError: cb is not a function', '    at Waze.onFrame (/var/opt/public/oap/oap_1234/source/javascript/waze.js:212:9)',
    '    at Timeout._onTimeout (/var/opt/public/oap/oap_1234/source/javascript/kit/mgu.js:701:31)', '2026-11-24T08:59:02.010Z FATAL exit code 1 rss=61MB');
fs.writeFileSync(path.join(FX, 'cluster_themes.log'), L.join('\n') + '\n');
fs.writeFileSync(path.join(FX, 'cluster_themes.log.1'), 'old\n');
fs.writeFileSync(path.join(FX, 'settings.json'), JSON.stringify({ theme: 'm_tricolour', layout: 'live' }, null, 2));
fs.writeFileSync(path.join(FX, 'blob.bin'), Buffer.from(Array.from({ length: 600 }, (x, i) => (i * 37) & 255)));
fs.mkdirSync(path.join(FX, 'cache'));
fs.symlinkSync('/tmp', path.join(FX, 'tmp-link'));

function shot(name, m, focusRow) {
    const rec = new Recorder(UI.W, UI.H, {});
    rec.own = true;
    rec.target = () => {};
    UI.draw(rec, G, t, m, { act: {}, focusRow, tz: 60 });
    const cv = new Canvas(UI.W, UI.H);
    play(rec.words(), cv);
    fs.writeFileSync(path.join(out, name + '.png'), cv.png());
    console.log('wrote ' + name);
}

(async () => {
    const fakeSys = Object.assign({}, sysinfo, {
        findLogs: async () => ({ error: null, logs: [
            { app: 'cluster_themes', dir: 'oap_1234', name: 'cluster_themes.log', file: path.join(FX, 'cluster_themes.log'), size: 214000, mtime: Date.now() - 60000 },
            { app: 'idrive_hud_widgets', dir: 'oap_1301', name: 'idrive_hud_widgets.log', file: '/var/opt/public/oap/oap_1301/data/idrive_hud_widgets.log', size: 90211, mtime: Date.now() - 3600000 },
            { app: 'oap_1400', dir: 'oap_1400', file: '/var/opt/public/oap/oap_1400/data', error: 'no access' },
        ] }),
    });
    const m = new Explorer({ rofs, sysinfo: fakeSys, settings: { get: () => null }, dataDir: FX });
    await m.start(FX);
    shot('1_files', m);
    m.setTab(1); shot('2_logs', m);
    m.setTab(2); shot('3_info', m);
    m.setTab(0);
    await m.openFile(path.join(FX, 'cluster_themes.log'));
    shot('4_viewer_end', m);
    m.toggleFilter(); shot('5_viewer_issues', m);
    m.qrOpen(); shot('6_qr', m);
    m.qrSize(); shot('7_qr_medium', m);
    m.back(); m.toggleFilter(); m.back();
    await m.openFile(path.join(FX, 'blob.bin')); shot('8_hex', m);
    m.back();
    await m.cd('/usr/lib'); shot('9_long_folder', m, 8);
    await m.cd('/dev'); m.rows().find((r) => r.title === 'null').run(); shot('10_device_note', m);
    fs.rmSync(FX, { recursive: true, force: true });
})();
