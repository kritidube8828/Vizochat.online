requireLogin();

async function loadStats() {
  try {
    const s = await api('/api/admin/stats');
    document.getElementById('totalUsers').textContent = fmtCoins(s.total_users);
    document.getElementById('onlineUsers').textContent = fmtCoins(s.online_users);
    document.getElementById('totalEarned').textContent = fmtCoins(s.total_earned_coins);
    document.getElementById('totalBought').textContent = fmtCoins(s.total_bought_coins);

    const tbody = document.querySelector('#bannedTable tbody');
    tbody.innerHTML = s.banned_users.map(u => `
      <tr>
        <td>${u.username || '-'}</td>
        <td>${u.email || '-'}</td>
        <td>${u.ban_expires_at ? new Date(u.ban_expires_at).toLocaleDateString() : '-'}</td>
        <td><button class="btn-sm btn-outline" onclick="unban('${u.id}')">Unban</button></td>
      </tr>`).join('') || '<tr><td colspan="4" class="muted">No banned users</td></tr>';
  } catch (e) {
    if (e.status === 403) {
      document.querySelector('.container').innerHTML = '<p class="muted">Admin access required for this account.</p>';
    }
  }
}

async function loadErrors() {
  try {
    const { errors } = await api('/api/admin/errors');
    document.getElementById('errorList').innerHTML = errors.length
      ? errors.map(e => `<div class="glass" style="padding:10px 14px; margin-bottom:8px; font-size:12px;">
          <b>${e.route || '-'}</b> — ${e.message}<br><span class="muted">${new Date(e.created_at).toLocaleString()}</span>
        </div>`).join('')
      : '<p class="muted" style="font-size:13px;">No errors logged.</p>';
  } catch (e) {}
}

async function unban(id) {
  await api(`/api/admin/user/${id}/unban`, { method: 'POST' });
  toast('User unbanned');
  loadStats();
}

document.getElementById('searchBtn').addEventListener('click', async () => {
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;
  const { users } = await api('/api/admin/users/search?q=' + encodeURIComponent(q));
  document.getElementById('searchResults').innerHTML = users.map(u => `
    <div class="option-card glass" onclick="viewUser('${u.id}')">
      <div><div class="option-title">${u.username}</div><div class="option-sub">${u.email || ''} · ${u.account_status}</div></div>
      <div class="chevron">›</div>
    </div>`).join('') || '<p class="muted" style="font-size:13px;">No users found.</p>';
});

async function viewUser(id) {
  const data = await api(`/api/admin/user/${id}`);
  const u = data.user;
  const banAction = u.account_status === 'banned'
    ? `<button class="btn-sm btn-outline" onclick="unban('${u.id}')">Unban</button>`
    : `<button class="btn-sm btn-danger" onclick="banUser('${u.id}')">Ban 21 days</button>`;
  document.getElementById('searchResults').innerHTML = `
    <div class="glass" style="padding:16px;">
      <b>${u.username}</b> <span class="muted">(${u.email || 'no email'})</span>
      <p class="muted" style="font-size:12px;">ID: ${u.id}</p>
      <p style="font-size:13px;">Spendable: 🪙 ${fmtCoins(u.spendable_coins)} &nbsp; Earned: ✦ ${fmtCoins(u.earned_coins)}</p>
      <p style="font-size:13px;">Status: <b>${u.account_status}</b></p>
      <p style="font-size:12px;" class="muted">Payments: ${data.payments.length} · Reports against: ${data.reportsAgainst.length}</p>
      <div class="mt12">${banAction}</div>
    </div>`;
}

async function banUser(id) {
  await api(`/api/admin/user/${id}/ban`, { method: 'POST', body: { days: 21 } });
  toast('User banned for 21 days');
  loadStats();
  viewUser(id);
}

loadStats();
loadErrors();
setInterval(loadStats, 15000);
