/**
 * Clock Engine — attendance rules.
 * Decides whether a punch is a clock-in or clock-out, supports undo, validates
 * manual entries and closes shifts that were never clocked out.
 */
class ClockEngine {
    constructor() {
        this.storage = window.clockStorage;
        // A shift left open longer than this is treated as a forgotten clock-out
        this.MAX_SHIFT_HOURS = 18;
        // A badge seen again this soon after a punch is ignored (not toggled back)
        this.RESCAN_GUARD_MS = 60000;
        this.lastPunchAt = {};
    }

    isOpen(record, now = Date.now()) {
        return record.status === 'CLOCKED_IN'
            && now - new Date(record.arrivalIso).getTime() < this.MAX_SHIFT_HOURS * 3600000;
    }

    getOpenRecord(employeeId) {
        return this.storage.getRecords().find(r => r.employeeId === employeeId && this.isOpen(r));
    }

    // Mark shifts nobody clocked out of, so they stop counting as "in"
    sweepStale() {
        this.storage.getRecords()
            .filter(r => r.status === 'CLOCKED_IN' && !this.isOpen(r))
            .forEach(r => this.storage.putRecord({ ...r, status: 'MISSED' }));
    }

    minutesWorked(record, now = new Date()) {
        if (record.departureIso) return U.minutesBetween(record.arrivalIso, record.departureIso);
        if (this.isOpen(record)) return U.minutesBetween(record.arrivalIso, now.toISOString());
        return null;
    }

    // One action for everything: clocks in, or clocks out if already in.
    punch(identifier, method = 'TAP') {
        const employee = this.storage.getEmployeeById(identifier);
        if (!employee) {
            return { ok: false, reason: 'unknown', message: 'Badge not recognised. Ask a supervisor to check the staff list.' };
        }

        const now = new Date();
        const open = this.getOpenRecord(employee.id);
        const last = this.lastPunchAt[employee.id] || 0;

        if (method === 'QR' && now - last < this.RESCAN_GUARD_MS) {
            return {
                ok: false, reason: 'recent', employee,
                message: `${employee.name} is already clocked ${open ? 'in' : 'out'}.`
            };
        }
        this.lastPunchAt[employee.id] = now.getTime();

        if (!open) {
            const record = this.storage.putRecord({
                id: U.uid('punch'),
                employeeId: employee.id,
                employeeName: employee.name,
                date: U.dateKey(now),
                arrivalIso: now.toISOString(),
                departureIso: null,
                status: 'CLOCKED_IN',
                method,
                notes: ''
            });
            return { ok: true, action: 'in', employee, record, at: now };
        }

        const record = this.storage.putRecord({ ...open, departureIso: now.toISOString(), status: 'COMPLETED' });
        return { ok: true, action: 'out', employee, record, previous: open, at: now };
    }

    // Reverse a punch made by mistake
    undo(result) {
        if (!result || !result.ok) return;
        if (result.action === 'in') this.storage.deleteRecord(result.record.id);
        else this.storage.putRecord(result.previous);
        delete this.lastPunchAt[result.employee.id];
    }

    getStatus(employeeId) {
        const open = this.getOpenRecord(employeeId);
        if (open) return { state: 'in', record: open };

        const today = U.dateKey();
        const done = this.storage.getRecords().find(r => r.employeeId === employeeId && r.date === today && r.departureIso);
        return done ? { state: 'done', record: done } : { state: 'out' };
    }

    getMetrics() {
        const counts = { in: 0, done: 0, out: 0, total: 0 };
        this.storage.getEmployees().forEach(e => {
            counts[this.getStatus(e.id).state]++;
            counts.total++;
        });
        return counts;
    }

    // Build the arrival/departure pair for a manual entry.
    // A clock-out earlier than the clock-in means the shift ended the next day.
    resolveTimes(date, inTime, outTime) {
        if (!date || !inTime) return null;
        const arrival = new Date(`${date}T${inTime}:00`);
        if (isNaN(arrival)) return null;
        let departure = null;
        let overnight = false;
        if (outTime) {
            departure = new Date(`${date}T${outTime}:00`);
            if (departure <= arrival) {
                departure = U.addDays(departure, 1);
                overnight = true;
            }
        }
        return { arrival, departure, overnight, minutes: departure ? Math.floor((departure - arrival) / 60000) : null };
    }

    // Add or correct an entry by hand
    saveEntry({ id, employeeId, date, inTime, outTime, notes }) {
        const employee = this.storage.getEmployeeById(employeeId);
        const existing = id ? this.storage.getRecord(id) : null;
        if (!employee && !existing) return { ok: false, field: 'employee', message: 'Choose a staff member.' };

        const times = this.resolveTimes(date, inTime, outTime);
        if (!times) return { ok: false, field: 'in', message: 'Enter the date and the clock-in time.' };
        if (times.arrival > new Date()) return { ok: false, field: 'in', message: 'The clock-in time is in the future.' };
        if (times.departure && times.departure > new Date()) return { ok: false, field: 'out', message: 'The clock-out time is in the future.' };
        if (times.minutes != null && times.minutes > this.MAX_SHIFT_HOURS * 60) {
            return { ok: false, field: 'out', message: `That shift is longer than ${this.MAX_SHIFT_HOURS} hours. Check the times.` };
        }

        const targetId = existing ? existing.employeeId : employee.id;
        if (!times.departure) {
            const open = this.getOpenRecord(targetId);
            if (open && open.id !== id) {
                return { ok: false, field: 'out', message: 'This person is already clocked in. Add a clock-out time, or clock them out first.' };
            }
        }

        let status = 'COMPLETED';
        if (!times.departure) {
            status = Date.now() - times.arrival.getTime() < this.MAX_SHIFT_HOURS * 3600000 ? 'CLOCKED_IN' : 'MISSED';
        }

        const record = this.storage.putRecord({
            id: existing ? existing.id : U.uid('man'),
            employeeId: targetId,
            employeeName: existing ? existing.employeeName : employee.name,
            date,
            arrivalIso: times.arrival.toISOString(),
            departureIso: times.departure ? times.departure.toISOString() : null,
            status,
            method: existing ? existing.method : 'MANUAL',
            notes: String(notes || '').trim()
        });
        return { ok: true, record };
    }
}

window.clockEngine = new ClockEngine();
