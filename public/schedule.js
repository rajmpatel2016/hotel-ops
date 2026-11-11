// Schedule: clicking a day opens the shift form for that person and day.
(function () {
  var dialog = document.getElementById('shiftDialog');
  if (!dialog) return;
  var boxes = Array.prototype.slice.call(dialog.querySelectorAll('input[name=days]'));
  var start = document.getElementById('sd_start');
  var end = document.getElementById('sd_end');
  var brk = document.getElementById('sd_break');

  document.addEventListener('click', function (e) {
    var cell = e.target.closest('button.cell');
    if (cell) {
      document.getElementById('sd_emp').value = cell.dataset.emp;
      document.getElementById('sd_name').textContent = cell.dataset.name;
      boxes.forEach(function (b) { b.checked = b.value === cell.dataset.day; });
      start.value = cell.dataset.start;
      end.value = cell.dataset.end;
      brk.value = cell.dataset.break || '30';
      if (brk.selectedIndex === -1) {
        var opt = document.createElement('option');
        opt.value = cell.dataset.break;
        opt.textContent = cell.dataset.break + ' min';
        brk.appendChild(opt);
        brk.value = cell.dataset.break;
      }
      document.getElementById('sd_note').value = cell.dataset.note;
      if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
      start.focus();
      return;
    }
    var preset = e.target.closest('[data-preset]');
    if (preset) {
      var parts = preset.dataset.preset.split(',');
      start.value = parts[0];
      end.value = parts[1];
      return;
    }
    if (e.target.closest('[data-close]')) dialog.close();
  });
})();
