/**
 * The Google Apps Script that keeps a Google Sheet as a live copy of the app.
 * A supervisor gets it from Settings › Copy sheet script (it comes with this
 * server's address and a private key filled in) and pastes it into the
 * sheet's Extensions › Apps Script.
 *
 * Every minute, and right after each punch, it asks the server for what
 * changed and writes it into the Attendance and Staff tabs.
 */
const TEMPLATE = `// PDN Attendance - Google Sheet copy (version 5)
// This sheet is a live copy of the app. Make changes in the app, not here.
//
// Setup:
// 1. Paste this into Extensions > Apps Script (replacing everything) and save.
// 2. In the toolbar choose the function pullFromApp and press Run. Approve access.
//    Your existing tabs are kept, renamed with "(before Firebase)".
// 3. Deploy > Manage deployments > Edit > Version: New version > Deploy.
//    (No deployment yet? Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone.)

var API = __API__;
var KEY = __KEY__;

var REC = {
  name: 'Attendance',
  headers: ['Record ID', 'Employee ID', 'Name', 'Date', 'Clock in', 'Clock out', 'Hours',
            'Status', 'Method', 'Notes', 'In (ISO)', 'Out (ISO)'],
  hoursCol: 6
};
var EMP = {
  name: 'Staff',
  headers: ['Employee ID', 'Name', 'Role', 'Department', 'Badge code', 'Access'],
  hoursCol: -1
};
var STATUS = { CLOCKED_IN: 'Clocked in', COMPLETED: 'Completed', MISSED: 'No clock-out' };
var METHOD = { QR: 'Badge scan', QR_SCAN: 'Badge scan', TAP: 'Front desk', '1_TAP_KIOSK': 'Front desk',
               PHONE: 'Phone', MOBILE_PUNCH: 'Phone', MANUAL: 'Added by hand', MANUAL_ENTRY: 'Added by hand' };

// The app pings this after each punch so the sheet catches up straight away
function doGet() { return reply_(); }
function doPost() { return reply_(); }

function reply_() {
  var result;
  try {
    result = { ok: true, copied: pullFromApp() };
  } catch (err) {
    result = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function pullFromApp() {
  ensureTimer_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return 0;
  try {
    var props = PropertiesService.getScriptProperties();
    var cursor = Number(props.getProperty('PDN_CURSOR')) || 0;
    var response = UrlFetchApp.fetch(API, {
      method: 'post',
      contentType: 'text/plain',
      payload: JSON.stringify({ action: 'mirror', key: KEY, cursor: cursor }),
      muteHttpExceptions: true
    });
    var data = JSON.parse(response.getContentText());
    if (!data.ok) throw new Error(data.error || 'The app refused the request.');

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var zone = ss.getSpreadsheetTimeZone();
    if (!cursor) archiveOld_(ss);

    var gone = { record: [], employee: [] };
    (data.deleted || []).forEach(function (d) { if (gone[d.type]) gone[d.type].push(d.id); });
    write_(tab_(ss, REC), REC, data.records.map(function (r) { return recordRow_(r, zone); }), gone.record);
    write_(tab_(ss, EMP), EMP, data.employees.map(staffRow_), gone.employee);

    props.setProperty('PDN_CURSOR', String(data.cursor));
    return data.records.length + data.employees.length + (data.deleted || []).length;
  } finally {
    lock.releaseLock();
  }
}

// Check for changes every minute, even when nobody has just punched
function ensureTimer_() {
  try {
    var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'pullFromApp'; });
    if (!exists) ScriptApp.newTrigger('pullFromApp').timeBased().everyMinutes(1).create();
  } catch (err) { /* only possible once the script has been approved */ }
}

// Tabs from before the move to Firebase are kept under a new name
function archiveOld_(ss) {
  [REC, EMP].forEach(function (def) {
    var sh = ss.getSheetByName(def.name);
    if (!sh || sh.getLastRow() <= 1) return;
    var name = def.name + ' (before Firebase)';
    for (var n = 2; ss.getSheetByName(name); n++) name = def.name + ' (before Firebase ' + n + ')';
    sh.setName(name);
  });
}

function tab_(ss, def) {
  var sh = ss.getSheetByName(def.name) || ss.insertSheet(def.name);
  var width = def.headers.length;
  var current = sh.getLastRow() ? sh.getRange(1, 1, 1, width).getDisplayValues()[0].join('|') : '';
  if (current !== def.headers.join('|')) {
    sh.getRange(1, 1, 1, width).setValues([def.headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function write_(sh, def, rows, deletes) {
  var width = def.headers.length;
  var last = sh.getLastRow();
  var index = {};
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 1).getDisplayValues().forEach(function (r, i) { index[r[0]] = i + 2; });
  }

  var adds = [];
  rows.forEach(function (row) {
    if (index[row[0]]) put_(sh, def, index[row[0]], [row]);
    else adds.push(row);
  });
  if (adds.length) put_(sh, def, sh.getLastRow() + 1, adds);

  deletes.map(function (id) { return index[id]; })
    .filter(function (row) { return row; })
    .sort(function (a, b) { return b - a; })
    .forEach(function (row) { sh.deleteRow(row); });
}

// Plain text everywhere so Sheets never reformats dates; Hours stays a number for sums
function put_(sh, def, startRow, rows) {
  var width = def.headers.length;
  var extra = startRow + rows.length - 1 - sh.getMaxRows();
  if (extra > 0) sh.insertRowsAfter(sh.getMaxRows(), extra);
  var formats = rows.map(function () {
    var f = [];
    for (var c = 0; c < width; c++) f.push(c === def.hoursCol ? '0.00' : '@');
    return f;
  });
  var range = sh.getRange(startRow, 1, rows.length, width);
  range.setNumberFormats(formats);
  range.setValues(rows);
}

function time_(iso, zone) {
  return iso ? Utilities.formatDate(new Date(iso), zone, 'h:mm a') : '';
}

function recordRow_(r, zone) {
  var hours = r.departureIso
    ? Math.round((new Date(r.departureIso) - new Date(r.arrivalIso)) / 36000) / 100
    : '';
  return [r.id, r.employeeId, r.employeeName, r.date, time_(r.arrivalIso, zone), time_(r.departureIso, zone),
          hours, STATUS[r.status] || r.status, METHOD[r.method] || r.method || '', r.notes || '',
          r.arrivalIso || '', r.departureIso || ''];
}

function staffRow_(e) {
  return [e.id, e.name, e.role || '', e.department || '', e.badgeCode || e.id,
          e.access === 'supervisor' ? 'Supervisor' : 'Staff'];
}
`;

function sheetScript(apiUrl, key) {
    return TEMPLATE
        .replace('__API__', () => JSON.stringify(apiUrl))
        .replace('__KEY__', () => JSON.stringify(key));
}

module.exports = { sheetScript };
