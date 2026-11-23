# AGS Control (iDrive 7 / MGU)

Opens and closes the active grille shutters (AKKS, upper and lower radiator shutter) through the DME – **for show use at standstill**.

The DME only accepts a tester override up to about 5 km/h and ends it above (measured on a G30 545e, see *Limits*), so controlling the shutters while driving is not possible this way. The app therefore allows Open / Closed only at standstill (≤ 3 km/h) and hands the shutters back to the DME as soon as the car drives off.

| Mode | Behaviour |
|---|---|
| **Open (standstill)** | both shutters 100 % |
| **Closed (standstill)** | both shutters 0 %; handed back to the DME above the coolant limit (default 105 °C) or when no coolant value is available |
| **OEM** | `returnControlToECU`, the DME controls the shutters as from the factory |

Pressing Open / Closed while moving (or without a speed signal) does nothing and shows *Only at standstill*. Driving off above 3 km/h hands the shutters back and switches to **OEM**; nothing re-opens by itself at the next stop.

**Hold override:** the DME ends a tester override by itself, measured on a G30 545e after 8–13 s, sometimes later; it then resets the tester set-point (ASW) to 0 %. Default **Smart** reads the upper flap's set-point every second (one `22` read), re-sends at once when it is no longer the commanded value and refreshes the override at the latest every 6 s. The full read-back runs only when the state changes, so it never blocks the check. On the G30 545e the DME also drops the override in a fixed rhythm of about 60 s, independent of the refresh; Smart learns that rhythm from the takeovers and checks every 250 ms from 3 s before to 4 s after the predicted moment, so the re-send follows within a fraction of a second. A refused send (the DME refuses a refresh about once a minute) is retried after 0.3 s up to five times without handing the flaps back; only repeated refusals hand them back to the DME. Fixed intervals (6/10/20 s) and Off are available for testing.

Runs with `autostart` in the background (confirmed with a Store install on a G30 545e), so driving off is handed back even with the app closed.

## Screen

Drawn on the canvas in the style of the kit's other apps (Engine Config), with three tabs:

| Tab | Content |
|---|---|
| **Shutters** | the front of a G30 LCI with M Sport package (`front.js`): the upper shutter behind the kidneys and double bars, the lower one behind the honeycomb of the centre intake; the louvres turn with the state, dimmed = the DME has them;, the mode in large letters, speed / coolant / position / car mode, and the **Open / Closed / OEM** buttons (selected one red; Open / Closed greyed out while moving) |
| **Status** | diagnostic link, DME answer, car mode, last send, DME takeovers, errors, read-back, **Read shutters** button |
| **Log** | the telemetry log, newest first, **Newer / Older**, **QR code** (opens the QR screen), **Clear** (press twice) |

Badges top right: `SIM` (car control off) and `MOVING`. Where the renderer does not hand the screen to the app, the HMI bar shows Open / Closed / OEM / Next page / Log list / Settings instead of the drawn buttons. `node kit/tools/preview_ags_ui.js <outDir>` renders the tabs to PNG on a PC.

## How it works

Jobs taken from BMW's own DME SGBD `dme8ff_r` (Bosch MG1, B48/B58), sent over the head unit's TASU diagnostic gateway (`kit/diag.js`) to the DME at `0x12`:

| Purpose | Request |
|---|---|
| Set upper shutter (AKKS_1) | `2F 60 13 03 <hi> <lo>` (set-point % 0–100, signed int) |
| Set lower shutter (AKKS_2) | `2F 60 14 03 <hi> <lo>` |
| Hand back to the DME | `2F 60 13 00` / `2F 60 14 00` |
| Probe / status | `22 4AD2` (bit 1 closed, bit 2 open, bit 7 external control active) |
| Read-back | `22 6213/6214` (tester set-point %), `22 6413/6414` (steps), `22 58D3` (actual position × 0.5°) |

Measured on a G30 545e: closed = 0°, 0 %, 10000 steps; open = 83.5°, 100 %, 11240/11330 steps. `AKKS_STATUS` (0x4AD2) stays `00` in both positions, so the read-back uses the position (≥ 80° OPEN, ≤ 3° CLOSED).

Everything can be changed in `app.json` → `config` (DIDs, `openPct`/`closedPct`, optional `session: "03"`).
The car's driving mode (`FES.statusFESVehicleDynamicSwitchHMI`) is only logged. A G30 545e sends names: `PHEV_SPORT_STANDARD` (Sport), `SPORT_EXPERT` (Sport Plus, coded), `PHEV_SPORT_INDIVIDUAL`, `ADAPTIVE`, `PHEV_HYBRID_STANDARD` / `PHEV_HYBRID_ECO`, `PHEV_ELECTRIC_STANDARD` / `PHEV_ELECTRIC_INDIVIDUAL`.

## Telemetry log

**Log** tab (or **Log list** in the HMI bar: 12 lines per page), newest first, kept on the head unit (`ags_log.txt` in the app's data directory, last 400 lines) so it survives a restart. Times use the **Log time zone** setting because the head unit clock runs on UTC. Lines are kept to ~55 characters:

| Entry | Meaning |
|---|---|
| `start v0.3.0 OEM` | app (re)started, e.g. by autostart (`SIM` = disarmed) |
| `fes SportInd` | the car's driving mode changed |
| `open ignored v20 n1500 D` | Open pressed while moving |
| `drove off v6 n900 D -> OEM` | car drove off: shutters handed back, mode OEM |
| `sent OPEN v0 n0 P` | state sent to the DME at 0 km/h, engine off, selector P |
| `REFUSED NRC22 v12 n1500 D OPEN` | DME refused (conditions not correct) at 12 km/h, 1500 rpm, D; logged once per refusal phase |
| `accepted v0 n0 P 32x v5-48` | accepted again, after 32 refusals between 5 and 48 km/h |
| `takeover +3s v10 n1500 D sp0%` | DME reset the set-point 3 s after the last send |
| `v48 n1500 D c82 SportInd REF sp0 tx65` | snapshot every 30 s: speed, rpm, selector, coolant, mode, state, set-point, sends |
| `rb 83.5deg 100/100%` | read-back: position, set-point upper/lower |

**QR code** on the Log tab (or *Show as QR code* on the log list) shows the log as plain-text QR codes (no compression), so a phone camera shows the lines as text that can be copied. Page 1 holds the newest lines; **Size** switches between Large (~14 lines, easiest to scan) and Medium (~25 lines); **Refresh** takes a new snapshot of the log.

## Installation

Part of [kokaonee/MGU-Apps](../../README.md), built on the community kit [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps).

**Via the MGU Store:** Settings → Add source → `kokaonee/MGU-Apps` → branch `main` → install *AGS Control*.

**Via the kit (SSH):**
```sh
python3 kit/tools/build.py ags_control
deploy/make-car-kit.sh ags_control && HU=root@<unit> KEY=~/.ssh/id_mgu deploy/push-to-car.sh install
```

Tests on a PC (fake DME, real diagnostic transport): `node kit/tools/test_ags_control.js`

## First run (required before switching to "Armed")

Out of the box **Control = Disarmed**: everything is simulated, no `2F` request reaches the car.

1. Open the app with the ignition on. Check the info line: `Link: yes`, `AKKS: ok`, a plausible coolant temperature and `Speed: 0 km/h`.
2. Press **Read shutter status**: it must return status / degrees / steps. If it returns nothing, the DME uses different DIDs – do not arm.
3. Stationary, bonnet closed: set **Armed**, then **Open** → the shutters move audibly/visibly, read-back shows `OPEN 83.5 deg` and `100%`. **Closed** → `CLOSED 0 deg`. **OEM** → set-point back to 0 %.
4. If `2F` is answered with `NRC 7F`/`22`: set `"session": "03"` in `config`, rebuild and repeat.
5. If the direction is inverted (open ↔ closed): swap `openPct`/`closedPct`.
6. Leave **Hold override** on **Smart**. Drive off: the log shows `drove off … -> OEM` and the mode is OEM.

## Limits / risks

- The app's coolant guard hands **Closed** back to the DME at the limit (5 K hysteresis). It only watches engine coolant, not the low-temperature circuit of the e-machine / power electronics.
- Improper use can set fault codes (AKKS diagnostics).
- Measured on a G30 545e over several drives (log with speed, rpm and selector): the DME accepts `2F` only up to about 5 km/h – independent of rpm and selector – refuses it above with `NRC 22 conditionsNotCorrect` and ends an accepted override 2–6 s after passing ~6 km/h. Once, with a warm engine, it also refused at 0 km/h for about two minutes.
- `VARIABLE_AKKS` (0x610C, both flaps in one job) is answered with `NRC 31 requestOutOfRange` at any speed on the G30 545e: not supported by this DME.
- With a warm engine the DME opens the shutters fully by itself while driving (OEM).

## Licence

MIT, like the kit it is built on.
