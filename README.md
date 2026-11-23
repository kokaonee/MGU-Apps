# MGU-Apps

Custom apps for BMW iDrive 7 (MGU) head units, installable via the [MGU Store](https://github.com/robertnisipeanu/mgu-store). Built on the [idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) community kit (MIT).

## Apps

| App | Version | What it does |
|---|---|---|
| [AGS Control](apps/ags_control/README.md) | 0.3.0 | Opens and closes the active grille shutters at standstill (show use), with live read-back and a telemetry log exportable as plain-text QR code. Tested on a G30 545e. |

## Install via the MGU Store

1. In the Store: **Settings → Add source** → `kokaonee/MGU-Apps`.
2. When asked what to follow, choose **Branch** → `main`.
3. **Settings → Check now**, then install the app. The Store also installs the kit's GPU renderer and controller gate the apps need.

If the original kit repository (or a fork of it) is also a source in your Store, remove it or don't install the renderer / controller gate twice: both sources ship them under the same ids.

## Repository layout

| Path | Content |
|---|---|
| `apps/<id>/` | one folder per app: `app.json` (manifest), `main.js`, modules, `README.md` |
| `kit/` | the community kit: runtime, build tools, renderer, localisation (copy, see `kit/UPSTREAM`) |
| `deploy/` | the kit's scripts to install over SSH instead of the Store |
| `mgu-repo.json` | tells the MGU Store how to build every app under `apps/` |

## Development

```sh
node kit/tools/test_ags_control.js                    # offline tests (fake DME, real diag transport)
python3 kit/tools/build.py --preview-only ags_control # build without BMW's SDK
node kit/tools/preview.js dist/ags_control out wait=3 # run it against a stubbed head unit
```

A real build needs BMW's SDK extracted from your own head unit (`kit/tools/extract_sdk.js`); it is never committed (see `.gitignore`).

## Kit updates

`kit/` and `deploy/` are a copy of the upstream kit at the commit noted in `kit/UPSTREAM`. To update, copy a newer upstream `kit/` and `deploy/` over them, keep the local additions listed there, run the tests and update the commit in `kit/UPSTREAM`.

## Licence

MIT – see [LICENSE](LICENSE). The kit is © cauliflowermossgrape and contributors; the apps in `apps/` are © kokaonee.
