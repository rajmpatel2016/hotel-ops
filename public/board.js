// Housekeeping board: saves each change as you make it and keeps the load table current.
(function () {
  var board = document.getElementById('board');
  if (!board) return;
  var day = board.dataset.day;
  var url = board.dataset.url;
  var credit = { checkout: Number(board.dataset.creditCheckout), stayover: Number(board.dataset.creditStayover) };
  var csrf = document.querySelector('meta[name=csrf]').content;
  var housekeepers = JSON.parse(document.getElementById('hkdata').textContent);
  var saveState = document.getElementById('saveState');
  var pending = 0;

  function rows() { return Array.prototype.slice.call(board.querySelectorAll('tr[data-room]')); }
  function needsService(tr) { return tr.dataset.status === 'checkout' || tr.dataset.status === 'stayover'; }

  function pill(cls, text) {
    var s = document.createElement('span');
    s.className = 'pill ' + cls;
    s.textContent = text;
    return s;
  }

  function refresh() {
    var by = {};
    housekeepers.forEach(function (h) { by[h.id] = { name: h.name, co: 0, so: 0 }; });
    var total = { checkout: 0, stayover: 0, vacant: 0, ooo: 0 };
    var unassigned = 0;
    rows().forEach(function (tr) {
      var st = tr.dataset.status;
      total[st]++;
      var sel = tr.querySelector('select.hk');
      var svc = needsService(tr);
      sel.disabled = !svc;
      if (!svc) sel.value = '';
      tr.classList.toggle('unassigned', svc && !sel.value);
      if (!svc) return;
      if (!sel.value) { unassigned++; return; }
      var h = by[sel.value];
      if (!h) return;
      if (st === 'checkout') h.co++; else h.so++;
    });

    var totals = document.getElementById('totals');
    totals.textContent = '';
    totals.appendChild(pill('st-open', total.checkout + ' checkouts'));
    totals.appendChild(pill('info', total.stayover + ' stayovers'));
    if (total.ooo) totals.appendChild(pill('bad', total.ooo + ' out of order'));
    if (unassigned) totals.appendChild(pill('warn', unassigned + ' unassigned'));

    var body = document.querySelector('#tally tbody');
    body.textContent = '';
    housekeepers.forEach(function (h) {
      var t = by[h.id];
      if (!t.co && !t.so) return;
      var tr = document.createElement('tr');
      [t.name, t.co, t.so, (t.co * credit.checkout + t.so * credit.stayover).toFixed(1)].forEach(function (v, i) {
        var td = document.createElement('td');
        if (i) td.className = 'n';
        td.textContent = v;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    if (!body.children.length) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'muted';
      td.textContent = 'No rooms assigned yet.';
      tr.appendChild(td);
      body.appendChild(tr);
    }
    applyFilter();
  }

  function applyFilter() {
    var only = document.getElementById('onlyService').checked;
    var floorRow = null;
    var shown = 0;
    Array.prototype.forEach.call(board.querySelectorAll('.grid.board tbody tr'), function (tr) {
      if (tr.classList.contains('floor')) {
        if (floorRow) floorRow.hidden = only && !shown;
        floorRow = tr;
        shown = 0;
        return;
      }
      var hide = only && !needsService(tr);
      tr.hidden = hide;
      if (!hide) shown++;
    });
    if (floorRow) floorRow.hidden = only && !shown;
  }

  function save(tr, patch) {
    patch.day = day;
    patch.room_id = Number(tr.dataset.room);
    pending++;
    tr.classList.add('saving');
    tr.classList.remove('failed');
    saveState.textContent = 'Saving…';
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-CSRF-Token': csrf },
      credentials: 'same-origin',
      body: JSON.stringify(patch),
    })
      .then(function (res) { return res.json().catch(function () { return { ok: false }; }); })
      .then(function (data) { if (!data.ok) throw new Error(data.error || 'Not saved'); })
      .then(function () {
        tr.classList.remove('saving');
        pending--;
        if (!pending) saveState.textContent = 'All changes saved';
      })
      .catch(function (err) {
        tr.classList.remove('saving');
        tr.classList.add('failed');
        pending--;
        saveState.textContent = 'A change was not saved (' + err.message + '). Reload the page and try again.';
      });
  }

  board.addEventListener('click', function (e) {
    var btn = e.target.closest('.seg button');
    if (!btn) return;
    var tr = btn.closest('tr');
    var status = btn.dataset.status;
    if (tr.dataset.status === status) return;
    tr.dataset.status = status;
    Array.prototype.forEach.call(tr.querySelectorAll('.seg button'), function (b) {
      b.setAttribute('aria-pressed', String(b === btn));
    });
    refresh();
    save(tr, { status: status });
  });

  board.addEventListener('change', function (e) {
    var tr = e.target.closest('tr[data-room]');
    if (!tr) return;
    if (e.target.classList.contains('hk')) {
      refresh();
      save(tr, { employee_id: e.target.value ? Number(e.target.value) : null });
    } else if (e.target.classList.contains('note')) {
      save(tr, { note: e.target.value });
    }
  });

  var only = document.getElementById('onlyService');
  try { only.checked = localStorage.getItem('hk-only-service') === '1'; } catch (e) {}
  only.addEventListener('change', function () {
    try { localStorage.setItem('hk-only-service', only.checked ? '1' : '0'); } catch (e) {}
    applyFilter();
  });

  window.addEventListener('beforeunload', function (e) {
    if (pending) { e.preventDefault(); e.returnValue = ''; }
  });

  refresh();
})();
