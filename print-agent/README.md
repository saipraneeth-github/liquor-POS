# Local print agent

A tiny program for the PC that sits next to the receipt printer. The server cannot reach USB, serial or
Bluetooth printers, so the agent **pulls** print jobs from the server and prints them locally.
No dependencies: only Node 18 or newer.

## 1. Set it up (5 minutes)

1. In the web app: **Business Settings -> Edit branch -> Local print agent**.
   Tick "Print through the local agent", click **Create token**, copy it (shown once).
2. On the shop PC copy this `print-agent` folder, then `config.example.json` -> `config.json`
   and fill in `serverUrl`, `token` and your `printer` (see below).
3. Check the printer: `node agent.mjs --test` prints a test page without contacting the server.
4. Run it: `node agent.mjs`. Back in Business Settings the branch shows **Agent online**.

## 2. Printer types (`printer.type`)

| type | when | settings |
|---|---|---|
| `windows-printer` | any printer installed in Windows (USB, driver installed) | `"name": "POS-58"` (name in *Printers & scanners*) |
| `windows-share` | printer shared on this or another PC | `"share": "\\\\localhost\\POS58"` |
| `file` | serial / **Bluetooth** (paired -> gets a COM port) / Linux USB | `"path": "\\\\.\\COM3"` or `"/dev/usb/lp0"` or `"/dev/rfcomm0"` |
| `command` | Linux/macOS CUPS | `"command": "lp -d POS58 -o raw"` |
| `tcp` | LAN printer, agent PC in the same network | `"host": "192.168.1.50", "port": 9100` |
| `stdout` | debugging: shows the text instead of printing | none |

Bluetooth printers: pair the printer in the OS first; Windows shows the outgoing COM port under
*Bluetooth & devices -> More Bluetooth settings -> COM Ports*. Use that as `file` path.

## 3. Keep it running

- **Windows:** Task Scheduler -> Create Task -> trigger "At log on" (or "At startup") -> action
  `node` with arguments `D:\print-agent\agent.mjs`, tick "Run whether user is logged on or not".
  Or use NSSM: `nssm install PrintAgent "C:\Program Files\nodejs\node.exe" "D:\print-agent\agent.mjs"`.
- **Linux:** systemd unit with `ExecStart=/usr/bin/node /opt/print-agent/agent.mjs`, `Restart=always`.

## 4. Good to know

- The agent only makes outgoing HTTPS requests; no router/firewall changes.
- A job that fails is reported to the server and offered again (up to 5 attempts, then it shows in the
  Print queue card with a Retry button). If the PC is off, jobs wait and print when the agent starts.
- Rotating or deleting the token in Business Settings cuts the old agent off immediately.
- Cash drawer: bills paid in cash include the drawer-kick command; it works if the drawer is wired to the printer.
