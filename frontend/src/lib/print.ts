import { api } from '../api/client';

/** api.* throws the raw response text; pull the error/message and validation details out when it is JSON. */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw);
    let msg = parsed.error || parsed.message || raw;
    const d = parsed.details;
    if (d && typeof d === 'object') {
      const parts: string[] = [];
      if (Array.isArray(d.formErrors) && d.formErrors.length) {
        parts.push(...d.formErrors.map(String));
      }
      if (d.fieldErrors && typeof d.fieldErrors === 'object') {
        for (const [k, v] of Object.entries(d.fieldErrors as Record<string, unknown>)) {
          if (Array.isArray(v) && v.length) {
            parts.push(`${k}: ${v.join(', ')}`);
          } else if (typeof v === 'string' && v) {
            parts.push(`${k}: ${v}`);
          }
        }
      }
      if (parts.length) {
        const detailStr = parts.join('; ');
        if (!msg.includes(detailStr)) {
          msg = `${msg}: ${detailStr}`;
        }
      }
    }
    return msg;
  } catch {
    return raw;
  }
}

/** Parses structured field errors from an API error response. */
export function parseFieldErrors(err: unknown): Record<string, string> {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw);
    const fields: Record<string, string> = {};
    const d = parsed.details?.fieldErrors;
    if (d && typeof d === 'object') {
      for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
        if (Array.isArray(v) && v.length) {
          fields[k] = String(v[0]);
        } else if (typeof v === 'string') {
          fields[k] = v;
        }
      }
    }
    return fields;
  } catch {
    return {};
  }
}

import { showToast } from './toast';
export { showToast };

export type PrintKind = 'bills' | 'kot';

/** Browser print: fetches the HTML receipt / ticket and prints it instantly via a hidden iframe (with popup fallback). */
export async function printInBrowser(kind: PrintKind, id: string): Promise<void> {
  try {
    const res = await fetch(`/api/v1/print/${kind}/${id}?format=html`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    });
    if (!res.ok) throw new Error(await res.text());
    const html = await res.text();

    let frame = document.getElementById('lc_print_frame') as HTMLIFrameElement | null;
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'lc_print_frame';
      frame.style.position = 'fixed';
      frame.style.right = '0';
      frame.style.bottom = '0';
      frame.style.width = '0';
      frame.style.height = '0';
      frame.style.border = '0';
      document.body.appendChild(frame);
    }

    const doc = frame.contentWindow?.document || frame.contentDocument;
    if (doc && frame.contentWindow) {
      doc.open();
      doc.write(html);
      doc.close();
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } else {
      const win = window.open('', '_blank', 'width=420,height=640');
      if (!win) throw new Error('Allow pop-ups to print.');
      win.document.open();
      win.document.write(html);
      win.document.close();
      win.focus();
      win.print();
    }
  } catch (err) {
    showToast('Could not print: ' + errorMessage(err), 'error');
  }
}

/** Sends the document to the branch's configured network (ESC/POS) printer. */
export async function sendToNetworkPrinter(kind: PrintKind, id: string): Promise<boolean> {
  try {
    await api.post(`/print/${kind}/${id}/send`);
    showToast('Sent to printer.', 'success');
    return true;
  } catch (err) {
    showToast(errorMessage(err), 'error');
    return false;
  }
}
