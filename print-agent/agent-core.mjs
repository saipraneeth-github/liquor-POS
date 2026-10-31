// print-agent/agent-core.mjs
// The heart of the local print agent. Zero dependencies (Node 18+). It polls the server for print jobs of
// one branch and delivers the raw ESC/POS bytes to a printer attached to this PC: USB, serial, Bluetooth
// (as a COM port), a Windows printer / share, a CUPS printer, or a LAN printer.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ─── CONFIG ─────────────────────────────────────────────────────────────────

export function loadConfig(file) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!cfg.serverUrl) throw new Error('config: "serverUrl" is required');
  if (!cfg.token || !String(cfg.token).startsWith('pa_')) throw new Error('config: "token" is required (create it in Business Settings -> branch -> Local print agent)');
  if (!cfg.printer?.type) throw new Error('config: "printer.type" is required');
  return { pollIntervalMs: 3000, ...cfg, serverUrl: String(cfg.serverUrl).replace(/\/+$/, '') };
}

// ─── SERVER API ─────────────────────────────────────────────────────────────

async function api(cfg, method, route, body) {
  const res = await fetch(`${cfg.serverUrl}/api/v1${route}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export const fetchJobs = (cfg, limit = 5) => api(cfg, 'GET', `/agent/jobs?limit=${limit}`);
export const ackJob = (cfg, id, ok, error) => api(cfg, 'POST', `/agent/jobs/${id}/ack`, { ok, ...(error ? { error } : {}) });

// ─── PRINTERS ───────────────────────────────────────────────────────────────

function sendTcp({ host, port = 9100 }, bytes) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error(`printer ${host}:${port} timed out`)); });
    socket.once('error', reject);
    socket.once('connect', () => socket.write(bytes, (err) => (err ? reject(err) : socket.end())));
    socket.once('close', resolve);
  });
}

/** Run a command and feed the bytes to its stdin (CUPS: "lp -d NAME -o raw"). */
function sendCommand({ command }, bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`command exited ${code}: ${stderr.trim().slice(0, 200)}`))));
    child.stdin.end(bytes);
  });
}

// Windows: write raw bytes to a printer by its installed name (works for any USB printer with a driver)
const WINDOWS_RAW_PS = `
param([string]$PrinterName, [string]$File)
$code = @"
using System;
using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("Cannot open printer '" + printer + "' (error " + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFOA di = new DOCINFOA(); di.pDocName = "POS receipt"; di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, di)) throw new Exception("StartDocPrinter failed");
      StartPagePrinter(h);
      IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
      Marshal.Copy(bytes, 0, p, bytes.Length);
      int written;
      bool ok = WritePrinter(h, p, bytes.Length, out written);
      Marshal.FreeCoTaskMem(p);
      EndPagePrinter(h); EndDocPrinter(h);
      if (!ok) throw new Exception("WritePrinter failed");
    } finally { ClosePrinter(h); }
  }
}
"@
Add-Type -TypeDefinition $code
[RawPrinter]::Send($PrinterName, [System.IO.File]::ReadAllBytes($File))
`;

function withTempFile(bytes, run) {
  const file = path.join(os.tmpdir(), `printjob-${process.pid}-${Date.now()}.bin`);
  fs.writeFileSync(file, bytes);
  const cleanup = () => fs.rmSync(file, { force: true });
  return run(file).then((r) => { cleanup(); return r; }, (e) => { cleanup(); throw e; });
}

function runProcess(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(0, 300)}`))));
  });
}

function sendWindowsPrinter({ name }, bytes) {
  if (!name) throw new Error('printer.name is required for windows-printer');
  return withTempFile(bytes, (file) => {
    const script = path.join(os.tmpdir(), `rawprint-${process.pid}.ps1`);
    fs.writeFileSync(script, WINDOWS_RAW_PS);
    return runProcess('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-PrinterName', name, '-File', file])
      .finally(() => fs.rmSync(script, { force: true }));
  });
}

/** A shared Windows printer: copy /b file \\computer\ShareName */
function sendWindowsShare({ share }, bytes) {
  if (!share) throw new Error('printer.share is required for windows-share');
  return withTempFile(bytes, (file) => runProcess('cmd', ['/c', 'copy', '/b', file, share]));
}

/** A device file: serial / Bluetooth COM port ("\\\\.\\COM3"), Linux "/dev/usb/lp0" or "/dev/rfcomm0". */
function sendFile({ path: target }, bytes) {
  if (!target) throw new Error('printer.path is required for file');
  fs.writeFileSync(target, bytes);
  return Promise.resolve();
}

function sendStdout(_printer, bytes) {
  const text = Buffer.from(bytes).toString('latin1').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  console.log(`----- ${bytes.length} bytes -----\n${text}\n-----`);
  return Promise.resolve();
}

export const PRINTER_TYPES = {
  tcp: sendTcp,
  command: sendCommand,
  'windows-printer': sendWindowsPrinter,
  'windows-share': sendWindowsShare,
  file: sendFile,
  stdout: sendStdout,
};

export async function printBytes(printer, bytes) {
  const send = PRINTER_TYPES[printer.type];
  if (!send) throw new Error(`Unknown printer.type "${printer.type}". Use one of: ${Object.keys(PRINTER_TYPES).join(', ')}`);
  await send(printer, bytes);
}

// ─── LOOP ───────────────────────────────────────────────────────────────────

/** Fetches and prints what is waiting. Returns { printed, failed }. */
export async function runOnce(cfg, log = console.log) {
  const { jobs } = await fetchJobs(cfg);
  const result = { printed: 0, failed: 0 };
  for (const job of jobs) {
    try {
      await printBytes(cfg.printer, Buffer.from(job.data, 'base64'));
      await ackJob(cfg, job.id, true);
      result.printed++;
      log(`printed ${job.kind} ${job.id}`);
    } catch (err) {
      result.failed++;
      log(`FAILED ${job.kind} ${job.id}: ${err.message}`);
      await ackJob(cfg, job.id, false, err.message).catch(() => undefined);
    }
  }
  return result;
}

/** Runs until stopped. A server or network error just waits for the next poll. */
export async function runForever(cfg, log = console.log, signal) {
  let warned = false;
  while (!signal?.aborted) {
    try {
      await runOnce(cfg, log);
      if (warned) log('server reachable again');
      warned = false;
    } catch (err) {
      if (!warned) log(`cannot reach the server (${err.message}); will keep trying`);
      warned = true;
    }
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
}

/** ESC/POS self-test page so the printer setup can be checked without the server. */
export function selfTestBytes() {
  const ESC = 0x1b, GS = 0x1d;
  return Buffer.concat([
    Buffer.from([ESC, 0x40, ESC, 0x61, 0x01]),
    Buffer.from('PRINT AGENT TEST\n'),
    Buffer.from([ESC, 0x61, 0x00]),
    Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ\nIf you can read this, the agent can print.\n\n\n'),
    Buffer.from([GS, 0x56, 0x01]),
  ]);
}
