// src/lib/print/network.ts
// Sends raw ESC/POS bytes to a network (LAN) receipt printer, normally TCP port 9100.
import net from 'node:net';

export class PrinterError extends Error {}

export function sendToPrinter(host: string, port: number, data: Uint8Array, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(new PrinterError(`Printer ${host}:${port} unreachable: ${err.message}`));
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('connection timed out')));
    socket.once('error', finish);
    socket.once('connect', () => {
      socket.write(data, (err) => {
        if (err) return finish(err);
        socket.end();
      });
    });
    socket.once('close', () => finish());
  });
}
