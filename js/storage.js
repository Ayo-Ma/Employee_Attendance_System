/**
 * Storage layer.
 * Staff, attendance records and settings are kept in localStorage so the app
 * works offline. Every change is also handed to sheetsSync, which pushes it to
 * the Google Sheet and pulls back what other devices have recorded.
 */
class ClockStorage {
    constructor() {
        this.EMPLOYEES_KEY = 'clockin_employees_v1';
        this.RECORDS_KEY = 'clockin_records_v1';
        this.SETTINGS_KEY = 'clockin_settings_v1';
        this.listeners = [];
        this.emitQueued = false;
        this.memory = {};
        this.migrate();

        // Another tab on this device changed something
        window.addEventListener('storage', (e) => {
            if ([this.EMPLOYEES_KEY, this.RECORDS_KEY, this.SETTINGS_KEY].includes(e.key)) this.emit();
        });
    }

    // --- Raw access (falls back to memory when localStorage is blocked) ---
    read(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw == null ? (key in this.memory ? this.memory[key] : fallback) : JSON.parse(raw);
        } catch (e) {
            return key in this.memory ? this.memory[key] : fallback;
        }
    }

    write(key, value) {
        this.memory[key] = value;
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            console.warn('[PDN] Could not save to this browser:', e);
        }
    }

    onChange(fn) {
        this.listeners.push(fn);
    }

    // Coalesce several writes in one tick into a single re-render
    emit() {
        if (this.emitQueued) return;
        this.emitQueued = true;
        queueMicrotask(() => {
            this.emitQueued = false;
            this.listeners.forEach(fn => fn());
        });
    }

    // Earlier versions seeded five sample people and two fake punches on first
    // launch. Remove the ones nobody touched so they never reach the real sheet.
    migrate() {
        const settings = this.read(this.SETTINGS_KEY, {});
        if (settings.dataVersion >= 2) return;

        const demoNames = {
            'EMP-1001': 'Alex Rivera', 'EMP-1002': 'Maya Lin', 'EMP-1003': 'David Okafor',
            'EMP-1004': 'Elena Rostova', 'EMP-1005': 'Marcus Vance'
        };
        const records = this.read(this.RECORDS_KEY, []).filter(r => !String(r.id).startsWith('rec-'));
        const used = new Set(records.map(r => r.employeeId));
        const employees = this.read(this.EMPLOYEES_KEY, [])
            .filter(e => !(demoNames[e.id] === e.name && !used.has(e.id)));

        this.write(this.RECORDS_KEY, records);
        this.write(this.EMPLOYEES_KEY, employees);
        this.write(this.SETTINGS_KEY, { ...settings, dataVersion: 2 });
    }

    queue(type, op, id, data) {
        if (window.sheetsSync) window.sheetsSync.enqueue(type, op, id, data);
    }

    // --- Staff ---
    getEmployees() {
        return this.read(this.EMPLOYEES_KEY, [])
            .filter(e => e.active !== false)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    getEmployeeById(idOrCode) {
        const key = String(idOrCode || '').trim().toUpperCase();
        return this.getEmployees().find(e => e.id.toUpperCase() === key || String(e.badgeCode || '').toUpperCase() === key);
    }

    nextEmployeeId(employees) {
        const highest = employees.reduce((max, e) => {
            const n = parseInt(String(e.id).replace(/\D/g, ''), 10);
            return n > max ? n : max;
        }, 1000);
        return `EMP-${highest + 1}`;
    }

    // Add (no id) or update (id) a staff member
    saveEmployee(data) {
        const employees = this.read(this.EMPLOYEES_KEY, []);
        const colors = ['#3b2fc9', '#0e7c66', '#b4472b', '#8a2e7a', '#2b6cb0', '#8b6b12', '#3f6b2a', '#a8324f'];
        const index = employees.findIndex(e => e.id === data.id);
        const existing = index === -1 ? null : employees[index];
        const id = existing ? existing.id : (data.id || this.nextEmployeeId(employees));

        const employee = {
            id,
            name: String(data.name || '').trim(),
            role: String(data.role || '').trim(),
            department: String(data.department || '').trim(),
            badgeCode: (existing && existing.badgeCode) || data.badgeCode || id,
            avatarColor: (existing && existing.avatarColor) || data.avatarColor || colors[employees.length % colors.length],
            active: true,
            // Set by the sheet, never by this page; kept so the screen stays accurate
            access: (existing && existing.access) || data.access || 'staff',
            hasPin: !!((existing && existing.hasPin) || data.hasPin),
            updatedAt: Date.now()
        };

        if (existing) employees[index] = employee;
        else employees.push(employee);

        this.write(this.EMPLOYEES_KEY, employees);
        this.queue('employee', 'upsert', id, employee);
        this.emit();
        return employee;
    }

    deleteEmployee(id) {
        this.write(this.EMPLOYEES_KEY, this.read(this.EMPLOYEES_KEY, []).filter(e => e.id !== id));
        this.queue('employee', 'delete', id);
        this.emit();
    }

    // --- Attendance records ---
    getRecords() {
        return this.read(this.RECORDS_KEY, [])
            .sort((a, b) => String(b.arrivalIso).localeCompare(String(a.arrivalIso)));
    }

    getRecord(id) {
        return this.read(this.RECORDS_KEY, []).find(r => r.id === id);
    }

    // Insert or replace a record
    putRecord(record) {
        const records = this.read(this.RECORDS_KEY, []);
        const saved = { ...record, updatedAt: Date.now() };
        const index = records.findIndex(r => r.id === saved.id);
        if (index === -1) records.push(saved);
        else records[index] = saved;

        this.write(this.RECORDS_KEY, records);
        this.queue('record', 'upsert', saved.id, saved);
        this.emit();
        return saved;
    }

    deleteRecord(id) {
        this.write(this.RECORDS_KEY, this.read(this.RECORDS_KEY, []).filter(r => r.id !== id));
        this.queue('record', 'delete', id);
        this.emit();
    }

    // --- Settings (this device only) ---
    getSettings() {
        return this.read(this.SETTINGS_KEY, {});
    }

    saveSettings(patch) {
        const settings = { ...this.getSettings(), ...patch };
        this.write(this.SETTINGS_KEY, settings);
        return settings;
    }

    // --- Merge what the Google Sheet returned ---
    // The sheet is the shared truth, except for anything this device has
    // changed and not yet uploaded (`pending` holds those "type:id" keys).
    applyRemote(remote, pending, since) {
        const core = r => JSON.stringify([r.employeeId, r.employeeName, r.date, r.arrivalIso, r.departureIso || null, r.status, r.method || '', r.notes || '']);
        let changed = false;

        if (Array.isArray(remote.employees)) {
            const local = this.read(this.EMPLOYEES_KEY, []);
            const next = [];

            remote.employees.forEach(e => {
                if (pending.has(`employee:${e.id}`)) return;
                next.push({ ...e, active: true });
            });
            // Keep local staff that are still waiting to upload
            local.forEach(e => {
                if (pending.has(`employee:${e.id}`)) next.push(e);
            });

            const sig = list => JSON.stringify(list.map(e => [e.id, e.name, e.role, e.department, e.badgeCode, e.avatarColor, e.access || 'staff', !!e.hasPin]).sort());
            if (sig(next) !== sig(local)) {
                this.write(this.EMPLOYEES_KEY, next);
                changed = true;
            }
        }

        if (Array.isArray(remote.records)) {
            const local = this.read(this.RECORDS_KEY, []);
            const remoteIds = new Set(remote.records.map(r => r.id));
            const localById = new Map(local.map(r => [r.id, r]));
            const next = [];

            remote.records.forEach(r => {
                const mine = localById.get(r.id);
                if (pending.has(`record:${r.id}`)) return;
                if (!mine || core(mine) !== core(r)) changed = true;
                next.push(r);
            });

            local.forEach(r => {
                if (pending.has(`record:${r.id}`)) {
                    next.push(r);                       // not uploaded yet
                } else if (!remoteIds.has(r.id)) {
                    if (r.date < since) next.push(r);   // older than the sync window
                    else changed = true;                // deleted on another device
                }
            });

            if (changed) this.write(this.RECORDS_KEY, next);
        }

        if (changed) this.emit();
        return changed;
    }

    // Apply only what changed on the server since this device last asked:
    // new or edited staff and records, and deletions. Anything this device
    // has changed and not yet uploaded (`pending`) is left alone.
    applyChanges(changes, pending) {
        const gone = new Set((changes.deleted || []).map(d => `${d.type}:${d.id}`));
        let changed = false;

        const merge = (key, type, incoming) => {
            const list = this.read(key, []);
            const byId = new Map(list.map(item => [item.id, item]));
            let touched = false;
            (incoming || []).forEach(item => {
                if (pending.has(`${type}:${item.id}`)) return;
                const next = type === 'employee' ? { ...item, active: true } : item;
                if (JSON.stringify(byId.get(item.id)) !== JSON.stringify(next)) {
                    byId.set(item.id, next);
                    touched = true;
                }
            });
            byId.forEach((item, id) => {
                if (gone.has(`${type}:${id}`) && !pending.has(`${type}:${id}`)) {
                    byId.delete(id);
                    touched = true;
                }
            });
            if (touched) {
                this.write(key, Array.from(byId.values()));
                changed = true;
            }
        };

        merge(this.EMPLOYEES_KEY, 'employee', changes.employees);
        merge(this.RECORDS_KEY, 'record', changes.records);
        if (changed) this.emit();
        return changed;
    }

    // --- CSV export ---
    exportToCSV(rows, filename) {
        const cell = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
        const csv = rows.map(row => row.map(cell).join(',')).join('\r\n');
        const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

window.clockStorage = new ClockStorage();
