#!/usr/bin/env node
// Local print agent. Usage:
//   node agent.mjs                     run with ./config.json
//   node agent.mjs --config D:\agent\config.json
//   node agent.mjs --test              print a self-test page and exit (no server needed)
//   node agent.mjs --once              fetch and print what is waiting, then exit
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, printBytes, runForever, runOnce, selfTestBytes } from './agent-core.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const stamp = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

const configFile = path.resolve(value('--config') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.json'));

try {
  if (flag('--test')) {
    const raw = JSON.parse((await import('node:fs')).readFileSync(configFile, 'utf8'));
    await printBytes(raw.printer, selfTestBytes());
    stamp('test page sent to the printer');
  } else if (flag('--once')) {
    const cfg = loadConfig(configFile);
    stamp(JSON.stringify(await runOnce(cfg, stamp)));
  } else {
    const cfg = loadConfig(configFile);
    stamp(`print agent started: ${cfg.serverUrl} -> ${cfg.printer.type}`);
    const stop = new AbortController();
    process.on('SIGINT', () => stop.abort());
    process.on('SIGTERM', () => stop.abort());
    await runForever(cfg, stamp, stop.signal);
  }
} catch (err) {
  console.error(`print agent: ${err.message}`);
  process.exit(1);
}
