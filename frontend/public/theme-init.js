// Applies the saved theme before first paint (prevents a dark/light flash).
// Kept as an external same-origin file so the Content-Security-Policy does not need 'unsafe-inline' for scripts.
(function () {
  try {
    var t = localStorage.getItem('lc_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', t);
    if (t === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  } catch (e) {}
})();
