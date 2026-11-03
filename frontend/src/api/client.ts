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
    const res = await fetch(`${API_BASE}${url}`, {
      method: 'POST',
      headers: this.getHeaders(data !== undefined),
      body: data ? JSON.stringify(data) : undefined,
    });
    return handleResponse<T>(res);
  }

  async put<T>(url: string, data?: unknown): Promise<T> {
    const res = await fetch(`${API_BASE}${url}`, {
      method: 'PUT',
      headers: this.getHeaders(data !== undefined),
      body: data ? JSON.stringify(data) : undefined,
    });
    return handleResponse<T>(res);
  }

  async patch<T>(url: string, data?: unknown): Promise<T> {
    const res = await fetch(`${API_BASE}${url}`, {
      method: 'PATCH',
      headers: this.getHeaders(data !== undefined),
      body: data ? JSON.stringify(data) : undefined,
    });
    return handleResponse<T>(res);
  }

  async delete<T>(url: string): Promise<T> {
    const res = await fetch(`${API_BASE}${url}`, {
      method: 'DELETE',
      headers: this.getHeaders(false),
    });
    return handleResponse<T>(res);
  }

  /** Direct download of a binary or text file (e.g. CSV, XML, PDF) with auth headers */
  async download(url: string, fallbackFilename: string): Promise<void> {
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
  }
}

export const api = new ApiClient();
