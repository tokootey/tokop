'use strict';

/* Panel de Floty: contraseña inicial fácil de pasar, contraseña nueva y datos de cada agencia (nombre, tipo, logo, administrador). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, getSetting } = require('../src/db');
const { openPlatform, initialPassword } = require('../src/platform');
const { verifyPassword, passwordProblem } = require('../src/auth');

test('contraseña inicial: sin letras ni números que se confunden y sin símbolos que cortan el doble clic', () => {
  for (let i = 0; i < 200; i++) {
    const p = initialPassword('ana@agencia.test');
    assert.match(p, /^[a-km-zA-HJ-NP-Z2-9]{12}$/);
    assert.equal(passwordProblem(p, 'ana@agencia.test'), null);
  }
});

test('datos de la agencia y contraseña nueva del administrador', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-agencias-'));
  const file = path.join(dir, 'rentacar.db');
  const platform = openPlatform(openDb(file), file);
  const a = platform.create({ name: 'Andes Rent', country: 'AR', admin_name: 'Ana', admin_email: 'ana@andes.test' });
  platform.create({ name: 'Sur Autos', country: 'AR', admin_name: 'Beto', admin_email: 'beto@sur.test' });
  const id = a.company.id;
  const db = () => platform.get(id).db;
  const admin = () => db().prepare("SELECT * FROM users WHERE role = 'admin'").get();
  assert.match(a.admin.password, /^[a-km-zA-HJ-NP-Z2-9]{12}$/);

  const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const r = platform.updateProfile(id, { name: 'Andes Rent a Car', business_mode: 'choferes', logo, admin_name: 'Ana Pérez', admin_email: 'Ana.Perez@Andes.test' });
  assert.equal(r.name, 'Andes Rent a Car');
  assert.equal(r.logo, logo);
  assert.equal(r.business_mode, 'choferes');
  assert.equal(getSetting(db(), 'company_name'), 'Andes Rent a Car');
  assert.equal(platform.get(id).name, 'Andes Rent a Car');
  assert.equal(platform.get(id).slug, a.company.slug, 'la dirección no cambia');
  assert.deepEqual([admin().name, admin().email], ['Ana Pérez', 'ana.perez@andes.test']);
  assert.equal(platform.byEmail('ana.perez@andes.test').id, id, 'entra con el email nuevo');

  // Validaciones: email de otra agencia, logo que no es imagen, tipo inválido, nombre vacío.
  assert.throws(() => platform.updateProfile(id, { admin_email: 'beto@sur.test' }), /ya lo usa/);
  assert.throws(() => platform.updateProfile(id, { logo: 'data:text/html;base64,PGgxPg==' }), /imagen/);
  assert.throws(() => platform.updateProfile(id, { logo: `data:image/png;base64,${'A'.repeat(400 * 1024)}` }), /imagen/);
  assert.throws(() => platform.updateProfile(id, { business_mode: 'otro' }), /Tipo de negocio/);
  assert.throws(() => platform.updateProfile(id, { name: '  ' }), /nombre/);
  platform.updateProfile(id, { logo: '' });
  assert.equal(platform.stats(id).logo, null, 'quitar el logo');

  // Contraseña nueva: la anterior deja de servir, tiene que cambiarla al entrar y se cierran sus sesiones.
  db().prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('x', ?, '2999-01-01')").run(admin().id);
  const reset = platform.resetAdminPassword(id);
  assert.equal(reset.email, 'ana.perez@andes.test');
  assert.ok(verifyPassword(reset.password, admin().password_hash));
  assert.ok(!verifyPassword(a.admin.password, admin().password_hash));
  assert.equal(admin().must_change_password, 1);
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.throws(() => platform.resetAdminPassword(999), /inexistente/);
});
