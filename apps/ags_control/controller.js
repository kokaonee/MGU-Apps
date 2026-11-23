'use strict';
/**
 * controller.js - active grille shutter (AKKS, "aktive Kuehlklappensteuerung") control through the DME.
 *
 * Jobs from BMW's SGBD dme8ff_r (Bosch MG1 / DME8, B48/B58), table SG_FUNKTIONEN:
 *   AKKS_1  0x6013  2F  active cooling flap 1 (upper, LIN)  arg SW_AKKS_1  signed int, %, 0..100
 *   AKKS_2  0x6014  2F  active cooling flap 2 (lower, LIN)  arg SW_AKKS_2  signed int, %, 0..100
 *   ASW_AKKS_1/2  0x6213/0x6214  22  tester set-point (%)
 *   ASG_AKKS_1/2  0x6413/0x6414  22  output value (steps)
 *   AKKS_STATUS   0x4AD2         22  bits: 0 variant present, 1 closed, 2 open, 7 external control active
 *   I_AKKS_ISTPOS 0x58D3         22  actual position in degrees (x 0.5)
 * Request (STEUERN_IO): 2F <DID> 03 <hi> <lo>  (03 = shortTermAdjustment), hand back: 2F <DID> 00 (returnControlToECU).
 *
 * Modes: open | closed | oem. Show use: Open / Closed only at standstill (<= 3 km/h); driving off hands back (OEM).
 * (The DME accepts the override only up to ~5 km/h and ends it above - measured on a G30 545e.)
 * Safety: setting "arm" = off -> simulated only, nothing reaches the car. "closed" is handed back to the DME
 * above the coolant limit (or without a coolant value). The DME ends a tester override by itself after a
 * while -> "hold" re-sends periodically.
 */
const EventEmitter = require('events');
const { Diag, hex, NRC, replyTo } = require('./kit/diag');
const { TLog } = require('./tlog');

const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const CDS = 'de.bmw.infotainment.vehicle.CDS';
const VEH2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const VINFO = 'de.bmw.infrastructure.VehicleInformation';
// selector position (as in kit/car.js): names or wire numbers
const STAGE = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };
const SEL = { N: 'N', R: 'R', P: 'P', 1: 'N', 2: 'R', 3: 'P' };   // DataPowerTrain2: _1.._9 / 5..13 = D
for (let i = 1; i <= 9; i++) { SEL['_' + i] = 'D'; SEL[4 + i] = 'D'; }

const MODES = ['open', 'closed', 'oem'];
// Show use only: the DME accepts a tester override up to ~5 km/h and drops it above (measured on a G30 545e)
const STAND_MAX_KMH = 3;
const DRIVE_KEYS = ['sport', 'sportplus', 'sportind', 'adaptive', 'hybrid', 'electric', 'comfort', 'eco'];
const COOL_HYST = 5;           // K below the limit before "closed" applies again
const ERROR_BACKOFF_MS = 5000;
const QUICK_RETRY_MS = 300;      // a refused send is retried this fast ...
const QUICK_RETRIES = 5;
const COND_RETRY_MS = 2000;      // NRC 22 (conditions not correct, e.g. while driving): keep retrying this often, never hand back         // ... this many times before the flaps are handed back (G30 545e: the DME refuses ~every 60 s)
const TICK_MS = 500;
const SMART_CHECK_MS = 1000;     // smart hold: read-only check of the override this often (one 22 read)
const FAST_CHECK_MS = 250;       // ... and this often around a predicted takeover
const FAST_BEFORE_MS = 3000;     // fast window opens this long before the predicted takeover
const FAST_AFTER_MS = 4000;      // ... and closes this long after it
const PERIOD_MIN_MS = 30000;     // takeover intervals in this range count as a rhythm
const PERIOD_MAX_MS = 90000;     // (G30 545e: the DME drops the override every ~60 s; longer gaps = missed takeovers)
const SMART_MAX_MS = 6000;       // smart hold: refresh at the latest after this (G30 545e: DME dropped it after 8-13 s)

// actualValueModeDrivingExperience: wire number / name -> group (values from the kit apps ambient_config / live_adjustments)
const FES_NUM = {
    // G30 545e reports: Sport 15, Sport Plus 2 (coded), Sport Individual 16, Adaptive 10, Hybrid 17/18, Electric 20/21
    1: 'sport', 2: 'sportplus', 3: 'sportind', 4: 'comfort', 5: 'comfort', 6: 'comfort', 7: 'eco', 8: 'eco', 9: 'eco', 10: 'adaptive',
    15: 'sport', 16: 'sportind', 23: 'sportplus', 28: 'sportplus', 17: 'hybrid', 18: 'hybrid', 19: 'hybrid', 20: 'electric', 21: 'electric',
};
const FES_NAME = {
    SPORT_DYNAMIC: 1, SPORT_EXPERT: 2, SPORT_INDIVIDUAL: 3, COMFORT: 4, COMFORT_PLUS: 5, COMFORT_INDIVIDUAL: 6,
    ECO_PRO_EFFICIENT: 7, ECO_PRO_PLUS: 8, ECO_PRO_INDIVIDUAL: 9, ADAPTIVE: 10, PHEV_SPORT_STANDARD: 15, PHEV_SPORT_INDIVIDUAL: 16,
    PHEV_HYBRID_STANDARD: 17, PHEV_HYBRID_ECO: 18, PHEV_HYBRID_COMFORT: 19, PHEV_ELECTRIC_STANDARD: 20, PHEV_ELECTRIC_INDIVIDUAL: 21,
    PHEV_SPORT_PLUS: 23, BOOST: 28,
};

const FES_SHORT = {
    PHEV_SPORT_STANDARD: 'Sport', SPORT_EXPERT: 'Sport+', PHEV_SPORT_INDIVIDUAL: 'SportInd', PHEV_SPORT_PLUS: 'Sport+',
    ADAPTIVE: 'Adapt', PHEV_HYBRID_STANDARD: 'Hybrid', PHEV_HYBRID_ECO: 'HybEco', PHEV_HYBRID_COMFORT: 'HybCom',
    PHEV_ELECTRIC_STANDARD: 'Elec', PHEV_ELECTRIC_INDIVIDUAL: 'ElecInd', BOOST: 'Boost',
};
/** Short name of a raw driving mode for the log / screen. */
function fesShort(raw) {
    if (raw === undefined || raw === null) return '-';
    const s = String(raw);
    return FES_SHORT[s.toUpperCase()] || s.slice(0, 10);
}

function fesGroup(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    const s = String(raw).trim();
    const n = /^\d+$/.test(s) ? Number(s) : FES_NAME[s.toUpperCase()];
    if (n !== undefined) return FES_NUM[n] || null;
    const w = s.toUpperCase();
    if (/ADAPTIV/.test(w)) return 'adaptive';
    if (/ELECTRIC|ELEKTR/.test(w)) return 'electric';
    if (/ECO/.test(w)) return 'eco';
    if (/HYBRID/.test(w)) return 'hybrid';
    if (/SPORT/.test(w) && /INDIVIDUAL/.test(w)) return 'sportind';
    if (/PLUS|EXPERT|BOOST/.test(w)) return 'sportplus';
    if (/SPORT/.test(w)) return 'sport';
    if (/COMFORT/.test(w)) return 'comfort';
    return null;
}

const hexBytes = (b) => (b || []).map((x) => hex(x)).join(' ');
const didOf = (s) => { const n = typeof s === 'number' ? s : parseInt(String(s), 16); return [(n >> 8) & 0xFF, n & 0xFF]; };
const u16 = (d, i) => (d && d.length >= i + 2 ? (d[i] << 8) | d[i + 1] : null);
const s16 = (d, i) => { const v = u16(d, i); return v === null ? null : (v & 0x8000 ? v - 0x10000 : v); };

function config(spec) {
    const c = Object.assign({
        ecu: '12',
        flaps: [
            { id: 'upper', name: 'upper', ctrl: '6013', asw: '6213', asg: '6413' },
            { id: 'lower', name: 'lower', ctrl: '6014', asw: '6214', asg: '6414' },
        ],
        variable: { id: 'both', name: 'both', ctrl: '610C', asw: '630C', asg: '650C' },   // VARIABLE_AKKS: both flaps in one job
        openPct: 100,
        closedPct: 0,
        statusDid: '4AD2',
        posDid: '58D3',
        openDeg: 80,            // read-back: at or above = OPEN (end stop measured 83.5)
        closedDeg: 3,           // read-back: at or below = CLOSED
        session: null,          // e.g. "03": send 10 03 before each override (only if the DME answers 7F 2F 7F/22)
        requireProbe: true,     // only control when the DME answers the AKKS DIDs
    }, (spec && spec.config) || {});
    c.ecuAddr = parseInt(String(c.ecu), 16);
    return c;
}

class Ags extends EventEmitter {
    /** o: { settings, signals, log, spec, now? } */
    constructor(o) {
        super();
        this.settings = o.settings;
        this.signals = o.signals;
        this.log = o.log;
        this.cfg = config(o.spec);
        this.now = o.now || Date.now;
        this.tlog = o.tlog || new TLog(null);
        this.version = (o.spec && o.spec.version) || '?';
        this.lastAsw = null;
        this.diag = null;
        this.link = false;
        this.probe = { done: false, present: false, detail: 'not checked yet' };
        this.fesRaw = null;
        this.coolant = null;
        this.coolantAt = 0;
        this.speed = null;
        this.notice = null;          // short message for the screen (e.g. 'Only at standstill')
        this.rpm = null;             // engine rpm (0 = engine off; a hybrid's run-down value below 400 counts as off)
        this.stage = null;           // selector P / R / N / D
        this.refused = null;         // { since, speed, count } while the DME answers NRC 22
        this.sent = 'oem';           // last sent (or simulated)
        this.sentAt = 0;
        this.coolBlocked = false;
        this.lastError = null;
        this.errorUntil = 0;
        this.errCount = 0;
        this.realOverride = false;   // a real 2F override is still active in the DME
        this.overridden = new Set(); // flap ids with an active override
        this._pending = false;
        this._again = false;
        this.readback = null;
        this.errLog = [];            // last failures with time, kept for the screen
        this.sendCount = 0;          // real 2F sends (for the screen)
        this.appliedEff = null;      // last state that got a full read-back
        this.sentClock = null;
        this.lastCheck = 0;
        this.lostNote = null;        // e.g. 'DME took over after 31 s'
        this.lostLog = [];           // last takeovers: { after, why, at }
        this.takeoverTimes = [];     // absolute times of takeovers, to learn the DME's rhythm
        this._q = Promise.resolve();
        this._busy = false;
        this._timer = null;
        this._fesSeen = [];
    }

    /* ------------------------------------------------------------------ Settings */
    get mode() { const m = this.settings.get('mode'); return MODES.indexOf(m) >= 0 ? m : 'oem'; }
    get armed() { return this.settings.get('arm') === 'on'; }
    get smartHold() { const h = this.settings.get('hold'); return h === undefined || h === 'smart'; }
    get holdMs() { if (this.smartHold) return SMART_MAX_MS; const v = Number(this.settings.get('hold')); return v > 0 ? v * 1000 : 0; }
    get coolLimit() { const v = Number(this.settings.get('coolLimit')); return v > 0 ? v : null; }
    get job() { return this.settings.get('job') === 'variable' ? 'variable' : 'akks'; }
    /** all flap jobs of the chosen control job */
    get jobFlaps() { return this.job === 'variable' ? [this.cfg.variable] : this.cfg.flaps; }
    /** the selected ones of them (upper / lower / both; VARIABLE_AKKS is always both) */
    get flaps() {
        if (this.job === 'variable') return this.jobFlaps;
        const sel = this.settings.get('flaps') || 'both';
        return this.cfg.flaps.filter((f) => sel === 'both' || sel === f.id);
    }
    /** every flap job of both kinds, for handing back */
    get everyFlap() { return this.cfg.flaps.concat([this.cfg.variable]); }

    /* ------------------------------------------------------------------ Start */
    async start() {
        this.diag = await new Diag(this.signals, this.log).init();
        this.diag.quiet = true;
        this.link = !!this.diag.available;
        this.diag.on('available', (on) => {
            const was = this.link;
            this.link = !!on;
            if (this.link && !was) {
                this.log.info('diagnostic link up');
                this._t('link up');
                this.sent = 'oem';                    // the DME starts with its own strategy
                this.probe.done = false;
                this._enqueue(() => this._probe());
            }
            if (!this.link && was) this._t('link down');
            if (!this.link || !was) { this.sent = 'oem'; this.overridden.clear(); this.realOverride = false; }
            this.emit('change');
        });
        await this._watch(FES, { statusFESVehicleDynamicSwitchHMI: (v) => this._onFes(v) }, 'driving mode');
        await this._watch(CDS, { statusEngineTemperature: (v) => this._onTemp(v) }, 'coolant');
        await this._watch(VEH2, { statusCarSpeed2: (v) => this._onSpeed(v) }, 'speed');
        await this._watch(CDS, { statusEngineSpeed2: (v) => this._onRpm(v) }, 'rpm');
        await this._watch(VINFO, {
            statusGearboxDrive: (v) => { const st = STAGE[v && v.statusActualStageDrive]; if (st) this.stage = st; },
            DataPowerTrain2: (v) => { const st = SEL[v && v.statusGearSelectionDrive]; if (st) this.stage = st; },
        }, 'gear');
        if (this.settings.onChange) this.settings.onChange((k) => { if (k === 'arm' || k === 'flaps' || k === 'job') { this.sent = '?'; this.errorUntil = 0; } if (k === 'job') this._t('job ' + (this.job === 'variable' ? 'VARIABLE_AKKS' : 'AKKS_1/2')); this.kick(); });
        if (this.link) await this._enqueue(() => this._probe());
        this._timer = setInterval(() => this.kick(), TICK_MS);
        this._snapTimer = setInterval(() => this._snapshot(), 30000);
        this._t('start v' + this.version + ' ' + this.mode.toUpperCase() + (this.job === 'variable' ? ' VAR' : '') + (this.armed ? '' : ' SIM'));
        this.emit('change');
        return this;
    }

    async _watch(iface, handlers, what) {
        try {
            const r = await this.signals.watch(iface, '1', handlers, this.log);
            if (r && r.error) this.log.warn(what + ': ' + r.error);
        } catch (e) { this.log.warn(what + ': ' + e); }
    }

    stop() { clearInterval(this._timer); clearInterval(this._snapTimer); this._timer = null; }

    _t(text) { try { this.tlog.add(text); } catch (e) { /* never break control for the log */ } }

    _spd() { return this.speed === null ? '?' : Math.round(this.speed); }

    /** every 30 s: speed, coolant, driving mode, what is sent, set-point, sends */
    _snapshot() {
        if (!this.link) return;
        const st = this.refused ? 'REF' : this.sent === '?' ? 'RETRY' : String(this.sent).toUpperCase();
        this._t(this._cond() + ' c' + (this.coolantValid() ? this.coolant : '?') + ' ' + fesShort(this.fesRaw) +
            ' ' + st + (this.lastAsw === null ? '' : ' sp' + this.lastAsw) + ' tx' + this.sendCount);
    }

    /* ------------------------------------------------------------------ Signals */
    _onFes(v) {
        const raw = v && typeof v === 'object' ? v.actualValueModeDrivingExperience : v;
        if (this._fesSeen.length < 30 && this._fesSeen.indexOf(String(raw)) < 0) { this._fesSeen.push(String(raw)); this.log.info('driving mode raw: ' + raw); }
        if (String(raw) === String(this.fesRaw)) return;
        this.fesRaw = raw;
        this._t('fes ' + fesShort(raw) + (this.mode === 'drive' ? ' -> ' + this.wanted().toUpperCase() : ''));
        this.kick();
        this.emit('change');
    }

    _onTemp(v) {
        const raw = v && typeof v === 'object' ? v.temperatureEngineDrive : v;
        const n = Number(raw);
        if (!isFinite(n) || n >= 255 || n < 0) return;       // 0xFF = invalid
        this.coolant = n - 48;
        this.coolantAt = this.now();
    }

    _onSpeed(v) {
        const raw = v && typeof v === 'object' ? v.speedVehicleCentreOfGravity : v;
        const n = Number(raw);
        if (!isFinite(n) || n >= 0xFFFF || n < 0) return;
        this.speed = n * 0.015625;
        if (this.mode !== 'oem' && this.speed > STAND_MAX_KMH) {
            // driving off: hand the shutters back to the DME and stay on OEM (nothing re-opens at the next stop)
            this._t('drove off ' + this._cond() + ' -> OEM');
            this._notice('Drove off: back to OEM');
            this.settings.set('mode', 'oem');
            this.sent = '?';
            this.errorUntil = 0;
            this.kick();
        }
    }

    _onRpm(v) {
        const raw = v && typeof v === 'object' ? v.actualValueRPMEngineCrankshaft : v;
        const n = Number(raw);
        if (!isFinite(n) || n >= 65535 || n < 0) return;
        const rpm = n * 0.25;
        this.rpm = rpm < 400 ? 0 : Math.round(rpm);
    }

    /** "v12 n1500 D": speed, engine rpm, selector, for the log */
    _cond() { return 'v' + this._spd() + ' n' + (this.rpm === null ? '?' : this.rpm) + ' ' + (this.stage || '?'); }

    coolantValid() { return this.coolant !== null && this.now() - this.coolantAt < 10000; }
    driveGroup() { return fesGroup(this.fesRaw); }

    /* ------------------------------------------------------------------ Logic */
    /** What the mode asks for (before the coolant guard). */
    wanted() { return this.mode; }

    /** standstill (speed known and at most 3 km/h): the only time Open / Closed are allowed */
    standing() { return this.speed !== null && this.speed <= STAND_MAX_KMH; }

    _notice(text) { this.notice = { at: this.now(), text }; this.emit('change'); }

    /** What goes to the car: closed becomes oem when hot / without a coolant value. */
    effective() {
        const w = this.wanted();
        if (w !== 'closed') { this.coolBlocked = false; return w; }
        const lim = this.coolLimit;
        if (!lim) { this.coolBlocked = false; return 'closed'; }
        if (!this.coolantValid()) { this.coolBlocked = true; return 'oem'; }
        if (this.coolBlocked) { if (this.coolant < lim - COOL_HYST) { this.coolBlocked = false; this._t('CLOSED allowed again c' + this.coolant); } }
        else if (this.coolant >= lim) { this.coolBlocked = true; this.log.info('closed paused: coolant ' + this.coolant + ' C'); this._t('CLOSED paused c' + this.coolant); }
        return this.coolBlocked ? 'oem' : 'closed';
    }

    setMode(m) {
        if (MODES.indexOf(m) < 0) return Promise.resolve();
        if (m !== 'oem' && !this.standing()) {
            this._notice('Only at standstill (' + (this.speed === null ? 'no speed signal' : Math.round(this.speed) + ' km/h') + ')');
            this._t(m + ' ignored ' + this._cond());
            return Promise.resolve();
        }
        this.errorUntil = 0;
        this.sent = '?';                              // a button press always sends
        if (m !== this.mode) this._t('mode ' + m.toUpperCase());
        this.settings.set('mode', m);
        return this.kick();
    }

    kick() {
        if (this._pending) { this._again = true; return this._q; }
        const eff = this.effective();
        const now = this.now();
        if (now < this.errorUntil) return this._q;
        const resend = eff !== 'oem' && this.armed && this.holdMs && now - this.sentAt >= this.holdMs;
        if (eff === this.sent && !resend) {
            if (this.smartHold && this.armed && this.link && this.overridden.size && now - this.lastCheck >= (this.inFastWindow(now) ? FAST_CHECK_MS : SMART_CHECK_MS) && now - this.sentAt >= 500) {
                this.lastCheck = now;
                return this._enqueue(() => this._check(eff));
            }
            return this._q;
        }
        return this._enqueue(() => this._apply(eff));
    }

    _enqueue(fn) {
        this._pending = true;
        this._q = this._q.then(async () => { this._busy = true; try { await fn(); } finally { this._busy = false; } })
            .catch((e) => { this.log.error('ags: ' + (e && e.stack || e)); })
            .then(() => {
                this._pending = false;
                this.emit('change');
                if (this._again) { this._again = false; setImmediate(() => this.kick()); }
            });
        return this._q;
    }

    async _apply(eff) {
        const flaps = this.flaps;
        if (!this.armed) {
            if (this.realOverride && this.link) await this._releaseAll('disarmed');
            if (eff !== this.sent) this.log.info('SIMULATED: ' + eff + ' (' + flaps.map((f) => f.name).join('+') + ')');
            this.sent = eff; this.sentAt = this.now(); this.lastError = null;
            return;
        }
        if (!this.link) { this.lastError = 'no diagnostic link'; return; }
        if (!this.probe.done || !this.probe.present) await this._probe();
        if (this.cfg.requireProbe && !this.probe.present) {
            this.lastError = 'DME does not answer AKKS: ' + this.probe.detail;
            this._logError(this.lastError);
            this.errorUntil = this.now() + ERROR_BACKOFF_MS * 6;
            return;
        }
        if (eff !== 'oem' && this.cfg.session) await this._req(0x10, [parseInt(String(this.cfg.session), 16) & 0xFF], 'Session');

        // hand back flaps that are not (or no longer) selected
        // flaps of the other job (after a job switch) are handed back too
        const all = this.everyFlap;
        const errors = [];
        const nrcs = [];
        for (const f of all) {
            const on = flaps.indexOf(f) >= 0;
            const d = didOf(f.ctrl);
            let data;
            if (!on || eff === 'oem') data = d.concat([0x00]);
            else {
                const pct = Math.max(0, Math.min(100, Math.round(eff === 'open' ? this.cfg.openPct : this.cfg.closedPct)));
                data = d.concat([0x03, (pct >> 8) & 0xFF, pct & 0xFF]);
            }
            // never overridden: no hand back (a flap of the other job only when it was overridden)
            if (data[2] === 0x00 && !this.overridden.has(f.id) && (eff !== 'oem' || this.jobFlaps.indexOf(f) < 0)) continue;
            const r = await this._req(0x2F, data, 'flap ' + f.name);
            if (!r.ok) { errors.push(f.name + ': ' + r.reason); nrcs.push(r.nrc); }
            else if (data[2] === 0x03) this.overridden.add(f.id);
            else this.overridden.delete(f.id);
        }
        const spd = this.speed === null ? '?' : Math.round(this.speed);
        if (errors.length && nrcs.every((n) => n === 0x22)) {
            // the DME says "conditions not correct" (seen while driving): nothing of ours is active, so nothing to hand back
            this.errCount++;
            this.errTotal = (this.errTotal || 0) + 1;
            const r0 = this.refused;
            if (!r0) this._t('REFUSED NRC22 ' + this._cond() + ' ' + eff.toUpperCase());
            const v = this.speed === null ? null : Math.round(this.speed);
            this.refused = {
                since: (r0 && r0.since) || this.now(), speed: this.speed, count: ((r0 && r0.count) || 0) + 1,
                vmin: v === null ? (r0 && r0.vmin) : Math.min(v, r0 && r0.vmin !== undefined && r0.vmin !== null ? r0.vmin : v),
                vmax: v === null ? (r0 && r0.vmax) : Math.max(v, r0 && r0.vmax !== undefined && r0.vmax !== null ? r0.vmax : v),
            };
            this.lastError = 'DME refuses (NRC 22 conditions not correct) at ' + spd + ' km/h';
            this._logError(eff + ': NRC 22 at ' + spd + ' km/h' + (this.refused.count > 1 ? ' (try ' + this.refused.count + ')' : ''));
            this.log.warn('ags ' + eff + ' refused (NRC 22) at ' + spd + ' km/h');
            this.errorUntil = this.now() + (this.errCount <= QUICK_RETRIES ? QUICK_RETRY_MS : COND_RETRY_MS);
            this.sent = '?';
            return;
        }
        if (errors.length) {
            this.errCount++;
            this.errTotal = (this.errTotal || 0) + 1;
            this.lastError = errors.join(', ');
            this._logError(eff + ': ' + this.lastError + (this.errCount > 1 ? ' (try ' + this.errCount + ')' : ''));
            this.log.warn('ags ' + eff + ' failed (' + this.errCount + '): ' + this.lastError);
            this._t('ERR ' + eff + ' ' + errors[0].replace(/ \w+$/, '') + ' v' + spd);
            if (this.errCount <= QUICK_RETRIES) {
                // a single refusal (the DME's periodic routine) must not move the flaps: keep what is set, retry fast
                this.errorUntil = this.now() + QUICK_RETRY_MS;
                this.sent = '?';
                return;
            }
            // refused again and again: hand everything back and back off
            this.errorUntil = this.now() + Math.min(60000, ERROR_BACKOFF_MS * Math.pow(2, this.errCount - QUICK_RETRIES - 1));
            if (eff !== 'oem') await this._releaseAll('error');
            this.sent = 'oem';
            return;
        }
        if (eff !== this.sent) this.log.info('sent: ' + eff);
        this.realOverride = this.overridden.size > 0;
        if (this.refused) {
            this.log.info('accepted again at ' + spd + ' km/h after ' + this.refused.count + ' refusals');
            this._t('accepted ' + this._cond() + ' ' + this.refused.count + 'x v' + this.refused.vmin + '-' + this.refused.vmax);
        }
        this.refused = null;
        this.errCount = 0;
        this.sent = eff; this.sentAt = this.now(); this.lastError = null;
        if (eff !== 'oem') { this.sendCount++; this.sentClock = this._clock(); }
        // full read-back (6 reads) only when the state changes; on refreshes it would block the 1 s check and the next refresh
        const changed = eff !== this.appliedEff;
        this.appliedEff = eff;
        if (changed) this._t('sent ' + eff.toUpperCase() + ' ' + this._cond());
        if (changed) setTimeout(() => this._enqueue(() => this._read()), 1500);
    }

    _clock() {
        const d = new Date(this.now());
        return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
    }

    /** Smart hold: read only. Re-send only when the DME has dropped our override. */
    async _check(eff) {
        if (this.sent !== eff || eff === 'oem') return;
        const want = eff === 'open' ? this.cfg.openPct : this.cfg.closedPct;
        // the DME resets the tester set-point (ASW) to 0 when it takes over: one read of the first overridden flap is enough
        let lost = null;
        const f = this.everyFlap.find((x) => this.overridden.has(x.id));
        if (!f) return;
        const a = await this._readDid(f.asw, 1200);
        const pct = a.ok ? s16(a.data, 0) : null;
        if (pct !== null) this.lastAsw = pct;
        if (pct !== null && pct !== want) lost = f.name + ' set-point ' + pct + '%';
        if (!lost) return;
        const after = Math.round((this.now() - this.sentAt) / 1000);
        this.lostNote = 'DME took over after ' + after + ' s (' + lost + ')';
        this.lostLog.push({ after, why: lost, at: this.now() });
        this.takeoverTimes.push(this.now());
        if (this.takeoverTimes.length > 8) this.takeoverTimes.shift();
        if (this.lostLog.length > 6) this.lostLog.shift();
        this.log.info(this.lostNote);
        this._t('takeover +' + after + 's ' + this._cond() + ' ' + lost.replace(/^\w+ set-point /, 'sp'));
        this.sent = '?';
        setImmediate(() => this.kick());
    }

    /** Rhythm of the DME's takeovers in ms (median of recent intervals in range), or null. */
    period() {
        const t = this.takeoverTimes, iv = [];
        for (let i = 1; i < t.length; i++) {
            const d = t[i] - t[i - 1];
            if (d >= PERIOD_MIN_MS && d <= PERIOD_MAX_MS) iv.push(d);
            else if (d > PERIOD_MAX_MS) {           // a missed takeover in between: fold it back into the rhythm
                const n = Math.round(d / 60000);
                if (n >= 2 && Math.abs(d / n - 60000) < 5000) iv.push(d / n);
            }
        }
        if (!iv.length) return null;
        iv.sort((a, b) => a - b);
        const m = iv.length >> 1;
        return iv.length % 2 ? iv[m] : (iv[m - 1] + iv[m]) / 2;
    }

    /** Next predicted takeover (absolute ms), or null. */
    nextTakeover(now) {
        const p = this.period();
        if (!p) return null;
        let next = this.takeoverTimes[this.takeoverTimes.length - 1] + p;
        while (next < now - FAST_AFTER_MS) next += p;
        return next;
    }

    inFastWindow(now) {
        const next = this.nextTakeover(now);
        return next !== null && now >= next - FAST_BEFORE_MS && now <= next + FAST_AFTER_MS;
    }

    _logError(msg) {
        const t = this._clock();
        this.errLog.push({ t, msg });
        if (this.errLog.length > 5) this.errLog.shift();
    }

    /** One request to the DME. -> { ok, data, reason } */
    async _req(sid, data, what, timeoutMs) {
        try {
            // reads run every second (smart hold): only writes go to the kit's log, to keep it small on the head unit
            if (sid !== 0x22) this.log.info('UDS -> ' + hex(this.cfg.ecuAddr) + ' ' + hex(sid) + ' ' + hexBytes(data) + ' (' + what + ')');
            const u = await this.diag.physical(this.cfg.ecuAddr, sid, data, timeoutMs || 3000, replyTo(sid, data));
            if (!u || !u.length) return { ok: false, reason: 'timeout' };
            if (u[0] === 0x7F) return { ok: false, nrc: u[2], reason: 'NRC ' + hex(u[2]) + ' ' + (NRC[u[2]] || '') };
            if (u[0] !== sid + 0x40) return { ok: false, reason: 'unexpected ' + hexBytes(u) };
            return { ok: true, data: u.slice(1) };
        } catch (e) {
            return { ok: false, reason: String(e && e.message || e) };
        }
    }

    async _readDid(did, timeoutMs) {
        const d = didOf(did);
        const r = await this._req(0x22, d, 'read ' + did, timeoutMs);
        return r.ok ? { ok: true, data: r.data.slice(2) } : r;
    }

    /** Read only: does this DME have the AKKS jobs? */
    async _probe() {
        if (!this.link) return;
        const st = await this._readDid(this.cfg.statusDid);
        const a1 = await this._readDid(this.cfg.flaps[0].asw);
        this.probe = {
            done: true,
            present: !!(st.ok || a1.ok),
            detail: st.ok ? 'Status ' + hexBytes(st.data) : a1.ok ? 'ASW ' + hexBytes(a1.data) : (st.reason || a1.reason),
        };
        this.log.info('AKKS probe: ' + JSON.stringify(this.probe));
        this._t('probe AKKS ' + (this.probe.present ? 'ok' : 'none ' + this.probe.detail));
    }

    /** Read-back (read only). */
    readBack() { return this._enqueue(() => this._read()); }

    async _releaseAll(why) {
        this._t('hand back (' + why + ')');
        for (const f of this.everyFlap) {
            if (this.jobFlaps.indexOf(f) < 0 && !this.overridden.has(f.id)) continue;
            await this._req(0x2F, didOf(f.ctrl).concat([0x00]), why + ': hand back ' + f.name);
        }
        this.overridden.clear();
        this.realOverride = false;
    }

    async _read() {
        if (!this.link) { this.readback = { text: 'no diagnostic link' }; return; }
        const out = { at: this.now(), flaps: [] };
        const st = await this._readDid(this.cfg.statusDid);
        if (st.ok && st.data.length) {
            const b = st.data[st.data.length - 1];
            out.status = { raw: b, closed: !!(b & 0x02), open: !!(b & 0x04), external: !!(b & 0x80) };
        }
        const pos = await this._readDid(this.cfg.posDid);
        if (pos.ok) out.posDeg = u16(pos.data, 0) !== null ? u16(pos.data, 0) * 0.5 : null;
        for (const f of this.jobFlaps) {
            const a = await this._readDid(f.asw);
            const g = await this._readDid(f.asg);
            out.flaps.push({ name: f.name, testerPct: a.ok ? s16(a.data, 0) : null, steps: g.ok ? u16(g.data, 0) : null, err: !a.ok && !g.ok ? (a.reason || g.reason) : null });
        }
        const parts = [];
        // AKKS_STATUS stays 00 on the G30 545e, so the position (0 = closed, ~83.5 = open) is what counts
        if (out.posDeg !== undefined && out.posDeg !== null) parts.push((out.posDeg >= this.cfg.openDeg ? 'OPEN' : out.posDeg <= this.cfg.closedDeg ? 'CLOSED' : 'moving') + ' ' + out.posDeg + ' deg');
        if (st.ok) parts.push('status ' + hexBytes(st.data));
        out.flaps.forEach((f) => parts.push(f.name + ': ' + (f.err ? f.err : (f.testerPct !== null ? f.testerPct + '%' : '-') + (f.steps !== null ? ' / ' + f.steps + ' steps' : ''))));
        out.text = parts.join(' | ') || 'no answer';
        this._t('rb ' + (out.posDeg === undefined || out.posDeg === null ? '?' : out.posDeg) + 'deg ' + out.flaps.map((f) => f.testerPct === null ? '-' : f.testerPct).join('/') + '%');
        this.readback = out;
    }

    /* ------------------------------------------------------------------ for the screen */
    status() {
        const g = this.driveGroup();
        return {
            mode: this.mode, wanted: this.wanted(), effective: this.effective(), sent: this.sent,
            armed: this.armed, link: this.link, probe: this.probe, drive: g, fesRaw: this.fesRaw,
            coolant: this.coolantValid() ? this.coolant : null, coolBlocked: this.coolBlocked,
            speed: this.speed, error: this.lastError, readback: this.readback, refused: this.refused, standing: this.standing(),
            notice: this.notice && this.now() - this.notice.at < 10000 ? this.notice.text : null,
            tasuError: this.diag && this.diag.error,
            lastErr: this.errLog[this.errLog.length - 1] || null, errCount: this.errTotal || 0,
            sendCount: this.sendCount, sentClock: this.sentClock, lostNote: this.lostNote, smart: this.smartHold,
            sentAgo: this.sentAt ? Math.round((this.now() - this.sentAt) / 1000) : null, lostLog: this.lostLog.slice(),
            period: this.period(), nextIn: (() => { const n = this.nextTakeover(this.now()); return n === null ? null : Math.round((n - this.now()) / 1000); })(),
            fast: this.inFastWindow(this.now()),
        };
    }
}

module.exports = { Ags, fesGroup, fesShort, config, MODES, DRIVE_KEYS };
