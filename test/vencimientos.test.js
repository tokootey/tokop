'use strict';

/*
 * Libreta del dueño de Floty: vencimientos que se corren solos al pagarlos, abono de cada agencia
 * y ficha de contacto. Todo en el registro de empresas, sin tocar los datos de las agencias.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { openPlatform } = require('../src/platform');
const { addMonths } = require('../src/owner-book');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-book-'));
const dbFile = path.join(dir, 'rentacar.db');
const platform = openPlatform(openDb(dbFile), dbFile);
const { book } = platform;

test.after(() => {
  platform.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sumar meses no se pasa de fin de mes', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(addMonths('2026-10-20', 12), '2027-10-20');
});

test('arranca con el dominio, Render y Netlify; pagar corre la fecha y queda anotado', () => {
  const titles = book.reminders().map((r) => r.title);
  assert.ok(titles.some((t) => t.includes('flotyapp.com.ar')));
  const nic = book.reminders().find((r) => r.title.includes('flotyapp.com.ar'));
  assert.equal(nic.due_date, '2027-10-20');
  assert.equal(book.payReminder(nic.id, { amount: 9000 }).due_date, '2028-10-20');
  assert.equal(book.payments('reminder', nic.id)[0].amount, 9000);

  const once = book.addReminder({ title: 'Renovar marca', due_date: '2026-12-01', repeat: 'una_vez' });
  book.payReminder(once.id);
  assert.ok(!book.reminders().some((r) => r.id === once.id), 'una sola vez: se archiva al pagarla');

  assert.throws(() => book.addReminder({ title: '' }), /qué hay que pagar/);
  assert.throws(() => book.addReminder({ title: 'X', due_date: '31/12/2026' }), /fecha no es válida/);
  const r = book.addReminder({ title: 'Contador', repeat: 'mensual', amount: '30000' });
  assert.equal(book.updateReminder(r.id, { title: 'Contador', repeat: 'mensual', due_date: '2026-11-10' }).due_date, '2026-11-10');
  book.removeReminder(r.id);
  assert.throws(() => book.removeReminder(r.id), /inexistente/);
});

test('ficha y abono de una agencia: se guarda, se cobra y el próximo cobro pasa al mes siguiente', () => {
  const { company } = platform.create({ name: 'Andes Rent', country: 'AR', admin_name: 'Ana', admin_email: 'ana@andes.test' });
  const saved = book.updateCompany(company.id, { contact_phone: '+54 9 2901 555111', notes: 'Cargarle la flota', plan_price: '25000', billing_day: '10', next_charge: '2026-10-10' });
  assert.equal(saved.plan_price, 25000);
  assert.equal(saved.contact_phone, '+54 9 2901 555111');
  // Solo cambia lo que viene: la nota queda.
  assert.equal(book.updateCompany(company.id, { trial_ends: '2026-11-01' }).notes, 'Cargarle la flota');
  assert.throws(() => book.updateCompany(company.id, { billing_day: 40 }), /1 al 31/);

  assert.equal(book.payCompany(company.id).next_charge, '2026-11-10');
  const [p] = book.payments('company', company.id);
  assert.equal(p.amount, 25000);
  assert.equal(p.period, '2026-10-10');
  assert.equal(platform.list().find((c) => c.id === company.id).next_charge, '2026-11-10');
});
