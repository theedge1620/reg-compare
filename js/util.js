// RuleCheck — Shared helpers: status bars, escaping, truncation.

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

// Drive one of the two status bars (each view owns one).
function setStatusIn(barId, icon, title, detail, visible = true) {
  const bar = document.getElementById(barId);
  bar.classList.toggle('visible', visible);
  bar.querySelector('.status-icon').textContent = icon;
  bar.querySelector('.status-title').textContent = title;
  bar.querySelector('.status-detail').textContent = detail;
}

function setStatus(icon, title, detail, visible = true) {
  setStatusIn('statusBar', icon, title, detail, visible);
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function trunc(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}
