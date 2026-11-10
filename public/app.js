// Small behaviors shared by every page.
(function () {
  // Submit a form as soon as its date or select changes.
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el && el.hasAttribute && el.hasAttribute('data-autosubmit') && el.form) el.form.submit();
  });
  // Ask before destructive actions.
  document.addEventListener('submit', function (e) {
    var msg = e.target.getAttribute && e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-print]');
    if (btn) window.print();
  });
})();
