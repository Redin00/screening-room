let me = null;
let createdCode = null;

async function init() {
  me = await requireProfile();
  if (!me) return;
  renderWhoami(me, 'whoami');

  if (!me.canHost && !me.isAdmin) {
    document.getElementById('host-panel').innerHTML = `
      <h2>Start a screening</h2>
      <p class="section-sub">Hosting isn't enabled for this profile.</p>
      <div class="perm-note">Ask an admin to grant this profile hosting permission — it keeps the server from filling up with random uploads.</div>
    `;
  }

  await refreshRoomList();
  setInterval(refreshRoomList, 8000);
}

async function refreshRoomList() {
  const rooms = await api('GET', '/api/rooms');
  const list = document.getElementById('room-list');
  if (!rooms.length) {
    list.innerHTML = '<div class="room-list-empty">No rooms are open right now.</div>';
    return;
  }
  list.innerHTML = rooms
    .map(
      (r) => `
      <div class="room-list-item">
        <div class="stub">
          <div class="r-name">${escapeHtml(r.name)}${r.isPrivate ? ' <span class="r-private-badge">private</span>' : ''}</div>
          <div class="r-meta">Hosted by ${escapeHtml(r.hostName)} · ${r.status === 'active' ? 'playing' : 'waiting for video'}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          ${(r.hostId === me.id || me.isAdmin) ? `<button class="btn-ghost btn-tiny" data-code="${r.code}" data-toggle-private>${r.isPrivate ? 'Make public' : 'Make private'}</button>` : ''}
          <button class="btn-ghost btn-small" data-code="${r.code}">Join</button>
        </div>
      </div>`
    )
    .join('');

  list.querySelectorAll('button[data-code]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.togglePrivate) {
        togglePrivate(btn.dataset.code);
      } else {
        goToRoom(btn.dataset.code);
      }
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function goToRoom(code) {
  window.location.href = `/room.html?code=${encodeURIComponent(code)}`;
}

async function togglePrivate(code) {
  const room = await api('GET', `/api/rooms/${encodeURIComponent(code)}`);
  const newVal = !room.isPrivate;
  try {
    await api('PATCH', `/api/rooms/${encodeURIComponent(code)}/private`, { private: newVal });
    showToast(newVal ? 'Room is now private — removed from the open list.' : 'Room is now public — visible in the open list.');
    await refreshRoomList();
  } catch (err) {
    showToast(err.message);
  }
}

function showToast(msg, ms = 3000) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  t.style.display = 'block';
  document.body.appendChild(t);
  setTimeout(() => {
    t.style.display = 'none';
    setTimeout(() => t.remove(), 300);
  }, ms);
}

document.getElementById('create-room-btn')?.addEventListener('click', async () => {
  const name = document.getElementById('room-name').value.trim();
  const isPrivate = document.getElementById('room-private').checked;
  const errEl = document.getElementById('create-error');
  errEl.textContent = '';
  try {
    const { code, isPrivate: createdPrivate } = await api('POST', '/api/rooms', { name, private: isPrivate });
    createdCode = code;
    document.getElementById('host-form').style.display = 'none';
    document.getElementById('room-code-reveal').style.display = 'block';
    document.getElementById('new-room-code').textContent = code;
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('enter-room-btn')?.addEventListener('click', () => {
  if (createdCode) goToRoom(createdCode);
});

document.getElementById('join-btn').addEventListener('click', async () => {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  const errEl = document.getElementById('join-error');
  errEl.textContent = '';
  if (!code) { errEl.textContent = 'Enter a room code.'; return; }
  try {
    await api('GET', `/api/rooms/${encodeURIComponent(code)}`);
    goToRoom(code);
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('surprise-btn')?.addEventListener('click', () => {
  window.open('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '_blank', 'noopener,noreferrer');
});

document.getElementById('join-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('join-btn').click();
});

init();
