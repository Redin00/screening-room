let me = null;

async function init() {
  me = await requireProfile();
  if (!me) return;
  if (!me.isAdmin) {
    window.location.href = '/lobby.html';
    return;
  }
  renderWhoami(me, 'whoami');
  await loadProfiles();

  document.getElementById('new-profile-form').addEventListener('submit', onCreate);
}

async function loadProfiles() {
  const rows = await api('GET', '/api/admin/profiles');
  const tbody = document.getElementById('profiles-body');
  tbody.innerHTML = rows.map((p) => rowHtml(p)).join('');

  rows.forEach((p) => {
    tbody.querySelector(`[data-toggle-host="${p.id}"]`).addEventListener('change', (e) =>
      patchProfile(p.id, { canHost: e.target.checked })
    );
    tbody.querySelector(`[data-toggle-admin="${p.id}"]`).addEventListener('change', (e) =>
      patchProfile(p.id, { isAdmin: e.target.checked })
    );
    tbody.querySelector(`[data-toggle-disabled="${p.id}"]`).addEventListener('change', (e) =>
      patchProfile(p.id, { disabled: e.target.checked })
    );
    tbody.querySelector(`[data-reset-pin="${p.id}"]`)?.addEventListener('click', () => resetPin(p.id));
    tbody.querySelector(`[data-clear-pin="${p.id}"]`)?.addEventListener('click', () =>
      patchProfile(p.id, { clearPin: true })
    );
    const delBtn = tbody.querySelector(`[data-delete="${p.id}"]`);
    if (delBtn) delBtn.addEventListener('click', () => deleteProfile(p.id, p.displayName));
  });
}

function rowHtml(p) {
  const isSelf = p.id === me.id;
  return `
    <tr>
      <td>
        <div class="name-cell">
          <div class="avatar-sm" style="background:${p.avatarColor}">${initials(p.displayName)}</div>
          <span>${escapeHtml(p.displayName)}${isSelf ? ' (you)' : ''}</span>
        </div>
      </td>
      <td><label class="toggle"><input type="checkbox" data-toggle-host="${p.id}" ${p.canHost ? 'checked' : ''}><span class="track"></span></label></td>
      <td><label class="toggle"><input type="checkbox" data-toggle-admin="${p.id}" ${p.isAdmin ? 'checked' : ''}><span class="track"></span></label></td>
      <td><label class="toggle"><input type="checkbox" data-toggle-disabled="${p.id}" ${p.disabled ? 'checked' : ''}><span class="track"></span></label></td>
      <td>
        ${p.hasPin
          ? `<button class="btn-ghost btn-small" data-clear-pin="${p.id}" type="button">Remove PIN</button>`
          : `<button class="btn-ghost btn-small" data-reset-pin="${p.id}" type="button">Set PIN</button>`}
      </td>
      <td>${isSelf ? '' : `<button class="btn-danger btn-small" data-delete="${p.id}" type="button">Delete</button>`}</td>
    </tr>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function patchProfile(id, body) {
  try {
    await api('PATCH', `/api/admin/profiles/${id}`, body);
    await loadProfiles();
  } catch (err) {
    alert(err.message);
    await loadProfiles();
  }
}

async function resetPin(id) {
  const pin = prompt('New PIN (4–8 digits):');
  if (!pin) return;
  await patchProfile(id, { pin });
}

async function deleteProfile(id, name) {
  if (!confirm(`Delete the profile "${name}"? This can't be undone.`)) return;
  try {
    await api('DELETE', `/api/admin/profiles/${id}`);
    await loadProfiles();
  } catch (err) {
    alert(err.message);
  }
}

async function onCreate(e) {
  e.preventDefault();
  const errEl = document.getElementById('new-profile-error');
  errEl.textContent = '';
  const displayName = document.getElementById('np-name').value.trim();
  const pin = document.getElementById('np-pin').value.trim();
  const canHost = document.getElementById('np-canhost').checked;

  try {
    await api('POST', '/api/admin/profiles', { displayName, pin: pin || undefined, canHost });
    document.getElementById('new-profile-form').reset();
    await loadProfiles();
  } catch (err) {
    errEl.textContent = err.message;
  }
}

init();
