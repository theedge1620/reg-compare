// RuleCheck — Tab navigation and start-up. Loaded last.

// ═════════════════════════════════════════════════════════════════════════════
// Top-level navigation
// ═════════════════════════════════════════════════════════════════════════════

const VIEWS = ['ecfr', 'compare', 'folder', 'icr'];

function switchView(view) {
  if (!VIEWS.includes(view)) view = 'ecfr';
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  document.querySelectorAll('.footer-note').forEach(f => f.classList.toggle('active', f.dataset.view === view));
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    switchView(tab.dataset.view);
    history.replaceState(null, '', `#${tab.dataset.view}`);
  });
});

switchView(location.hash.replace('#', '') || 'ecfr');
