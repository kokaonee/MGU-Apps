# File Explorer

Browse the head unit's folders and read files – the apps' logs above all – right on the central display. **Strictly read-only.** Lines can be sent to a phone as plain-text QR codes (no laptop, no SSH).

Version 0.1.0 – first probe build. It also shows which user the apps run as, what they may read and the head unit's IP addresses, to plan the next steps (HTTP export to a phone on the car's hotspot).

## Tabs

| Tab | What it shows |
|---|---|
| **Files** | The folder (starts in the app's own data folder). Folders first, then files with size and date; links with their target; devices, pipes and sockets are listed but never opened. Buttons: **Up**, **Back** (folder before), **Reload**. Tap a file to open it. |
| **Logs** | Every kit app's log (`<id>.log`, `<id>.log.1`) under `/var/opt/public/oap/oap_<uid>/data/` this app may read, newest first; folders it may not read are marked. Below: quick places (this app's data, all OAP apps, `/tmp`, `/var/log`, `/proc/self`, `/`). |
| **Info** | User, uid / gid and groups of the app's process, Node version, host, folders, IPv4 addresses per interface, which places are readable and which not. |

## Viewer

- Files are read in **windows of 64 KB**. Logs and every other file open at the **end** (newest lines). **Older** / **Newer** move one window, **End** jumps back to the end.
- `FATAL`, `ERROR`, `uncaught` and similar lines are red, `WARN` lines amber.
- **Issues** shows only the red / amber lines plus the stack lines (`at ...`) right after them.
- Binary files are shown as hex.
- **QR** turns the shown lines (all, or only the issues) into a plain-text QR code, starting at the top line on screen. **Next** / **Prev** go through the following lines, **Size** switches Large (easier to scan) / Medium (more lines). The phone camera shows the text; copy it and send it on.

Scroll by dragging the list or text, or with the controller. Where the kit does not run the screen, the HMI bar has Up / Down / Open / Back / Next page / QR code instead.

## Read-only, and safe to read

- All file access is in one module, `rofs.js`: `readdir`, `lstat`, `stat`, `readlink`, `realpath`, `open` with `'r'`, `read`, `close` – nothing else, no `child_process`. The tests check the app's sources for this.
- Only regular files are opened; devices, pipes and sockets are refused before any open.
- At most 64 KB per read, one file at a time, every call with a 3 s timeout. A path that timed out (some `/proc` and `/sys` files can block) is not opened again until the app restarts.
- No recursion, so link loops can't hang anything. Folders with more than 3000 entries show the first 3000.
- The app writes nothing of its own. Only the kit itself keeps its usual `file_explorer.log` and `settings.json` in the app's data folder.

## Settings

| Setting | Values |
|---|---|
| Hidden files (.name) | Show (default) / Hide |
| Text size | Normal / Large |
| Time zone (file times) | UTC / UTC+1 / UTC+2 (the head unit clock runs on UTC) |

## Development

```sh
node kit/tools/test_file_explorer.js                    # offline tests (rofs, viewer, QR, model, read-only rule)
node kit/tools/preview_file_explorer_ui.js out          # the pages as PNGs, as the GPU renderer draws them
python3 kit/tools/build.py --preview-only file_explorer
node kit/tools/preview.js dist/file_explorer out wait=2 render BTN_PAGE render
```

## Open questions (to check on the car)

- Which user OAP apps run as and what they may read (Info tab).
- Where Waze on Cluster and cluster-render log.
- Whether a phone on the car's Wi-Fi hotspot can reach the head unit (Info tab: IPv4 per interface) – the base for a later download of whole files.
