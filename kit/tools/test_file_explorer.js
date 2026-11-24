'use strict';
// File Explorer without a car: rofs (read-only, windows, devices, /proc), textbuf, the model, the read-only rule.
//   node kit/tools/test_file_explorer.js      (from the repo root). Local addition, not upstream.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'apps', 'file_explorer');
const KIT = path.join(ROOT, 'kit', 'runtime');
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const rofs = require(path.join(APP, 'rofs'));
const TB = require(path.join(APP, 'textbuf'));
const sysinfo = require(path.join(APP, 'sysinfo'));
const QR = require(path.join(APP, 'qrpage'));
const { Explorer } = require(path.join(APP, 'model'));

const results = [];
async function t(name, fn) {
    try { await fn(); results.push('PASS  ' + name); } catch (e) { results.push('FAIL  ' + name + ' :: ' + (e && e.stack || e)); }
}

// fixture (the test itself may write; the app may not)
const FX = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-'));
fs.mkdirSync(path.join(FX, 'sub'));
fs.mkdirSync(path.join(FX, '.hidden'));
const big = [];
for (let i = 0; i < 5000; i++) big.push('2026-11-24T08:' + String(i % 60).padStart(2, '0') + ':00.000Z INFO line ' + i + (i === 4999 ? ' FATAL uncaught: TypeError: x is not a function' : ''));
big.push('    at Foo (/x/app.js:1:1)');
fs.writeFileSync(path.join(FX, 'app.log'), big.join('\n') + '\n');
fs.writeFileSync(path.join(FX, 'bin.dat'), Buffer.from([0, 1, 2, 3, 255, 0, 65, 66]));
fs.writeFileSync(path.join(FX, 'empty.txt'), '');
fs.symlinkSync('sub', path.join(FX, 'link-to-sub'));
fs.symlinkSync('nowhere', path.join(FX, 'broken'));
fs.symlinkSync('.', path.join(FX, 'loop'));

(async () => {
    await t('read-only rule: no write / exec calls in the app, fs only in rofs.js', async () => {
        const bad = /\b(writeFile|appendFile|createWriteStream|unlink|rmdir|rename|mkdir|mkdtemp|chmod|chown|lchown|utimes|futimes|symlink|truncate|ftruncate|copyFile|fsync|rm)(Sync)?\s*\(|\bfs\.write|\bfs\.link|child_process|process\.binding|(^|[^.\w])spawn\(|(^|[^.\w])exec(Sync|File)?\(/m;
        for (const f of fs.readdirSync(APP).filter((x) => x.endsWith('.js'))) {
            const src = fs.readFileSync(path.join(APP, f), 'utf8');
            const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            assert(!bad.test(code), f + ' has a write / exec call: ' + (code.match(bad) || [])[0]);
            if (f !== 'rofs.js') assert(!/require\(['"](fs|graceful-fs)['"]\)/.test(code), f + ' requires fs (only rofs.js may)');
        }
        const ro = fs.readFileSync(path.join(APP, 'rofs.js'), 'utf8');
        const opens = ro.match(/fs\.open\([^)]*\)/g) || [];
        assert(opens.length >= 1 && opens.every((o) => /,\s*'r'\s*,/.test(o)), 'fs.open only with r: ' + opens.join(' | '));
        assert(Object.isFrozen(rofs));
    });

    await t('list: dirs first, types, links, broken link, loop link', async () => {
        const l = await rofs.list(FX);
        assert.strictEqual(l.error, null);
        const by = {}; l.entries.forEach((e) => { by[e.name] = e; });
        assert.strictEqual(by.sub.type, 'dir');
        assert.strictEqual(by['link-to-sub'].type, 'link'); assert.strictEqual(by['link-to-sub'].ttype, 'dir');
        assert.strictEqual(by.broken.ttype, 'broken');
        assert.strictEqual(by.loop.ttype, 'dir');
        const firstFile = l.entries.findIndex((e) => !rofs.isDirish(e));
        assert(l.entries.slice(firstFile).every((e) => !rofs.isDirish(e)), 'dirs first');
    });

    await t('list: missing / not a folder -> error text, no throw', async () => {
        assert.strictEqual((await rofs.list(path.join(FX, 'nope'))).error, 'missing');
        assert.strictEqual((await rofs.list(path.join(FX, 'app.log'))).error, 'not a folder');
    });

    await t('read: tail window, head window, next window, eof', async () => {
        const size = fs.statSync(path.join(FX, 'app.log')).size;
        const tail = await rofs.read(path.join(FX, 'app.log'), { tail: true });
        assert.strictEqual(tail.buf.length, rofs.CHUNK); assert.strictEqual(tail.off, size - rofs.CHUNK); assert(tail.eof);
        const head = await rofs.read(path.join(FX, 'app.log'), { off: 0 });
        assert.strictEqual(head.off, 0); assert(!head.eof);
        const next = await rofs.read(path.join(FX, 'app.log'), { off: rofs.CHUNK });
        assert.strictEqual(next.off, rofs.CHUNK);
        const e = await rofs.read(path.join(FX, 'empty.txt'));
        assert.strictEqual(e.buf.length, 0); assert(e.eof);
    });

    await t('read: devices, folders refused; /proc read with unknown size', async () => {
        await assert.rejects(rofs.read('/dev/null'), (e) => e.code === 'EDEVICE');
        await assert.rejects(rofs.read('/dev/zero'), (e) => e.code === 'EDEVICE');
        await assert.rejects(rofs.read(FX), (e) => e.code === 'EISDIR');
        const p = await rofs.read('/proc/self/status');
        assert(p.virtual && p.size === null && /Pid:/.test(p.buf.toString()));
    });

    await t('read: parallel reads queue up (one open file at a time)', async () => {
        const rs = await Promise.all([1, 2, 3, 4].map(() => rofs.read(path.join(FX, 'app.log'), { off: 0 })));
        assert(rs.every((r) => r.buf.length === rofs.CHUNK));
    });

    await t('textbuf: binary, hex, levels, filter, ASCII only, long lines cut', async () => {
        assert(TB.isBinary(fs.readFileSync(path.join(FX, 'bin.dat'))));
        assert(!TB.isBinary(Buffer.from('hello\tworld\n')));
        assert(/^00000000  00 01 02 03 ff 00 41 42 .*\|\.\.\.\.\.\.AB\|$/.test(TB.hexLines(Buffer.from([0, 1, 2, 3, 255, 0, 65, 66]), 0)[0]));
        assert.deepStrictEqual(TB.textLines(Buffer.from('a\tb\nGrüße ✓\n')), ['a    b', 'Gruesse ?']);
        assert.strictEqual(TB.textLines(Buffer.from('x\ny'), { cutHead: true })[0], '[...] x');
        assert.strictEqual(TB.textLines(Buffer.from('z'.repeat(700))).length, 3);
        assert.strictEqual(TB.level('2026 FATAL uncaught: boom'), 'bad');
        assert.strictEqual(TB.level('2026 WARN render: x'), 'warn');
        assert.strictEqual(TB.level('2026 INFO all fine'), '');
        const f = TB.filterLines(['INFO a', 'ERROR b', '    at c (x.js)', 'INFO d', 'WARN e']);
        assert.deepStrictEqual(f.map((x) => x.i), [1, 2, 4]);
    });

    await t('qrpage: pages fit the capacity, continue where the last ended', async () => {
        const lines = big.slice(0, 200);
        const p1 = QR.build(lines, 0, 15, 'head');
        assert(p1.n > 3 && Buffer.byteLength(p1.text) <= require(path.join(KIT, 'qr')).capacity(15, 'L'));
        const p2 = QR.build(lines, p1.end, 15, 'head');
        assert.strictEqual(p2.start, p1.end);
        const long = QR.build(['y'.repeat(5000)], 0, 15, 'h');
        assert.strictEqual(long.end, 1);
    });

    await t('sysinfo: rows, findLogs on a fake oap root', async () => {
        const g = await sysinfo.gather({ dataDir: FX });
        assert(g.rows.find((r) => r[0] === 'USER'));
        const root = path.join(FX, 'oap');
        fs.mkdirSync(root); fs.mkdirSync(path.join(root, 'oap_1')); fs.mkdirSync(path.join(root, 'oap_1', 'data'));
        fs.writeFileSync(path.join(root, 'oap_1', 'data', 'ags_control.log'), 'x\n');
        fs.writeFileSync(path.join(root, 'oap_1', 'data', 'ags_control.log.1'), 'y\n');
        fs.writeFileSync(path.join(root, 'oap_1', 'data', 'settings.json'), '{}');
        fs.mkdirSync(path.join(root, 'oap_2'));
        const r = await sysinfo.findLogs({ root });
        assert.strictEqual(r.error, null);
        assert.deepStrictEqual(r.logs.filter((l) => !l.error).map((l) => l.name).sort(), ['ags_control.log', 'ags_control.log.1']);
        assert(r.logs.some((l) => l.error === 'missing'), 'oap_2 without data shown as error');
    });

    await t('model: navigate, hidden files, open log at the end, older/newer, issues, QR, back', async () => {
        const s = { hidden: 'show' };
        const m = new Explorer({ rofs, sysinfo: Object.assign({}, sysinfo, { findLogs: async () => ({ error: null, logs: [] }), gather: async () => ({ rows: [] }) }), settings: { get: (k) => s[k] }, dataDir: FX });
        await m.start(FX);
        let names = m.rows().map((r) => r.title);
        assert.strictEqual(names[0], '..'); assert(names.indexOf('.hidden') > 0);
        s.hidden = 'hide';
        assert(m.rows().every((r) => r.title !== '.hidden'));
        await m.rows().find((r) => r.title === 'sub').run();
        assert.strictEqual(m.cwd, path.join(FX, 'sub'));
        await m.back();
        assert.strictEqual(m.cwd, FX);
        m.textRows = 10;
        await m.openFile(path.join(FX, 'app.log'));
        const v = m.viewer;
        assert(v && !v.err && v.eof && v.off > 0, 'tail window');
        assert.strictEqual(v.top, m.shown().length - 10, 'at the end');
        assert(/at Foo/.test(m.shown()[m.shown().length - 1]));
        m.toggleFilter();
        assert(v.filter && m.shown().some((l) => /FATAL/.test(l)) && m.shown().some((l) => /at Foo/.test(l)));
        m.toggleFilter();
        assert(m.canOlder());
        const off = v.off;
        await m.older();
        assert(m.viewer.off < off && m.canNewer());
        await m.newer();
        assert(m.viewer.off >= off - rofs.CHUNK);
        m.qrOpen(); assert(m.viewer.qr);
        m.qrNext(m.viewer.qr.start + 5); assert.strictEqual(m.viewer.qr.stack.length, 1);
        m.qrPrev(); assert.strictEqual(m.viewer.qr.stack.length, 0);
        m.back(); assert(m.viewer && !m.viewer.qr);
        m.back(); assert(!m.viewer);
        await m.up();
        assert.strictEqual(m.cwd, path.dirname(FX));
        assert.strictEqual(m.rows()[m.sel[0]].path, FX, 'up lands on the folder we came from');
    });

    await t('model: a device entry is noted, not opened; scrolling clamps', async () => {
        const m = new Explorer({ rofs, sysinfo: Object.assign({}, sysinfo, { findLogs: async () => ({ error: null, logs: [] }), gather: async () => ({ rows: [] }) }), dataDir: '/dev' });
        await m.start('/dev');
        const nul = m.rows().find((r) => r.title === 'null');
        assert.strictEqual(nul.kind, 'device');
        nul.run();
        assert(!m.viewer && /not opened/.test(m.notice.text));
        m.listRows = 5;
        assert.strictEqual(m.scroll(-3), false);
        if (m.rows().length > 5) { assert(m.scroll(2)); assert(m.scrollable(-1)); }
    });

    console.log(results.join('\n'));
    try { fs.rmSync(FX, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    const failed = results.filter((r) => r.startsWith('FAIL')).length;
    console.log(failed ? failed + ' FAILED' : 'all passed');
    process.exit(failed ? 1 : 0);
})();
