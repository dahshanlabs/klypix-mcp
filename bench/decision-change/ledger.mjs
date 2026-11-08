// One durable budget for agent calls, observers, smokes and retries. Reserving
// money does not itself enforce a provider limit: each caller must enforce the
// same maximum on its provider request before it starts paid work.
import fs from 'node:fs';
import path from 'node:path';

const cents = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Budget amount must be finite and nonnegative');
  return Math.ceil((n - 1e-9) * 100);
};

export class BudgetLedger {
  constructor(file, { limitUsd = 50 } = {}) {
    this.file = path.resolve(file);
    this.limitCents = cents(limitUsd);
    if (!this.limitCents) throw new Error('Budget must be positive');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) this.transaction(() => {
      if (!fs.existsSync(this.file)) this.append({ type: 'init', limitCents: this.limitCents });
    });
    if (this.snapshot().limitCents !== this.limitCents) throw new Error('Existing ledger has a different budget');
  }
  append(event) {
    const fd = fs.openSync(this.file, 'a');
    try { fs.writeSync(fd, `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  }
  transaction(fn) {
    const lock = `${this.file}.lock`;
    let fd;
    try { fd = fs.openSync(lock, 'wx'); }
    catch { throw new Error('Budget ledger is locked; paid work must wait (never remove a live lock)'); }
    try { return fn(); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  snapshot() {
    const events = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    if (events[0]?.type !== 'init') throw new Error('Invalid budget ledger');
    const reservations = new Map();
    let halted = false;
    for (const event of events.slice(1)) {
      if (event.type === 'reserve') {
        if (reservations.has(event.id)) throw new Error(`Duplicate reservation ${event.id}`);
        reservations.set(event.id, { ...event, status: 'reserved' });
      } else if (event.type === 'settle' || event.type === 'unknown') {
        const prior = reservations.get(event.id);
        if (!prior || prior.status !== 'reserved') throw new Error(`Invalid settlement ${event.id}`);
        reservations.set(event.id, { ...prior, ...event, status: event.type });
        if (event.type === 'unknown' || event.actualCents > prior.maxCents) halted = true;
      } else if (event.type === 'halt') halted = true;
      else throw new Error(`Unknown ledger event ${event.type}`);
    }
    let spentCents = 0; let reservedCents = 0;
    for (const r of reservations.values()) {
      if (r.status === 'reserved') reservedCents += r.maxCents;
      else spentCents += r.status === 'unknown' ? r.maxCents : r.actualCents;
    }
    const limitCents = events[0].limitCents;
    return { limitCents, spentCents, reservedCents, remainingCents: limitCents - spentCents - reservedCents,
      halted: halted || spentCents + reservedCents > limitCents, reservations: [...reservations.values()] };
  }
  remaining() { const s = this.snapshot(); return s.halted ? 0 : s.remainingCents / 100; }
  reserve({ id, kind, maxUsd, meta = {} }) {
    return this.transaction(() => {
      const state = this.snapshot(); const maxCents = cents(maxUsd);
      if (!id || !kind || !maxCents) throw new Error('Reservation requires id, kind and positive maxUsd');
      if (state.reservations.some(r => r.id === id)) throw new Error(`Reservation already exists: ${id}`);
      if (state.halted || maxCents > state.remainingCents) throw new Error('Aggregate budget exhausted or accounting uncertain; no paid call started');
      const r = { type: 'reserve', id, kind, maxCents, meta };
      this.append(r);
      return { ...r, maxUsd: maxCents / 100 };
    });
  }
  settle(id, { actualUsd, usage = null } = {}) {
    return this.transaction(() => {
      const prior = this.snapshot().reservations.find(r => r.id === id);
      if (!prior || prior.status !== 'reserved') throw new Error(`No open reservation: ${id}`);
      const actualCents = cents(actualUsd);
      this.append({ type: 'settle', id, actualCents, actualUsd: Number(actualUsd), usage });
      if (actualCents > prior.maxCents) throw new Error('Provider exceeded its reserved cap; ledger halted');
      return this.snapshot();
    });
  }
  unknown(id, { reason = 'Provider cost unavailable' } = {}) {
    return this.transaction(() => {
      const prior = this.snapshot().reservations.find(r => r.id === id);
      if (!prior || prior.status !== 'reserved') throw new Error(`No open reservation: ${id}`);
      this.append({ type: 'unknown', id, reason });
      return this.snapshot();
    });
  }
  halt(reason) {
    return this.transaction(() => {
      this.append({ type: 'halt', reason: String(reason || 'Accounting review required') });
      return this.snapshot();
    });
  }
}

export function costBetween(before, after) {
  const previous = new Set(before.reservations.map(record => record.id));
  const records = after.reservations.filter(record => !previous.has(record.id));
  const uncertain = records.some(record => record.status !== 'settle');
  return { apiEquivalentUsd: uncertain ? null : records.reduce((sum, record) => sum + record.actualUsd, 0),
    chargedAgainstCapUsd: (after.spentCents - before.spentCents) / 100,
    uncertain, reservations: records.map(record => ({ id: record.id, kind: record.kind, status: record.status,
      actualUsd: record.actualUsd ?? null, reservedUsd: record.maxCents / 100 })) };
}
