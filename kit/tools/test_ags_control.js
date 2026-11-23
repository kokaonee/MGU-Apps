'use strict';
// AGS Control without a car: the controller against a fake DME through the real kit/diag transport.
//   node kit/tools/test_ags_control.js      (from the root of the idrive7-apps kit)
const assert = require('assert');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
const KIT = path.join(ROOT, 'kit', 'runtime');
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const { Ags, fesGroup } = require(path.join(ROOT, 'apps', 'ags_control', 'controller'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, error() {} };
const hx = (a) => a.map((b) => b.toString(16).padStart(2, '0')).join(' ');
const results = [];
async function t(name, fn) {
    try { await fn(); results.push('PASS  ' + name); } catch (e) { results.push('FAIL  ' + name + ' :: ' + (e && e.stack || e)); }
}

/** Fake car: DME 0x12 with AKKS, FES/CDS signals fed by hand. o.noAkks, o.nrc2F */
function car(o) {
    o = o || {};
    const dme = { sent: [], pct: { 0x6013: null, 0x6014: null } };
    const sig = {};
    let cb;
    const frame = (u) => setTimeout(() => cb && cb({ udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, 0x12, 0, 0].concat(u)) }), 2);
    const signals = {
        async proxy() { return {}; },
        async on(p, e, f) { cb = f; },
        async onAvailable(p, f) { f(true); },
        async watch(iface, inst, handlers) { Object.assign(sig, handlers); return { available: true }; },
        async call(p, m, req) {
            const sid = req.serviceID, d = [...req.udsData];
            dme.sent.push(hx([sid].concat(d)));
            const did = (d[0] << 8) | d[1];
            if (sid === 0x22) {
                if (o.noAkks) frame([0x7F, 0x22, 0x31]);
                else if (did === 0x4AD2) frame([0x62, 0x4A, 0xD2, dme.pct[0x6013] === 100 ? 0x85 : dme.pct[0x6013] === 0 ? 0x83 : 0x01]);
                else if (did === 0x58D3) frame([0x62, 0x58, 0xD3, 0x00, 0xB4]);
                else if (did === 0x6213 || did === 0x6214) { const v = dme.pct[did - 0x200] || 0; frame([0x62, d[0], d[1], v >> 8, v & 255]); }
                else if (did === 0x6413 || did === 0x6414) frame([0x62, d[0], d[1], 0x01, 0x2C]);
                else frame([0x7F, 0x22, 0x31]);
            } else if (sid === 0x2F) {
                if (o.nrc2F) frame([0x7F, 0x2F, o.nrcCode || 0x22]);
                else {
                    if (d[2] === 3) dme.pct[did] = (d[3] << 8) | d[4];
                    if (d[2] === 0) dme.pct[did] = null;
                    frame([0x6F].concat(d.slice(0, 3)));
                }
            }
            return 'NO_ERROR';
        },
    };
    return { dme, signals, sig, opts: o };
}

async function make(set, o) {
    const c = car(o);
    const s = Object.assign({ arm: 'on', mode: 'oem', hold: 'off', coolLimit: '105', flaps: 'both',
        drv_sport: 'open', drv_sportplus: 'open', drv_sportind: 'closed', drv_hybrid: 'oem', drv_electric: 'oem', drv_adaptive: 'oem' }, set || {});
    const listeners = [];
    const settings = { get: (k) => s[k], set: (k, v) => { s[k] = v; listeners.forEach((f) => f(k, v)); }, onChange: (f) => listeners.push(f) };
    const ags = new Ags({ settings, signals: c.signals, log: quiet, spec: {} });
    await ags.start();
    c.sig.statusEngineTemperature({ temperatureEngineDrive: 90 + 48 });
    c.sig.statusCarSpeed2({ speedVehicleCentreOfGravity: 0 });                 // standing
    await sleep(30);
    const f2 = () => c.dme.sent.filter((x) => x.startsWith('2f'));
    return { c, s, ags, settings, f2, done: () => ags.stop() };
}

(async () => {
    await t('driving mode mapping', async () => {
        assert.deepStrictEqual([1, 2, 3, 4, 7, 10, 15, 16, 17, 18, 19, 20, 21, 23, 28, 0, 61].map(fesGroup),
            ['sport', 'sportplus', 'sportind', 'comfort', 'eco', 'adaptive', 'sport', 'sportind', 'hybrid', 'hybrid', 'hybrid', 'electric', 'electric', 'sportplus', 'sportplus', null, null]);
        // names as the G30 545e sends them
        assert.deepStrictEqual(['PHEV_SPORT_STANDARD', 'SPORT_EXPERT', 'PHEV_SPORT_INDIVIDUAL', 'ADAPTIVE', 'PHEV_HYBRID_STANDARD', 'PHEV_HYBRID_ECO', 'PHEV_ELECTRIC_STANDARD', 'PHEV_ELECTRIC_INDIVIDUAL'].map(fesGroup),
            ['sport', 'sportplus', 'sportind', 'adaptive', 'hybrid', 'hybrid', 'electric', 'electric']);
    });

    await t('disarmed: not a single 2F request', async () => {
        const x = await make({ arm: 'off' });
        for (const m of ['open', 'closed', 'drive', 'oem']) { await x.ags.setMode(m); await sleep(20); }
        assert.strictEqual(x.f2().length, 0); x.done();
    });

    await t('open: both flaps 03 00 64, OEM: 00', async () => {
        const x = await make();
        await x.ags.setMode('open'); await sleep(30);
        assert.deepStrictEqual(x.f2(), ['2f 60 13 03 00 64', '2f 60 14 03 00 64']);
        await x.ags.setMode('oem'); await sleep(30);
        assert.deepStrictEqual(x.f2().slice(2), ['2f 60 13 00', '2f 60 14 00']); x.done();
    });

    await t('closed: 03 00 00; upper only -> lower handed back', async () => {
        const x = await make({ flaps: 'upper' });
        await x.ags.setMode('closed'); await sleep(30);
        assert.deepStrictEqual(x.f2(), ['2f 60 13 03 00 00']);
        x.settings.set('flaps', 'lower'); await sleep(40);
        assert.deepStrictEqual(x.f2().slice(1), ['2f 60 13 00', '2f 60 14 03 00 00']); x.done();
    });

    await t('coolant guard: closed -> OEM at the limit, back only 5 K below', async () => {
        const x = await make();
        await x.ags.setMode('closed'); await sleep(30); assert.strictEqual(x.ags.sent, 'closed');
        x.c.sig.statusEngineTemperature({ temperatureEngineDrive: 106 + 48 }); await x.ags.kick(); await sleep(30);
        assert.strictEqual(x.ags.sent, 'oem');
        x.c.sig.statusEngineTemperature({ temperatureEngineDrive: 102 + 48 }); await x.ags.kick(); await sleep(30);
        assert.strictEqual(x.ags.sent, 'oem');
        x.c.sig.statusEngineTemperature({ temperatureEngineDrive: 99 + 48 }); await x.ags.kick(); await sleep(30);
        assert.strictEqual(x.ags.sent, 'closed'); x.done();
    });

    await t('no coolant value: closed is not sent', async () => {
        const x = await make();
        x.ags.coolant = null;
        await x.ags.setMode('closed'); await sleep(30);
        assert.strictEqual(x.ags.sent, 'oem'); assert.ok(x.ags.status().coolBlocked);
        assert.ok(!x.f2().some((r) => r.endsWith('03 00 00'))); x.done();
    });

    await t('hold: re-sent when due', async () => {
        const x = await make({ hold: '5' });
        await x.ags.setMode('open'); await sleep(30);
        const n = x.f2().length;
        x.ags.sentAt -= 6000; await x.ags.kick(); await sleep(30);
        assert.strictEqual(x.f2().length, n + 2); x.done();
    });

    await t('smart hold: no re-send while the DME keeps the override', async () => {
        const x = await make({ hold: 'smart' });
        await x.ags.setMode('open'); await sleep(40);
        const n = x.f2().length;
        for (let i = 0; i < 3; i++) { x.ags.sentAt = Date.now() - 3000; x.ags.lastCheck = 0; await x.ags.kick(); await sleep(30); }
        assert.strictEqual(x.f2().length, n, 'only reads, no 2F');
        assert.ok(x.c.dme.sent.filter((r) => r.startsWith('22 62 13')).length >= 3, 'checked ASW');
        x.done();
    });

    await t('smart hold: re-send when the DME drops the override', async () => {
        const x = await make({ hold: 'smart' });
        await x.ags.setMode('open'); await sleep(40);
        const n = x.f2().length;
        x.c.dme.pct[0x6013] = null; x.c.dme.pct[0x6014] = null;      // DME timed out
        x.ags.sentAt = Date.now() - 3000; x.ags.lastCheck = 0; await x.ags.kick(); await sleep(60);
        assert.deepStrictEqual(x.f2().slice(n), ['2f 60 13 03 00 64', '2f 60 14 03 00 64']);
        assert.ok(/DME took over after/.test(x.ags.status().lostNote), x.ags.status().lostNote);
        x.done();
    });

    await t('smart hold: refresh at the latest after 6 s', async () => {
        const x = await make({ hold: 'smart' });
        await x.ags.setMode('open'); await sleep(40);
        const n = x.f2().length;
        x.ags.sentAt -= 7000; await x.ags.kick(); await sleep(40);
        assert.strictEqual(x.f2().length, n + 2); assert.strictEqual(x.ags.status().sendCount, 2);
        x.done();
    });

    await t('refresh does not trigger the full read-back', async () => {
        const x = await make({ hold: 'smart' });
        await x.ags.setMode('open'); await sleep(1700);
        const reads = () => x.c.dme.sent.filter((r) => r.startsWith('22 58 d3')).length;
        const n = reads();
        assert.strictEqual(n, 1, 'one read-back after the mode change');
        x.ags.sentAt -= 7000; await x.ags.kick(); await sleep(1700);
        assert.strictEqual(reads(), n, 'no read-back after a refresh');
        x.done();
    });

    await t('rhythm: learns ~60 s and checks every 250 ms around the predicted takeover', async () => {
        const x = await make({ hold: 'smart' });
        await x.ags.setMode('open'); await sleep(40);
        const now = Date.now();
        assert.strictEqual(x.ags.period(), null, 'no rhythm without takeovers');
        x.ags.takeoverTimes = [now - 179000, now - 118000, now - 58000];   // 61 s, 60 s apart
        assert.strictEqual(x.ags.period(), 60500);
        assert.ok(x.ags.inFastWindow(now), 'next predicted in ~2 s -> fast window');
        const reads = () => x.c.dme.sent.filter((r) => r.startsWith('22 62 13')).length;
        const n = reads();
        x.ags.sentAt = now - 1000; x.ags.lastCheck = now - 300; await x.ags.kick(); await sleep(30);
        assert.strictEqual(reads(), n + 1, 'checked after 300 ms inside the window');
        x.ags.takeoverTimes = [now - 90000, now - 30000];                   // next in ~30 s
        assert.ok(!x.ags.inFastWindow(now));
        const m = reads();
        x.ags.lastCheck = Date.now() - 300; await x.ags.kick(); await sleep(30);
        assert.strictEqual(reads(), m, 'no check after 300 ms outside the window');
        x.ags.takeoverTimes = [now - 190000, now - 70000];                  // 120 s = one missed takeover
        assert.strictEqual(x.ags.period(), 60000);
        x.done();
    });

    await t('telemetry log: short lines, refusal summary, survives a restart', async () => {
        const os = require('os'), fs = require('fs');
        const { TLog } = require(path.join(ROOT, 'apps', 'ags_control', 'tlog'));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agslog-'));
        const tlog = new TLog(dir, () => 60);
        const c = car({ nrc2F: true });
        const st = { arm: 'on', mode: 'oem', hold: 'smart', coolLimit: '105', flaps: 'both', drv_sportind: 'open' };
        const settings = { get: (k) => st[k], set: (k, v) => { st[k] = v; }, onChange() {} };
        const ags = new Ags({ settings, signals: c.signals, log: quiet, spec: { version: '9.9' }, tlog });
        await ags.start();
        c.sig.statusEngineTemperature({ temperatureEngineDrive: 82 + 48 });
        c.sig.statusCarSpeed2({ speedVehicleCentreOfGravity: 2 / 0.015625 });
        c.sig.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: 1500 * 4 });
        c.sig.statusGearboxDrive({ statusActualStageDrive: 'D' });
        c.sig.statusFESVehicleDynamicSwitchHMI({ actualValueModeDrivingExperience: 'PHEV_SPORT_INDIVIDUAL' });
        await ags.setMode('open'); await sleep(40);
        for (let i = 0; i < 3; i++) { ags.errorUntil = 0; await ags.kick(); await sleep(30); }
        c.sig.statusCarSpeed2({ speedVehicleCentreOfGravity: 0 });
        c.opts.nrc2F = false; ags.errorUntil = 0; await ags.kick(); await sleep(40);
        ags._snapshot();
        ags.stop();
        const lines = tlog.lines.join('\n');
        assert.ok(/start v9\.9/.test(lines) && /fes SportInd/.test(lines) && /mode OPEN/.test(lines), lines);
        assert.strictEqual((lines.match(/REFUSED NRC22 v2 n1500 D OPEN/g) || []).length, 1, 'one REFUSED line, not one per retry');
        assert.ok(/accepted v0 n1500 D \d+x v2-2/.test(lines) && /sent OPEN v0 n1500 D/.test(lines), lines);
        assert.ok(/v0 n1500 D c82 SportInd OPEN/.test(lines), lines);
        assert.ok(tlog.lines.every((l) => l.length <= 55 && /^\d\d:\d\d:\d\d /.test(l)), 'short, time-stamped lines');
        tlog._save(true);
        const again = new TLog(dir, () => 60);
        assert.strictEqual(again.lines.length, tlog.lines.length, 'kept on disk');
        const pg = again.page(0, 12);
        assert.strictEqual(pg.rows[0], tlog.lines[tlog.lines.length - 1], 'newest first');
    });

    await t('log QR pages: plain text, fit the code, newest first, nothing lost', async () => {
        const qrview = require(path.join(ROOT, 'apps', 'ags_control', 'qrview'));
        const qr = require(path.join(KIT, 'qr'));
        const lines = [];
        for (let i = 0; i < 400; i++) lines.push('16:' + String(i % 60).padStart(2, '0') + ':00 entry number ' + i + ' v48 c82 SportInd');
        for (const sz of qrview.SIZES) {
            const pgs = qrview.pages(lines, sz.version, 'AGS log v1');
            assert.ok(pgs.every((p) => Buffer.byteLength(p.text) <= qr.capacity(sz.version, 'L')), sz.id + ': fits');
            assert.ok(/entry number 399 /.test(pgs[0].last) && /^AGS log v1 1\//.test(pgs[0].text), sz.id + ': newest on page 1');
            const all = pgs.slice().reverse().reduce((a, p) => a.concat(p.lines), []);
            assert.deepStrictEqual(all, lines.slice(lines.length - all.length), sz.id + ': consecutive, no gaps');
        }
        assert.strictEqual(qrview.pages([], 20)[0].lines[0], '(log is empty)');
    });

    await t('show use: Open / Closed refused while moving, nothing sent', async () => {
        const x = await make();
        x.c.sig.statusCarSpeed2({ speedVehicleCentreOfGravity: 20 / 0.015625 });
        await x.ags.setMode('open'); await sleep(30);
        assert.strictEqual(x.f2().length, 0); assert.strictEqual(x.ags.mode, 'oem');
        assert.ok(/Only at standstill \(20 km\/h\)/.test(x.ags.status().notice), x.ags.status().notice);
        x.c.sig.statusCarSpeed2({ speedVehicleCentreOfGravity: 0xFFFF });       // invalid: no speed known
        x.ags.speed = null;
        await x.ags.setMode('closed'); await sleep(30);
        assert.strictEqual(x.f2().length, 0, 'no speed signal: not allowed either');
        x.done();
    });

    await t('show use: driving off hands back and stays on OEM', async () => {
        const x = await make({ hold: 'smart' });
        await x.ags.setMode('open'); await sleep(40);
        assert.deepStrictEqual(x.f2(), ['2f 60 13 03 00 64', '2f 60 14 03 00 64']);
        x.c.sig.statusCarSpeed2({ speedVehicleCentreOfGravity: 6 / 0.015625 }); await sleep(60);
        assert.deepStrictEqual(x.f2().slice(2), ['2f 60 13 00', '2f 60 14 00'], 'handed back');
        assert.strictEqual(x.ags.mode, 'oem'); assert.strictEqual(x.ags.sent, 'oem');
        x.c.sig.statusCarSpeed2({ speedVehicleCentreOfGravity: 0 }); await x.ags.kick(); await sleep(40);
        assert.strictEqual(x.f2().length, 4, 'nothing re-opens at the next stop');
        x.done();
    });

    await t('DME without AKKS: nothing is controlled', async () => {
        const x = await make({}, { noAkks: true });
        await x.ags.setMode('open'); await sleep(40);
        assert.strictEqual(x.f2().length, 0); assert.ok(/AKKS/.test(x.ags.lastError)); x.done();
    });

    await t('DME refuses once during an active override: no hand back, quick retry', async () => {
        const x = await make({ hold: 'smart' });
        await x.ags.setMode('open'); await sleep(40);
        x.c.opts.nrc2F = true;
        x.ags.sentAt -= 7000; await x.ags.kick(); await sleep(40);           // refresh refused
        assert.ok(!x.f2().some((r) => /^2f 60 1[34] 00$/.test(r)), 'flaps not handed back');
        assert.ok(/NRC 22/.test(x.ags.status().lastErr.msg));
        x.c.opts.nrc2F = false;
        await sleep(350); await x.ags.kick(); await sleep(40);               // retry after 0.3 s succeeds
        assert.strictEqual(x.ags.sent, 'open'); assert.strictEqual(x.ags.status().error, null);
        x.done();
    });

    await t('NRC 22 at standstill: never hand back, keep retrying, apply when accepted', async () => {
        const x = await make({}, { nrc2F: true });
        x.c.sig.statusCarSpeed2({ speedVehicleCentreOfGravity: 2 / 0.015625 });
        await x.ags.setMode('open'); await sleep(40);
        for (let i = 0; i < 8; i++) { x.ags.errorUntil = 0; await x.ags.kick(); await sleep(30); }
        assert.ok(!x.f2().some((r) => /^2f 60 1[34] 00$/.test(r)), 'nothing handed back');
        assert.ok(/at 2 km\/h/.test(x.ags.lastError), x.ags.lastError);
        assert.ok(x.ags.status().refused && x.ags.status().refused.count >= 8);
        assert.ok(x.ags.errorUntil - Date.now() > 1000, 'slow retry after the quick ones');
        x.c.opts.nrc2F = false; x.ags.errorUntil = 0; await x.ags.kick(); await sleep(40);
        assert.strictEqual(x.ags.sent, 'open'); assert.strictEqual(x.ags.status().refused, null);
        x.done();
    });

    await t('other refusals again and again: hand back, error, backoff', async () => {
        const x = await make({}, { nrc2F: true, nrcCode: 0x31 });
        await x.ags.setMode('open'); await sleep(40);
        for (let i = 0; i < 6; i++) { x.ags.errorUntil = 0; await x.ags.kick(); await sleep(30); }
        assert.ok(x.f2().some((r) => r === '2f 60 13 00'), 'handed back after repeated refusals');
        assert.strictEqual(x.ags.sent, 'oem'); assert.ok(/NRC 31/.test(x.ags.lastError));
        assert.ok(/NRC 31/.test(x.ags.status().lastErr.msg) && /^\d\d:\d\d:\d\d$/.test(x.ags.status().lastErr.t), 'sticky error');
        const n = x.f2().length; await x.ags.kick(); await sleep(20);
        assert.strictEqual(x.f2().length, n, 'no spam during backoff'); x.done();
    });

    await t('armed -> disarmed: an active override is handed back', async () => {
        const x = await make();
        await x.ags.setMode('open'); await sleep(30);
        x.settings.set('arm', 'off'); await sleep(40);
        assert.deepStrictEqual(x.f2().slice(-2), ['2f 60 13 00', '2f 60 14 00']); x.done();
    });

    await t('read-back', async () => {
        const x = await make();
        await x.ags.setMode('open'); await sleep(30);
        await x.ags.readBack();
        assert.ok(/status 85/.test(x.ags.readback.text) && /OPEN/.test(x.ags.readback.text) && /90 deg/.test(x.ags.readback.text) && /upper: 100%/.test(x.ags.readback.text), x.ags.readback.text);
        x.done();
    });

    console.log(results.join('\n'));
    const fail = results.filter((r) => r.startsWith('FAIL')).length;
    console.log(fail ? fail + ' FAILED' : 'all ' + results.length + ' passed');
    process.exit(fail ? 1 : 0);
})();
