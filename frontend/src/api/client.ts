import { startGlobalLoading, stopGlobalLoading } from '../context/LoadingContext.js';

const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: any,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function getActionCopy(url: string, method: string): { title: string; subtitle: string } {
  if (url.includes('/review')) {
    return { title: 'Reviewing Supplier Invoice…', subtitle: 'Validating line items and catalog matches…' };
  }
  if (url.includes('/approve')) {
    return { title: 'Approving Invoice & Inwarding…', subtitle: 'Adding stock bottles and posting purchase ledgers…' };
  }
  if (url.includes('/bills') && method === 'POST') {
    return { title: 'Processing Counter Bill…', subtitle: 'Recording payment & deducting live store stock…' };
  }
  if (url.includes('/closing')) {
    return { title: 'Finalizing Daily Closing…', subtitle: 'Reconciling tender totals and locking registers…' };
  }
  if (url.includes('/counter-sheets') && url.includes('/post')) {
    return { title: 'Posting Counter Sheet…', subtitle: 'Calculating sold bottles and recording sales…' };
  }
  if (url.includes('/tally-export')) {
    return { title: 'Generating Tally XML…', subtitle: 'Exporting vouchers & ledger entries for Tally Prime…' };
  }
  if (method === 'DELETE') {
    return { title: 'Processing Deletion…', subtitle: 'Removing record and updating database…' };
  }
  return { title: 'Processing Action…', subtitle: 'Please wait while the server completes the operation.' };
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const message = (data && (data.error || data.message)) || text || `Request failed (${res.status})`;
    throw new ApiError(res.status, message, data);
  }
  return res.json();
}

class ApiClient {
  // Content-Type only when a body is sent: Fastify rejects an empty body declared as JSON (400)
  private getHeaders(hasBody = true) {
    const token = localStorage.getItem('token');
    return {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async get<T>(url: string): Promise<T> {
    const res = await fetch(`${API_BASE}${url}`, { headers: this.getHeaders(false) });
    return handleResponse<T>(res);
  }

  async post<T>(url: string, data?: unknown): Promise<T> {
    const { title, subtitle } = getActionCopy(url, 'POST');
    startGlobalLoading(title, subtitle);
    try {
      const res = await fetch(`${API_BASE}${url}`, {
        method: 'POST',
        headers: this.getHeaders(data !== undefined),
        body: data ? JSON.stringify(data) : undefined,
      });
      return await handleResponse<T>(res);
    } finally {
      stopGlobalLoading();
    }
  }

  async put<T>(url: string, data?: unknown): Promise<T> {
    const { title, subtitle } = getActionCopy(url, 'PUT');
    startGlobalLoading(title, subtitle);
    try {
      const res = await fetch(`${API_BASE}${url}`, {
        method: 'PUT',
        headers: this.getHeaders(data !== undefined),
        body: data ? JSON.stringify(data) : undefined,
      });
      return await handleResponse<T>(res);
    } finally {
      stopGlobalLoading();
    }
  }

  async patch<T>(url: string, data?: unknown): Promise<T> {
    const { title, subtitle } = getActionCopy(url, 'PATCH');
    startGlobalLoading(title, subtitle);
    try {
      const res = await fetch(`${API_BASE}${url}`, {
        method: 'PATCH',
        headers: this.getHeaders(data !== undefined),
        body: data ? JSON.stringify(data) : undefined,
      });
      return await handleResponse<T>(res);
    } finally {
      stopGlobalLoading();
    }
  }

  async delete<T>(url: string): Promise<T> {
    const { title, subtitle } = getActionCopy(url, 'DELETE');
    startGlobalLoading(title, subtitle);
    try {
      const res = await fetch(`${API_BASE}${url}`, {
        method: 'DELETE',
        headers: this.getHeaders(false),
      });
      return await handleResponse<T>(res);
    } finally {
      stopGlobalLoading();
    }
  }

  /** Direct download of a binary or text file (e.g. CSV, XML, PDF) with auth headers */
  async download(url: string, fallbackFilename: string): Promise<void> {
    const { title, subtitle } = getActionCopy(url, 'GET');
    startGlobalLoading(title, subtitle);
    try {
      const res = await fetch(`${API_BASE}${url}`, { headers: this.getHeaders(false) });
      if (!res.ok) {
        await handleResponse(res);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition');
      let filename = fallbackFilename;
      if (disposition) {
        const match = disposition.match(/filename=["']?([^"';]+)["']?/i);
        if (match && match[1]) filename = match[1];
      }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    } finally {
      stopGlobalLoading();
    }
  }
}

export const api = new ApiClient();
