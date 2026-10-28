const API_BASE = '/api/v1';

class ApiClient {
  private getHeaders() {
    const token = localStorage.getItem('token');
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async get<T>(url: string): Promise<T> {
    const res = await fetch(`${API_BASE}${url}`, {
      headers: this.getHeaders(),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async post<T>(url: string, data?: any): Promise<T> {
    const res = await fetch(`${API_BASE}${url}`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: data ? JSON.stringify(data) : undefined,
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
}

export const api = new ApiClient();
