const API = import.meta.env.VITE_API_URL || '';

export async function request(path, options) {
  const response = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || `Request failed (${response.status})`);
    error.code = data.error;
    error.errorCode = data.errorCode;
    throw error;
  }
  return data;
}
