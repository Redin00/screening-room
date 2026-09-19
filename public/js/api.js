async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function initials(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

async function requireProfile() {
  const { profile } = await api('GET', '/api/profiles/me');
  if (!profile) {
    window.location.href = '/';
    return null;
  }
  return profile;
}

function renderWhoami(profile, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `
    <div class="avatar-sm" style="background:${profile.avatarColor}">${initials(profile.displayName)}</div>
    <span>${profile.displayName}</span>
    ${profile.isAdmin ? '<a href="/admin.html" class="btn-ghost btn-small" style="text-decoration:none;display:inline-block;">Admin</a>' : ''}
    <button class="btn-ghost btn-small" id="logout-btn" type="button">Switch profile</button>
  `;
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('POST', '/api/profiles/logout');
    window.location.href = '/';
  });
}
