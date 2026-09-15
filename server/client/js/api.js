// api.js - shared fetch helper + auth/session utilities used across all pages.
const API_BASE = ''; // same-origin (server serves both API and static client)

const Session = {
  getToken(){ return localStorage.getItem('vizo_token'); },
  setToken(t){ localStorage.setItem('vizo_token', t); },
  clear(){ localStorage.removeItem('vizo_token'); },
  isLoggedIn(){ return !!this.getToken(); }
};

async function api(path, { method = 'GET', body, isForm = false } = {}) {
  const headers = {};
  const token = Session.getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (!isForm && body) headers['Content-Type'] = 'application/json';

  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: isForm ? body : (body ? JSON.stringify(body) : undefined)
  });

  if (res.status === 401) {
    Session.clear();
    window.location.href = '/index.html';
    throw new Error('unauthorized');
  }

  if (res.status === 503) {
    // Temporary server/DB hiccup - never logs the user out for this, unlike 401.
    toast('Server is busy, please try again in a moment.');
    throw new Error('temporarily_unavailable');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'request_failed');
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function requireLogin() {
  if (!Session.isLoggedIn()) window.location.href = '/index.html';
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function fmtCoins(n){ return (n ?? 0).toLocaleString('en-IN'); }
