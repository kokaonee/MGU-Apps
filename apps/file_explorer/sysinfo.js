'use strict';
/**
 * sysinfo.js - what the Info and Logs tabs show. File access only through rofs.js.
 *
 *   gather(o)   -> { rows: [[label, value, kind]], ips: [...] }   who the app runs as, its folders, the network
 *               interfaces, which places are readable. o: { dataDir }
 *   findLogs(o) -> [{ app, file, size, mtime, error }]  the kit apps' logs (<id>.log / .log.1) in every
 *               /var/opt/public/oap/oap_<uid>/data/ this process may read; o: { root }
 */
const os = require('os');
const path = require('path');
const rofs = require('./rofs');

const OAP_ROOT = '/var/opt/public/oap';
const PROBES = ['/', '/etc', '/var/log', '/var/opt/public/oap', '/var/opt', '/opt', '/tmp', '/proc/self', '/data', '/mnt'];

/** name for an id from a passwd / group file (read-only, first window only) */
async function idName(file, id) {
    try {
        const r = await rofs.read(file, { off: 0 });
        const line = r.buf.toString('utf8').split('\n').find((l) => l.split(':')[2] === String(id));
        return line ? line.split(':')[0] : null;
    } catch (e) { return null; }
}

async function gather(o) {
    const opt = o || {};
    const rows = [];
    const uid = process.getuid ? process.getuid() : null, gid = process.getgid ? process.getgid() : null;
    let user = null;
    try { user = os.userInfo().username; } catch (e) { user = await idName('/etc/passwd', uid); }
    const groups = process.getgroups ? process.getgroups() : [];
    const gnames = [];
    for (const g of groups.slice(0, 12)) { const n = await idName('/etc/group', g); gnames.push(n ? n + '(' + g + ')' : String(g)); }
    rows.push(['USER', (user || '?') + '  ·  uid ' + uid + '  ·  gid ' + gid, '']);
    rows.push(['GROUPS', gnames.join(' ') || '-', '']);
    rows.push(['PROCESS', 'pid ' + process.pid + '  ·  node ' + process.version + '  ·  ' + os.platform() + ' ' + os.arch()
        + '  ·  rss ' + Math.round(process.memoryUsage().rss / 1048576) + ' MB', '']);
    rows.push(['HOST', os.hostname() + '  ·  up ' + Math.round(os.uptime() / 60) + ' min  ·  kernel ' + os.release(), '']);
    rows.push(['FOLDERS', 'cwd ' + process.cwd() + '  ·  data ' + (opt.dataDir || '?'), '']);

    // network: the head unit's addresses (for a later HTTP export to a phone on the car's hotspot)
    const ips = [];
    const nif = os.networkInterfaces();
    Object.keys(nif).forEach((name) => (nif[name] || []).forEach((a) => {
        if (a.family === 'IPv4' || a.family === 4) ips.push(name + ' ' + a.address + (a.internal ? ' (lo)' : ''));
    }));
    rows.push(['IPV4', ips.join('  ·  ') || 'none', ips.some((x) => !/\(lo\)/.test(x)) ? 'good' : 'warn']);
    const v6 = [];
    Object.keys(nif).forEach((name) => (nif[name] || []).forEach((a) => { if (!(a.family === 'IPv4' || a.family === 4) && !a.internal) v6.push(name); }));
    if (v6.length) rows.push(['IPV6 ON', v6.filter((x, i) => v6.indexOf(x) === i).join(' '), '']);

    // which places this process may read
    const res = [];
    for (const p of PROBES) res.push([p, await rofs.canRead(p)]);
    rows.push(['READABLE', res.filter((r) => r[1] === 'yes').map((r) => r[0]).join('  ') || 'none', 'good']);
    rows.push(['NOT READABLE', res.filter((r) => r[1] !== 'yes').map((r) => r[0] + ' (' + r[1] + ')').join('  ') || 'none',
        res.some((r) => r[1] !== 'yes' && r[1] !== 'missing') ? 'warn' : '']);
    return { rows, ips };
}

async function findLogs(o) {
    const root = (o && o.root) || OAP_ROOT;
    const out = [];
    const top = await rofs.list(root);
    if (top.error) return { error: root + ': ' + top.error, logs: out };
    const dirs = top.entries.filter((e) => /^oap_/.test(e.name) && rofs.isDirish(e));
    for (const d of dirs) {
        const data = await rofs.list(path.join(d.path, 'data'));
        if (data.error) { out.push({ app: d.name, file: path.join(d.path, 'data'), error: data.error }); continue; }
        data.entries.filter((e) => /\.log(\.\d+)?$/.test(e.name) && e.type === 'file')
            .forEach((e) => out.push({ app: e.name.replace(/\.log(\.\d+)?$/, ''), dir: d.name, file: e.path, name: e.name, size: e.size, mtime: e.mtime }));
    }
    out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    return { error: null, logs: out };
}

module.exports = { gather, findLogs, OAP_ROOT };
