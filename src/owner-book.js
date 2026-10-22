'use strict';

const { fail } = require('./util');

/**
 * Libreta del dueño de Floty (Panel de Floty): sus vencimientos (dominio, servidor, etc.),
 * el abono de cada agencia y su ficha de contacto. Vive en el registro de empresas (empresas.db).
 * No cobra nada: sólo lleva la cuenta y avisa.
 */

/** Campos de la ficha de cada agencia que carga el dueño. */
const COMPANY_FIELDS = ['contact_name', 'contact_phone', 'notes', 'plan_price', 'billing_day', 'next_charge', 'trial_ends', 'domain_expires', 'cert_expires'];
const REPEATS = ['anual', 'mensual', 'una_vez'];

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T12:00:00Z`).getTime());
const date = (v, label) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!isDate(s)) fail(400, `${label}: la fecha no es válida`);
  return s;
};
const amount = (v, label) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) fail(400, `${label}: tiene que ser un número`);
  return Math.round(n * 100) / 100;
};
const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;

/** Suma meses a una fecha AAAA-MM-DD sin pasarse de fin de mes (31/01 + 1 mes = 28 o 29/02). */
function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

function ownerBook(reg) {
  const cols = reg.prepare('PRAGMA table_info(companies)').all().map((c) => c.name);
  for (const f of COMPANY_FIELDS) {
    if (!cols.includes(f)) reg.exec(`ALTER TABLE companies ADD COLUMN ${f} ${['plan_price', 'billing_day'].includes(f) ? 'REAL' : 'TEXT'}`);
  }
  const fresh = !reg.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reminders'").get();
  reg.exec(`CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    due_date TEXT,
    repeat TEXT NOT NULL DEFAULT 'anual',
    amount REAL,
    note TEXT,
    done_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    ref_id INTEGER NOT NULL,
    paid_at TEXT NOT NULL,
    period TEXT,
    amount REAL,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_payments_ref ON payments(kind, ref_id);`);
  // La primera vez arranca con lo que Mateo ya paga (datos que pasó él, 22/10/2026).
  if (fresh) {
    const add = reg.prepare('INSERT INTO reminders (title, due_date, repeat, note) VALUES (?, ?, ?, ?)');
    add.run('Dominio flotyapp.com.ar (NIC Argentina)', '2027-10-20', 'anual', 'Se renueva en nic.ar con tu clave fiscal.');
    add.run('Render (servidor de Floty)', null, 'mensual', 'Cargá la fecha cuando publiques la versión paga.');
    add.run('Netlify (página web)', '2026-11-20', 'mensual', 'Plan de la página flotyapp.com.ar.');
  }

  const getReminder = (id) => reg.prepare('SELECT * FROM reminders WHERE id = ?').get(Number(id)) || fail(404, 'Vencimiento inexistente');
  const reminderData = (b) => {
    const title = text(b.title, 120);
    if (!title) fail(400, 'Poné qué hay que pagar o renovar');
    const repeat = REPEATS.includes(b.repeat) ? b.repeat : 'anual';
    return [title, date(b.due_date, 'Vence el'), repeat, amount(b.amount, 'Monto'), text(b.note, 500)];
  };
  const log = reg.prepare('INSERT INTO payments (kind, ref_id, paid_at, period, amount, note) VALUES (?, ?, ?, ?, ?, ?)');
  const now = () => new Date().toISOString();

  return {
    reminders: () => reg.prepare('SELECT * FROM reminders WHERE done_at IS NULL ORDER BY due_date IS NULL, due_date, id').all(),
    addReminder: (b) => getReminder(reg.prepare('INSERT INTO reminders (title, due_date, repeat, amount, note) VALUES (?, ?, ?, ?, ?)').run(...reminderData(b || {})).lastInsertRowid),
    updateReminder(id, b) {
      getReminder(id);
      reg.prepare('UPDATE reminders SET title = ?, due_date = ?, repeat = ?, amount = ?, note = ? WHERE id = ?').run(...reminderData(b || {}), Number(id));
      return getReminder(id);
    },
    removeReminder(id) {
      getReminder(id);
      reg.prepare('DELETE FROM reminders WHERE id = ?').run(Number(id));
      return { ok: true };
    },
    /** Pagado: queda en el historial y la fecha pasa al año o al mes siguiente (o se archiva si era una sola vez). */
    payReminder(id, b = {}) {
      const r = getReminder(id);
      const p = log.run('reminder', r.id, now(), r.due_date, amount(b.amount, 'Monto') ?? r.amount, text(b.note, 200));
      if (r.repeat === 'una_vez') reg.prepare('UPDATE reminders SET done_at = ? WHERE id = ?').run(now(), r.id);
      else if (r.due_date) reg.prepare('UPDATE reminders SET due_date = ? WHERE id = ?').run(addMonths(r.due_date, r.repeat === 'anual' ? 12 : 1), r.id);
      return { ...getReminder(id), payment_id: Number(p.lastInsertRowid) };
    },

    /** Ficha y abono de una agencia: solo los campos que vienen en el pedido. */
    updateCompany(id, b = {}) {
      const c = reg.prepare('SELECT * FROM companies WHERE id = ? AND active = 1').get(Number(id)) || fail(404, 'Empresa inexistente');
      const v = {
        contact_name: () => text(b.contact_name, 120),
        contact_phone: () => text(b.contact_phone, 40),
        notes: () => text(b.notes, 2000),
        plan_price: () => amount(b.plan_price, 'Precio del plan'),
        billing_day: () => {
          const d = amount(b.billing_day, 'Día de cobro');
          if (d !== null && !(Number.isInteger(d) && d >= 1 && d <= 31)) fail(400, 'Día de cobro: un número del 1 al 31');
          return d;
        },
        next_charge: () => date(b.next_charge, 'Próximo cobro'),
        trial_ends: () => date(b.trial_ends, 'Fin de la prueba gratis'),
        domain_expires: () => date(b.domain_expires, 'Vencimiento del dominio'),
        cert_expires: () => date(b.cert_expires, 'Vencimiento del certificado'),
      };
      const keys = COMPANY_FIELDS.filter((k) => k in b);
      if (keys.length) reg.prepare(`UPDATE companies SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => v[k]()), c.id);
      return reg.prepare(`SELECT id, ${COMPANY_FIELDS.join(', ')} FROM companies WHERE id = ?`).get(c.id);
    },
    /** Cobro del abono: queda en el historial y el próximo cobro pasa al mes siguiente. */
    payCompany(id, b = {}) {
      const c = reg.prepare('SELECT * FROM companies WHERE id = ? AND active = 1').get(Number(id)) || fail(404, 'Empresa inexistente');
      const p = log.run('company', c.id, now(), c.next_charge, amount(b.amount, 'Monto') ?? c.plan_price, text(b.note, 200));
      const base = c.next_charge || new Date().toISOString().slice(0, 10);
      reg.prepare('UPDATE companies SET next_charge = ? WHERE id = ?').run(addMonths(base, 1), c.id);
      return { id: c.id, next_charge: addMonths(base, 1), payment_id: Number(p.lastInsertRowid) };
    },
    /**
     * Deshacer un "Pagado" tocado sin querer: vuelve la fecha que tenía y borra el pago del historial.
     * Solo el último pago de ese vencimiento o agencia (si hubo otro después, ya no es "sin querer").
     */
    undoPayment(id) {
      const p = reg.prepare('SELECT * FROM payments WHERE id = ?').get(Number(id)) || fail(404, 'Pago inexistente');
      const last = reg.prepare('SELECT MAX(id) id FROM payments WHERE kind = ? AND ref_id = ?').get(p.kind, p.ref_id).id;
      if (last !== p.id) fail(409, 'Solo se puede deshacer el último pago');
      if (p.kind === 'reminder') reg.prepare('UPDATE reminders SET due_date = ?, done_at = NULL WHERE id = ?').run(p.period, p.ref_id);
      else reg.prepare('UPDATE companies SET next_charge = ? WHERE id = ?').run(p.period, p.ref_id);
      reg.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
      return { ok: true };
    },
    payments: (kind, refId, limit = 12) => reg.prepare('SELECT * FROM payments WHERE kind = ? AND ref_id = ? ORDER BY id DESC LIMIT ?').all(kind, Number(refId), limit),
  };
}

module.exports = { ownerBook, addMonths, COMPANY_FIELDS };
