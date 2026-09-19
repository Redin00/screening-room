let profiles = [];
let activeProfile = null;

async function init() {
  // If already signed in, skip straight to the lobby.
  const me = await api('GET', '/api/profiles/me');
  if (me.profile) {
    window.location.href = '/lobby.html';
    return;
  }

  profiles = await api('GET', '/api/profiles');
  const grid = document.getElementById('profile-grid');
  const emptyNote = document.getElementById('empty-note');

  if (!profiles.length) {
    emptyNote.style.display = 'block';
    return;
  }

  grid.innerHTML = profiles
    .map(
      (p) => `
      <button class="profile-tile" data-id="${p.id}" type="button">
        <div class="avatar" style="background:${p.avatarColor}">${initials(p.displayName)}</div>
        <div class="name">${p.displayName}</div>
        ${p.hasPin ? '<div class="lock">PIN required</div>' : ''}
      </button>`
    )
    .join('');

  grid.querySelectorAll('.profile-tile').forEach((btn) => {
    btn.addEventListener('click', () => onPick(parseInt(btn.dataset.id, 10)));
  });
}

function onPick(id) {
  activeProfile = profiles.find((p) => p.id === id);
  if (!activeProfile) return;

  if (!activeProfile.hasPin) {
    selectProfile(id, '');
    return;
  }

  document.getElementById('pin-avatar').style.background = activeProfile.avatarColor;
  document.getElementById('pin-avatar').textContent = initials(activeProfile.displayName);
  document.getElementById('pin-name').textContent = activeProfile.displayName;
  document.getElementById('pin-input').value = '';
  document.getElementById('pin-error').textContent = '';
  document.getElementById('pin-backdrop').style.display = 'flex';
  document.getElementById('pin-input').focus();
}

async function selectProfile(id, pin) {
  try {
    await api('POST', `/api/profiles/${id}/select`, { pin });
    window.location.href = '/lobby.html';
  } catch (err) {
    document.getElementById('pin-error').textContent = err.message;
  }
}

document.getElementById('pin-cancel').addEventListener('click', () => {
  document.getElementById('pin-backdrop').style.display = 'none';
});
document.getElementById('pin-submit').addEventListener('click', () => {
  selectProfile(activeProfile.id, document.getElementById('pin-input').value.trim());
});
document.getElementById('pin-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') selectProfile(activeProfile.id, e.target.value.trim());
});

init();
