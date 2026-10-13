/**
 * The Google Apps Script that turns a Google Sheet into the shared backend.
 * Settings > "Copy script" puts this text on the clipboard; it is pasted into
 * the sheet's Extensions > Apps Script editor and deployed as a Web app.
 *
 * It keeps three tabs: "Attendance", "Staff" and "Settings", and it is where
 * the rules are enforced: who is signed in, who is a supervisor, PINs, and
 * whether a phone is at the office. The page cannot bypass these.
 */
window.PDN_APPS_SCRIPT = `// PDN Attendance - Google Sheets backend (version 3)
// Paste into Extensions > Apps Script of your attendance spreadsheet, then
// Deploy > Manage deployments > Edit > Version: New version > Deploy.
// (First time: Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone.)

var VERSION = 3;
var TOKEN_DAYS = 90;        // how long a phone stays signed in
var MAX_TRIES = 5;          // wrong PINs before a short lock
var LOCK_MINUTES = 10;
var UNDO_SECONDS = 120;     // how long staff can undo their own punch
var MAX_SHIFT_HOURS = 18;

var REC = {
  name: 'Attendance',
  headers: ['Record ID', 'Employee ID', 'Name', 'Date', 'Clock in', 'Clock out', 'Hours',
            'Status', 'Method', 'Notes', 'In (ISO)', 'Out (ISO)', 'Updated'],
  updatedCol: 12,
  numberCols: [6]
};

var EMP = {
  name: 'Staff',
  headers: ['Employee ID', 'Name', 'Role', 'Department', 'Badge code', 'Colour', 'Updated',
            'Access', 'PIN (hidden)'],
  updatedCol: 6,
  numberCols: []
};

var SET = { name: 'Settings', headers: ['Setting', 'Value'], updatedCol: 0, numberCols: [] };
var SETTING_DEFAULTS = { geoOn: false, lat: '', lng: '', radius: 200, kioskPin: true };

var STATUS_LABELS = { CLOCKED_IN: 'Clocked in', COMPLETED: 'Completed', MISSED: 'No clock-out' };

function doGet(e) {
  var p = (e && e.parameter) || {};
  return out_(run_({ action: p.action === 'roster' ? 'roster' : 'ping' }));
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return out_({ ok: false, error: 'The request was not valid JSON.' });
  }
  return out_(run_(body));
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message, extra) {
  var res = extra || {};
  res.ok = false;
  res.code = code;
  res.error = message;
  return res;
}

function run_(req) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return fail_('busy', 'The sheet is busy. Try again in a moment.');
  }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      return fail_('setup', 'This script is not attached to a spreadsheet. Open your sheet and use Extensions > Apps Script.');
    }
    if (req.action === 'ping') return { ok: true, version: VERSION, sheet: ss.getName() };

    var ctx = {
      ss: ss,
      rec: table_(ss, REC),
      emp: table_(ss, EMP),
      set: table_(ss, SET),
      since: req.since
    };
    ctx.staff = loadStaff_(ctx.emp);
    ctx.settings = loadSettings_(ctx.set);

    var res = handle_(req, ctx);
    if (res.ok !== false) {
      res.ok = true;
      res.version = VERSION;
      res.sheet = ss.getName();
    }
    return res;
  } catch (err) {
    return fail_('error', String((err && err.message) || err));
  } finally {
    lock.releaseLock();
  }
}

function handle_(req, ctx) {
  var action = req.action;

  // --- No sign-in needed ---
  if (action === 'roster') {
    return {
      needsSetup: !hasSupervisor_(ctx.staff),
      people: ctx.staff.list.map(function (e) { return { id: e.id, name: e.name, avatarColor: e.avatarColor }; })
    };
  }

  if (action === 'setup') {
    if (hasSupervisor_(ctx.staff)) return fail_('forbidden', 'A supervisor already exists. Sign in instead.');
    if (!validPin_(req.pin)) return fail_('pin', 'Choose a PIN of exactly 4 digits.');
    var first = req.id ? ctx.staff.byId[req.id] : null;
    if (!first) {
      var name = String(req.name || '').trim();
      if (!name) return fail_('setup', 'Enter your name.');
      var newId = nextId_(ctx.staff);
      write_(ctx.emp, EMP, ctx.emp.getLastRow() + 1, [[newId, name, '', '', newId, '#3b2fc9', String(Date.now()), 'Staff', '']]);
      ctx.staff = loadStaff_(ctx.emp);
      first = ctx.staff.byId[newId];
    }
    setCells_(ctx.emp, first.row, 'Supervisor', hashPin_(first.id, req.pin));
    return session_(ctx, first.id);
  }

  if (action === 'login') {
    var person = ctx.staff.byId[req.id];
    if (!person) return fail_('auth', 'That person is no longer on the team.');
    var check = checkPin_(person, req.pin);
    if (!check.ok) return check;
    return session_(ctx, person.id);
  }

  // --- Everything below needs a valid sign-in ---
  var me = whoami_(req.token, ctx.staff);
  if (!me) return fail_('auth', 'Please sign in again.');
  var boss = me.access === 'supervisor';

  if (action === 'sync') {
    if (boss) {
      var items = req.items || [];
      apply_(ctx.rec, REC, items.filter(function (it) { return it.type === 'record'; }), recordRow_);
      apply_(ctx.emp, EMP, items.filter(function (it) {
        // The last supervisor can never be removed
        return it.type === 'employee' && !(it.op === 'delete' && isLastSupervisor_(ctx.staff, it.id));
      }), employeeRow_);
    }
    return state_(ctx, me.id);
  }

  if (action === 'punch') {
    var target = me;
    var method = 'PHONE';
    if (req.forId && req.forId !== me.id) {
      // A front-desk screen punching for someone who typed their own PIN
      if (!boss) return fail_('forbidden', 'Only a supervisor screen can do that.');
      target = ctx.staff.byId[req.forId];
      if (!target) return fail_('forbidden', 'That person is no longer on the team.');
      var pinCheck = checkPin_(target, req.pin);
      if (!pinCheck.ok) return pinCheck;
      method = 'TAP';
    } else if (!boss && ctx.settings.geoOn) {
      var where = checkPlace_(ctx.settings, req.geo);
      if (!where.ok) return where;
    }
    var punched = punch_(ctx, target, method);
    var out = state_(ctx, me.id);
    out.punched = punched;
    return out;
  }

  if (action === 'undo') {
    var undone = undo_(ctx, me, boss, req.recordId);
    if (undone.ok === false) return undone;
    return state_(ctx, me.id);
  }

  if (action === 'changePin') {
    var current = checkPin_(me, req.pin);
    if (!current.ok) return current;
    if (!validPin_(req.newPin)) return fail_('pin', 'Choose a PIN of exactly 4 digits.');
    setCells_(ctx.emp, me.row, null, hashPin_(me.id, req.newPin));
    return session_(ctx, me.id);
  }

  // --- Supervisors only ---
  if (!boss) return fail_('forbidden', 'Only a supervisor can do that.');

  if (action === 'setAccess') {
    var who = ctx.staff.byId[req.id];
    if (!who) return fail_('forbidden', 'That person is no longer on the team.');
    var makeBoss = req.access === 'supervisor';
    if (!makeBoss && isLastSupervisor_(ctx.staff, who.id)) {
      return fail_('forbidden', 'There must always be at least one supervisor. Make someone else a supervisor first.');
    }
    setCells_(ctx.emp, who.row, makeBoss ? 'Supervisor' : 'Staff', null);
    return state_(ctx, me.id);
  }

  if (action === 'resetPin') {
    var owner = ctx.staff.byId[req.id];
    if (!owner) return fail_('forbidden', 'That person is no longer on the team. Sync and try again.');
    var pin = ('000' + Math.floor(Math.random() * 10000)).slice(-4);
    setCells_(ctx.emp, owner.row, null, hashPin_(owner.id, pin));
    CacheService.getScriptCache().remove('tries_' + owner.id);
    var reply = owner.id === me.id ? session_(ctx, me.id) : state_(ctx, me.id);
    reply.pin = pin;
    return reply;
  }

  if (action === 'saveSettings') {
    saveSettings_(ctx, req.settings || {});
    return state_(ctx, me.id);
  }

  return fail_('error', 'Unknown request.');
}

// ---------------------------------------------------------------- sign-in

function secret_() {
  var props = PropertiesService.getScriptProperties();
  var value = props.getProperty('PDN_SECRET');
  if (!value) {
    value = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('PDN_SECRET', value);
  }
  return value;
}

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function validPin_(pin) {
  return /^[0-9]{4}$/.test(String(pin || ''));
}

// PINs are never stored, only a keyed hash of them
function hashPin_(id, pin) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, secret_() + '|' + id + '|' + pin));
}

function sign_(text) {
  return hex_(Utilities.computeHmacSha256Signature(text, secret_()));
}

// A sign-in token is tied to the person's current PIN, so resetting the PIN signs their devices out
function token_(emp) {
  var body = emp.id + '.' + (Date.now() + TOKEN_DAYS * 86400000);
  return body + '.' + sign_(body + '.' + emp.pinHash);
}

function whoami_(token, staff) {
  var parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  var emp = staff.byId[parts[0]];
  if (!emp || !emp.pinHash) return null;
  if (!(Number(parts[1]) > Date.now())) return null;
  return sign_(parts[0] + '.' + parts[1] + '.' + emp.pinHash) === parts[2] ? emp : null;
}

function checkPin_(emp, pin) {
  var cache = CacheService.getScriptCache();
  var key = 'tries_' + emp.id;
  var tries = Number(cache.get(key)) || 0;
  if (tries >= MAX_TRIES) {
    return fail_('locked', 'Too many wrong PINs. Wait ' + LOCK_MINUTES + ' minutes, or ask a supervisor to reset it.');
  }
  if (!emp.pinHash) return fail_('nopin', 'No PIN has been set for ' + emp.name + ' yet. Ask a supervisor.');
  if (!validPin_(pin) || hashPin_(emp.id, pin) !== emp.pinHash) {
    cache.put(key, String(tries + 1), LOCK_MINUTES * 60);
    return fail_('pin', 'Wrong PIN.');
  }
  cache.remove(key);
  return { ok: true };
}

function session_(ctx, id) {
  ctx.staff = loadStaff_(ctx.emp);
  var res = state_(ctx, id);
  res.token = token_(ctx.staff.byId[id]);
  return res;
}

// ---------------------------------------------------------------- staff

function loadStaff_(sh) {
  var list = [];
  var byId = {};
  rows_(sh, EMP.headers.length).forEach(function (r, i) {
    if (!r[0] || !r[1]) return;
    var e = {
      row: i + 2, id: r[0], name: r[1], role: r[2], department: r[3],
      badgeCode: r[4] || r[0], avatarColor: r[5], updatedAt: Number(r[6]) || 0,
      access: r[7] === 'Supervisor' ? 'supervisor' : 'staff', pinHash: r[8] || ''
    };
    list.push(e);
    byId[e.id] = e;
  });
  return { list: list, byId: byId };
}

function publicEmployee_(e) {
  return {
    id: e.id, name: e.name, role: e.role, department: e.department, badgeCode: e.badgeCode,
    avatarColor: e.avatarColor, updatedAt: e.updatedAt, access: e.access, hasPin: !!e.pinHash
  };
}

function hasSupervisor_(staff) {
  return staff.list.some(function (e) { return e.access === 'supervisor' && e.pinHash; });
}

function isLastSupervisor_(staff, id) {
  var emp = staff.byId[id];
  if (!emp || emp.access !== 'supervisor') return false;
  return !staff.list.some(function (e) { return e.id !== id && e.access === 'supervisor' && e.pinHash; });
}

function nextId_(staff) {
  var highest = 1000;
  staff.list.forEach(function (e) {
    var n = parseInt(String(e.id).replace(/[^0-9]/g, ''), 10);
    if (n > highest) highest = n;
  });
  return 'EMP-' + (highest + 1);
}

// Write the Access and/or PIN cells of one person (null leaves a cell alone)
function setCells_(sh, row, access, pinHash) {
  if (access !== null) sh.getRange(row, 8).setNumberFormat('@').setValue(access);
  if (pinHash !== null) sh.getRange(row, 9).setNumberFormat('@').setValue(pinHash);
}

// ---------------------------------------------------------------- settings

function loadSettings_(sh) {
  var settings = {};
  for (var key in SETTING_DEFAULTS) settings[key] = SETTING_DEFAULTS[key];
  rows_(sh, 2).forEach(function (r) {
    if (!(r[0] in SETTING_DEFAULTS)) return;
    if (typeof SETTING_DEFAULTS[r[0]] === 'boolean') settings[r[0]] = r[1] === 'true';
    else if (r[0] === 'radius') settings[r[0]] = Number(r[1]) || SETTING_DEFAULTS.radius;
    else settings[r[0]] = r[1];
  });
  return settings;
}

function saveSettings_(ctx, patch) {
  for (var key in SETTING_DEFAULTS) {
    if (patch[key] !== undefined && patch[key] !== null) ctx.settings[key] = patch[key];
  }
  if (ctx.settings.geoOn === true && (ctx.settings.lat === '' || ctx.settings.lng === '')) ctx.settings.geoOn = false;
  var rows = [];
  for (var name in SETTING_DEFAULTS) rows.push([name, String(ctx.settings[name])]);
  write_(ctx.set, SET, 2, rows);
  ctx.settings = loadSettings_(ctx.set);
}

// Is this phone at the office? Distance in metres between two GPS points.
function checkPlace_(settings, geo) {
  if (!geo || geo.lat === undefined || geo.lng === undefined) {
    return fail_('geo', 'Your location is needed to clock in. Allow location for this site and try again.');
  }
  var accuracy = Number(geo.acc) || 0;
  if (accuracy > 1000) {
    return fail_('geo', 'Your phone could not get a precise location. Turn on GPS, step near a window and try again.');
  }
  var rad = Math.PI / 180;
  var dLat = (Number(geo.lat) - Number(settings.lat)) * rad;
  var dLng = (Number(geo.lng) - Number(settings.lng)) * rad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(Number(settings.lat) * rad) * Math.cos(Number(geo.lat) * rad) *
          Math.sin(dLng / 2) * Math.sin(dLng / 2);
  var metres = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  var allowed = Number(settings.radius) + Math.min(accuracy, 150);
  if (metres <= allowed) return { ok: true };
  var far = metres >= 1000 ? (Math.round(metres / 100) / 10) + ' km' : (Math.round(metres / 10) * 10) + ' m';
  return fail_('geo', 'You are about ' + far + ' from the office. You can clock in and out when you are there.');
}

// ---------------------------------------------------------------- punches

// The sheet decides clock-in or clock-out and stamps the time itself,
// so a phone cannot send a made-up time.
function punch_(ctx, target, method) {
  var now = new Date();
  var zone = ctx.ss.getSpreadsheetTimeZone();
  var rows = rows_(ctx.rec, REC.headers.length);
  var open = -1;

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r[1] !== target.id || r[7] !== STATUS_LABELS.CLOCKED_IN || r[11]) continue;
    if (now.getTime() - new Date(r[10]).getTime() >= MAX_SHIFT_HOURS * 3600000) continue;
    if (open === -1 || r[10] > rows[open][10]) open = i;
  }

  var timeText = Utilities.formatDate(now, zone, 'h:mm a');

  if (open === -1) {
    var rec = {
      id: 'punch-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12),
      employeeId: target.id, employeeName: target.name,
      date: Utilities.formatDate(now, zone, 'yyyy-MM-dd'),
      arrivalTime: timeText, departureTime: '', hours: '',
      status: 'CLOCKED_IN', method: method, notes: '',
      arrivalIso: now.toISOString(), departureIso: '', updatedAt: now.getTime()
    };
    write_(ctx.rec, REC, ctx.rec.getLastRow() + 1, [recordRow_(rec)]);
    return { action: 'in', recordId: rec.id, employeeId: target.id, at: now.toISOString() };
  }

  var row = rows[open].slice();
  var minutes = Math.floor((now.getTime() - new Date(row[10]).getTime()) / 60000);
  row[5] = timeText;
  row[6] = Math.round(minutes / 0.6) / 100;
  row[7] = STATUS_LABELS.COMPLETED;
  row[11] = now.toISOString();
  row[12] = String(now.getTime());
  write_(ctx.rec, REC, open + 2, [row]);
  return { action: 'out', recordId: row[0], employeeId: target.id, at: now.toISOString() };
}

function undo_(ctx, me, boss, recordId) {
  var rows = rows_(ctx.rec, REC.headers.length);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][0] !== recordId) continue;
    var row = rows[i].slice();
    if (!boss && row[1] !== me.id) return fail_('forbidden', 'That entry belongs to someone else.');
    var last = new Date(row[11] || row[10]).getTime();
    if (!boss && Date.now() - last > UNDO_SECONDS * 1000) {
      return fail_('forbidden', 'It is too late to undo that. Ask a supervisor to correct it.');
    }
    if (row[11]) {
      // Undo a clock-out: the shift is open again
      row[5] = ''; row[6] = ''; row[7] = STATUS_LABELS.CLOCKED_IN; row[11] = '';
      row[12] = String(Date.now());
      write_(ctx.rec, REC, i + 2, [row]);
    } else {
      ctx.rec.deleteRow(i + 2);
    }
    return { ok: true };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- tables

// Find the tab, creating it and keeping its header row up to date.
function table_(ss, def) {
  var sh = ss.getSheetByName(def.name) || ss.insertSheet(def.name);
  var width = def.headers.length;
  var current = sh.getLastRow() === 0 ? [] : sh.getRange(1, 1, 1, width).getDisplayValues()[0];
  if (current.join('|') !== def.headers.join('|')) {
    sh.getRange(1, 1, 1, width).setNumberFormat('@').setValues([def.headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// Everything is stored as plain text so Sheets never reformats dates or
// times; only the Hours column is a real number so it can be summed.
function write_(sh, def, startRow, rows) {
  var width = def.headers.length;
  var extra = startRow + rows.length - 1 - sh.getMaxRows();
  if (extra > 0) sh.insertRowsAfter(sh.getMaxRows(), extra);

  var formats = rows.map(function () {
    var f = [];
    for (var c = 0; c < width; c++) f.push(def.numberCols.indexOf(c) === -1 ? '@' : '0.00');
    return f;
  });
  var range = sh.getRange(startRow, 1, rows.length, width);
  range.setNumberFormats(formats);
  range.setValues(rows);
}

function apply_(sh, def, items, toRow) {
  if (!items.length) return;
  var width = def.headers.length;
  var last = sh.getLastRow();
  var index = {};

  if (last > 1) {
    var existing = sh.getRange(2, 1, last - 1, width).getDisplayValues();
    for (var i = 0; i < existing.length; i++) {
      index[existing[i][0]] = { row: i + 2, updated: Number(existing[i][def.updatedCol]) || 0, values: existing[i] };
    }
  }

  var adds = [];
  var deletes = [];

  items.forEach(function (it) {
    var hit = index[it.id];
    if (it.op === 'delete') {
      if (hit && hit.row > 0) deletes.push(hit.row);
      return;
    }
    var data = it.data || {};
    var stamp = Number(data.updatedAt) || 0;
    if (hit) {
      // A newer edit from another device wins
      if (hit.updated > stamp || hit.row < 0) return;
      write_(sh, def, hit.row, [toRow(data, hit.values)]);
    } else {
      adds.push(toRow(data, null));
      index[it.id] = { row: -1, updated: stamp };
    }
  });

  if (adds.length) write_(sh, def, sh.getLastRow() + 1, adds);

  deletes.sort(function (a, b) { return b - a; }).forEach(function (row) {
    sh.deleteRow(row);
  });
}

function recordRow_(r) {
  return [
    r.id, r.employeeId, r.employeeName, r.date,
    r.arrivalTime || '', r.departureTime || '',
    (r.hours === null || r.hours === undefined || r.hours === '') ? '' : Number(r.hours),
    STATUS_LABELS[r.status] || r.status || '',
    r.method || '', r.notes || '',
    r.arrivalIso || '', r.departureIso || '',
    String(r.updatedAt || 0)
  ];
}

// Access and PIN are never taken from the page; they keep what the sheet already has
function employeeRow_(e, existing) {
  return [e.id, e.name, e.role || '', e.department || '', e.badgeCode || e.id,
          e.avatarColor || '', String(e.updatedAt || 0),
          existing ? (existing[7] || 'Staff') : 'Staff', existing ? (existing[8] || '') : ''];
}

function rows_(sh, width) {
  var last = sh.getLastRow();
  return last > 1 ? sh.getRange(2, 1, last - 1, width).getDisplayValues() : [];
}

// What a signed-in person is allowed to see
function state_(ctx, meId) {
  ctx.staff = loadStaff_(ctx.emp);
  var me = ctx.staff.byId[meId];
  var boss = me.access === 'supervisor';
  var codes = {};
  for (var code in STATUS_LABELS) codes[STATUS_LABELS[code]] = code;

  var records = rows_(ctx.rec, REC.headers.length)
    .filter(function (r) {
      return r[0] && r[10] && (!ctx.since || r[3] >= ctx.since) && (boss || r[1] === me.id);
    })
    .map(function (r) {
      var status = codes[r[7]] || r[7];
      // A shift nobody clocked out of stops counting as "in" after MAX_SHIFT_HOURS
      if (status === 'CLOCKED_IN' && !r[11] && Date.now() - new Date(r[10]).getTime() >= MAX_SHIFT_HOURS * 3600000) {
        status = 'MISSED';
      }
      return {
        id: r[0], employeeId: r[1], employeeName: r[2], date: r[3],
        status: status, method: r[8], notes: r[9],
        arrivalIso: r[10], departureIso: r[11] || null,
        updatedAt: Number(r[12]) || 0
      };
    });

  return {
    me: { id: me.id, name: me.name, access: me.access },
    employees: (boss ? ctx.staff.list : [me]).map(publicEmployee_),
    records: records,
    settings: boss ? ctx.settings : { geoOn: ctx.settings.geoOn, kioskPin: ctx.settings.kioskPin }
  };
}
`;
