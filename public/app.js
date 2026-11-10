'use strict';

/* ============================================================
   Utilidades
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) =>
  v === null || v === undefined
    ? ''
    : String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = { user: null, settings: {}, branches: [], categories: [], extras: [] };

// Formato de números, moneda e impuesto según el país configurado (Ajustes → Empresa y contrato).
const locale = () => state.settings.locale || 'es-AR';
const taxName = () => state.settings.tax_name || 'IVA';
const taxIdLabel = () => state.settings.tax_id_label || 'CUIT';
const num = (n) => Number(n).toLocaleString(locale());
/** "1 reserva" / "3 reservas": en vez de "reserva(s)". */
const plural = (n, one, many) => `${num(n)} ${Number(n) === 1 ? one : many}`;
// WhatsApp: vacío o un número de 8 a 15 dígitos (con +, espacios, guiones o paréntesis).
const validPhone = (s) => !s || (/^[+\d\s().-]+$/.test(s) && String(s).replace(/\D/g, '').length >= 8 && String(s).replace(/\D/g, '').length <= 15);
const PHONE_ERROR = 'Tiene que ser un número con código de país, por ejemplo +54 9 2901 555123.';
// Una fecha que ya pasó (con 5 minutos de margen): se avisa antes de guardar.
const isPast = (d) => d < new Date(Date.now() - 5 * 60000);
const money = (n) => {
  const cur = state.settings.currency || 'ARS';
  try {
    return new Intl.NumberFormat(locale(), { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n || 0);
  } catch {
    return `${cur} ${Number(n || 0).toFixed(2)}`;
  }
};
// Las fechas también se escapan: se muestran dentro de HTML.
const fmtDT = (s) => (s ? esc(`${String(s).slice(8, 10)}/${String(s).slice(5, 7)}/${String(s).slice(0, 4)} ${String(s).slice(11, 16)}`) : '');
// Horas que guarda la base por su cuenta (CURRENT_TIMESTAMP): vienen en hora universal (UTC);
// se muestran en la hora de la compu o el celular de quien mira, que es la de la agencia.
const stampLocal = (s) => (s ? localISO(new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${String(s).replace(' ', 'T')}Z`)) : '');
const fmtD = (s) => (s ? esc(`${String(s).slice(8, 10)}/${String(s).slice(5, 7)}/${String(s).slice(0, 4)}`) : '');
const pad = (n) => String(n).padStart(2, '0');
const localISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());

const STATUS_LABEL = {
  pendiente: 'Pendiente',
  confirmada: 'Confirmada',
  en_curso: 'En curso',
  finalizada: 'Finalizada',
  cancelada: 'Cancelada',
  no_show: 'No show',
  disponible: 'Disponible',
  alquilado: 'Alquilado',
  mantenimiento: 'En el taller',
  fuera_servicio: 'Fuera de servicio',
  procesada: 'Procesada',
  duplicada: 'Duplicada',
  error: 'Error',
  recibida: 'Recibida',
  cotizador: 'Cotizador',
  web: 'Por internet',
  manual: 'Mostrador',
  importado: 'Importada',
  abierto: 'Abierto',
  cerrado: 'Cerrado',
};
const badge = (s) => `<span class="badge b-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
const sourceBadge = (s) => (s === 'manual' ? '' : ` <span class="badge b-cotizador">${esc(STATUS_LABEL[s] || s)}</span>`);
const fuel = (n) => (n === null || n === undefined ? '' : `${n}/8`);
// Modo "autos para choferes" (Configuración → Tipo de negocio): alquiler por período que se renueva solo.
const choferesMode = () => state.settings.business_mode === 'choferes';
// Solo las agencias a las que el dueño de Floty se lo activa: cada auto elige si paga cada 24 o cada 12 horas.
const payModes = () => choferesMode() && state.settings.rent_period === 'dia' && String(state.settings.pay_modes) === '1';
// Funciones en prueba: las activa el dueño de Floty por agencia, desde el panel.
const proOn = () => String(state.settings.pro_features) === '1';
const PERIOD_LABEL = { dia: ['día', 'días'], semana: ['semana', 'semanas'], mes: ['mes', 'meses'] };
const periodWord = (n = 1) => (PERIOD_LABEL[state.settings.rent_period] || PERIOD_LABEL.semana)[Number(n) === 1 ? 0 : 1];
/** Primera línea del precio: "3 días × $ 20.000" o, por períodos, "1 semana × $ 100.000". */
const baseLabel = (q, days) => (q.periods ? `${plural(q.periods, periodWord(1), periodWord(2))} × ${money(q.per_day)}` : `${plural(days, 'día', 'días')}${q.per_day ? ` × ${money(q.per_day)}` : ''}`);

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/password') {
    if (state.user) logout(false); // la sesión venció mientras se usaba la app
    throw new Error('Sesión vencida, volvé a ingresar');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}
const GET = (p) => api('GET', p);
const POST = (p, b) => api('POST', p, b || {});
const PUT = (p, b) => api('PUT', p, b);
const DEL = (p) => api('DELETE', p);

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isError);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 6000 : 3000);
}
/** Aviso con "Deshacer" (6 segundos): para lo que se toca sin querer, como "Pagado". */
function toastUndo(msg, onUndo) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span> <button type="button" class="toast-undo">Deshacer</button>`;
  t.classList.remove('err', 'hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 6000);
  $('.toast-undo', t).addEventListener('click', () => {
    t.classList.add('hidden');
    onUndo();
  });
}

/** Ejecuta una acción mostrando el error como toast. */
async function run(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'file') continue;
    if (el.type === 'checkbox') out[el.name] = el.checked ? 1 : 0;
    else if (el.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value === '' ? null : el.value;
  }
  return out;
}

/* ---------- Modal ---------- */
function openModal(title, html, onSubmit, { wide = false } = {}) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('.modal-box').style.maxWidth = wide ? '960px' : '720px';
  $('#modal').classList.remove('hidden');
  const form = $('#modal-body form');
  if (form && onSubmit) {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = form.querySelector('[type=submit]');
      if (btn) btn.disabled = true;
      try {
        // false = el usuario se arrepintió en una confirmación: la ventana queda abierta con lo cargado.
        if ((await onSubmit(formData(form), form)) !== false) closeModal();
      } catch (e) {
        toast(e.message, true);
      } finally {
        if (btn) btn.disabled = false;
      }
    });
    const first = form.querySelector('input:not([type=hidden]), select, textarea');
    if (first) first.focus();
  }
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modal-body').innerHTML = '';
}
/**
 * Pregunta antes de hacer algo (en lugar del cartelito del navegador). Se abre encima de cualquier ventana.
 * `danger`: la acción no tiene vuelta atrás, va en rojo y con aviso. El botón seguro ("Volver") queda elegido.
 * Devuelve una promesa con true (sí) o false (volver, Escape o tocar afuera).
 */
function confirmModal({ title, text, ok = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'modal confirm-modal';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'confirm-title');
    box.innerHTML = `<div class="modal-box card confirm-box${danger ? ' danger' : ''}">
        <span class="confirm-ic" aria-hidden="true">${danger ? ICON.alert : ICON.help}</span>
        <h2 id="confirm-title">${esc(title)}</h2>
        <p>${esc(text)}</p>
        ${danger ? '<p class="confirm-warn">Esta acción no se puede deshacer.</p>' : ''}
        <div class="actions"><button class="btn" type="button" data-no>Volver</button><button class="btn ${danger ? 'danger-solid' : 'primary'}" type="button" data-yes>${esc(ok)}</button></div>
      </div>`;
    const done = (v) => {
      document.removeEventListener('keydown', onKey, true);
      box.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation(); // que Escape no cierre también la ventana de abajo
      done(false);
    };
    document.addEventListener('keydown', onKey, true);
    box.addEventListener('click', (e) => {
      if (e.target === box || e.target.closest('[data-no]')) done(false);
      else if (e.target.closest('[data-yes]')) done(true);
    });
    document.body.appendChild(box);
    $('[data-no]', box).focus();
  });
}
document.addEventListener('click', (e) => {
  if (e.target.matches('[data-close]') || e.target.id === 'modal') closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

/* ---------- Formularios genéricos ---------- */
function field(f, value) {
  if (f.when && !f.when()) return ''; // campos que solo van en un tipo de negocio
  const v = value === undefined || value === null ? (f.default ?? '') : value;
  const cls = f.full ? ' class="full"' : '';
  const req = f.required ? ' required' : '';
  if (f.type === 'photos') {
    return `<label class="full">${esc(f.label)}<input name="${f.name}" type="file" accept="image/*,application/pdf" multiple/>
      <small class="muted">Desde el celular podés sacar las fotos de a una o elegirlas de la galería: se van sumando. Tocá una miniatura para sacarla.</small>
      <div class="thumbs photo-preview" style="margin-top:8px"></div></label>`;
  }
  if (f.type === 'checkbox') {
    return `<label class="check${f.full ? ' full' : ''}"><input type="checkbox" name="${f.name}" ${Number(v) ? 'checked' : ''}/> ${esc(f.label)}</label>`;
  }
  if (f.type === 'select') {
    const opts = (typeof f.options === 'function' ? f.options() : f.options)
      .map((o) => {
        const [val, lab] = Array.isArray(o) ? o : [o, STATUS_LABEL[o] || o];
        return `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(lab)}</option>`;
      })
      .join('');
    return `<label${cls}>${esc(f.label)}<select name="${f.name}"${req}>${f.required ? '' : '<option value=""></option>'}${opts}</select></label>`;
  }
  if (f.type === 'textarea') return `<label${cls}>${esc(f.label)}<textarea name="${f.name}"${req}${f.rows ? ` rows="${Number(f.rows)}"` : ''}>${esc(v)}</textarea></label>`;
  const step = f.type === 'number' ? ` step="${f.step || 'any'}"` : '';
  return `<label${cls}>${esc(f.label)}<input name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}"${step}${req} ${f.attrs || ''}/></label>`;
}
/* Fotos: cada elección se suma a las anteriores (con la cámara del celular sale una foto por vez) y se ven en miniatura. */
const pickedFiles = new WeakMap();
function setPhotos(input, files) {
  const dt = new DataTransfer();
  files.forEach((f) => dt.items.add(f));
  input.files = dt.files;
  pickedFiles.set(input, files);
  const box = input.parentElement.querySelector('.photo-preview');
  if (!box) return;
  box.querySelectorAll('img').forEach((img) => URL.revokeObjectURL(img.src));
  box.innerHTML = files
    .map((f, i) => `<button type="button" class="thumb" data-unpick="${i}" title="Sacar ${esc(f.name)}">${f.type.startsWith('image/') ? `<img alt="${esc(f.name)}" src="${URL.createObjectURL(f)}"/>` : 'PDF'}</button>`)
    .join('') + (files.length ? `<small class="muted">${files.length} archivo${files.length > 1 ? 's' : ''} elegido${files.length > 1 ? 's' : ''}</small>` : '');
}
document.addEventListener('change', (e) => {
  if (e.target.matches('input[type=file][name=fotos]')) setPhotos(e.target, [...(pickedFiles.get(e.target) || []), ...e.target.files]);
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-unpick]');
  if (!b) return;
  e.preventDefault(); // el botón está dentro del <label>: que no abra el selector de archivos
  const input = b.closest('label').querySelector('input[type=file]');
  setPhotos(input, (pickedFiles.get(input) || []).filter((_, i) => i !== Number(b.dataset.unpick)));
});

const formHtml = (fields, values = {}, submit = 'Guardar') =>
  `<form><div class="form-grid">${fields.map((f) => field(f, values[f.name])).join('')}</div>
   <div class="actions" style="margin-top:16px"><button class="btn primary" type="submit">${esc(submit)}</button><button class="btn" type="button" data-close>Cancelar</button></div></form>`;

/* ============================================================
   Sesión
   ============================================================ */
async function loadCatalogs() {
  const [settings, branches, categories, extras] = await Promise.all([GET('/settings'), GET('/branches'), GET('/categories'), GET('/extras')]);
  Object.assign(state, { settings, branches, categories, extras });
  $('#brand').textContent = settings.company_name || 'Floty';
  const logo = $('.brand img');
  logo.dataset.floty ??= logo.getAttribute('src'); // el de Floty, para volver a él si la agencia no tiene logo
  logo.src = settings.company_logo || logo.dataset.floty;
  $('.brand small').classList.toggle('hidden', !settings.company_name); // "Floty con Floty" no
  document.title = settings.company_name ? `${settings.company_name} · Floty` : 'Floty · Gestión para rent a car';
  renderBranchPick();
}

// Selector de sucursal: con dos o más, Hoy, el calendario, las reservas y los autos muestran solo la elegida. Se recuerda en este navegador.
const BRANCH_KEY = 'floty-sucursal';
const branchQS = (sep = '?') => (state.branch ? `${sep}branch=${state.branch}` : '');
function renderBranchPick() {
  const list = state.branches.filter((b) => b.active);
  let saved = null;
  try {
    saved = Number(localStorage.getItem(BRANCH_KEY));
  } catch {}
  state.branch = list.length > 1 && list.some((b) => b.id === saved) ? saved : null;
  $('#branch-pick').classList.toggle('hidden', list.length < 2 || !!state.user.owner_mode);
  $('#branch-select').innerHTML = `<option value="">${L('Todas', 'All')}</option>${list.map((b) => `<option value="${b.id}"${b.id === state.branch ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}`;
}
$('#branch-select').addEventListener('change', (e) => {
  state.branch = Number(e.target.value) || null;
  try {
    localStorage.setItem(BRANCH_KEY, state.branch || '');
  } catch {}
  route();
});

async function startSession() {
  try {
    state.user = await GET('/auth/me');
  } catch {
    return showLogin();
  }
  if (state.user.must_change_password) return showForcedPasswordChange();
  $('#pwchange-screen')?.remove();
  $('#login').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  $('#user-name').textContent = state.user.name;
  $('#acct-btn').textContent = String(state.user.name || '?').trim().slice(0, 1).toUpperCase();
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', state.user.role !== 'admin'));
  // Panel de Floty: sólo el dueño de Floty (empresas y dominios), nunca las agencias.
  $('#floty-panel').classList.toggle('hidden', !state.user.platform_admin);
  await loadCatalogs();
  // El dueño de Floty no alquila autos: ve solo su panel administrativo.
  document.body.classList.toggle('owner', !!state.user.owner_mode);
  if (state.user.owner_mode) {
    $('#brand').textContent = 'Panel de Floty';
    $('.brand small').classList.add('hidden');
    document.title = 'Panel de Floty';
  }
  checkStale();
  route();
}

/** Si el programa de la ventana negra es más viejo que estas pantallas, avisar cómo reiniciarlo. */
async function checkStale() {
  const h = await fetch('/api/health').then((r) => r.json()).catch(() => ({}));
  if (!h.stale) return;
  const bar = document.createElement('div');
  bar.className = 'stale-bar';
  bar.innerHTML = '<b>La app se actualizó, pero sigue abierto el programa anterior.</b> Cerrá todas las ventanas negras y volvé a abrir <b>iniciar-windows</b>. Mientras tanto, algunas pantallas pueden fallar.';
  document.body.appendChild(bar);
}

function showLogin() {
  $('#pwchange-screen')?.remove();
  $('#shell').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

function logout(callApi = true) {
  if (callApi) POST('/auth/logout').catch(() => {});
  state.user = null;
  closeModal();
  const pw = $('#login-form [name=password]');
  if (pw) pw.value = '';
  showLogin();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  const btn = e.target.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    await api('POST', '/auth/login', formData(e.target));
    startSession();
  } catch (err) {
    $('#login-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});
$('#logout').addEventListener('click', () => logout());
// Menú de cuenta del Panel de Floty: se abre con el botón redondo y se cierra al tocar afuera o con Escape.
const acctMenu = (open) => {
  $('.user-box').classList.toggle('open', open);
  $('#acct-btn').setAttribute('aria-expanded', String(open));
};
$('#acct-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  acctMenu(!$('.user-box').classList.contains('open'));
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#acct-menu')) acctMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') acctMenu(false);
});
$('#change-pw').addEventListener('click', () =>
  openModal('Cambiar mi contraseña', passwordFormHtml(), async (d) => {
    await submitPasswordChange(d);
    toast('Contraseña cambiada. Las otras sesiones abiertas se cerraron.');
  }),
);

const PASSWORD_HINT = 'Mínimo 8 caracteres, con letras y números. Evitá datos fáciles de adivinar.';

function passwordFormHtml(submit = 'Cambiar contraseña') {
  return `<form><div class="form-grid">
    <label class="full">Contraseña actual<input name="current" type="password" required autocomplete="current-password"/></label>
    <label>Contraseña nueva<input name="password" type="password" required minlength="8" autocomplete="new-password"/></label>
    <label>Repetir contraseña nueva<input name="password2" type="password" required minlength="8" autocomplete="new-password"/></label>
    <p class="muted full" style="margin:0">${PASSWORD_HINT}</p>
  </div><div class="actions" style="margin-top:16px"><button class="btn primary" type="submit">${esc(submit)}</button></div></form>`;
}

async function submitPasswordChange(d) {
  if (d.password !== d.password2) throw new Error('Las contraseñas nuevas no coinciden');
  await api('POST', '/auth/password', { current: d.current, password: d.password });
}

/** Primer ingreso con una contraseña de fábrica o puesta por el administrador: hay que cambiarla. */
function showForcedPasswordChange() {
  $('#shell').classList.add('hidden');
  $('#login').classList.add('hidden');
  $('#pwchange-screen')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'pwchange-screen';
  wrap.className = 'login';
  wrap.innerHTML = `<div class="card login-card"><h1>Elegí tu contraseña</h1>
    <p class="muted">Por seguridad, antes de empezar cambiá la contraseña que te dieron por una propia.</p>
    ${passwordFormHtml('Guardar y entrar')}<p class="error" id="pwchange-error"></p>
    <button type="button" class="btn link" id="pwchange-out">Salir</button></div>`;
  document.body.appendChild(wrap);
  $('#pwchange-out', wrap).addEventListener('click', () => logout());
  $('form', wrap).addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#pwchange-error').textContent = '';
    try {
      await submitPasswordChange(formData(e.target));
      toast('Contraseña guardada');
      startSession();
    } catch (err) {
      $('#pwchange-error').textContent = err.message;
    }
  });
}

/* ============================================================
   Router
   ============================================================ */
const routes = [];
const on = (pattern, handler, navKey) => routes.push({ pattern, handler, navKey });

// Menú corto: "Ajustes" agrupa varias pantallas, que se eligen con pestañas arriba. El taller se maneja desde cada auto.
// Sección del menú que queda marcada (Ajustes, Reservas y Clientes están en "Más").
// detalle: una reserva se abre desde Hoy, el Calendario o Más; el menú deja marcada la sección de la que venías.
const NAV_MENU = { ajustes: 'mas', reservas: 'mas', clientes: 'mas', completa: 'mas', detalle: null };
const NAV_GROUP = { tarifas: 'ajustes', cotizador: 'ajustes', config: 'ajustes', usuarios: 'ajustes', importar: 'ajustes', asistente: 'ajustes' };
const SUBNAV = {
  ajustes: [
    ['tarifas', '#/tarifas', 'Tarifas y sucursales'],
    ['config', '#/config', 'Empresa y contrato', true],
    ['usuarios', '#/usuarios', 'Usuarios', true],
    ['cotizador', '#/cotizador', 'Cotizador web', true, true],
    ['asistente', '#/asistente', 'Link de reservas', true, true],
    ['importar', '#/importar', 'Importar datos', true],
  ],
};
function renderSubnav(group, current) {
  const nav = $('#subnav');
  // tourism: solo para alquiler turístico (en el modo autos para trabajo no aparece).
  const items = (SUBNAV[group] || []).filter(([, , , only, tourism]) => (!only || (only === 'platform' ? state.user.platform_admin : isAdmin())) && !(tourism && choferesMode()));
  nav.classList.toggle('hidden', items.length < 2);
  nav.innerHTML = items.map(([key, href, label]) => `<a href="${href}" class="${key === current ? 'active' : ''}">${esc(label)}</a>`).join('');
}

async function route() {
  if (!state.user) return;
  const hash = location.hash.replace(/^#/, '') || '/panel';
  if (state.user.owner_mode && !/^\/empresas(\/\d+\/estadisticas)?$/.test(hash)) {
    location.hash = '#/empresas'; // vuelve a entrar acá por hashchange
    return;
  }
  for (const r of routes) {
    const m = hash.match(r.pattern);
    if (m) {
      const group = NAV_GROUP[r.navKey];
      const key = group || r.navKey;
      const menu = key in NAV_MENU ? NAV_MENU[key] : group || r.navKey;
      if (menu !== null) $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === menu));
      $('#fab').classList.toggle('hidden', ['nueva', 'completa'].includes(r.navKey));
      renderSubnav(group, r.navKey);
      closeModal(); // un cartel abierto no queda encima de otra pantalla
      const view = $('#view');
      view.innerHTML = '<p class="muted">Cargando…</p>';
      try {
        await r.handler(view, ...m.slice(1));
        view.classList.remove('enter');
        void view.offsetWidth; // reinicia la animación de entrada
        view.classList.add('enter');
      } catch (e) {
        view.innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p></div>`;
      }
      return;
    }
  }
  location.hash = '#/panel';
}
window.addEventListener('hashchange', route);

/* ============================================================
   Panel
   ============================================================ */
// Lista de primeros pasos para una empresa nueva: sólo la ve el administrador y desaparece al completarla.
function setupCard(setup) {
  if (!setup || !isAdmin() || setup.done === setup.total) return '';
  return `<div class="card setup"><h2>Primeros pasos <span class="count">${setup.done}/${setup.total}</span></h2>
    <p class="muted">Para empezar a trabajar con el sistema completá estos pasos. Esta lista desaparece cuando estén todos hechos.</p>
    <ul class="steps">${setup.steps
      .map((x) => `<li class="${x.done ? 'done' : ''}">${x.done ? '✔' : '○'} ${x.done ? esc(x.label) : `<a href="${esc(x.href)}">${esc(x.label)}</a>`}</li>`)
      .join('')}</ul></div>`;
}

// Pantalla Hoy: lo que el dueño mira primero. Quién sale y quién vuelve hoy, con un botón para cada cosa.
const WEEKDAYS = () => L(['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'], ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const dayName = (s) => `${WEEKDAYS()[new Date(String(s).slice(0, 10) + 'T12:00').getDay()]} ${fmtD(s).slice(0, 5)}`;
const WA_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 20.5l1.6-5.4A8.4 8.4 0 1 1 21 11.5z"/></svg>';
// Íconos de línea (se pintan con el color del texto).
const svgIcon = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON = {
  check: svgIcon('M5 12.5l4.5 4.5L19 7.5'),
  key: svgIcon('M14.5 9.5a4 4 0 1 0-3.9 4.9L9 16H7v2H5v2H3v-2.6l6.1-6.1M15 8h.01'),
  in: svgIcon('M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10'),
  car: svgIcon('M5 16l1.5-5h11L19 16M5 16h14v3H5zM7.5 19v1.5M16.5 19v1.5'),
  road: svgIcon('M4 12h12M12 6l6 6-6 6M20 5v14'),
  wrench: svgIcon('M14.7 6.3a4 4 0 0 0 5 5l-8.4 8.4a2.1 2.1 0 0 1-3-3zM14.7 6.3L17 4'),
  calm: svgIcon('M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4L7 17M17 7l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'),
  list: svgIcon('M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01'),
  plus: svgIcon('M12 5v14M5 12h14'),
  user: svgIcon('M20 21a8 8 0 0 0-16 0M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'),
  help: svgIcon('M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5M12 17.5h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z'),
  doc: svgIcon('M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5'),
  tag: svgIcon('M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01'),
  building: svgIcon('M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M3 21h18M8 7h4M8 11h4M8 15h4'),
  users: svgIcon('M17 21a6 6 0 0 0-12 0M11 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM21 21a5 5 0 0 0-4-4.9M16 3.1a4 4 0 0 1 0 7.8'),
  globe: svgIcon('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18'),
  link: svgIcon('M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'),
  sheet: svgIcon('M4 4h16v16H4zM4 10h16M4 15h16M10 4v16'),
  lock: svgIcon('M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4'),
  out: svgIcon('M9 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3M16 16l4-4-4-4M20 12H10'),
  panel: svgIcon('M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z'),
  money: svgIcon('M3 7h18v10H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 10v.01M18 14v.01'),
  send: svgIcon('M21 3L10 14M21 3l-7 18-4-7-7-4z'),
  backup: svgIcon('M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'),
  disk: svgIcon('M3 14h18v6H3zM5 14l2.5-9h9L19 14M7 17h.01M11 17h.01'),
  alert: svgIcon('M12 3.5l9.5 16.5h-19zM12 10v4.5M12 17.5h.01'),
  trash: svgIcon('M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'),
  chart: svgIcon('M4 20V10M10 20V4M16 20v-7M22 20H2'),
  copy: svgIcon('M9 9h11v11H9zM5 15H4V4h11v1'),
  reset: svgIcon('M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5'),
};
/** Enlace para escribirle por WhatsApp al cliente (el número con código de país, sin signos). */
const waLink = (phone) => {
  const n = String(phone || '').replace(/\D/g, '');
  return n ? `<a class="btn wa" href="https://wa.me/${n}" target="_blank" rel="noopener" aria-label="Escribirle por WhatsApp">${WA_ICON}<span>WhatsApp</span></a>` : '';
};

on(/^\/panel$/, async (view) => {
  const d = await GET(`/dashboard${branchQS()}`);
  const car = (r) => (r.vehicle_plate ? `${esc([r.vehicle_brand, r.vehicle_model].filter(Boolean).join(' ') || r.category_name)} · ${esc(r.vehicle_plate)}` : `${esc(r.category_name)} · sin auto asignado`);
  const owes = (r) => {
    const due = Math.round((Number(r.total) - Number(r.paid)) * 100) / 100;
    return due > 0 ? `<span class="pill debe">Debe ${money(due)}</span>` : '<span class="pill ok">Pagado</span>';
  };
  // Iniciales con un color fijo por nombre: cada cliente se reconoce de un vistazo.
  const avatar = (name) => {
    const n = String(name || '?').trim();
    const ini = n.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    const h = [...n].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
    return `<span class="avatar" style="--h:${h}" aria-hidden="true">${esc(ini)}</span>`;
  };
  const who = (r, lines) => `<div class="trip-who">${avatar(r.customer_name)}<div><b>${esc(r.customer_name)}</b>${lines}</div></div>`;
  const trip = (r, kind) => {
    const out = kind === 'out';
    const at = out ? r.pickup_at : r.return_at;
    const where = out ? r.pickup_branch_name : r.return_branch_name;
    const late = at.slice(0, 10) < d.now.slice(0, 10);
    // Frases con datos en el medio: se arman en cada idioma (i18n.js no las puede traducir por pedazos).
    const when = late
      ? `${out ? L('Tenía que salir el', 'Was due out on') : L('Tenía que volver el', 'Was due back on')} ${dayName(at)}`
      : `${fmtDT(at).slice(11)}${where ? ` ${L('en', 'at')} ${esc(where)}` : ''}`;
    const extra = out ? ` · ${L('vuelve el', 'returns on')} ${dayName(r.return_at)}` : '';
    const action = out
      ? `<a class="btn primary" href="#/reservas/${r.id}?accion=checkout">${ICON.key}Entregar el auto</a>`
      : `<a class="btn back" href="#/reservas/${r.id}?accion=checkin">${ICON.in}Recibir el auto</a>`;
    return `<div class="trip ${kind}">
      <div class="trip-top" data-href="#/reservas/${r.id}">
        ${who(r, `<small>${car(r)}</small><small>${when}${extra}</small>`)}
        ${owes(r)}
      </div>
      <div class="trip-actions">${action}${waLink(r.customer_phone)}</div>
    </div>`;
  };
  // Pedidos sin confirmar (del link de reservas, del cotizador o cargados como pendientes).
  // Lo que conviene saber antes de confirmar: falta auto, falta licencia, o la reserva tiene notas.
  const pendAlerts = (r) =>
    [!r.vehicle_plate && 'Sin auto asignado', !r.customer_license && 'Falta la licencia del cliente', r.notes && 'Tiene notas'].filter(Boolean);
  // El lugar de retiro (no dónde se tomó la reserva: "Mostrador" se leía como lugar de entrega).
  const pend = (r) => `<div class="trip pend">
      <div class="trip-top" data-href="#/reservas/${r.id}">
        ${who(r, `<small>${esc(r.category_name)}${r.pickup_branch_name ? ` · ${L('retira en', 'pick-up at')} ${esc(r.pickup_branch_name)}` : ''}${sourceBadge(r.source)}</small><small>${dayName(r.pickup_at)} ${fmtDT(r.pickup_at).slice(11)} → ${dayName(r.return_at)}</small>`)}
        <span class="pill">${money(r.total)}</span>
      </div>
      ${pendAlerts(r).length ? `<p class="pend-alerts">${ICON.alert}${pendAlerts(r).map(esc).join(' · ')}</p>` : ''}
      <div class="trip-actions"><button class="btn primary" type="button" data-confirm="${r.id}">${ICON.check}Confirmar</button><a class="btn" href="#/reservas/${r.id}">Ver detalle</a>${waLink(r.customer_phone)}</div>
    </div>`;
  const column = (title, icon, color, rows, kind, empty) => `<div class="hoy-col">
      <h2><svg viewBox="0 0 24 24" stroke="${color}" aria-hidden="true"><path d="${icon}"/></svg>${title}${rows.length ? ` <span class="count">${rows.length}</span>` : ''}</h2>
      ${rows.length ? rows.map((r) => trip(r, kind)).join('') : `<p class="hoy-empty">${ICON.calm}${empty}</p>`}
    </div>`;
  const now = new Date();
  const first = String(state.user.name || '').split(' ')[0];
  const hour = now.getHours();
  const hello = hour < 13 ? L('Buen día', 'Good morning') : hour < 20 ? L('Buenas tardes', 'Good afternoon') : L('Buenas noches', 'Good evening');
  const out = [...d.late_pickups, ...d.pickups_today];
  const back = [...d.overdue, ...d.returns_today];
  const tomorrow = d.tomorrow || { pickups: 0, returns: 0 };
  view.innerHTML = `
    <div class="hoy-head">
      <div><div class="date">${esc(now.toLocaleDateString(L('es-AR', 'en-US'), { weekday: 'long', day: 'numeric', month: 'long' }))}</div><h1>${hello}, ${esc(first)}</h1>
        <p class="hello">${out.length + back.length ? L(`Hoy hay ${plural(out.length + back.length, 'movimiento', 'movimientos')} de autos.`, `${plural(out.length + back.length, 'car movement', 'car movements')} today.`) : L('Día tranquilo: hoy no se mueve ningún auto.', 'Quiet day: no cars moving today.')}</p></div>
      <svg class="hoy-art" viewBox="0 0 260 120" preserveAspectRatio="xMaxYMax meet" aria-hidden="true"><path d="M10 110 C 80 110, 90 60, 150 60 S 220 20, 250 14"/><circle class="pin" cx="250" cy="14" r="6"/><g transform="translate(132 40)"><path class="car-ic" d="M0 12a4 4 0 0 1 4-4h2l5-7h12l6 7h1a4 4 0 0 1 4 4v6H0z" style="stroke:none"/><circle cx="8" cy="18" r="4" fill="#0f1a2e" style="stroke:none"/><circle cx="26" cy="18" r="4" fill="#0f1a2e" style="stroke:none"/></g></svg>
    </div>
    <div class="hoy-counts">
      <a href="#/flota?estado=disponible"><i class="ic free" aria-hidden="true">${ICON.car}</i><b>${d.fleet.disponible || 0}</b><span>autos libres</span></a>
      <a href="#/flota?estado=alquilado"><i class="ic out" aria-hidden="true">${ICON.road}</i><b>${d.fleet.alquilado || 0}</b><span>alquilados</span></a>
      <a href="#/flota?estado=mantenimiento"><i class="ic shop" aria-hidden="true">${ICON.wrench}</i><b>${d.fleet.mantenimiento || 0}</b><span>en el taller</span></a>
    </div>
    ${d.quote_errors ? `<div class="notice warn">Hay <b>${plural(d.quote_errors, 'solicitud', 'solicitudes')}</b> del cotizador o del formulario web con error. <a href="#/cotizador">Revisar bandeja</a></div>` : ''}
    ${d.pending.length ? `<div class="hoy-col"><h2>Para confirmar <span class="count">${d.pending_confirmation}</span></h2><div class="hoy-pending">${d.pending.map(pend).join('')}</div></div>` : ''}
    <div class="hoy-cols">
      ${column('Salen hoy', 'M5 12h14M13 6l6 6-6 6', 'var(--primary)', out, 'out', 'Hoy no sale ningún auto.')}
      ${column('Vuelven hoy', 'M19 12H5M11 6l-6 6 6 6', '#c2410c', back, 'back', 'Hoy no vuelve ningún auto.')}
    </div>
    <p class="hoy-next">Mañana: ${tomorrow.pickups === 1 ? 'sale 1 auto' : `salen ${tomorrow.pickups} autos`}, ${tomorrow.returns === 1 ? 'vuelve 1' : `vuelven ${tomorrow.returns}`}. <a href="#/planning">Ver calendario</a></p>
    ${d.choferes ? choferesCards(d.choferes) : ''}
    ${/* Lo del día va primero; los primeros pasos de una empresa nueva, abajo. */ setupCard(d.setup)}
    ${
      d.alerts.documents.length
        ? `<div class="card"><h2>${choferesMode() ? 'Seguro, VTV o habilitación' : 'Seguro o VTV'} por vencer (30 días) <span class="count">${d.alerts.documents.length}</span></h2><div class="daylist">${d.alerts.documents
            .map(
              (v) =>
                `<div class="dayrow docs"><span class="plate">${esc(v.plate)}</span><div><small>Seguro</small><b>${fmtD(v.insurance_expiry) || '—'}</b></div><div><small>VTV</small><b>${fmtD(v.vtv_expiry) || '—'}</b></div>${choferesMode() ? `<div><small>Habilitación</small><b>${fmtD(v.permit_expiry) || '—'}</b></div>` : ''}</div>`,
            )
            .join('')}</div></div>`
        : ''
    }`;
  // Antes de confirmar se ve lo importante (auto, notas, lo que falta); al confirmar se abre el voucher.
  $$('[data-confirm]', view).forEach((b) =>
    b.addEventListener('click', () => {
      const r = d.pending.find((x) => x.id === Number(b.dataset.confirm));
      const alerts = pendAlerts(r).filter((a) => a !== 'Tiene notas');
      openModal(
        `Confirmar ${r.code}`,
        `<dl class="confirm-facts">
          <div><dt>Cliente</dt><dd>${esc(r.customer_name)}</dd></div>
          <div><dt>Retira</dt><dd>${fmtDT(r.pickup_at)}${r.pickup_branch_name ? ` · ${esc(r.pickup_branch_name)}` : ''}</dd></div>
          <div><dt>Devuelve</dt><dd>${fmtDT(r.return_at)}</dd></div>
          <div><dt>Auto</dt><dd>${r.vehicle_plate ? `<span class="plate">${esc(r.vehicle_plate)}</span> ${esc([r.vehicle_brand, r.vehicle_model].filter(Boolean).join(' '))}` : `<span class="warn-text">Sin auto asignado</span> · ${esc(r.category_name)}`}</dd></div>
          <div><dt>Total</dt><dd>${money(r.total)}</dd></div>
          ${r.notes ? `<div class="wide"><dt>Notas</dt><dd class="notes-box">${esc(r.notes)}</dd></div>` : ''}
        </dl>
        ${alerts.length ? `<div class="notice warn">${alerts.map(esc).join('. ')}. Podés confirmarla igual y completarlo antes de la entrega.</div>` : ''}
        <form class="form"><div class="actions"><a class="btn" href="#/reservas/${r.id}" data-close>Abrir la reserva</a><button class="btn primary" type="submit">${ICON.check}Confirmar reserva</button></div></form>`,
        async () => {
          await POST(`/reservations/${r.id}/status`, { status: 'confirmada' });
          toast('Reserva confirmada');
          location.hash = `#/reservas/${r.id}?accion=voucher`;
        },
      );
    }),
  );
  if (!tourSeen()) showTour();
}, 'panel');

/* ---------- Guía: recorrido corto la primera vez que se entra a Hoy ---------- */
const TOUR = [
  [null, 'Bienvenido a Floty', 'Te mostramos en un minuto cómo se usa. Son cinco pasos.'],
  ['#nav a[data-route=panel]', 'Hoy', 'Lo primero que mirás cada mañana: quién retira y quién devuelve un auto, cuánto debe cada uno y los pedidos para confirmar.'],
  ['#fab', 'Nueva reserva', 'Fechas, auto y cliente en un minuto. Después le mandás el voucher por WhatsApp.'],
  ['#nav a[data-route=planning]', 'Calendario', 'Qué auto está ocupado cada día. Tocá un espacio libre para reservar ahí.'],
  ['#nav a[data-route=mas]', 'Más', 'Todas las reservas, los clientes, el taller, los precios y los ajustes. Los pedidos que llegan de tu página web te aparecen en Hoy, en "Para confirmar".'],
];
const tourSeen = () => {
  try {
    return localStorage.getItem('floty_tour') === '1';
  } catch {
    return true; // sin almacenamiento no se puede recordar: mejor no mostrarlo cada vez
  }
};
function showTour(step = 0) {
  $('#tour')?.remove();
  $$('.tour-hi').forEach((el) => el.classList.remove('tour-hi'));
  const end = () => {
    $('#tour')?.remove();
    $$('.tour-hi').forEach((el) => el.classList.remove('tour-hi'));
    try {
      localStorage.setItem('floty_tour', '1');
    } catch {}
  };
  if (step >= TOUR.length) return end();
  const [target, title, text] = TOUR[step];
  const el = target && $(target);
  // getClientRects y no offsetParent: el botón "Nueva reserva" es fijo y no tiene offsetParent.
  if (el && el.getClientRects().length) el.classList.add('tour-hi');
  const box = document.createElement('div');
  box.id = 'tour';
  box.className = 'tour';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Cómo funciona Floty');
  box.innerHTML = `<div class="card tour-card">
      <div class="tour-dots" aria-hidden="true">${TOUR.map((_, i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('')}</div>
      <h2>${esc(title)}</h2><p>${esc(text)}</p>
      <div class="actions"><button class="btn primary" type="button" data-next>${step === TOUR.length - 1 ? 'Listo' : 'Siguiente'}</button><button class="btn link" type="button" data-skip>Saltar</button></div>
    </div>`;
  document.body.appendChild(box);
  $('[data-next]', box).addEventListener('click', () => showTour(step + 1));
  $('[data-skip]', box).addEventListener('click', end);
  $('[data-next]', box).focus();
}
on(/^\/guia$/, () => {
  location.hash = '#/panel';
  showTour();
}, 'panel');

// Los menús "Más acciones" se cierran al elegir una opción o al tocar afuera.
document.addEventListener('click', (e) => {
  $$('details.menu[open]').forEach((d) => {
    if (!d.contains(e.target) || e.target.closest('.menu-list button')) d.removeAttribute('open');
  });
});
document.addEventListener('click', (e) => {
  const tr = e.target.closest('[data-href]');
  if (tr && !e.target.closest('button, a, input, select')) location.hash = tr.dataset.href;
});

/* ============================================================
   Reservas: listado
   ============================================================ */
// Filtros por estado, en el orden en que avanza una reserva. "" = activas (lo que hay que atender).
const RES_FILTERS = [
  ['', 'Activas'],
  ['pendiente', 'Para confirmar'],
  ['confirmada', 'Confirmadas'],
  ['en_curso', 'En la calle'],
  ['finalizada', 'Terminadas'],
  ['cancelada,no_show', 'Canceladas y no show'],
  ['all', 'Todas'],
];
on(/^\/reservas$/, async (view) => {
  view.innerHTML = `
    <div class="page-head"><h1>Reservas</h1></div>
    <form class="toolbar" id="res-filter">
      <label>Buscar<input name="q" placeholder="Código, cliente, DNI, patente…"/></label>
      <input type="hidden" name="status" value=""/>
      <button class="btn">Buscar</button>
      <div class="chips status-chips" role="group" aria-label="Estado">${RES_FILTERS.map(([v, l], i) => `<button type="button" class="chip${i ? '' : ' on'}" data-st="${v}" aria-pressed="${!i}">${l}</button>`).join('')}</div>
      <details class="more-opts filters"><summary>Más filtros</summary><div class="toolbar">
      <label>Origen<select name="source"><option value="">Todos</option><option value="manual">Mostrador</option><option value="cotizador">Cotizador</option><option value="web">Por internet</option><option value="importado">Importadas</option></select></label>
      <label>Desde<input type="date" name="from"/></label>
      <label>Hasta<input type="date" name="to"/></label>
      </div></details>
    </form>
    <div class="table-wrap" id="res-table"></div>`;
  const load = async () => {
    const f = formData($('#res-filter'));
    const qs = new URLSearchParams();
    if (f.q) qs.set('q', f.q);
    if (!f.status) qs.set('status', 'pendiente,confirmada,en_curso');
    else if (f.status !== 'all') qs.set('status', f.status);
    if (f.source) qs.set('source', f.source);
    if (f.from) qs.set('from', f.from);
    if (f.to) qs.set('to', f.to);
    if (state.branch) qs.set('branch', state.branch);
    const rows = await GET(`/reservations?${qs}`);
    $('#res-table').innerHTML = rows.length
      ? `<table><thead><tr><th>Código</th><th>Cliente</th><th>Retiro</th><th>Devolución</th><th>Cat.</th><th>Vehículo</th><th>Estado</th><th class="right">Total</th></tr></thead><tbody>
        ${rows
          .map(
            (r) => `<tr class="click" data-href="#/reservas/${r.id}">
              <td class="nowrap"><b>${esc(r.code)}</b>${sourceBadge(r.source)}</td>
              <td>${esc(r.customer_name)}</td>
              <td class="nowrap">${fmtDT(r.pickup_at)}<br><small class="muted">${esc(r.pickup_branch_name || '')}</small></td>
              <td class="nowrap">${fmtDT(r.return_at)}<br><small class="muted">${esc(r.return_branch_name || '')}</small></td>
              <td>${esc(r.category_code)}</td>
              <td>${r.vehicle_plate ? esc(r.vehicle_plate) : '<span class="muted">—</span>'}</td>
              <td>${badge(r.status)}</td>
              <td class="right nowrap">${money(r.total)}</td></tr>`,
          )
          .join('')}</tbody></table>`
      : '<div class="card muted">No hay reservas con esos filtros.</div>';
  };
  $('#res-filter').addEventListener('submit', (e) => {
    e.preventDefault();
    run(load);
  });
  // Un toque en una pastilla filtra al instante.
  $$('[data-st]', view).forEach((b) =>
    b.addEventListener('click', () => {
      $$('[data-st]', view).forEach((x) => {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-pressed', String(x === b));
      });
      $('#res-filter [name=status]').value = b.dataset.st;
      run(load);
    }),
  );
  await load();
}, 'reservas');

/* ============================================================
   Nueva reserva / cotización en mostrador
   ============================================================ */
const branchOptions = () => state.branches.filter((b) => b.active).map((b) => [b.id, b.name]);
// Lugares de retiro y devolución: las sucursales y, al final, el hotel del cliente.
const placeOptions = () => [...branchOptions(), ...(choferesMode() ? [] : [['hotel', 'Hotel (se lo llevamos)']])];

on(/^\/reservas\/completa(?:\?(.*))?$/, async (view, query) => {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  let p0 = addDays(now, 1);
  p0.setHours(10);
  let r0 = addDays(p0, 3);
  const sel = { category_id: null, customer_id: null };
  // Datos que llegan al arrastrar sobre el Planning: ?vehiculo=ID&desde=AAAA-MM-DD&hasta=AAAA-MM-DD
  const pre = new URLSearchParams(query || '');
  let preVehicle = null;
  if (pre.get('vehiculo')) preVehicle = await GET(`/vehicles/${Number(pre.get('vehiculo'))}`).catch(() => null);
  // Fecha sola (desde el Planning, a las 10) o fecha y hora (desde la reserva rápida, con "Más opciones").
  const dayAt10 = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? new Date(`${d}T10:00`) : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(d || '') ? new Date(d) : null);
  if (dayAt10(pre.get('desde')) && dayAt10(pre.get('hasta'))) {
    p0 = dayAt10(pre.get('desde'));
    r0 = dayAt10(pre.get('hasta'));
  }
  if (preVehicle) sel.category_id = preVehicle.category_id;
  // Cliente escrito en la reserva rápida: se busca por su WhatsApp; si no está, se carga al guardar.
  const preName = (pre.get('nombre') || '').trim();
  const prePhone = (pre.get('tel') || '').trim();
  let preCustomer = null;
  if (prePhone.replace(/\D/g, '').length >= 6) {
    const digits = prePhone.replace(/\D/g, '');
    preCustomer = (await GET(`/customers?q=${encodeURIComponent(digits.slice(-6))}`).catch(() => [])).find((x) => String(x.phone || '').replace(/\D/g, '') === digits) || null;
  }
  view.innerHTML = `
    <div class="page-head"><h1>Nueva reserva</h1></div>
    ${
      preVehicle
        ? `<div class="card" style="border-color:var(--primary);margin-bottom:16px">Reserva para <b>${esc(preVehicle.plate)}</b> ${esc(preVehicle.brand || '')} ${esc(preVehicle.model || '')}, del ${fmtD(localISO(p0))} al ${fmtD(localISO(r0))}. Completá lo que falta y guardá.</div>`
        : ''
    }
    <form id="new-res" class="stack">
      <div class="card">
        <h2>1 · Fechas y lugares</h2>
        <div class="form-grid">
          <label>Retiro <span class="req">*</span><input type="datetime-local" name="pickup_at" value="${localISO(p0)}" required/></label>
          <label>Devolución <span class="req">*</span><input type="datetime-local" name="return_at" value="${localISO(r0)}" required/></label>
          <p class="field-warn full hidden" id="nr-past">${ICON.alert}El retiro es en el pasado. Revisá la fecha antes de guardar.</p>
          <div class="full actions" id="durations"><small class="muted">Duración rápida:</small>${(choferesMode() ? [7, 14, 30] : [1, 2, 3, 5, 7, 14])
            .map((n) => `<button type="button" class="btn small" data-days="${n}">${n === 7 ? '1 semana' : n === 14 ? '2 semanas' : n === 30 ? '1 mes' : `${n} día${n > 1 ? 's' : ''}`}</button>`)
            .join('')}</div>
          ${field({ name: 'pickup_branch_id', label: 'Lugar de retiro', type: 'select', options: placeOptions, required: true })}
          ${field({ name: 'return_branch_id', label: 'Lugar de devolución', type: 'select', options: placeOptions, required: true })}
          ${insurances().length && !choferesMode() ? `<div class="full">${insuranceSelect()}</div>` : ''}
        </div>
        <div class="qr-hotel hidden" id="nr-hotel">
          ${hotelFee() ? `<p class="hotel-fee">${ICON.money}<span>La entrega en hotel tiene un costo extra de <b>${money(hotelFee())}</b>. Ya está sumado en los precios de abajo.</span></p>` : ''}
          <p class="muted">Datos del hotel. Si todavía no los sabés, dejalos vacíos: al guardar te damos un link para que el cliente los complete.</p>
          <div class="qr-hotel-grid">${hotelInputs({}, '')}</div>
          ${branchOptions().length > 1 ? `<label class="hidden" data-from>El auto sale de<select name="branch_from">${branchOptions().map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('')}</select></label>` : ''}
        </div>
        <details class="more-opts">
        <summary>${choferesMode() ? 'Más opciones: descuento y notas' : 'Más opciones: adicionales, descuento y vuelo'}</summary>
        <div class="actions" style="margin-top:12px">${state.extras
          .filter((x) => !choferesMode() && x.active && x.kind !== 'seguro' && String(x.code).toUpperCase() !== 'HOTEL') // el hotel se suma solo; el seguro se elige arriba
          .map(
            (x) =>
              `<label class="check"><input type="checkbox" name="extra_${x.id}"/> ${esc(x.name)} <small class="muted">(${money(x.price)}${x.charge_type === 'dia' ? '/día' : ''})</small></label>`,
          )
          .join('')}</div>
        <div class="form-grid" style="margin-top:12px">
          <label>Descuento %<input type="number" name="discount_pct" min="0" max="100" step="any" value="0"/></label>
          <label>Descuento en $ <small class="muted">(para redondear, ej. 10.000)</small><input type="number" name="discount_amount" min="0" step="any" value="0"/></label>
          <label>Vuelo / referencia<input name="flight"/></label>
        </div>
        </details>
      </div>
      <div class="card">
        <h2>2 · Categoría disponible</h2>
        <div id="cats" class="cat-cards"><p class="muted">Cargando…</p></div>
      </div>
      <div class="card">
        <h2>3 · Cliente</h2>
        <div class="toolbar">
          <label style="flex:1">Buscar cliente existente<input id="cust-q" placeholder="Nombre, DNI, email o teléfono"/></label>
          <button type="button" class="btn" id="cust-new">+ Cliente nuevo</button>
        </div>
        <div id="cust-results"></div>
        <div id="cust-selected" class="muted">Ningún cliente seleccionado.</div>
      </div>
      <div class="grid cols-2">
        <div class="card">
          <h2>4 · Vehículo y notas</h2>
          <div class="form-grid">
            <label class="full">Vehículo (opcional, se puede asignar después)<select name="vehicle_id" id="veh-select"><option value="">Asignar después</option></select></label>
            <label class="full">Notas<textarea name="notes"></textarea></label>
          </div>
        </div>
        <div class="card">
          <h2>Resumen</h2>
          <div id="summary" class="muted">Elegí una categoría.</div>
          <div class="actions" style="margin-top:16px">
            <button class="btn primary" type="submit" data-status="confirmada">Crear y confirmar</button>
            <button class="btn" type="submit" data-status="pendiente">Guardar como pendiente</button>
          </div>
        </div>
      </div>
    </form>`;
  const form = $('#new-res');
  const pb = form.pickup_branch_id;
  if (state.branch && [...pb.options].some((o) => Number(o.value) === state.branch)) pb.value = state.branch;
  if (preVehicle && preVehicle.branch_id && branchOptions().some(([id]) => id === preVehicle.branch_id)) pb.value = preVehicle.branch_id;
  if (pre.get('lugar') && [...pb.options].some((o) => o.value === pre.get('lugar'))) pb.value = pre.get('lugar');
  form.return_branch_id.value = pb.value;
  const checkPast = () => $('#nr-past').classList.toggle('hidden', !(form.pickup_at.value && isPast(new Date(form.pickup_at.value))));
  checkPast();
  form.pickup_at.addEventListener('change', checkPast);
  // "Hotel" en retiro o devolución abre los datos del hotel; con hotel en el retiro, se elige de qué sucursal sale el auto.
  const syncHotel = () => {
    const deliver = pb.value === 'hotel';
    const back = form.return_branch_id.value === 'hotel';
    $('#nr-hotel').classList.toggle('hidden', !deliver && !back);
    $('[data-from]', form)?.classList.toggle('hidden', !deliver);
  };
  pb.addEventListener('change', () => {
    form.return_branch_id.value = pb.value;
    syncHotel();
  });
  form.return_branch_id.addEventListener('change', syncHotel);
  // La devolución queda a N días del retiro, a la misma hora.
  $('#durations').addEventListener('click', (e) => {
    const b = e.target.closest('[data-days]');
    if (!b || !form.pickup_at.value) return;
    form.return_at.value = localISO(addDays(new Date(form.pickup_at.value), Number(b.dataset.days)));
    refresh();
  });

  const params = () => {
    const f = formData(form);
    const extras = state.extras.filter((x) => f[`extra_${x.id}`]).map((x) => x.id);
    // Con hotel: las sucursales reales (de dónde sale y adónde vuelve el auto) y el costo del hotel en el precio.
    const hotel = { deliver: f.pickup_branch_id === 'hotel', return: f.return_branch_id === 'hotel' };
    const from = Number(f.branch_from) || Number(branchOptions()[0] && branchOptions()[0][0]);
    const pickup = hotel.deliver ? from : Number(f.pickup_branch_id);
    const back = hotel.return ? pickup : Number(f.return_branch_id);
    const fee = state.extras.find((x) => String(x.code).toUpperCase() === 'HOTEL' && x.active && x.price > 0);
    if (fee && (hotel.deliver || hotel.return)) extras.push(fee.id);
    if (Number(f.insurance)) extras.push(Number(f.insurance));
    return { ...f, extras, hotel, pickup_branch_id: pickup, return_branch_id: back };
  };

  let quotes = [];
  const refresh = async () => {
    const f = params();
    if (!f.pickup_at || !f.return_at) return;
    const qs = new URLSearchParams({
      pickup_at: f.pickup_at,
      return_at: f.return_at,
      pickup_branch_id: f.pickup_branch_id || '',
      return_branch_id: f.return_branch_id || '',
      discount_pct: f.discount_pct || 0,
      discount_amount: f.discount_amount || 0,
      extras: f.extras.join(','),
    });
    try {
      quotes = await GET(`/availability?${qs}`);
    } catch (e) {
      $('#cats').innerHTML = `<p class="error">${esc(e.message)}</p>`;
      return;
    }
    // Si con las fechas nuevas la categoría elegida se quedó sin autos, se saca (no se cotiza sin disponibilidad).
    if (sel.category_id && !quotes.some((x) => x.id === sel.category_id && x.available)) {
      if (quotes.some((x) => x.id === sel.category_id)) toast('No quedan autos libres en esa categoría para esas fechas. Elegí otra.', true);
      sel.category_id = null;
      $('#summary').classList.add('muted');
      $('#summary').textContent = 'Elegí una categoría con autos libres.';
    }
    $('#cats').innerHTML = quotes
      .map(
        (c) => `<div class="cat-card ${c.available ? '' : 'none'} ${sel.category_id === c.id ? 'selected' : ''}" data-cat="${c.id}">
          <div class="cat-name"><span class="cat-code">${esc(c.code)}</span>${esc(c.name)}</div>
          <div class="muted">${plural(c.available, 'disponible', 'disponibles')} · ${plural(c.quote.days, 'día', 'días')}</div>
          <div class="price">${money(c.quote.total)} <small class="muted">total</small></div>
          <small class="muted">${money(c.quote.total / (c.quote.days || 1))} promedio por día</small>
          <small class="muted">Garantía ${money(c.quote.deposit)}</small></div>`,
      )
      .join('');
    renderSummary();
    loadVehicles();
  };

  const renderSummary = () => {
    const c = quotes.find((x) => x.id === sel.category_id);
    if (!c) return;
    $('#summary').classList.remove('muted');
    $('#summary').innerHTML = breakdownHtml(c.quote);
  };

  const loadVehicles = async () => {
    const s = $('#veh-select');
    const current = s.value;
    if (!sel.category_id) return;
    const f = params();
    const list = await GET(`/available-vehicles?${new URLSearchParams({ category_id: sel.category_id, pickup_at: f.pickup_at, return_at: f.return_at })}`);
    s.innerHTML =
      '<option value="">Asignar después</option>' +
      list.map((v) => `<option value="${v.id}">${esc(v.plate)} · ${esc(v.brand)} ${esc(v.model)} (${esc(v.branch_name || '')})</option>`).join('');
    if (list.some((v) => String(v.id) === current)) s.value = current;
    else if (preVehicle && list.some((v) => v.id === preVehicle.id)) s.value = preVehicle.id;
  };

  $('#cats').addEventListener('click', (e) => {
    const card = e.target.closest('[data-cat]');
    if (!card) return;
    if (card.classList.contains('none')) return toast('No hay autos libres en esa categoría para esas fechas.', true);
    sel.category_id = Number(card.dataset.cat);
    $$('.cat-card').forEach((c) => c.classList.toggle('selected', c === card));
    renderSummary();
    loadVehicles();
  });
  form.addEventListener('change', (e) => {
    if (e.target.name !== 'vehicle_id' && e.target.name !== 'notes') refresh();
  });

  // Cliente
  const pickCustomer = (c) => {
    sel.customer_id = c.id;
    $('#cust-results').innerHTML = '';
    $('#cust-q').value = '';
    $('#cust-selected').classList.remove('muted');
    $('#cust-selected').innerHTML = `✔ <b>${esc(c.full_name)}</b> · ${esc(c.doc_type || '')} ${esc(c.doc_number || '')} · ${esc(c.phone || '')} · ${esc(c.email || '')}
      ${c.license_number ? '' : '<br><span class="error">Falta la licencia de conducir (se pide al entregar).</span>'}`;
  };
  let t;
  $('#cust-q').addEventListener('input', (e) => {
    clearTimeout(t);
    const q = e.target.value.trim();
    if (q.length < 2) return ($('#cust-results').innerHTML = '');
    t = setTimeout(async () => {
      const rows = await GET(`/customers?q=${encodeURIComponent(q)}`);
      $('#cust-results').innerHTML = rows.length
        ? `<table><tbody>${rows
            .slice(0, 8)
            .map((c) => `<tr class="click" data-cust="${c.id}"><td><b>${esc(c.full_name)}</b></td><td>${esc(c.doc_number || '')}</td><td>${esc(c.phone || '')}</td><td>${esc(c.email || '')}</td></tr>`)
            .join('')}</tbody></table>`
        : `<p class="muted">No está cargado. <button type="button" class="btn small primary" id="cust-new-q">+ Cargar «${esc(q)}» como cliente nuevo</button></p>`;
      $$('[data-cust]').forEach((tr) => tr.addEventListener('click', () => pickCustomer(rows.find((c) => c.id === Number(tr.dataset.cust)))));
      $('#cust-new-q')?.addEventListener('click', () => newCustomer(q));
    }, 250);
  });
  $('#cust-q').addEventListener('keydown', (e) => e.key === 'Enter' && e.preventDefault());
  // Lo que se escribió en la búsqueda pasa al formulario: así no hay que tipearlo dos veces.
  const newCustomer = (q = '') => {
    const pre = q.includes('@') ? { email: q } : /^[\d.\s-]+$/.test(q) ? { doc_number: q.replace(/\D/g, '') } : { full_name: q };
    openModal('Cliente nuevo', formHtml(CUSTOMER_FIELDS, pre), async (data) => {
      pickCustomer(await POST('/customers', data));
    });
  };
  $('#cust-new').addEventListener('click', () => newCustomer($('#cust-q').value.trim()));
  if (preCustomer) pickCustomer(preCustomer);
  else if (preName) {
    $('#cust-selected').classList.remove('muted');
    $('#cust-selected').innerHTML = `Cliente nuevo: <b>${esc(preName)}</b>${prePhone ? ` · ${esc(prePhone)}` : ''} <span class="muted">(se carga al guardar)</span>`;
  }
  syncHotel();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = e.submitter ? e.submitter.dataset.status : 'pendiente';
    // Todo lo que falta, junto, debajo de cada parte (no de a un aviso por vez).
    const missing = [!sel.category_id && ['cats', 'Elegí una categoría.'], !sel.customer_id && !preName && ['cust-selected', 'Elegí o cargá un cliente.']].filter(Boolean);
    $$('.field-error[data-for]', form).forEach((p) => p.remove());
    for (const [id, msg] of missing) $(`#${id}`).insertAdjacentHTML('afterend', `<p class="field-error" data-for="${id}">${esc(msg)}</p>`);
    if (missing.length) return $(`#${missing[0][0]}`).scrollIntoView({ block: 'center', behavior: 'smooth' });
    const f = params();
    if (isPast(new Date(f.pickup_at)) && !(await confirmModal({ title: 'El retiro es en el pasado', text: `La reserva se retira el ${fmtDT(f.pickup_at)}, que ya pasó. ¿La guardás igual?`, ok: 'Guardar igual' }))) return;
    const c = quotes.find((x) => x.id === sel.category_id);
    if (!c || !c.available) return toast('No hay autos libres en esa categoría para esas fechas. Elegí otra.', true);
    if (!sel.customer_id) sel.customer_id = (await run(() => POST('/customers', { full_name: preName, phone: prePhone }))).id;
    const body = {
      customer_id: sel.customer_id,
      category_id: sel.category_id,
      vehicle_id: f.vehicle_id ? Number(f.vehicle_id) : null,
      pickup_branch_id: Number(f.pickup_branch_id),
      return_branch_id: Number(f.return_branch_id),
      pickup_at: f.pickup_at,
      return_at: f.return_at,
      discount_pct: f.discount_pct || 0,
      discount_amount: f.discount_amount || 0,
      flight: f.flight,
      notes: f.notes,
      extras: f.extras.map((id) => ({ extra_id: id, quantity: 1 })),
      status,
      hotel: f.hotel.deliver || f.hotel.return ? { ...hotelFrom(form), ...f.hotel } : undefined,
    };
    const r = await run(() => POST('/reservations', body), 'Reserva creada');
    location.hash = `#/reservas/${r.id}${status === 'confirmada' ? '?accion=voucher' : ''}`;
  });

  await refresh();
}, 'completa');

/* ============================================================
   Nueva reserva rápida: fechas, auto libre, nombre y WhatsApp. Se hace en un minuto desde el celular.
   Lo demás (adicionales, descuento, vuelo, otro lugar de devolución) está en "Reserva con más opciones".
   ============================================================ */
/* ---------- Entrega en hotel: los datos los carga la agencia o el cliente con su link ---------- */
const HOTEL_FIELDS = [
  ['name', 'Hotel', 'Ej.: Hotel Arakur'],
  ['address', 'Dirección', 'Calle y número, o cómo llegar'],
  ['room', 'Habitación', ''],
  ['contact', 'Teléfono o contacto en el hotel', 'Recepción, nombre…'],
  ['notes', 'Indicaciones', 'A qué hora, a quién se lo damos…'],
];
const hotelInputs = (h = {}, cls = 'qr-field') =>
  HOTEL_FIELDS.map(([k, label, ph]) => `<label class="${cls}${k === 'notes' || k === 'address' ? ' full' : ''}">${label}<input name="h_${k}" maxlength="${k === 'notes' ? 500 : 200}" value="${esc(h[k] || '')}" placeholder="${esc(ph)}"/></label>`).join('');
/* ---------- Seguros: los carga la agencia (Precios y lugares → Seguros); en cada reserva se elige uno ---------- */
const insurances = () => (state.extras || []).filter((e) => e.kind === 'seguro' && e.active).sort((a, b) => a.price - b.price);
const insurancePrice = (x, days) => {
  const a = x.charge_type === 'fijo' ? x.price : x.price * days;
  return x.max_price > 0 ? Math.min(a, x.max_price) : a;
};
const insuranceNote = (x) =>
  x ? `${x.deductible ? `Franquicia: ${money(x.deductible)} (lo que paga el cliente si hay un daño)` : 'Sin franquicia: si hay un daño, el cliente no paga nada'}${x.price ? ` · ${money(x.price)}${x.charge_type === 'dia' ? ' por día' : ' por alquiler'}` : ' · incluido en la tarifa'}` : '';
// Viene elegido el más barato (normalmente el incluido en la tarifa). Abajo, la franquicia del elegido.
const insuranceSelect = (cls = '') => {
  const list = insurances();
  if (!list.length) return '';
  return `<label class="${cls}">Seguro<select name="insurance">${list
    .map((x) => `<option value="${x.id}">${esc(x.name)}${x.price ? ` (+${money(x.price)}${x.charge_type === 'dia' ? '/día' : ''})` : ''}</option>`)
    .join('')}</select></label><small class="ins-note" data-ins-note>${esc(insuranceNote(list[0]))}</small>`;
};
document.addEventListener('change', (e) => {
  if (e.target.name !== 'insurance') return;
  const note = e.target.closest('form')?.querySelector('[data-ins-note]');
  if (note) note.textContent = insuranceNote(insurances().find((x) => x.id === Number(e.target.value)));
});
/** Seguro de una reserva ya hecha (o null) y los adicionales sin el seguro. */
const resInsurance = (r) => (r.extras || []).find((x) => x.kind === 'seguro') || null;
const resAddons = (r) => (r.extras || []).filter((x) => x.kind !== 'seguro');

/** Costo de la entrega en hotel: el adicional "Entrega en hotel" (código HOTEL), por alquiler. 0 = sin costo. */
const hotelFee = () => {
  const x = (state.extras || []).find((e) => String(e.code).toUpperCase() === 'HOTEL' && e.active);
  return x ? Number(x.price) || 0 : 0;
};
const hotelFrom = (form) => Object.fromEntries(HOTEL_FIELDS.map(([k]) => [k, (form.elements[`h_${k}`] || {}).value || '']));
/** Link para que el cliente complete los datos del hotel (lleva la agencia si no es la principal). */
function hotelLink(r) {
  return clientLink('hotel', r.hotel_token);
}
/** Links del cliente: con dominio propio van por ese dominio (sin la dirección de Floty); si no, llevan la agencia si no es la principal. */
const clientLink = (path, token) => {
  const co = state.user && state.user.company;
  if (co && co.domain) return `https://${co.domain}/${path}${token ? `/${token}` : ''}`;
  return `${location.origin}/${path}${token ? `/${token}` : ''}${co && !co.principal ? `?empresa=${encodeURIComponent(co.slug)}` : ''}`;
};
const waText = (r, text) => `https://wa.me/${String(r.customer_phone || '').replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
const contractMessage = (r, link) =>
  `${L('Hola', 'Hi')} ${String(r.customer_name || '').split(' ')[0]}! ${L(`Este es el contrato de tu alquiler con ${state.settings.company_name}. Leelo y firmalo desde el celular`, `This is your rental agreement with ${state.settings.company_name}. Read and sign it from your phone`)}: ${link}`;
const expressMessage = (r, link) =>
  `${L('Hola', 'Hi')} ${String(r.customer_name || '').split(' ')[0]}! ${L(`Tu auto de ${state.settings.company_name} ya está listo. Mirá las fotos y el estado del auto y firmá el contrato desde el celular. Al firmar vas a ver dónde está`, `Your car from ${state.settings.company_name} is ready. Check the photos and condition of the car and sign the agreement from your phone. Once you sign, you will see where it is`)}: ${link}`;
const signedMessage = (r, contract, photos, place) =>
  `${L('Hola', 'Hi')} ${String(r.customer_name || '').split(' ')[0]}! ${L('Tu contrato firmado', 'Your signed agreement')}: ${contract}\n${L('Fotos del auto', 'Car photos')}: ${photos}${place ? `\n${L('El auto quedó en', 'The car is at')}: ${place}` : ''}`;
const returnMessage = (r, link) =>
  `${L('Hola', 'Hi')} ${String(r.customer_name || '').split(' ')[0]}! ${L(`Cuando dejes el auto${r.vehicle_plate ? ` ${r.vehicle_plate}` : ''}, sacale fotos y subilas acá`, `When you leave the car${r.vehicle_plate ? ` ${r.vehicle_plate}` : ''}, take photos of it and upload them here`)}: ${link}`;
/** Un envío: su propio botón de WhatsApp, para que salga en un mensaje aparte. Con el WhatsApp de la agencia conectado, sale solo. */
const sendStep = (title, hint, r, text, link) => `<div class="send-step stack">
    <b>${esc(title)}</b><small class="muted">${esc(hint)}</small>
    ${
      !r.customer_phone
        ? '<small class="error">El cliente no tiene teléfono cargado: copiá el link.</small>'
        : state.settings.whatsapp_api
          ? `<button class="btn ok" type="button" data-wa-send="${r.id}" data-text="${esc(text)}">${WA_ICON}Mandarlo por WhatsApp</button><a class="muted" href="${esc(waText(r, text))}" target="_blank" rel="noopener"><small>o mandarlo desde tu WhatsApp</small></a>`
          : `<a class="btn ok" href="${esc(waText(r, text))}" target="_blank" rel="noopener">${WA_ICON}Mandarlo por WhatsApp</a>`
    }
    <input readonly value="${esc(link)}" data-notr aria-label="Link"/>
  </div>`;

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-wa-send]');
  if (!b || b.disabled) return;
  b.disabled = true;
  try {
    await POST(`/reservations/${b.dataset.waSend}/whatsapp`, { text: b.dataset.text });
    b.textContent = 'Enviado ✓';
    toast('Mensaje enviado por WhatsApp');
  } catch (err) {
    b.disabled = false;
    toast(err.message, true);
  }
});

/** La tarjeta que dejó el cliente: identifica la tarjeta, no permite cobrar. */
function clientCardHtml(r) {
  if (!proOn() || choferesMode() || ['cancelada', 'no_show'].includes(r.status)) return '';
  const c = r.signature && r.signature.card;
  const open = ['pendiente', 'confirmada', 'en_curso'].includes(r.status);
  const ask = open ? `<div class="actions no-print" style="margin-top:12px"><button class="btn" type="button" data-act="card">${c ? 'Pedirle otra tarjeta' : 'Pedirle la tarjeta'}</button></div>` : '';
  return `<div class="card"><h2>Tarjeta del cliente</h2>${
    c
      ? `<p><b>${esc(c.brand)} terminada en ${esc(c.last4)}</b> · vence ${esc(c.exp)}<br><small class="muted">${esc(c.holder)} · ${fmtDT(stampLocal(c.at))}</small></p><p class="muted">Pedile esta tarjeta al entregar el auto. Con estos datos no se le puede cobrar: el cobro o la garantía se hacen con tu terminal.</p>`
      : '<p class="muted">Todavía no dejó ninguna.</p>'
  }${ask}</div>`;
}

function signatureCardHtml(r) {
  if (!proOn() || choferesMode() || ['cancelada', 'no_show'].includes(r.status)) return '';
  const s = r.signature;
  const open = ['pendiente', 'confirmada', 'en_curso'].includes(r.status);
  const ask = open ? `<div class="actions no-print" style="margin-top:12px"><button class="btn" type="button" data-act="sign">${s && s.requested ? 'Volver a mandar el link de firma' : 'Pedir la firma del cliente'}</button></div>` : '';
  if (s && s.signed_at && !s.stale) {
    return `<div class="card"><h2>Firma del contrato</h2>
      <p><span class="badge b-confirmada">Firmado</span> por <b>${esc(s.name)}</b> · ${esc(s.doc)}</p>
      <img class="sign-image" src="${esc(s.image)}" alt="Firma del cliente"/>
      <small class="muted">${fmtDT(stampLocal(s.signed_at))} · IP ${esc(s.ip || '')} · Huella ${esc(String(s.hash).slice(0, 16))}</small>
      <div class="actions no-print" style="margin-top:12px"><button class="btn" type="button" data-act="sendSigned">${ICON.send}Mandar contrato firmado y fotos</button></div></div>`;
  }
  if (s && s.signed_at) return `<div class="card"><h2>Firma del contrato</h2><p class="notice warn">Firmó ${esc(s.name)}, pero la reserva cambió después. Pedile la firma de nuevo.</p>${ask}</div>`;
  if (s && s.pre_delivery) return `<div class="card"><h2>Firma del contrato</h2><p class="notice warn">Pre-entrega lista: el auto quedó en ${esc(s.left_place || '')}. El alquiler arranca cuando el cliente firme.</p></div>`;
  return `<div class="card"><h2>Firma del contrato</h2><p class="muted">${s && s.requested ? 'Le pediste la firma: todavía no firmó.' : 'El cliente lo firma desde el celular, con el dedo.'}</p>${ask}</div>`;
}

const hotelAsk = (r) => {
  const text = `${L('Hola', 'Hi')} ${String(r.customer_name || '').split(' ')[0]}! ${L('Para llevarte el auto al hotel necesitamos unos datos. Completalos acá', 'To bring the car to your hotel we need a few details. Fill them in here')}: ${hotelLink(r)}`;
  const n = String(r.customer_phone || '').replace(/\D/g, '');
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
};

on(/^\/reservas\/nueva(?:\?(.*))?$/, async (view, query) => {
  const pre = new URLSearchParams(query || '');
  const dayAt10 = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? new Date(`${s}T10:00`) : null);
  const start = new Date();
  start.setHours(10, 0, 0, 0);
  let from = dayAt10(pre.get('desde')) || addDays(start, 1);
  let to = dayAt10(pre.get('hasta')) || addDays(from, choferesMode() ? 7 : 3);
  const sel = { vehicle: Number(pre.get('vehiculo')) || null };
  let cars = [];
  const branches = state.branches.filter((b) => b.active);
  const QUICK = choferesMode()
    ? [
        [7, '1 semana'],
        [14, '2 semanas'],
        [30, '1 mes'],
      ]
    : [
        [1, '1 día'],
        [3, '3 días'],
        [7, '1 semana'],
        [14, '2 semanas'],
      ];

  view.innerHTML = `
    <form class="qr" id="qr" novalidate>
      <div class="page-head"><h1>Nueva reserva</h1><a class="btn link" href="#/reservas/completa" data-more>Más opciones (adicionales, descuento, notas)</a></div>
      <p class="muted req-note">Los campos con <span class="req">*</span> son obligatorios.</p>
      <section>
        <h2>¿Cuándo?</h2>
        <div class="qr-dates">
          <label class="qr-field">Retiro <span class="req">*</span><input type="datetime-local" name="from" required></label>
          <label class="qr-field">Devolución <span class="req">*</span><input type="datetime-local" name="to" required></label>
        </div>
        <p class="field-warn hidden" id="qr-past">${ICON.alert}El retiro es en el pasado. Revisá la fecha antes de guardar.</p>
        <div class="chips">${QUICK.map(([n, label]) => `<button type="button" class="chip" data-days="${n}">${label}</button>`).join('')}</div>
        <label class="qr-field" style="margin-top:8px">Lugar de retiro<select name="place">${branches.map((b) => `<option value="${b.id}"${b.id === state.branch ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}${choferesMode() ? '' : '<option value="hotel">Hotel (se lo llevamos)</option>'}</select></label>
        <div class="qr-hotel hidden" id="qr-hotel">
          ${
            hotelFee()
              ? `<p class="hotel-fee">${ICON.money}<span>La entrega en hotel tiene un costo extra de <b>${money(hotelFee())}</b>. Se suma al total.</span></p>`
              : isAdmin()
                ? '<p class="muted">La entrega en hotel no tiene costo extra. Si la querés cobrar, ponele precio en Más → Precios y lugares → Adicionales ("Entrega en hotel").</p>'
                : ''
          }
          <p class="muted">Datos del hotel. Si todavía no los sabés, dejalos vacíos: al guardar te damos un link para que el cliente los complete.</p>
          <div class="qr-hotel-grid">${hotelInputs()}</div>
          ${
            // Con varias sucursales, de cuál sale el auto (para la disponibilidad y el contrato).
            branches.length > 1 ? `<label class="qr-field">El auto sale de<select name="branch">${branches.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></label>` : ''
          }
          <label class="check"><input type="checkbox" name="h_return" checked/> La devolución también en el hotel</label>
        </div>
      </section>
      <section>
        <h2>¿Qué auto? <span class="req">*</span> <span class="muted" style="font-weight:400">(libres en esas fechas)</span></h2>
        <div class="cars" id="qr-cars"><p class="muted">Cargando…</p></div>
        <p class="field-error hidden" data-err="car"></p>
        ${insurances().length && !choferesMode() ? `<div style="margin-top:10px">${insuranceSelect('qr-field')}</div>` : ''}
        <label class="qr-field" style="margin-top:10px">Descuento en $ <small class="muted">(opcional, para redondear: 10.000, 20.000…)</small><input name="discount" type="number" inputmode="numeric" min="0" step="any" placeholder="0"></label>
      </section>
      <section>
        <h2>¿Quién lo alquila?</h2>
        <div style="display:flex;flex-direction:column;gap:8px">
          <label class="qr-field">Nombre y apellido <span class="req">*</span><input name="name" autocomplete="off" required aria-describedby="err-name"></label>
          <p class="field-error hidden" data-err="name" id="err-name"></p>
          <label class="qr-field">WhatsApp (con código de país)<input name="phone" type="tel" inputmode="tel" placeholder="+54 9 2901 555123" aria-describedby="err-phone"></label>
          <p class="field-error hidden" data-err="phone" id="err-phone"></p>
        </div>
      </section>
      <div class="qr-total">
        <div class="sum"><span class="muted" id="qr-what">Elegí un auto</span><b id="qr-sum"></b></div>
        <button class="btn ok big" type="submit" data-send="1">${WA_ICON}Guardar y mandar por WhatsApp</button>
        <button class="btn link" type="submit">Guardar sin mandar</button>
      </div>
    </form>`;
  const form = $('#qr', view);
  const set = () => {
    form.from.value = localISO(from);
    form.to.value = localISO(to);
    const days = Math.round((to - from) / 86400000);
    $$('.chip', form).forEach((c) => c.classList.toggle('on', Number(c.dataset.days) === days));
    $('#qr-past', form).classList.toggle('hidden', !isPast(from));
  };
  // Los errores aparecen todos juntos, cada uno debajo de su campo.
  const showErr = (k, msg) => {
    const p = $(`[data-err="${k}"]`, form);
    p.textContent = msg || '';
    p.classList.toggle('hidden', !msg);
    const input = k === 'car' ? null : form[k];
    if (input) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  };
  // "Más opciones" lleva lo ya cargado al formulario completo.
  $('[data-more]', form).addEventListener('click', (e) => {
    e.preventDefault();
    const q = new URLSearchParams({ desde: localISO(from), hasta: localISO(to), lugar: form.place.value });
    if (sel.vehicle) q.set('vehiculo', sel.vehicle);
    if (form.name.value.trim()) q.set('nombre', form.name.value.trim());
    if (form.phone.value.trim()) q.set('tel', form.phone.value.trim());
    location.hash = `#/reservas/completa?${q}`;
  });
  const days = () => Math.max(1, Math.round((to - from) / 86400000));
  const discount = () => Math.max(0, Number(form.discount.value) || 0);
  const summary = () => {
    const c = cars.find((x) => x.id === sel.vehicle);
    $('#qr-what', form).textContent = c ? `${days()} ${days() === 1 ? L('día', 'day') : L('días', 'days')} · ${[c.brand, c.model].filter(Boolean).join(' ') || c.plate}` : 'Elegí un auto';
    const ins = form.insurance && insurances().find((x) => x.id === Number(form.insurance.value));
    const gross = c ? c.quote.total + (sel.hotel ? hotelFee() : 0) + (ins ? insurancePrice(ins, days()) : 0) : 0;
    // El descuento se resta antes del impuesto (como lo calcula el sistema): si el precio no lo incluye, el total baja un poco más.
    const off = c ? Math.min(gross, discount() * (c.quote.tax_included || !c.quote.tax_rate ? 1 : 1 + c.quote.tax_rate / 100)) : 0;
    $('#qr-sum', form).textContent = c ? money(gross - off) : '';
    // En el celular el resumen queda fijo abajo recién cuando hay auto elegido: antes ocupaba un tercio de la pantalla.
    $('.qr-total', form).classList.toggle('ready', Boolean(c));
  };
  const paint = () => {
    const box = $('#qr-cars', form);
    if (sel.vehicle && !cars.some((c) => c.id === sel.vehicle)) {
      // El auto elegido no está libre en las fechas nuevas: se avisa en vez de borrarlo en silencio.
      sel.vehicle = null;
      toast('El auto que habías elegido no está libre en esas fechas. Elegí otro.', true);
    }
    box.innerHTML = cars.length
      ? cars
          .map(
            (c) => `<button type="button" class="car${c.id === sel.vehicle ? ' on' : ''}" data-car="${c.id}" aria-pressed="${c.id === sel.vehicle}">
              <span><b>${esc([c.brand, c.model].filter(Boolean).join(' ') || c.plate)}</b><small>${esc(c.category_name)} · ${esc(c.plate)}</small></span>
              <span class="price">${money(Math.round(c.quote.total / Math.max(1, c.quote.days)))} <small class="muted">/día</small></span>
            </button>`,
          )
          .join('')
      : '<p class="hoy-empty">No hay autos libres en esas fechas.</p>';
    summary();
  };
  // Autos libres: cada categoría con lugar, y dentro de ella los autos sin otra reserva en esas fechas.
  const load = async () => {
    if (!(to > from)) {
      cars = [];
      $('#qr-cars', form).innerHTML = '<p class="error">La devolución tiene que ser después del retiro.</p>';
      return summary();
    }
    const q = `pickup_at=${encodeURIComponent(localISO(from))}&return_at=${encodeURIComponent(localISO(to))}`;
    const cats = (await GET(`/availability?${q}`)).filter((c) => c.available > 0);
    const lists = await Promise.all(cats.map((c) => GET(`/available-vehicles?${q}&category_id=${c.id}`)));
    cars = lists.flatMap((vs, i) => vs.map((v) => ({ ...v, category_name: cats[i].name, quote: cats[i].quote })));
    paint();
  };
  form.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-days]');
    if (chip) {
      to = addDays(from, Number(chip.dataset.days));
      set();
      load();
    }
    const c = e.target.closest('[data-car]');
    if (c) {
      sel.vehicle = Number(c.dataset.car);
      showErr('car');
      paint();
    }
  });
  form.addEventListener('input', (e) => e.target.name === 'discount' && summary());
  form.addEventListener('change', (e) => {
    if (e.target.name === 'insurance') return summary();
    // El WhatsApp se revisa al salir del campo: así el voucher no se manda a un número mal cargado.
    if (e.target.name === 'phone') return showErr('phone', validPhone(e.target.value.trim()) ? '' : PHONE_ERROR);
    if (e.target.name === 'name') return showErr('name', e.target.value.trim() ? '' : 'Escribí el nombre y apellido del cliente.');
    // "Hotel" en el lugar de entrega abre el formulario del hotel ahí mismo.
    if (e.target.name === 'place') {
      sel.hotel = e.target.value === 'hotel';
      $('#qr-hotel', form).classList.toggle('hidden', !sel.hotel);
      if (sel.hotel) form.h_name.focus();
      summary(); // el total suma (o saca) el costo del hotel
      return;
    }
    if (e.target.name !== 'from' && e.target.name !== 'to') return;
    const f = new Date(form.from.value);
    const t = new Date(form.to.value);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return;
    // Si cambia la salida, la vuelta se corre igual: se mantienen los días elegidos.
    if (e.target.name === 'from') to = addDays(f, days());
    else to = t;
    from = f;
    set();
    load();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const send = Boolean(e.submitter && e.submitter.dataset.send);
    const c = cars.find((x) => x.id === sel.vehicle);
    const name = form.name.value.trim();
    const phone = form.phone.value.trim();
    showErr('car', c ? '' : 'Elegí un auto de la lista.');
    showErr('name', name ? '' : 'Escribí el nombre y apellido del cliente.');
    showErr('phone', validPhone(phone) ? '' : PHONE_ERROR);
    if (!c || !name || !validPhone(phone)) {
      $('.field-error:not(.hidden)', form)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (isPast(from) && !(await confirmModal({ title: 'El retiro es en el pasado', text: `La reserva se retira el ${fmtDT(localISO(from))}, que ya pasó. ¿La guardás igual (por ejemplo, para cargar un alquiler que ya empezó)?`, ok: 'Guardar igual' }))) return;
    // Si ya existe un cliente con ese WhatsApp, se usa ese (así no se duplica).
    const digits = phone.replace(/\D/g, '');
    let customer = null;
    if (digits.length >= 6) {
      const found = await GET(`/customers?q=${encodeURIComponent(digits.slice(-6))}`).catch(() => []);
      customer = found.find((x) => String(x.phone || '').replace(/\D/g, '') === digits) || null;
    }
    const r = await run(async () => {
      if (!customer) customer = await POST('/customers', { full_name: name, phone });
      // Sucursal: la elegida como lugar de entrega; con hotel, de la que sale el auto (o la única).
      const branch = sel.hotel ? (form.branch ? Number(form.branch.value) : branches[0] && branches[0].id) : Number(form.place.value);
      return POST('/reservations', {
        customer_id: customer.id,
        category_id: c.category_id,
        vehicle_id: c.id,
        pickup_branch_id: branch || null,
        return_branch_id: branch || null,
        pickup_at: localISO(from),
        return_at: localISO(to),
        status: 'confirmada',
        hotel: sel.hotel ? { ...hotelFrom(form), deliver: true, return: form.h_return.checked } : undefined,
        extras: form.insurance ? [{ extra_id: Number(form.insurance.value), quantity: 1 }] : undefined,
        discount_amount: discount(),
      });
    }, 'Reserva guardada');
    // Hotel sin datos: primero la reserva, donde está el botón para pedírselos al cliente.
    // Sin mandar: al calendario, con la reserva nueva resaltada (el calendario arranca el día antes de la salida).
    if (!send) planningFrom = addDays(new Date(from.getFullYear(), from.getMonth(), from.getDate()), -1);
    location.hash = r.hotel_missing ? `#/reservas/${r.id}` : send ? `#/reservas/${r.id}?accion=voucher` : `#/planning?r=${r.id}`;
  });
  set();
  await load();
}, 'nueva');

/* ============================================================
   Más: todo lo que no se usa todos los días
   ============================================================ */
on(/^\/mas$/, async (view) => {
  const tile = (href, title, sub, icon, tone = '', attrs = '') =>
    `<a href="${href}"${attrs}><i class="ic ${tone}" aria-hidden="true">${icon}</i><div><b>${title}</b><span>${sub}</span></div></a>`;
  const admin = isAdmin();
  view.innerHTML = `
    <div class="page-head"><h1>Más</h1></div>
    ${admin ? `<div class="mas-group">Información</div><div class="mas">${tile('#/estadisticas', 'Estadísticas', 'Qué autos se piden más, categorías, seguros, ingresos, daños y taller', ICON.chart, 'green')}</div>` : ''}
    <div class="mas-group">Reservas y clientes</div>
    <div class="mas">
      ${tile('#/reservas', 'Todas las reservas', 'Buscar, filtrar y ver las anteriores', ICON.list)}
      ${tile('#/reservas/completa', 'Reserva con más opciones', 'Adicionales, descuento, vuelo, otro lugar de devolución', ICON.plus)}
      ${tile('#/clientes', 'Clientes', 'Datos, licencia y sus reservas', ICON.user)}
      ${tile('#/flota?estado=mantenimiento', 'Taller', 'Autos en el taller: mandar, sacar y su historial', ICON.wrench, 'warm')}
      ${choferesMode() ? tile('#/gastos', 'Gastos de los autos', 'Taller, repuestos, combustible, seguro: lo que gasta cada auto', ICON.money, 'warm') : ''}
    </div>
    <div class="mas-group">Para explicar Floty</div>
    <div class="mas">
      ${tile('#/guia', 'Cómo funciona Floty', 'El recorrido de cinco pasos, otra vez', ICON.help, 'green')}
      ${tile('/como-funciona', 'Hoja para mostrar Floty', 'Una página para imprimir o mandar', ICON.doc, 'green')}
    </div>
    <div class="mas-group">Ajustes</div>
    <div class="mas">
      ${tile('#/tarifas', 'Precios y lugares', 'Categorías, tarifas, temporadas, adicionales y lugares', ICON.tag)}
      ${admin ? tile('#/config', 'Empresa y contrato', 'Datos de la empresa, contrato, cancelaciones y factura', ICON.building) : ''}
      ${admin ? tile('#/usuarios', 'Usuarios', 'Quién entra al sistema y qué hizo', ICON.users) : ''}
      ${admin && !choferesMode() ? tile('#/cotizador', 'Página web: formulario', 'Que las cotizaciones de tu página entren solas', ICON.globe) : ''}
      ${admin && !choferesMode() ? tile('#/asistente', 'Link de reservas (opcional)', '¿No tenés reservas por internet? Un link para Instagram y WhatsApp', ICON.link) : ''}
      ${admin ? tile('#/importar', 'Pasar datos de una planilla', 'Autos, clientes y reservas desde Excel o Drive', ICON.sheet) : ''}
    </div>
    <div class="mas-group">Tu cuenta</div>
    <div class="mas">
      ${state.user.platform_admin ? tile('#/empresas', 'Panel de Floty', 'Agencias y sus direcciones (solo vos lo ves)', ICON.panel, 'gray') : ''}
      ${tile('#/mas', 'Cambiar contraseña', esc(state.user.email || ''), ICON.lock, 'gray', ' data-act="pw"')}
      ${tile('#/mas', 'Salir', 'Cerrar la sesión en este dispositivo', ICON.out, 'gray', ' data-act="logout" class="out"')}
    </div>
    ${
      // Sólo en la demo del navegador (scripts/demo/runtime.js define __demoReset).
      window.__demoReset
        ? `<div class="mas-group">Demo</div><div class="mas">${tile('#/mas', 'Reiniciar datos', 'Esta demo guarda los datos solo en este navegador. Vuelve a los datos de ejemplo.', ICON.reset, 'warm', ' id="demo-reset"')}</div>`
        : ''
    }`;
  $('#demo-reset', view)?.addEventListener('click', (e) => {
    e.preventDefault();
    window.__demoReset();
  });
  // Los mismos botones de la barra de la compu (en el celular esa barra no los muestra).
  $$('[data-act]', view).forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      $(a.dataset.act === 'pw' ? '#change-pw' : '#logout').click();
    }),
  );
}, 'mas');

function breakdownHtml(q) {
  const row = (l, v, cls = '') => `<tr class="${cls}"><td>${l}</td><td class="right">${v}</td></tr>`;
  return `<table class="breakdown"><tbody>
    ${row(`${esc(q.category ? q.category.name : '')} · ${baseLabel(q, q.days)}`, money(q.base))}
    ${q.season_extra ? row('Recargo de temporada', money(q.season_extra)) : ''}
    ${q.promo_discount ? row(`Promoción: ${esc(q.promo.name)}`, '−' + money(q.promo_discount)) : ''}
    ${q.dynamic_extra ? row(`Recargo por alta demanda ${q.dynamic_pct}%`, money(q.dynamic_extra)) : ''}
    ${(q.extras || []).map((x) => row(`${esc(x.name)}${x.quantity > 1 ? ` ×${x.quantity}` : ''}`, money(x.amount))).join('')}
    ${q.one_way_fee ? row('Devolución en otra sucursal', money(q.one_way_fee)) : ''}
    ${q.discount ? row(`Descuento${q.discount_pct ? ` ${q.discount_pct}%` : ''}`, '−' + money(q.discount)) : ''}
    ${q.tax_rate ? row(`${esc(taxName())} ${q.tax_rate}% ${q.tax_included ? '(incluido)' : ''}`, money(q.tax)) : ''}
    ${q.calculated_total !== undefined ? row('<span class="muted">Precio según tarifas del sistema</span>', `<span class="muted">${money(q.calculated_total)}</span>`) : ''}
    ${row(q.source === 'acordado' ? 'Total (precio acordado)' : q.calculated_total !== undefined ? `Total (precio del ${STATUS_LABEL[q.source] || q.source})` : 'Total', money(q.total), 'total')}
    </tbody></table>
    <p class="muted">Garantía: ${money(q.deposit)}${q.km_included ? ` · Km incluidos: ${q.km_included}` : ' · Km libres'}${q.periods ? ` · Se cobra por adelantado y se renueva cada ${periodWord(1)}` : ''}</p>`;
}

/* ============================================================
   Reserva: detalle y operación (entrega, devolución, pagos)
   ============================================================ */
on(/^\/reservas\/(\d+)(?:\?accion=(\w+))?$/, async (view, id, accion) => {
  const r = await GET(`/reservations/${id}`);
  const c = r.contract;
  const canEdit = ['pendiente', 'confirmada'].includes(r.status);
  // Arriba sólo el próximo paso; lo que se usa poco va en "Más acciones".
  const actions = [];
  const more = [];
  if (r.status === 'pendiente') actions.push(`<button class="btn primary" data-act="confirm">${ICON.check}Confirmar</button>`);
  if (canEdit) {
    actions.push(`<button class="btn ${r.status === 'confirmada' ? 'ok' : ''}" data-act="checkout">${ICON.key}Entregar vehículo</button>`);
    more.push(`<button data-act="assign">${r.vehicle_id ? 'Cambiar de auto o intercambiar' : 'Asignar vehículo'}</button>`);
    more.push('<button data-act="edit">Modificar fechas o datos</button>');
  }
  const hotelOpen = ['pendiente', 'confirmada', 'en_curso'].includes(r.status);
  if (hotelOpen && !r.hotel && !choferesMode()) more.push('<button data-act="hotel">Entregar o retirar en un hotel</button>');
  if (r.status === 'en_curso') actions.push(`<button class="btn ok" data-act="checkin">${ICON.in}Registrar devolución</button>`);
  if (proOn() && !choferesMode() && r.status === 'confirmada') {
    actions.push(`<button class="btn" data-act="preDelivery">${ICON.key}${r.signature && r.signature.pre_delivery ? 'Cambiar la pre-entrega' : 'Pre-entrega'}</button>`);
    if (r.signature && r.signature.pre_delivery) actions.push(`<button class="btn" data-act="express">${ICON.send}Mandar link de firma</button>`);
  }
  if (proOn() && !choferesMode() && r.status === 'en_curso') actions.push(`<button class="btn" data-act="returnPhotos">${ICON.send}Fotos de la devolución</button>`);
  // Saldo a cobrar a la vista, con el importe: un toque abre el cobro ya completado.
  if (['confirmada', 'en_curso', 'finalizada'].includes(r.status) && r.balance.pending > 0)
    actions.push(`<button class="btn ${r.status === 'finalizada' ? 'primary' : ''}" data-act="pay">${ICON.money}Cobrar ${money(r.balance.pending)}</button>`);
  if (['cancelada', 'no_show'].includes(r.status)) actions.push('<button class="btn" data-act="reopen">Reabrir</button>');
  if (!['cancelada', 'no_show'].includes(r.status)) {
    if (r.status !== 'finalizada' && !choferesMode()) actions.push(`<button class="btn" data-act="voucher">${ICON.send}Enviar voucher</button>`);
    actions.push(`<button class="btn" data-act="pdf">${ICON.doc}Contrato PDF</button>`);
    more.push('<button data-act="print">Imprimir contrato</button>');
  }
  const invoiced = (r.invoices || []).some((i) => i.status === 'emitida');
  if (state.settings.invoice_provider && ['confirmada', 'en_curso', 'finalizada'].includes(r.status) && !invoiced) more.unshift('<button data-act="invoice">Facturar (prueba)</button>');
  if (canEdit) {
    // Recién cuando pasó la hora de retiro (antes de eso, es una cancelación).
    if (!choferesMode() && new Date(String(r.pickup_at).replace(' ', 'T')) <= new Date()) more.push('<button class="danger" data-act="noshow">El cliente no se presentó</button>');
    more.push('<button class="danger" data-act="cancel">Cancelar reserva</button>');
  }
  if (more.length) actions.push(`<details class="menu"><summary class="btn">Más acciones</summary><div class="menu-list">${more.join('')}</div></details>`);

  view.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(r.code)} ${badge(r.status)}${sourceBadge(r.source)}</h1>
      ${r.external_id ? `<small class="muted">Id en cotizador: ${esc(r.external_id)}</small>` : ''}</div>
      <div class="actions no-print">${actions.join('')}</div>
    </div>
    <div class="detail">
      <div class="col">
      <div class="card">
        <h2>Datos de la reserva</h2>
        <dl class="info">
          <dt>Cliente</dt><dd><b>${esc(r.customer_name)}</b><br><small>${esc(r.customer_doc || '')} · ${esc(r.customer_phone || '')} · ${esc(r.customer_email || '')}</small>
            <br><button class="btn small no-print" type="button" data-docs style="margin-top:6px">Carnet y DNI</button></dd>
          <dt>Retiro</dt><dd>${fmtDT(r.pickup_at)} · ${esc(r.pickup_branch_name || '')}</dd>
          <dt>Devolución</dt><dd>${fmtDT(r.return_at)} · ${esc(r.return_branch_name || '')}</dd>
          <dt>Categoría</dt><dd>${esc(r.category_code)} · ${esc(r.category_name)}</dd>
          <dt>Vehículo</dt><dd>${r.vehicle_plate ? `<b>${esc(r.vehicle_plate)}</b> ${esc(r.vehicle_brand)} ${esc(r.vehicle_model)}` : '<span class="badge b-pendiente">Sin asignar</span>'}</dd>
          ${
            choferesMode()
              ? ''
              : `<dt>Seguro</dt><dd>${resInsurance(r) ? `<b>${esc(resInsurance(r).name)}</b> · ${resInsurance(r).deductible ? `franquicia ${money(resInsurance(r).deductible)}` : 'sin franquicia'}` : '<span class="muted">Sin elegir</span>'}</dd>
          <dt>Adicionales</dt><dd>${resAddons(r).map((x) => esc(x.name)).join(', ') || '—'}</dd>`
          }
          ${r.flight ? `<dt>Vuelo</dt><dd>${esc(r.flight)}</dd>` : ''}
          <dt>Notas</dt><dd>${esc(r.notes || '—')}</dd>
        </dl>
      </div>
      ${
        r.hotel
          ? `<div class="card hotel-card${r.hotel_missing ? ' missing' : ''}">
        <h2>${ICON.building} ${[r.hotel.deliver && 'Entrega', r.hotel.return && 'devolución'].filter(Boolean).join(' y ').replace(/^d/, 'D')} en hotel</h2>
        ${
          r.hotel_missing
            ? `<p class="hotel-warn">Faltan los datos del hotel. Completalos vos o pedíselos al cliente: le llega un link para completarlos desde el celular.</p>`
            : `<dl class="info">${HOTEL_FIELDS.filter(([k]) => r.hotel[k])
                .map(([k, label]) => `<dt>${label}</dt><dd>${esc(r.hotel[k])}</dd>`)
                .join('')}</dl>`
        }
        ${
          hotelOpen
            ? `<div class="actions no-print" style="margin-top:12px">
          <button class="btn${r.hotel_missing ? '' : ' small'}" type="button" data-act="hotel">${r.hotel_missing ? 'Completar yo' : 'Cambiar'}</button>
          ${r.customer_phone ? `<a class="btn${r.hotel_missing ? ' ok' : ' small'}" href="${esc(hotelAsk(r))}" target="_blank" rel="noopener">${WA_ICON}${r.hotel_missing ? 'Pedírselos por WhatsApp' : 'Mandarle el link'}</a>` : ''}
          <button class="btn small" type="button" data-hotel-copy>Copiar link</button>
        </div>`
            : ''
        }
      </div>`
          : ''
      }
      ${
        c
          ? `<div class="card"><h2>Contrato ${esc(c.number)}</h2>
        <dl class="info">
          <dt>Salida</dt><dd>${fmtDT(c.out_at)} · ${c.out_km} km · combustible ${fuel(c.out_fuel)}</dd>
          ${c.out_notes ? `<dt>Obs. salida</dt><dd>${esc(c.out_notes)}</dd>` : ''}
          <dt>Devolución</dt><dd>${c.in_at ? `${fmtDT(c.in_at)} · ${c.in_km} km · combustible ${fuel(c.in_fuel)}` : '<span class="muted">Pendiente</span>'}</dd>
          ${c.in_notes ? `<dt>Obs. devolución</dt><dd>${esc(c.in_notes)}</dd>` : ''}
          ${c.charges ? `<dt>Km recorridos</dt><dd>${c.charges.km_driven}</dd>` : ''}
        </dl>
        ${
          c.charges && c.charges.lines.length
            ? `<h3 style="margin-top:12px">Cargos adicionales</h3><table class="breakdown"><tbody>${c.charges.lines
                .map((l) => `<tr><td>${esc(l.concept)}</td><td class="right">${money(l.amount)}</td></tr>`)
                .join('')}<tr class="total"><td>Total final</td><td class="right">${money(c.final_total)}</td></tr></tbody></table>`
            : ''
        }</div>`
          : ''
      }
      ${signatureCardHtml(r)}
      ${clientCardHtml(r)}
      ${rentalCardHtml(r)}
      ${invoicesCardHtml(r)}
      ${filesCardHtml(r)}
      </div>
      <div class="col">
      <div class="card"><h2>Precio</h2>${r.pricing ? breakdownHtml(r.pricing) : money(r.total)}</div>
      <div class="card">
        <h2>Pagos</h2>
        <dl class="info">
          <dt>Total a cobrar</dt><dd><b>${money(r.balance.due)}</b></dd>
          <dt>Pagado</dt><dd>${money(r.balance.paid)}</dd>
          <dt>Saldo</dt><dd><b class="${r.balance.pending > 0 ? 'error' : ''}">${money(r.balance.pending)}</b></dd>
          <dt>Garantía retenida</dt><dd>${money(r.balance.deposit_held)} <small class="muted">(sugerida ${money(r.deposit)})</small></dd>
        </dl>
        ${
          r.payments.length
            ? `<div class="table-scroll"><table class="mini" style="margin-top:12px"><thead><tr><th>Fecha</th><th>Tipo</th><th>Medio</th><th class="right">Importe</th></tr></thead><tbody>${r.payments
                .map(
                  (p) =>
                    `<tr><td class="nowrap">${fmtDT(stampLocal(p.created_at)).slice(0, 5)} ${esc(stampLocal(p.created_at).slice(11, 16))}</td><td>${esc(PAYMENT_KINDS[p.kind] || p.kind)}</td><td>${esc(p.method || '')} ${p.reference ? `<small class="muted">${esc(p.reference)}</small>` : ''}${p.notes ? `<br><small class="muted">${esc(p.notes)}</small>` : ''}</td><td class="right">${money(p.amount)}</td></tr>`,
                )
                .join('')}</tbody></table></div>`
            : ''
        }
        <div class="actions no-print" style="margin-top:12px"><button class="btn" data-act="pay">+ Registrar pago / garantía</button></div>
      </div>
      <div class="card"><h2>Historial</h2>
        <ol class="timeline">${r.log
          .slice()
          .reverse()
          .map(
            (l) => `<li><div class="t-head"><b>${esc(LOG_LABEL[l.action] || l.action)}</b><small>${fmtDT(stampLocal(l.at))} · ${esc(l.user_name || 'sistema')}</small></div>${
              l.detail ? `<div class="t-detail">${esc(logDetail(l.detail))}</div>` : ''
            }</li>`,
          )
          .join('')}</ol>
      </div>
      </div>
    </div>
`;

  const reload = () => route();
  const handlers = {
    // Al confirmar se abre el envío del voucher, que es lo que sigue.
    confirm: () => run(() => POST(`/reservations/${r.id}/status`, { status: 'confirmada' }), 'Reserva confirmada').then(() => (location.hash = `#/reservas/${r.id}?accion=voucher`)),
    // Antes de cancelar se muestra cuánto corresponde devolver según la política; al confirmar queda registrado.
    cancel: async () => {
      const f = await run(() => GET(`/reservations/${r.id}/refund`));
      openModal(
        `Cancelar ${r.code}`,
        `<div class="card" style="margin-bottom:12px">
           <p style="margin:0">Según la política de la empresa (cancela <b>${esc(f.rule)}</b> del retiro) corresponde devolver
             <b>${f.percent} %</b> de lo pagado: <b style="font-size:18px">${money(f.amount)}</b>${f.paid ? ` de ${money(f.paid)}` : ' (no hay pagos registrados)'}.</p>
           ${r.balance.deposit_held > 0 ? `<p class="muted" style="margin:6px 0 0">La garantía (${money(r.balance.deposit_held)}) se devuelve aparte, completa.</p>` : ''}
         </div>
         <form><div class="form-grid"><label class="full">Motivo de la cancelación (opcional)<input name="reason"/></label></div>
         <p class="muted">El sistema sólo calcula y deja registrada la devolución: el dinero lo devolvés vos y lo anotás en Pagos como "Devolución de dinero".</p>
         <div class="actions"><button class="btn danger" type="submit">Cancelar la reserva</button><button class="btn" type="button" data-close>Volver</button></div></form>`,
        async (d) => {
          const res = await POST(`/reservations/${r.id}/status`, { status: 'cancelada', reason: d.reason });
          toast(`Reserva cancelada. Corresponde devolver ${money(res.refund ? res.refund.amount : 0)}.`);
          reload();
        },
      );
    },
    noshow: async () =>
      (await confirmModal({ title: 'El cliente no se presentó', text: `La reserva ${r.code} queda como "no show" y se libera el auto. Según tu política, no corresponde devolver dinero.`, ok: 'Marcar no show', danger: true })) &&
      run(() => POST(`/reservations/${r.id}/status`, { status: 'no_show' }), 'Marcada como no show').then(reload),
    reopen: () => run(() => POST(`/reservations/${r.id}/status`, { status: 'pendiente' }), 'Reserva reabierta').then(reload),
    invoice: async () =>
      (await confirmModal({ title: 'Emitir factura de prueba', text: `Se emite por ${money(r.balance.due)}. Es de prueba: no tiene validez fiscal.`, ok: 'Emitir', danger: true })) &&
      run(() => POST(`/reservations/${r.id}/invoice`), 'Factura de prueba emitida').then(reload),
    // Entrega y/o devolución en un hotel: los datos pueden quedar vacíos (los completa el cliente con su link).
    hotel: () => {
      const h = r.hotel || { deliver: 1, return: 1 };
      openModal(
        'Entrega en hotel',
        `<form><div class="form-grid">
           <label class="check"><input type="checkbox" name="h_deliver" ${h.deliver ? 'checked' : ''}/> Le llevamos el auto al hotel</label>
           <label class="check"><input type="checkbox" name="h_return" ${h.return ? 'checked' : ''}/> Lo retiramos del hotel al final</label>
           ${hotelInputs(h, '')}
         </div>
         ${hotelFee() && canEdit ? `<p class="hotel-fee">${ICON.money}<span>La entrega en hotel suma <b>${money(hotelFee())}</b> al precio (si destildás las dos opciones, se saca).</span></p>` : ''}
         <p class="muted">Si no sabés algún dato, dejalo vacío y mandale el link al cliente. Destildá las dos opciones para volver a la agencia.</p>
         <div class="actions"><button class="btn primary" type="submit">Guardar</button><button class="btn" type="button" data-close>Cancelar</button></div></form>`,
        async (_d, form) => {
          await POST(`/reservations/${r.id}/hotel`, { ...hotelFrom(form), deliver: form.h_deliver.checked, return: form.h_return.checked });
          toast('Hotel guardado');
          reload();
        },
      );
    },
    assign: async () => {
      const { free, swaps } = await GET(`/reservations/${r.id}/move-options`);
      const car = (v) => `${v.plate} · ${v.brand} ${v.model} · ${v.km} km · ${v.branch_name || ''}`;
      const options = [
        ...(r.vehicle_id ? [[r.vehicle_id, `${r.vehicle_plate} · ${L('el que tiene ahora', 'current car')}`]] : []),
        ...free.map((v) => [v.id, car(v)]),
        ...swaps.map((v) => [`swap-${v.reservation_id}`, `${L('Intercambiar con', 'Swap with')} ${v.customer_name} · ${v.plate} ${v.brand} ${v.model}`]),
      ];
      openModal(
        r.vehicle_id ? 'Cambiar de auto o intercambiar' : 'Asignar vehículo',
        formHtml([{ name: 'vehicle_id', label: 'Vehículo', type: 'select', full: true, options }], { vehicle_id: r.vehicle_id }),
        async (d) => {
          const swap = /^swap-(\d+)$/.exec(d.vehicle_id || '');
          if (swap) await POST(`/reservations/${r.id}/swap`, { reservation_id: Number(swap[1]) });
          else await POST(`/reservations/${r.id}/assign`, { vehicle_id: d.vehicle_id ? Number(d.vehicle_id) : null });
          toast(swap ? 'Autos intercambiados' : 'Vehículo asignado');
          reload();
        },
      );
    },
    checkout: async () => {
      // Para entregar sirve sólo un auto que esté hoy en la playa (no alquilado a otro cliente).
      const list = (await GET(`/reservations/${r.id}/available-vehicles`)).filter((v) => v.status !== 'alquilado' || v.id === r.vehicle_id);
      if (r.vehicle_id && !list.some((v) => v.id === r.vehicle_id)) list.unshift({ id: r.vehicle_id, plate: r.vehicle_plate, brand: r.vehicle_brand, model: r.vehicle_model, km: '' });
      if (!list.length) return toast('No hay vehículos libres de esta categoría', true);
      const vOpts = list.map((v) => [v.id, `${v.plate} · ${v.brand} ${v.model}${v.km !== '' ? ` · ${v.km} km` : ''}`]);
      const first = list.find((v) => v.id === r.vehicle_id) || list[0];
      openModal(
        `Entrega · ${r.code}`,
        formHtml(
          [
            { name: 'vehicle_id', label: 'Vehículo', type: 'select', options: vOpts, required: true, full: true },
            { name: 'out_at', label: 'Fecha y hora de salida', type: 'datetime-local', required: true },
            { name: 'out_km', label: 'Km de salida', type: 'number', required: true },
            { name: 'out_fuel', label: 'Combustible (octavos)', type: 'select', options: FUEL_OPTS, required: true },
            { name: 'out_notes', label: 'Observaciones / estado del vehículo', type: 'textarea', full: true },
            { name: 'fotos', label: 'Fotos del auto al entregarlo (frente, laterales, cola, interior, tablero con km y combustible)', type: 'photos' },
          ],
          { vehicle_id: first.id, out_at: localISO(new Date()), out_km: first.km, out_fuel: first.fuel ?? 8 },
          'Entregar y abrir contrato',
        ),
        async (d, form) => {
          await POST(`/reservations/${r.id}/checkout`, { ...d, vehicle_id: Number(d.vehicle_id), out_fuel: Number(d.out_fuel) });
          toast('Vehículo entregado. Contrato abierto.');
          try {
            await uploadFiles(r.id, 'entrega', form.fotos.files);
          } catch (e) {
            toast(`La entrega quedó registrada, pero falló una foto: ${e.message}. Podés subirla desde la reserva.`, true);
          }
          reload();
        },
      );
      const sel = $('#modal-body [name=vehicle_id]');
      sel.addEventListener('change', () => {
        const v = list.find((x) => x.id === Number(sel.value));
        if (v && v.km !== '') $('#modal-body [name=out_km]').value = v.km;
        if (v && v.fuel !== undefined) $('#modal-body [name=out_fuel]').value = v.fuel;
      });
    },
    // Pre-entrega: el auto queda listo sin que arranque el alquiler. La entrega se completa cuando el cliente firma.
    preDelivery: async () => {
      const list = (await GET(`/reservations/${r.id}/available-vehicles`)).filter((v) => v.status !== 'alquilado' || v.id === r.vehicle_id);
      if (r.vehicle_id && !list.some((v) => v.id === r.vehicle_id)) list.unshift({ id: r.vehicle_id, plate: r.vehicle_plate, brand: r.vehicle_brand, model: r.vehicle_model, km: '' });
      if (!list.length) return toast('No hay vehículos libres de esta categoría', true);
      const pre = r.signature && r.signature.pre_delivery;
      const first = list.find((v) => v.id === (pre ? pre.vehicle_id : r.vehicle_id)) || list[0];
      openModal(
        `Pre-entrega · ${r.code}`,
        formHtml(
          [
            { name: 'vehicle_id', label: 'Vehículo', type: 'select', options: list.map((v) => [v.id, `${v.plate} · ${v.brand} ${v.model}${v.km !== '' ? ` · ${v.km} km` : ''}`]), required: true, full: true },
            { name: 'left_place', label: 'Dónde queda el auto (el cliente lo ve recién al firmar)', required: true, full: true },
            { name: 'out_km', label: 'Km de salida', type: 'number', required: true },
            { name: 'out_fuel', label: 'Combustible (octavos)', type: 'select', options: FUEL_OPTS, required: true },
            { name: 'out_notes', label: 'Observaciones / estado del vehículo', type: 'textarea', full: true },
            { name: 'fotos', label: 'Fotos del auto (frente, laterales, cola, interior, tablero con km y combustible)', type: 'photos' },
          ],
          { vehicle_id: first.id, left_place: (r.signature && r.signature.left_place) || '', out_km: pre ? pre.out_km : first.km, out_fuel: pre ? pre.out_fuel : first.fuel ?? 8, out_notes: (pre && pre.out_notes) || '' },
          'Guardar pre-entrega',
        ),
        async (d, form) => {
          await POST(`/reservations/${r.id}/pre-delivery`, { ...d, vehicle_id: Number(d.vehicle_id), out_fuel: Number(d.out_fuel), terms: contractTermsList(r) });
          toast('Pre-entrega guardada. El alquiler arranca cuando el cliente firme.');
          try {
            await uploadFiles(r.id, 'entrega', form.fotos.files);
          } catch (e) {
            toast(`La pre-entrega quedó guardada, pero falló una foto: ${e.message}. Podés subirla desde la reserva.`, true);
          }
          location.hash = `#/reservas/${r.id}?accion=express`;
        },
      );
      const sel = $('#modal-body [name=vehicle_id]');
      sel.addEventListener('change', () => {
        const v = list.find((x) => x.id === Number(sel.value));
        if (v && v.km !== '') $('#modal-body [name=out_km]').value = v.km;
        if (v && v.fuel !== undefined) $('#modal-body [name=out_fuel]').value = v.fuel;
      });
    },
    checkin: () =>
      openModal(
        `Devolución · ${r.code}`,
        formHtml(
          [
            { name: 'in_at', label: 'Fecha y hora de devolución', type: 'datetime-local', required: true },
            { name: 'return_branch_id', label: 'Sucursal de devolución', type: 'select', options: branchOptions, required: true },
            { name: 'in_km', label: `Km de llegada (salió con ${c.out_km})`, type: 'number', required: true, attrs: `min="${c.out_km}"` },
            { name: 'in_fuel', label: `Combustible (salió con ${c.out_fuel}/8)`, type: 'select', options: FUEL_OPTS, required: true },
            { name: 'damage_charge', label: 'Cargo por daños', type: 'number', default: 0 },
            { name: 'in_notes', label: 'Observaciones / daños detectados', type: 'textarea', full: true },
            { name: 'fotos', label: 'Fotos del auto al recibirlo (daños, km y combustible)', type: 'photos' },
            { name: 'send_to_maintenance', label: 'Enviar el vehículo a taller', type: 'checkbox', full: true },
          ],
          { in_at: localISO(new Date()), return_branch_id: r.return_branch_id, in_fuel: c.out_fuel },
          'Cerrar contrato',
        ),
        async (d, form) => {
          await POST(`/reservations/${r.id}/checkin`, { ...d, return_branch_id: Number(d.return_branch_id), in_fuel: Number(d.in_fuel) });
          toast('Devolución registrada');
          try {
            await uploadFiles(r.id, 'devolucion', form.fotos.files);
          } catch (e) {
            toast(`La devolución quedó registrada, pero falló una foto: ${e.message}. Podés subirla desde la reserva.`, true);
          }
          // Si quedó saldo (km o combustible de más, daños), se abre el cobro directo.
          location.hash = `#/reservas/${r.id}?accion=pay`;
        },
      ),
    pay: () =>
      openModal(
        'Registrar movimiento',
        formHtml(
          [
            { name: 'kind', label: 'Tipo', type: 'select', options: Object.entries(PAYMENT_KINDS), required: true },
            {
              name: 'method',
              label: 'Medio',
              type: 'select',
              options: [...['efectivo', 'tarjeta', 'transferencia', 'mercadopago', 'otro'].map((m) => [m, m]), ...(choferesMode() ? [['repuesto', 'repuesto o arreglo que pagó el chofer']] : [])],
              required: true,
            },
            { name: 'amount', label: 'Importe', type: 'number', required: true },
            { name: 'reference', label: 'Referencia / comprobante' },
            { name: 'notes', label: 'Notas (por ejemplo: pagó $30.000 y $20.000 en una batería)', type: 'textarea', full: true },
          ],
          { kind: 'pago', method: 'efectivo', amount: r.balance.pending > 0 ? r.balance.pending : '' },
        ),
        async (d) => {
          await POST(`/reservations/${r.id}/payments`, d);
          toast('Movimiento registrado');
          reload();
        },
      ),
    edit: () =>
      openModal(
        `Modificar ${r.code}`,
        formHtml(
          [
            { name: 'pickup_at', label: 'Retiro', type: 'datetime-local', required: true },
            { name: 'return_at', label: 'Devolución', type: 'datetime-local', required: true },
            { name: 'pickup_branch_id', label: 'Lugar de retiro', type: 'select', options: branchOptions },
            { name: 'return_branch_id', label: 'Lugar de devolución', type: 'select', options: branchOptions },
            { name: 'category_id', label: 'Categoría', type: 'select', options: () => state.categories.map((x) => [x.id, `${x.code} · ${x.name}`]), required: true },
            { name: 'discount_pct', label: 'Descuento %', type: 'number' },
            { name: 'discount_amount', label: 'Descuento en $', type: 'number' },
            { name: 'price_override', label: `Precio final acordado (opcional; ahora ${money(r.total)})`, type: 'number' },
            { name: 'flight', label: 'Vuelo / referencia', when: () => !choferesMode() },
            { name: 'notes', label: 'Notas', type: 'textarea', full: true },
            ...(r.pricing && r.pricing.calculated_total !== undefined
              ? [{ name: 'recalculate', label: 'Recalcular el precio con las tarifas del sistema (descarta el precio del cotizador)', type: 'checkbox', full: true }]
              : []),
          ],
          r,
        ),
        async (d) => {
          const body = { ...d, category_id: Number(d.category_id), recalculate: !!d.recalculate };
          if (body.category_id !== r.category_id) body.vehicle_id = null;
          await PUT(`/reservations/${r.id}`, body);
          toast('Reserva modificada');
          reload();
        },
      ),
    fine: () =>
      openModal(
        'Cargar multa o cargo',
        formHtml(
          [
            { name: 'kind', label: 'Tipo', type: 'select', required: true, options: [['multa', 'Multa de tránsito'], ['otro', 'Otro cargo (acarreo, lavado, daño…)']] },
            { name: 'amount', label: 'Importe', type: 'number', required: true },
            { name: 'date', label: 'Fecha de la infracción', type: 'date' },
            { name: 'reference', label: 'N° de acta o comprobante' },
            { name: 'description', label: 'Detalle', full: true },
          ],
          { kind: 'multa', date: localISO(new Date()).slice(0, 10) },
        ),
        async (d) => {
          await POST(`/reservations/${r.id}/charges`, d);
          toast('Cargo registrado: se suma a lo que debe el chofer');
          reload();
        },
      ),
    km: () =>
      openModal(
        'Registrar kilometraje',
        `<p class="muted">Si pasó los km incluidos (${num(Number(r.category_km_per_period) || 0)} por ${periodWord(1)}), se cobra el excedente.</p>${formHtml([{ name: 'km', label: 'Km que marca hoy el auto', type: 'number', required: true }], { km: r.vehicle_km })}`,
        async (d) => {
          const res = await POST(`/reservations/${r.id}/km`, d);
          toast(res.km_charge ? `Se pasó ${num(res.km_charge.km)} km: se cobran ${money(res.km_charge.amount)}` : 'Km registrados: está dentro de lo incluido');
          reload();
        },
      ),
    start: () =>
      openModal(
        'Corregir desde cuándo corre el alquiler',
        `<p class="muted">Para un alquiler que se cargó con otra fecha: se rearman los ${periodWord(2)} desde la fecha nueva hasta hoy, al precio de ahora. Los pagos no se tocan.</p>${formHtml(
          [{ name: 'start_at', label: 'Empezó el', type: 'datetime-local', required: true }],
          { start_at: r.pickup_at },
        )}`,
        async (d) => {
          await PUT(`/reservations/${r.id}/start`, d);
          toast('Inicio corregido');
          reload();
        },
      ),
    print: () => printContract(r),
    voucher: () => sendVoucher(r),
    sign: async () => {
      const s = await run(() => POST(`/reservations/${r.id}/signature`, { terms: contractTermsList(r) }));
      if (!s) return;
      const link = clientLink('firmar', s.token);
      openModal(`Firma del contrato · ${r.code}`, sendStep('Contrato para firmar', 'Le llega un link: lee el contrato y firma con el dedo. La firma aparece sola en la reserva.', r, contractMessage(r, link), link));
    },
    express: async () => {
      const s = await run(() => POST(`/reservations/${r.id}/signature`, { terms: contractTermsList(r) }));
      if (!s) return;
      const contract = clientLink('firmar', s.token);
      const photos = clientLink('fotos', s.photos_token);
      const count = r.files.filter((f) => f.stage === 'entrega' && f.mime.startsWith('image/')).length;
      const signed = s.signed_at && !s.stale;
      openModal(
        `Pre-entrega · ${r.code}`,
        `<label>Dónde quedó el auto<input id="left-place" maxlength="300" placeholder="Ej.: Estacionamiento del aeropuerto, nivel 2, lugar 45" value="${esc(s.left_place || '')}"/></label>
         <p class="muted">El cliente lo ve recién después de firmar.</p>
         ${count ? '' : '<p class="notice warn">Todavía no hay fotos de la entrega: agregalas desde la reserva antes de mandar el link, así las ve al firmar.</p>'}
         <div id="express-send">${
           signed
             ? sendStep('Contrato firmado y fotos', 'Ya firmó. Le llegan los links del contrato firmado y de las fotos.', r, signedMessage(r, contract, photos, s.left_place), contract)
             : sendStep('Contrato y fotos', `Ve ${count} foto${count === 1 ? '' : 's'} y el estado del auto en la misma pantalla donde firma.`, r, expressMessage(r, contract), contract)
         }</div>`,
      );
      const place = $('#left-place');
      place.addEventListener('input', () => {
        const wa = $('#express-send a');
        if (wa && signed) wa.href = waText(r, signedMessage(r, contract, photos, place.value.trim()));
      });
      place.addEventListener('change', () => run(() => POST(`/reservations/${r.id}/left-place`, { place: place.value })));
    },
    sendSigned: () => {
      const s = r.signature;
      const contract = clientLink('firmar', s.token);
      openModal(`Contrato firmado · ${r.code}`, sendStep('Contrato firmado y fotos', 'Le llegan los links del contrato firmado y de las fotos.', r, signedMessage(r, contract, clientLink('fotos', s.photos_token), s.left_place), contract));
    },
    returnPhotos: async () => {
      const c = await run(() => POST(`/reservations/${r.id}/return-link`));
      if (!c) return;
      const link = clientLink('devolucion', c.return_token);
      openModal(`Fotos de la devolución · ${r.code}`, sendStep('Link para el cliente', 'Saca las fotos desde el celular y aparecen solas en esta reserva, en Devolución. El link se cierra al registrar la devolución.', r, returnMessage(r, link), link));
    },
    card: async () => {
      const c = await run(() => POST(`/reservations/${r.id}/card-link`));
      if (!c) return;
      const link = clientLink('tarjeta', c.card_token);
      const text = `${L('Hola', 'Hi')} ${String(r.customer_name || '').split(' ')[0]}! ${L(`Para tu reserva ${r.code} en ${state.settings.company_name}, dejá acá los datos de tu tarjeta`, `For your booking ${r.code} at ${state.settings.company_name}, please leave your card details here`)}: ${link}`;
      openModal(`Tarjeta del cliente · ${r.code}`, sendStep('Dejar la tarjeta', 'Carga los datos desde el celular. Queda guardada la marca, los últimos 4 dígitos, el titular y el vencimiento.', r, text, link));
    },
    pdf: async () => {
      if (!window.jspdf) return toast('No se pudo cargar el generador de PDF. Recargá la página e intentá de nuevo.', true);
      let built;
      try {
        built = buildContractPdf(r);
      } catch (e) {
        console.error(e);
        return toast('No se pudo generar el PDF del contrato.', true);
      }
      const blob = built.doc.output('blob');
      downloadBlob(blob, built.filename);
      // Copia archivada en la reserva, en "Fotos y documentación" → Contratos.
      try {
        await uploadFiles(r.id, 'contrato', [new File([blob], built.filename, { type: 'application/pdf' })]);
        toast('Contrato PDF descargado y guardado en la reserva');
      } catch (e) {
        toast(`El PDF se descargó, pero no se pudo guardar una copia en la reserva: ${e.message}`, true);
      }
      reload();
    },
    photos: () =>
      openModal(
        'Agregar fotos o documentos',
        formHtml(
          [
            {
              name: 'stage',
              label: 'Corresponden a',
              type: 'select',
              required: true,
              options: [['entrega', 'Entrega del auto'], ['devolucion', 'Devolución del auto'], ['otro', 'Otros documentos']],
            },
            { name: 'fotos', label: 'Archivos', type: 'photos' },
          ],
          { stage: r.status === 'finalizada' ? 'devolucion' : r.status === 'en_curso' || (r.signature && r.signature.pre_delivery) ? 'entrega' : 'otro' },
          'Subir',
        ),
        async (d, form) => {
          if (!form.fotos.files.length) throw new Error('Elegí al menos una foto o documento');
          await uploadFiles(r.id, d.stage, form.fotos.files);
          reload();
        },
      ),
  };
  $$('[data-act]', view).forEach((b) => b.addEventListener('click', () => handlers[b.dataset.act]()));
  $$('[data-del-charge]', view).forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmModal({ title: 'Borrar cargo', text: 'Se saca de lo que debe el chofer.', ok: 'Borrar', danger: true }))) return;
      run(() => DEL(`/reservations/${r.id}/charges/${b.dataset.delCharge}`), 'Cargo borrado').then(reload);
    }),
  );
  $('[data-hotel-copy]', view)?.addEventListener('click', () =>
    (navigator.clipboard ? navigator.clipboard.writeText(hotelLink(r)) : Promise.reject()).then(() => toast('Link copiado: mandáselo al cliente'), () => toast(hotelLink(r))),
  );
  wireFiles(view, r, reload);
  $('[data-docs]', view)?.addEventListener('click', () => openDocuments(r.customer_id, r.customer_name));
  // Con ?accion=checkout|checkin|pay se abre ese paso directo si el estado lo permite (pay: sólo si queda saldo).
  if (accion) {
    history.replaceState(null, '', `#/reservas/${r.id}`);
    if (accion === 'pay' ? r.balance.pending > 0 : $(`[data-act="${accion}"]`, view)) handlers[accion]();
  }
}, 'detalle');

/* ---------- Voucher de la reserva (PDF, WhatsApp y email) ---------- */
/** Política de devolución de la empresa, en una frase (va en el voucher y en el contrato). */
function refundPolicyText(s = state.settings) {
  const n = (v, d) => (v === '' || v === undefined || v === null || !Number.isFinite(Number(v)) ? d : Number(v));
  const full = n(s.refund_full_hours, 72);
  const partial = Math.min(full, n(s.refund_partial_hours, 24));
  const pct = n(s.refund_partial_pct, 50);
  if (LANG === 'en') {
    const extra = s.refund_terms_en || s.refund_terms;
    return `If cancelled ${full} h or more before pick-up, 100 % of the amount paid is refunded${partial < full ? `; between ${full} and ${partial} h, ${pct} %` : ''}; with less than ${partial} h or if the customer does not show up, there is no refund.${extra ? ` ${extra}` : ''}`;
  }
  const middle = partial < full ? `; entre ${full} y ${partial} h, el ${pct} %` : '';
  return `Si se cancela con ${full} h o más de anticipación al retiro, se devuelve el 100 % de lo pagado${middle}; con menos de ${partial} h o si el cliente no se presenta, no hay devolución.${s.refund_terms ? ` ${s.refund_terms}` : ''}`;
}

/** Datos del voucher en texto plano, por secciones: los usan el PDF (contract-pdf.js) y el email. */
function voucherLines(r) {
  const s = state.settings;
  const d = (v) => (v ? `${String(v).slice(8, 10)}/${String(v).slice(5, 7)}/${String(v).slice(0, 4)}` : '');
  const dt = (v) => (v ? `${d(v)} ${String(v).slice(11, 16)}` : '');
  const q = r.pricing || {};
  const days = `${r.days} día${r.days === 1 ? '' : 's'}`;
  const vehicle = `Categoría ${r.category_code} · ${r.category_name}${
    r.vehicle_plate ? ` · ${r.vehicle_brand || ''} ${r.vehicle_model || ''} patente ${r.vehicle_plate}`.replace(/\s+/g, ' ') : ' (el auto se asigna al retirar)'
  }`;
  const price = [
    q.base !== undefined ? [`Tarifa ${days}${q.per_day ? ` × ${money(q.per_day)}` : ''}`, money(q.base)] : null,
    q.season_extra ? ['Recargo de temporada', money(q.season_extra)] : null,
    q.promo_discount ? [`Promoción: ${q.promo.name}`, '−' + money(q.promo_discount)] : null,
    q.dynamic_extra ? [`Recargo por alta demanda ${q.dynamic_pct}%`, money(q.dynamic_extra)] : null,
    ...(q.extras || []).map((x) => [`${x.name}${x.quantity > 1 ? ` ×${x.quantity}` : ''}`, money(x.amount)]),
    q.one_way_fee ? ['Devolución en otro lugar', money(q.one_way_fee)] : null,
    q.discount ? [`Descuento${q.discount_pct ? ` ${q.discount_pct} %` : ''}`, `−${money(q.discount)}`] : null,
    q.tax_rate ? [`${taxName()} ${q.tax_rate} %${q.tax_included ? ' (incluido)' : ''}`, money(q.tax)] : null,
    ['Total', money(r.balance.due)],
    ['Pagado', money(r.balance.paid)],
    ['Saldo a pagar', money(r.balance.pending)],
  ].filter(Boolean);
  const sections = [
    { title: 'Reserva', rows: [['Código', r.code], ['Estado', STATUS_LABEL[r.status] || r.status]] },
    {
      title: 'Cliente y conductor',
      rows: [
        ['Nombre', r.customer_name],
        r.customer_doc ? ['Documento', `${r.customer_doc_type || 'DNI'} ${r.customer_doc}`] : null,
        r.customer_phone ? ['Teléfono', r.customer_phone] : null,
        r.customer_email ? ['Email', r.customer_email] : null,
        ['Conductor', r.customer_license ? `El titular · licencia ${r.customer_license}${r.customer_license_expiry ? ` (vence ${d(r.customer_license_expiry)})` : ''}` : 'El titular · traer la licencia al retirar'],
      ].filter(Boolean),
    },
    {
      title: 'Alquiler',
      rows: [
        ['Vehículo', vehicle],
        ['Retiro', `${dt(r.pickup_at)} · ${r.pickup_branch_name || ''}`],
        ['Devolución', `${dt(r.return_at)} · ${r.return_branch_name || ''}`],
        r.hotel && r.hotel.address ? ['Dirección del hotel', r.hotel.address] : null,
        r.hotel && r.hotel.notes ? ['Indicaciones', r.hotel.notes] : null,
        ['Duración', days],
        ['Kilometraje', q.km_included ? `${num(q.km_included)} km incluidos` : 'Libre'],
        resInsurance(r) ? ['Seguro', `${resInsurance(r).name} · ${resInsurance(r).deductible ? `franquicia ${money(resInsurance(r).deductible)}` : 'sin franquicia'}`] : null,
        ['Adicionales', resAddons(r).map((x) => x.name).join(', ') || 'Ninguno'],
        ...(r.flight ? [['Vuelo', r.flight]] : []),
      ].filter(Boolean),
    },
    { title: 'Precio', rows: price },
    ...(Number(r.deposit) > 0 ? [{ title: 'Garantía', rows: [['Depósito', `${money(r.deposit)} (se toma al retirar el auto y se devuelve al entregarlo en las mismas condiciones)`]] }] : []),
  ];
  return {
    sections,
    statusLine: r.status === 'pendiente' ? 'Pendiente de confirmación' : r.status === 'en_curso' ? 'Alquiler en curso' : 'Reserva confirmada',
    requirements: `Licencia de conducir vigente, documento o pasaporte y tarjeta de crédito para la garantía. Edad mínima: ${Number(s.min_driver_age) || 21} años.`,
    policy: refundPolicyText(s),
    company: [s.company_name, s.company_tax_id ? `${taxIdLabel()} ${s.company_tax_id}` : '', s.company_address, s.company_phone && `Tel. ${s.company_phone}`].filter(Boolean).join(' · '),
  };
}

const voucherIntro = (r) => {
  const first = String(r.customer_name || '').split(' ')[0];
  return r.status === 'pendiente'
    ? `Hola ${first}, recibimos tu reserva en ${state.settings.company_name}. Te avisamos apenas esté confirmada.`
    : `Hola ${first}, te confirmamos tu reserva en ${state.settings.company_name}.`;
};

/** Mensaje de WhatsApp: corto, con lo esencial. El detalle completo va en el PDF y el email. */
function voucherWhatsapp(r) {
  const v = voucherLines(r);
  const get = (title, key) => (v.sections.find((x) => x.title === title).rows.find(([k]) => k === key) || [])[1];
  const p = refundPolicyText({ ...state.settings, refund_terms: '' }).replace(/^Si se cancela con /, 'con ');
  return [
    voucherIntro(r),
    '',
    `Reserva ${r.code} (${get('Reserva', 'Estado')})`,
    `Retiro: ${get('Alquiler', 'Retiro')}`,
    `Devolución: ${get('Alquiler', 'Devolución')} (${get('Alquiler', 'Duración')})`,
    ...(r.hotel && r.hotel.address ? [`Dirección del hotel: ${r.hotel.address}`] : []),
    `Auto: categoría ${r.category_code} · ${r.category_name}`,
    ...(resInsurance(r) ? [`Seguro: ${get('Alquiler', 'Seguro')}`] : []),
    `Total ${money(r.balance.due)} · Pagado ${money(r.balance.paid)} · Saldo ${money(r.balance.pending)}`,
    ...(Number(r.deposit) > 0 ? [`Garantía: ${money(r.deposit)} (se devuelve al entregar el auto)`] : []),
    '',
    'Traé licencia de conducir, documento y tarjeta de crédito.',
    `Cancelación: ${p}`,
    state.settings.company_phone ? `Consultas: ${state.settings.company_phone}` : '',
  ]
    .map(trDoc)
    .join('\n')
    .trim();
}

/** Email: el voucher completo en texto. */
function voucherEmail(r) {
  const v = voucherLines(r);
  return [
    voucherIntro(r),
    ...v.sections.flatMap((sec) => ['', sec.title.toUpperCase(), ...sec.rows.map(([k, val]) => `${k}: ${val}`)]),
    '',
    'PARA RETIRAR EL AUTO',
    v.requirements,
    '',
    'CANCELACIÓN Y DEVOLUCIONES',
    v.policy,
    '',
    v.company,
  ]
    .map(trDoc)
    .join('\n')
    .trim();
}

function sendVoucher(r) {
  if (!window.jspdf) return toast('No se pudo cargar el generador de PDF. Recargá la página e intentá de nuevo.', true);
  const { doc, filename } = buildVoucherPdf(r);
  const file = new File([doc.output('blob')], filename, { type: 'application/pdf' });
  const text = voucherWhatsapp(r);
  const emailText = voucherEmail(r);
  // WhatsApp necesita el número con código de país, sin signos: +54 9 2901 123456 → 5492901123456.
  const phone = String(r.customer_phone || '').replace(/\D/g, '');
  const wa = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
  const mail = `mailto:${encodeURIComponent(r.customer_email || '')}?subject=${encodeURIComponent(trDoc(`Voucher de tu reserva ${r.code} · ${state.settings.company_name}`))}&body=${encodeURIComponent(emailText)}`;
  const canShare = navigator.canShare && navigator.canShare({ files: [file] });
  openModal(
    `Enviar voucher · ${r.code}`,
    `<p class="muted">Elegí cómo mandárselo a <b>${esc(r.customer_name)}</b>. Por WhatsApp va un resumen corto; el email y el PDF llevan el voucher completo.</p>
     <div class="stack" style="gap:10px">
       ${canShare ? '<button class="btn primary" type="button" id="v-share">Compartir el PDF (WhatsApp, email…)</button>' : ''}
       <a class="btn ${canShare ? '' : 'primary'}" href="${esc(wa)}" target="_blank" rel="noopener" id="v-wa">WhatsApp${phone ? ` a ${esc(r.customer_phone)}` : ' (elegís el contacto)'}</a>
       <a class="btn" href="${esc(mail)}" id="v-mail">Email${r.customer_email ? ` a ${esc(r.customer_email)}` : ' (falta el email del cliente)'}</a>
       <button class="btn" type="button" id="v-pdf">Descargar el PDF</button>
     </div>
     ${phone && phone.length < 11 ? '<p class="error">El teléfono parece no tener código de país (por ejemplo 54 9 para Argentina): WhatsApp puede no encontrarlo.</p>' : ''}
     <details class="more-opts" style="margin-top:12px"><summary>Ver el mensaje de WhatsApp</summary><pre class="snippet" style="white-space:pre-wrap">${esc(text)}</pre></details>
     <p class="muted" style="margin-top:8px">Por WhatsApp o email desde la computadora va el mensaje; si querés mandar también el PDF, descargalo y adjuntalo.</p>`,
  );
  $('#v-pdf').addEventListener('click', () => downloadBlob(file, filename));
  $('#v-share')?.addEventListener('click', () => navigator.share({ files: [file], title: `Voucher ${r.code}`, text }).catch(() => {}));
}

const LOG_LABEL = {
  firma_pedida: 'Firma pedida al cliente',
  firma_cliente: 'El cliente firmó el contrato',
  firma_anulada: 'Firma anulada: la reserva cambió',
  tarjeta_dejada: 'El cliente dejó su tarjeta',
  creada: 'Reserva creada',
  modificada: 'Reserva modificada',
  confirmada: 'Confirmada',
  cancelada: 'Cancelada',
  no_show: 'No se presentó',
  pendiente: 'Reabierta',
  vehiculo_asignado: 'Vehículo asignado',
  vehiculo_intercambiado: 'Auto intercambiado',
  entregado: 'Auto entregado',
  devuelto: 'Auto devuelto',
  pago: 'Pago registrado',
  devolucion: 'Devolución de dinero',
  garantia: 'Garantía recibida',
  devolucion_garantia: 'Garantía devuelta',
  archivo_subido: 'Archivo subido',
  archivo_borrado: 'Archivo borrado',
  factura_emitida: 'Factura emitida',
  devolucion_calculada: 'Devolución según la política',
  renovado: 'Se renovó solo',
  cargo: 'Multa o cargo',
  cargo_borrado: 'Cargo borrado',
  lectura_km: 'Lectura de km',
};
const DETAIL_KEY = { porcentaje: 'porcentaje', devolver: 'a devolver', pagado: 'pagado', regla: 'cancelación', factura: 'factura', modo: 'modo', status: 'estado', source: 'origen', contrato: 'contrato', km: 'km', combustible: 'combustible', cargos: 'cargos' };

function logDetail(d) {
  if (!d) return '';
  try {
    const o = JSON.parse(d);
    return typeof o === 'object' && o
      ? Object.entries(o)
          .map(([k, v]) => `${DETAIL_KEY[k] || k}: ${k === 'combustible' ? `${v}/8` : ['cargos', 'devolver', 'pagado'].includes(k) ? money(v) : k === 'porcentaje' ? `${v} %` : STATUS_LABEL[v] || v}`)
          .join(' · ')
      : String(o);
  } catch {
    return d;
  }
}

/** Facturas de la reserva. Las de prueba se marcan bien a la vista: no tienen validez fiscal. */
function invoicesCardHtml(r) {
  if (!(r.invoices || []).length) return '';
  return `<div class="card"><h2>Factura</h2>${r.invoices
    .map(
      (i) => `<dl class="info">
        <dt>Comprobante</dt><dd><b>${esc(i.type_name)} ${i.provider === 'arca' ? `${String(i.point_of_sale).padStart(5, '0')}-${String(i.number).padStart(8, '0')}` : `N° ${i.number}`}</b>
          <span class="badge b-pendiente">PRUEBA · ${i.mode === 'simulado' ? 'simulada' : 'homologación'} · sin validez fiscal</span></dd>
        <dt>${i.provider === 'arca' ? 'CAE' : 'Track ID'}</dt><dd>${esc(i.auth_code || '—')}${i.auth_due ? ` <small class="muted">vence ${fmtD(i.auth_due)}</small>` : ''}</dd>
        <dt>Cliente</dt><dd>${esc(i.customer_name)} ${i.customer_doc ? `<small class="muted">${esc(i.customer_doc)}</small>` : ''}</dd>
        <dt>Importe</dt><dd>Neto ${money(i.net)} · ${esc(taxName())} ${money(i.tax)} · <b>Total ${money(i.total)}</b></dd>
        <dt>Fecha</dt><dd>${fmtD(stampLocal(i.created_at))}</dd>
      </dl>`,
    )
    .join('')}</div>`;
}

/* ---------- Fotos y documentación del alquiler ---------- */
const STAGE_LABEL = { entrega: 'Entrega', devolucion: 'Devolución', contrato: 'Contratos', otro: 'Otros documentos' };

/**
 * Achica las fotos antes de subirlas: 1600 px en el lado largo, JPEG 0,75 (~250 KB, se sigue viendo un rayón).
 * Las del celular pesan varios MB y el servidor no acepta fotos de más de 1 MB. Los PDF van tal cual.
 */
async function shrinkImage(file, max = 1600, quality = 0.75) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type) || !window.createImageBitmap) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 400 * 1024) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
    return blob || file;
  } catch {
    return file;
  }
}

async function uploadFiles(reservationId, stage, fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return 0;
  let done = 0;
  for (const f of files) {
    toast(`Subiendo ${done + 1} de ${files.length}…`);
    const blob = await shrinkImage(f);
    const type = blob.type || f.type || 'application/octet-stream';
    const name = blob === f ? f.name : f.name.replace(/\.[^.]+$/, '') + '.jpg';
    const res = await fetch(`/api/reservations/${reservationId}/files?stage=${stage}&name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': type },
      credentials: 'same-origin',
      body: blob,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(`${f.name}: ${data.error || (res.status === 413 ? 'el archivo es demasiado grande' : `error ${res.status}`)}`);
    }
    done++;
  }
  toast(`${done} archivo${done > 1 ? 's' : ''} guardado${done > 1 ? 's' : ''}`);
  return done;
}

/** Las fotos piden sesión: se descargan con la cookie y se muestran como blob. */
const fileUrls = new Map();
async function fileUrl(id) {
  if (fileUrls.has(id)) return fileUrls.get(id);
  const res = await fetch(`/api/files/${id}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('No se pudo abrir el archivo');
  const url = URL.createObjectURL(await res.blob());
  fileUrls.set(id, url);
  return url;
}

function filesCardHtml(r) {
  r.files = r.files || [];
  const groups = ['entrega', 'devolucion', 'contrato', 'otro']
    .map((stage) => {
      const list = r.files.filter((f) => f.stage === stage);
      if (!list.length && (stage === 'otro' || stage === 'contrato')) return '';
      return `<h3 style="margin-top:12px">${STAGE_LABEL[stage]} <small class="muted">(${list.length})</small></h3>
        <div class="thumbs">${
          list.length
            ? list
                .map(
                  (f) =>
                    `<button type="button" class="thumb" data-file="${f.id}" title="${esc(f.name)} · ${esc(f.created_at.slice(0, 16))}">${
                      f.mime.startsWith('image/') ? `<img alt="${esc(f.name)}" data-thumb="${f.id}"/>` : '<span>PDF</span>'
                    }</button>`,
                )
                .join('')
            : '<span class="muted">Sin fotos todavía.</span>'
        }</div>`;
    })
    .join('');
  return `<div class="card"><h2>Fotos y documentación</h2>${groups}
    <div class="actions no-print" style="margin-top:12px"><button class="btn" data-act="photos">+ Agregar fotos o documentos</button></div></div>`;
}

function wireFiles(view, r, reload) {
  $$('[data-thumb]', view).forEach((img) =>
    fileUrl(Number(img.dataset.thumb))
      .then((u) => (img.src = u))
      .catch(() => (img.alt = 'No disponible')),
  );
  $$('[data-file]', view).forEach((b) =>
    b.addEventListener('click', async () => {
      const f = r.files.find((x) => x.id === Number(b.dataset.file));
      const url = await run(() => fileUrl(f.id));
      openModal(
        `${STAGE_LABEL[f.stage]} · ${f.name}`,
        `${f.mime.startsWith('image/') ? `<img src="${url}" alt="${esc(f.name)}" style="width:100%;border-radius:8px"/>` : '<p>Documento PDF.</p>'}
         <p class="muted">Subido el ${fmtDT(stampLocal(f.created_at))}${f.user_name ? ` por ${esc(f.user_name)}` : ''}.</p>
         <div class="actions"><a class="btn" href="${url}" target="_blank" rel="noopener">Abrir en otra pestaña</a>
         <button class="btn danger" type="button" id="file-del">Borrar</button></div>`,
      );
      $('#file-del').addEventListener('click', async () => {
        if (!(await confirmModal({ title: 'Borrar archivo', text: 'La foto o el documento se borra de la reserva.', ok: 'Borrar', danger: true }))) return;
        await run(() => DEL(`/files/${f.id}`), 'Archivo borrado');
        closeModal();
        reload();
      });
    }),
  );
}

/* ---------- Carnet y DNI del cliente ---------- */
const DOC_KINDS = [
  ['carnet_frente', 'Carnet · frente'],
  ['carnet_dorso', 'Carnet · dorso'],
  ['dni_frente', 'DNI · frente'],
  ['dni_dorso', 'DNI · dorso'],
];
/** Los documentos de la persona: se cargan una vez y se ven desde todas sus reservas. Subir otro reemplaza al anterior. */
async function openDocuments(customerId, name) {
  const docs = await GET(`/customers/${customerId}/documents`);
  const slot = ([kind, label]) => {
    const d = docs.find((x) => x.kind === kind);
    return `<div class="doc-slot" data-kind="${kind}">
      <b>${label}</b>
      ${d ? `<button type="button" class="thumb" data-open="${d.id}" title="Ver">${d.mime.startsWith('image/') ? `<img alt="${label}" data-doc-img="${d.id}"/>` : '<span>PDF</span>'}</button>` : '<div class="thumb empty"><span>Falta</span></div>'}
      <div class="actions"><label class="btn small">${d ? 'Cambiar' : 'Subir foto'}<input type="file" accept="image/*,application/pdf" hidden data-up></label>
      ${d ? `<button type="button" class="btn small danger" data-del="${d.id}">Borrar</button>` : ''}</div>
    </div>`;
  };
  openModal(`Carnet y DNI · ${name}`, `<p class="muted">Se cargan una vez y quedan en la ficha del cliente para todos sus alquileres.</p><div class="doc-slots">${DOC_KINDS.map(slot).join('')}</div>`);
  const box = $('#modal-body');
  const blobOf = (id) => fetch(`/api/documents/${id}`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.blob() : Promise.reject(new Error('No se pudo abrir el archivo'))));
  $$('[data-doc-img]', box).forEach((img) =>
    blobOf(img.dataset.docImg)
      .then((b) => (img.src = URL.createObjectURL(b)))
      .catch(() => (img.alt = 'No disponible')),
  );
  $$('[data-open]', box).forEach((b) => b.addEventListener('click', () => run(() => blobOf(b.dataset.open)).then((blob) => window.open(URL.createObjectURL(blob), '_blank', 'noopener'))));
  $$('[data-up]', box).forEach((input) =>
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (!f) return;
      const kind = input.closest('[data-kind]').dataset.kind;
      toast('Subiendo…');
      const blob = await shrinkImage(f);
      const res = await fetch(`/api/customers/${customerId}/documents?kind=${kind}&name=${encodeURIComponent(f.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': blob.type || f.type || 'application/octet-stream' },
        credentials: 'same-origin',
        body: blob,
      });
      if (!res.ok) return toast((await res.json().catch(() => ({}))).error || 'No se pudo subir', true);
      toast('Guardado');
      openDocuments(customerId, name);
    }),
  );
  $$('[data-del]', box).forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmModal({ title: 'Borrar documento', text: 'La foto se borra de la ficha del cliente.', ok: 'Borrar', danger: true }))) return;
      await run(() => DEL(`/documents/${b.dataset.del}`), 'Borrado');
      openDocuments(customerId, name);
    }),
  );
}

const FUEL_OPTS = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, n === 8 ? '8/8 (lleno)' : n === 0 ? '0/8 (vacío)' : `${n}/8`]);
const PAYMENT_KINDS = { pago: 'Pago', devolucion: 'Devolución de dinero', garantia: 'Garantía (depósito)', devolucion_garantia: 'Devolución de garantía' };

/**
 * Condiciones del contrato con las {palabras} completadas, como lista de cláusulas { title, body } en texto plano.
 * La usan el contrato impreso y el PDF.
 */
/** Choferes: los períodos del alquiler (se renuevan solos), el recargo por atraso y las multas y cargos. */
function rentalCardHtml(r) {
  const open = r.status === 'en_curso';
  if (!r.periods.length && !r.charges.length && !(choferesMode() && open)) return '';
  const kindLabel = { multa: 'Multa', otro: 'Cargo', km: '' };
  return `<div class="card"><h2>Alquiler por ${periodWord(1)}</h2>
    ${
      r.periods.length
        ? `<div class="table-scroll"><table class="mini"><thead><tr><th>#</th><th>Desde</th><th>Hasta</th><th class="right">Importe</th></tr></thead><tbody>${r.periods
            .map((p) => `<tr><td>${p.n}</td><td class="nowrap">${fmtDT(p.start_at)}</td><td class="nowrap">${fmtDT(p.end_at)}</td><td class="right">${p.amount > 0 ? money(p.amount) : 'Libre'}</td></tr>`)
            .join('')}</tbody></table></div>
    ${open ? `<p class="muted">Alquiler por tiempo indeterminado: se suma un ${periodWord(1)} más solo, cobrado por adelantado, hasta que registres la devolución.</p>` : ''}`
        : ''
    }
    ${r.late_fee.total ? `<p><b class="error">Recargo por atraso en el pago: ${plural(r.late_fee.days, 'día', 'días')} · ${money(r.late_fee.total)}</b></p>` : ''}
    <h3 style="margin-top:12px">Multas y cargos</h3>
    ${
      r.charges.length
        ? `<table class="breakdown"><tbody>${r.charges
            .map(
              (x) =>
                `<tr><td>${fmtD(x.date)} · ${esc([kindLabel[x.kind] ?? x.kind, x.description].filter(Boolean).join(' '))}${x.reference ? ` <small class="muted">${esc(x.reference)}</small>` : ''}</td>
                <td class="right nowrap">${money(x.amount)}${isAdmin() ? ` <button class="btn small danger no-print" type="button" data-del-charge="${x.id}" aria-label="Borrar cargo">×</button>` : ''}</td></tr>`,
            )
            .join('')}</tbody></table>`
        : '<p class="muted">Sin multas ni cargos.</p>'
    }
    <div class="actions no-print" style="margin-top:12px">
      <button class="btn small" type="button" data-act="fine">Cargar multa</button>
      ${open ? '<button class="btn small" type="button" data-act="km">Registrar km</button>' : ''}
      ${open && isAdmin() && r.periods.length ? '<button class="btn small" type="button" data-act="start">Corregir inicio</button>' : ''}
    </div></div>`;
}

/** Pantalla Hoy, modo choferes: quién debe, licencias vencidas y autos a los que les toca service. */
function choferesCards(c) {
  const card = (title, rows) => (rows.length ? `<div class="card"><h2>${title} <span class="count">${rows.length}</span></h2><div class="daylist">${rows.join('')}</div></div>` : '');
  const over = c.owing.filter((r) => r.days_owed > 3);
  return [
    over.length
      ? `<div class="notice error"><b>${over.length === 1 ? '1 chofer debe' : `${over.length} choferes deben`} más de 3 ${periodWord(2)}:</b> ${over
          .map((r) => `<a href="#/reservas/${r.id}">${esc(r.customer_name)}</a> (${num(r.days_owed)})`)
          .join(', ')}</div>`
      : '',
    card(
      'Choferes que deben',
      c.owing.map(
        (r) =>
          `<div class="dayrow"><span class="plate">${esc(r.vehicle_plate || '')}</span><div><a href="#/reservas/${r.id}"><b>${esc(r.customer_name)}</b></a>${
            r.late_fee ? `<small>incluye ${money(r.late_fee)} de recargo por atraso</small>` : ''
          }</div><div><small>Debe${r.days_owed >= 1 ? ` ${num(r.days_owed)} ${periodWord(r.days_owed)}` : ''}</small><b class="error">${money(r.pending)}</b></div>${waLink(r.customer_phone)}</div>`,
      ),
    ),
    card(
      'Licencia vencida',
      c.license_expired.map((r) => `<div class="dayrow"><div><a href="#/reservas/${r.id}"><b>${esc(r.customer_name)}</b></a></div><div><small>Venció</small><b class="error">${fmtD(r.license_expiry)}</b></div></div>`),
    ),
    card(
      'Les toca service',
      c.service_due.map(
        (v) => `<div class="dayrow"><span class="plate">${esc(v.plate)}</span><div><small>Tiene</small><b>${num(v.km)} km</b></div><div><small>Service a los</small><b>${num(v.next_service_km)} km</b></div></div>`,
      ),
    ),
  ].join('');
}

function contractTermsList(r) {
  const s = state.settings;
  const km = Number(r.category_km_per_day) || 0;
  const values = {
    empresa: s.company_name || L('la Empresa', 'the Company'),
    tolerancia: Number(s.grace_hours) || 0,
    edad_minima: Number(s.min_driver_age) || 21,
    cargo_combustible:
      Number(s.fuel_charge_per_eighth) > 0
        ? money(s.fuel_charge_per_eighth)
        : L('el valor del combustible faltante más un cargo por servicio', 'the cost of the missing fuel plus a service charge'),
    kilometraje:
      km > 0
        ? L(
            `El alquiler incluye ${km} km por día (${km * (r.days || 1)} km en total). Cada km excedente se cobrará ${money(r.category_extra_km_rate)}.`,
            `The rental includes ${km} km per day (${km * (r.days || 1)} km in total). Each extra km will be charged ${money(r.category_extra_km_rate)}.`,
          )
        : L('El alquiler tiene kilometraje libre.', 'The rental has unlimited mileage.'),
    franquicia: Number(s.deductible_amount) > 0 ? money(s.deductible_amount) : L('el monto de la franquicia de la póliza vigente', 'the deductible of the policy in force'),
    garantia: money(r.deposit),
    jurisdiccion: L(s.jurisdiction, s.jurisdiction_en || s.jurisdiction) || L('la ciudad donde se celebra este contrato', 'the city where this agreement is signed'),
  };
  const choferes = choferesMode();
  if (choferes) {
    const kmP = Number(r.category_km_per_period) || 0;
    const last = (r.periods || []).slice(-1)[0];
    Object.assign(values, {
      periodo: periodWord(1),
      precio_periodo: money(last ? last.amount : (r.pricing && r.pricing.per_day) || r.total),
      recargo_atraso: Number(s.late_fee_per_day) > 0 ? money(s.late_fee_per_day) : 'el que informe el Locador',
      dias_gracia: Number(s.late_grace_days) || 0,
      uso: r.customer_work_apps ? `trabajar con ${r.customer_work_apps}` : 'viajes por aplicaciones (Uber, Cabify, DiDi), remis o reparto',
      garante: r.guarantor_name
        ? ` Además, ${r.guarantor_name}${r.guarantor_doc ? `, documento ${r.guarantor_doc}` : ''}${r.guarantor_address ? `, con domicilio en ${r.guarantor_address}` : ''}, firma como garante: se constituye en fiador solidario, liso, llano y principal pagador de todas las obligaciones del Locatario en este contrato y sus renovaciones.`
        : '',
      kilometraje:
        kmP > 0
          ? `El kilometraje incluido es de ${num(kmP)} km por ${periodWord(1)}; cada kilómetro adicional se cobra ${money(r.category_extra_km_rate)}.`
          : 'El kilometraje es libre.',
    });
  }
  const terms = String(choferes ? s.contract_terms_choferes || '' : L(s.contract_terms, s.contract_terms_en || s.contract_terms) || '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const filled = p.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m)).replace(/\s+/g, ' ');
      const title = filled.match(/^(\d+\.\s*[^.]{2,60}\.)\s*/);
      return title ? { title: title[1], body: filled.slice(title[0].length) } : { title: '', body: filled };
    });
  // La política de devolución de Ajustes va siempre como última cláusula, numerada a continuación (salvo para choferes: el contrato ya trae la rescisión).
  if (choferes) return terms;
  return [...terms, { title: `${terms.length + 1}. ${L('CANCELACIÓN Y DEVOLUCIONES', 'CANCELLATION AND REFUNDS')}.`, body: refundPolicyText(s) }];
}

/** Condiciones en HTML para el contrato impreso. */
const contractTerms = (r) =>
  contractTermsList(r)
    .map((t) => `<p>${t.title ? `<b>${esc(t.title)}</b> ` : ''}${esc(t.body)}</p>`)
    .join('');

/** Medidor de combustible en octavos: los llenos marcados, o vacío para completar a mano. */
const fuelGauge = (n) =>
  `<span class="gauge">${Array.from({ length: 8 }, (_, i) => `<i class="${n !== null && n !== undefined && i < n ? 'on' : ''}"></i>`).join('')}</span>${
    n !== null && n !== undefined ? ` ${n}/8` : ' ___/8'
  }`;

/** Dibujo del auto visto desde arriba, para marcar los daños con una X. */
const CAR_SVG = `<svg viewBox="0 0 220 110" width="220" height="110" aria-label="Diagrama del vehículo">
  <rect x="20" y="15" width="180" height="80" rx="28" fill="none" stroke="#333" stroke-width="2"/>
  <path d="M70 22 L60 88 M150 22 L160 88" stroke="#999"/>
  <rect x="78" y="26" width="64" height="58" rx="6" fill="none" stroke="#999"/>
  <rect x="34" y="6" width="26" height="10" rx="3" fill="#333"/><rect x="160" y="6" width="26" height="10" rx="3" fill="#333"/>
  <rect x="34" y="94" width="26" height="10" rx="3" fill="#333"/><rect x="160" y="94" width="26" height="10" rx="3" fill="#333"/>
  <text x="8" y="58" font-size="9" fill="#555" transform="rotate(-90 8 58)">TRASERA</text>
  <text x="214" y="42" font-size="9" fill="#555" transform="rotate(90 214 42)">FRENTE</text>
</svg>`;

function printContract(r) {
  const s = state.settings;
  const c = r.contract;
  const delivered = Boolean(c);
  const w = window.open('', '_blank');
  if (!w) return toast('El navegador bloqueó la ventana del contrato: permití las ventanas emergentes para esta página.', true);
  const q = r.pricing || {};
  const line = (label, value) => `<tr><th>${label}</th><td>${value || '<span class="blank"></span>'}</td></tr>`;
  const priceRows = [
    q.base !== undefined ? [`Alquiler ${baseLabel(q, r.days)}`, money(q.base)] : null,
    q.season_extra ? ['Recargo de temporada', money(q.season_extra)] : null,
    q.promo_discount ? [`Promoción: ${q.promo.name}`, '−' + money(q.promo_discount)] : null,
    ...(q.extras || []).map((x) => [esc(x.name) + (x.quantity > 1 ? ` ×${esc(x.quantity)}` : ''), money(x.amount)]),
    q.one_way_fee ? ['Devolución en otro lugar', money(q.one_way_fee)] : null,
    q.discount ? [`Descuento${q.discount_pct ? ` ${esc(q.discount_pct)}%` : ''}`, '−' + money(q.discount)] : null,
    q.tax_rate ? [`${esc(taxName())} ${esc(q.tax_rate)}%${q.tax_included ? ' (incluido)' : ''}`, money(q.tax)] : null,
  ].filter(Boolean);
  const charges = c && c.charges && c.charges.lines.length ? c.charges.lines : [];
  const outKm = delivered ? c.out_km : r.vehicle_km;
  const outFuel = delivered ? c.out_fuel : r.vehicle_fuel;
  const title = delivered ? 'CONTRATO DE ALQUILER DE VEHÍCULO' : 'CONTRATO DE ALQUILER DE VEHÍCULO (PRE-CONTRATO)';

  w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${delivered ? 'Contrato ' + esc(c.number) : 'Pre-contrato ' + esc(r.code)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111; margin: 0 auto; max-width: 190mm; padding: 8px; }
  h1 { font-size: 17px; margin: 0; } h2 { font-size: 12px; margin: 10px 0 4px; text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid #111; padding-bottom: 2px; }
  .head { display: flex; justify-content: space-between; gap: 12px; border-bottom: 2px solid #111; padding-bottom: 6px; }
  .head .right { text-align: right; } .muted { color: #555; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
  table { width: 100%; border-collapse: collapse; } th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; width: 36%; font-weight: 600; }
  .price td:last-child { text-align: right; white-space: nowrap; } .price tr.total td { font-weight: 700; font-size: 12px; }
  .blank { display: inline-block; min-width: 120px; border-bottom: 1px solid #555; height: 12px; }
  .gauge { display: inline-flex; gap: 2px; vertical-align: middle; } .gauge i { width: 9px; height: 11px; border: 1px solid #333; display: inline-block; } .gauge i.on { background: #333; }
  .state { display: grid; grid-template-columns: 230px 1fr; gap: 10px; align-items: start; }
  .notes { border: 1px solid #999; min-height: 64px; padding: 4px 6px; white-space: pre-wrap; }
  .sign { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 36px; }
  .sign div { border-top: 1px solid #111; padding-top: 3px; text-align: center; } .sign small { display: block; color: #555; margin-top: 10px; text-align: left; }
  .terms { columns: 2; column-gap: 16px; font-size: 9.5px; line-height: 1.35; text-align: justify; } .terms p { margin: 0 0 5px; break-inside: avoid; }
  .page2 { break-before: page; }
  .badge { display: inline-block; border: 1px solid #111; padding: 1px 6px; font-weight: 700; }
</style></head><body>
<div class="head">
  <div><h1>${esc(s.company_name || '')}</h1>
    <div>${esc(s.company_address || '')}</div>
    <div>${esc(s.company_phone || '')}${s.company_tax_id ? ` · ${esc(taxIdLabel())} ${esc(s.company_tax_id)}` : ''}</div></div>
  <div class="right"><b>${title}</b><br>
    ${delivered ? `N° <b>${esc(c.number)}</b>` : '<span class="badge">Sin entregar todavía</span>'}<br>
    Reserva ${esc(r.code)} · Emitido ${esc(new Date().toLocaleDateString(locale()))}</div>
</div>

<div class="grid">
  <div><h2>Cliente / conductor principal</h2><table>
    ${line('Nombre y apellido', esc(r.customer_name))}
    ${line('Documento', r.customer_doc ? `${esc(r.customer_doc_type || 'DNI')} ${esc(r.customer_doc)}` : '')}
    ${line('Domicilio', esc(r.customer_address || ''))}
    ${line('Teléfono', esc(r.customer_phone || ''))}
    ${line('Email', esc(r.customer_email || ''))}
    ${line('Fecha de nacimiento', fmtD(r.customer_birth_date))}
    ${line('Licencia N°', esc(r.customer_license || ''))}
    ${line('Vencimiento licencia', fmtD(r.customer_license_expiry))}
  </table>
  ${choferesMode()
    ? `<h2>Licencia profesional y garante</h2><table>
    ${line('Clase de licencia', esc(r.customer_license_class || ''))}${line('Trabaja con', esc(r.customer_work_apps || ''))}
    ${line('Garante', esc(r.guarantor_name || ''))}${line('Documento / teléfono', esc([r.guarantor_doc, r.guarantor_phone].filter(Boolean).join(' · ')))}
  </table>`
    : `<h2>Conductor adicional</h2><table>
    ${line('Nombre y apellido', '')}${line('Documento', '')}${line('Licencia N° / vence', '')}
  </table>`}</div>
  <div><h2>Vehículo</h2><table>
    ${line('Marca y modelo', r.vehicle_plate ? `${esc(r.vehicle_brand || '')} ${esc(r.vehicle_model || '')}` : '')}
    ${line('Patente', r.vehicle_plate ? `<b>${esc(r.vehicle_plate)}</b>` : '')}
    ${line('Color / año', r.vehicle_plate ? `${esc(r.vehicle_color || '')} ${r.vehicle_year ? '· ' + esc(r.vehicle_year) : ''}` : '')}
    ${line('Categoría', `${esc(r.category_code)} · ${esc(r.category_name)}`)}
  </table>
  <h2>Período del alquiler</h2><table>
    ${line('Retiro', `${fmtDT(r.pickup_at)} · ${esc(r.pickup_branch_name || '')}`)}
    ${line('Devolución pactada', `${fmtDT(r.return_at)} · ${esc(r.return_branch_name || '')}`)}
    ${line('Días', esc(r.days))}
    ${r.flight ? line('Vuelo / referencia', esc(r.flight)) : ''}
  </table></div>
</div>

<div class="grid">
  <div><h2>Entrega del vehículo</h2><table>
    ${line('Fecha y hora', delivered ? fmtDT(c.out_at) : '')}
    ${line('Kilómetros', outKm !== null && outKm !== undefined && outKm !== '' ? `${num(outKm)} km${delivered ? '' : ' <span class="muted">(según flota, verificar)</span>'}` : '')}
    ${line('Combustible', fuelGauge(outFuel))}
  </table></div>
  <div><h2>Devolución del vehículo</h2><table>
    ${line('Fecha y hora', c && c.in_at ? fmtDT(c.in_at) : '')}
    ${line('Kilómetros', c && c.in_at ? `${num(c.in_km)} km` : '')}
    ${line('Combustible', fuelGauge(c && c.in_at ? c.in_fuel : null))}
  </table></div>
</div>

<h2>Estado del vehículo (marcar con X los daños)</h2>
<div class="state">${CAR_SVG}
  <div><div class="muted">Observaciones a la entrega:</div><div class="notes">${esc(c && c.out_notes ? c.out_notes : '')}</div>
  <div class="muted" style="margin-top:4px">Observaciones a la devolución:</div><div class="notes">${esc(c && c.in_notes ? c.in_notes : '')}</div></div>
</div>

<div class="grid">
  <div><h2>Precio</h2><table class="price">
    ${priceRows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}
    <tr class="total"><td>Total del alquiler</td><td>${money(r.total)}</td></tr>
    ${charges.map((l) => `<tr><td>${esc(l.concept)}</td><td>${money(l.amount)}</td></tr>`).join('')}
    ${c && c.final_total !== null && c.final_total !== undefined && c.final_total !== r.total ? `<tr class="total"><td>Total final con cargos</td><td>${money(c.final_total)}</td></tr>` : ''}
  </table></div>
  <div><h2>Pagos y garantía</h2><table class="price">
    <tr><td>Pagado</td><td>${money(r.balance.paid)}</td></tr>
    <tr><td>Saldo pendiente</td><td>${money(r.balance.pending)}</td></tr>
    <tr><td>Garantía requerida</td><td>${money(r.deposit)}</td></tr>
    <tr><td>Garantía recibida</td><td>${money(r.balance.deposit_held)}</td></tr>
    <tr><td>Adicionales</td><td>${r.extras.map((x) => esc(x.name)).join(', ') || '—'}</td></tr>
  </table></div>
</div>

<p style="margin-top:10px">El Cliente declara haber leído y aceptado las condiciones generales que forman parte de este contrato (página siguiente) y recibir el vehículo en el estado indicado.</p>
<div class="sign">
  <div>Firma del cliente<small>Aclaración:<br>DNI:</small></div>
  <div>${choferesMode() ? 'Garante' : 'Conductor adicional'}<small>Aclaración:<br>DNI:</small></div>
  <div>Por ${esc(s.company_name || 'la Empresa')}<small>Aclaración:</small></div>
</div>

<div class="page2">
  <div class="head"><div><b>${esc(s.company_name || '')}</b></div><div class="right">Condiciones generales · ${delivered ? 'Contrato N° ' + esc(c.number) : 'Reserva ' + esc(r.code)}</div></div>
  <h2>Condiciones generales del alquiler</h2>
  <div class="terms">${contractTerms(r)}</div>
  <div class="sign" style="grid-template-columns:1fr 1fr">
    <div>Firma del cliente (conformidad)<small>Aclaración:<br>DNI:</small></div>
    <div>Por ${esc(s.company_name || 'la Empresa')}</div>
  </div>
</div>
</body></html>`);
  w.document.close();
  // La demo muestra el contrato en la misma página (sin body propio) y lo traduce ella.
  if (w.document.body) {
    w.document.documentElement.lang = LANG;
    w.document.title = tr(w.document.title);
    translateTree(w.document.body, true);
  }
  w.focus();
  setTimeout(() => w.print(), 300);
}

/* ============================================================
   Planning (grilla de ocupación, estilo Rently)
   ============================================================ */
let planningFrom = null;
// ?r=ID: la reserva recién creada desde el calendario se ve resaltada al volver.
on(/^\/planning(?:\?r=(\d+))?$/, async (view, highlight) => {
  if (!planningFrom) {
    const t = new Date();
    planningFrom = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1);
  }
  const days = 14;
  const fromStr = localISO(planningFrom).slice(0, 10);
  const p = await GET(`/planning?from=${fromStr}&days=${days}${branchQS('&')}`);
  const start = planningFrom.getTime();
  const span = days * 86400000;
  const pos = (s) => {
    const [d, t] = s.split('T');
    const [y, m, dd] = d.split('-').map(Number);
    const [hh, mi] = t.split(':').map(Number);
    return ((new Date(y, m - 1, dd, hh, mi).getTime() - start) / span) * 100;
  };
  const bar = (r) => {
    const l = Math.max(0, pos(r.pickup_at));
    const rr = Math.min(100, pos(r.return_at));
    if (rr <= 0 || l >= 100) return '';
    return `<div class="pl-bar ${r.status}${String(r.id) === highlight ? ' just-made' : ''}${['pendiente', 'confirmada'].includes(r.status) ? ' pl-move' : ''}" data-id="${r.id}" style="left:${l}%;width:${Math.max(rr - l, 0.8)}%" data-href="#/reservas/${r.id}"
      title="${esc(r.code)} · ${esc(r.customer_name)} · ${fmtDT(r.pickup_at)} → ${fmtDT(r.return_at)}">${esc(r.customer_name)}</div>`;
  };
  const mbar = (m) => {
    const l = Math.max(0, pos(`${m.start_date || fromStr}T00:00`));
    const endD = m.end_date || localISO(addDays(planningFrom, days)).slice(0, 10);
    const rr = Math.min(100, pos(`${endD}T23:59`));
    if (rr <= 0 || l >= 100) return '';
    return `<div class="pl-bar mant" style="left:${l}%;width:${rr - l}%" title="En el taller: ${esc(maintKind(m.kind || ''))}">En el taller</div>`;
  };
  const todayStr = localISO(new Date()).slice(0, 10);
  const dayCells = Array.from({ length: days }, (_, i) => {
    const d = addDays(planningFrom, i);
    const ds = localISO(d).slice(0, 10);
    const wk = d.getDay() === 0 || d.getDay() === 6;
    return `<div class="${ds === todayStr ? 'today' : wk ? 'weekend' : ''}">${L(['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá'], ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'])[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}</div>`;
  }).join('');
  const track = `background-size:${100 / days}% 100%`;

  let rows = '';
  for (const cat of state.categories) {
    const vehicles = p.vehicles.filter((v) => v.category_id === cat.id);
    const unassigned = p.reservations.filter((r) => r.category_id === cat.id && !r.vehicle_id);
    if (!vehicles.length && !unassigned.length) continue;
    rows += `<div class="pl-row group"><div class="pl-label">${esc(cat.code)} · ${esc(cat.name)}</div><div></div></div>`;
    for (const v of vehicles) {
      rows += `<div class="pl-row"><div class="pl-label"><b>${esc(v.plate)}</b> <small>${esc(v.brand)} ${esc(v.model)}</small></div>
        <div class="pl-track${['mantenimiento', 'fuera_servicio'].includes(v.status) ? '' : ' pl-drag'}" data-vehicle="${v.id}" style="${track}">${p.maintenance.filter((m) => m.vehicle_id === v.id).map(mbar).join('')}${p.reservations
          .filter((r) => r.vehicle_id === v.id)
          .map(bar)
          .join('')}</div></div>`;
    }
    // Reservas sin vehículo: una fila por reserva para que no se pisen.
    for (const r of unassigned) {
      rows += `<div class="pl-row"><div class="pl-label"><small class="error">Sin asignar</small> <small>${esc(r.code)}</small></div>
        <div class="pl-track" style="${track}">${bar(r)}</div></div>`;
    }
  }

  view.innerHTML = `
    <div class="page-head"><h1>Calendario de autos</h1>
      <div class="actions"><button class="btn" data-nav="-7">◀ Semana</button><button class="btn" data-nav="0">Hoy</button><button class="btn" data-nav="7">Semana ▶</button></div></div>
    <div class="legend" style="margin-bottom:10px">
      <span style="--c:#e0a100">Pendiente</span><span style="--c:#1f6feb">Confirmada</span><span style="--c:#1a9b5b">En curso</span>
      <span style="--c:#8b94a6">Finalizada</span><span style="--c:#d1373a">En el taller</span><span>· Tocá una barra para abrir la reserva · <b>Para reservar, tocá en la fila de un auto el día de retiro y después el de devolución (con el mouse también podés arrastrar).</b> <b>Con el mouse, arrastrá una barra para mover la reserva, o soltala sobre otra para intercambiar los autos.</b></span></div>
    <div class="planning">
      <div class="pl-row head"><div class="pl-label"><small>Vehículo</small></div><div class="pl-days" style="grid-template-columns:repeat(${days},1fr)">${dayCells}</div></div>
      ${rows || '<p class="muted" style="padding:16px">No hay vehículos cargados.</p>'}
    </div>`;
  $$('[data-nav]', view).forEach((b) =>
    b.addEventListener('click', () => {
      const n = Number(b.dataset.nav);
      if (n === 0) planningFrom = null;
      else planningFrom = addDays(planningFrom, n);
      route();
    }),
  );
  enableDragToBook($('.planning', view), p, days);
  enableDragToMove($('.planning', view), p, days);
  $('.just-made', view)?.scrollIntoView({ block: 'center', inline: 'center' });
}, 'planning');

/**
 * Crear una reserva arrastrando (dedo o mouse) sobre la fila de un auto en el Planning.
 * Se marcan días completos: del primer día marcado a las 10:00 al día siguiente del último, a las 10:00.
 * Si el tramo pisa otra reserva o el taller, se marca en rojo y no se crea.
 */
function enableDragToBook(container, p, days) {
  const dayStr = (i) => localISO(addDays(planningFrom, i)).slice(0, 10);
  const todayIdx = Math.round((new Date(localISO(new Date()).slice(0, 10) + 'T00:00') - planningFrom) / 86400000);
  let drag = null;

  const dayAt = (track, clientX) => {
    const r = track.getBoundingClientRect();
    return Math.min(days - 1, Math.max(0, Math.floor(((clientX - r.left) / r.width) * days)));
  };

  // ¿El tramo [desde, hasta) se superpone con una reserva activa o un taller de ese auto?
  const clash = (vehicleId, from, to) =>
    p.reservations.some((r) => r.vehicle_id === vehicleId && ['pendiente', 'confirmada', 'en_curso'].includes(r.status) && r.pickup_at < to && r.return_at > from) ||
    p.maintenance.some((m) => m.vehicle_id === vehicleId && (m.start_date || '') <= to.slice(0, 10) && (m.end_date || '9999-12-31') >= from.slice(0, 10));

  const paint = () => {
    const a = Math.min(drag.startDay, drag.endDay);
    const b = Math.max(drag.startDay, drag.endDay);
    drag.from = `${dayStr(a)}T10:00`;
    drag.to = `${dayStr(b + 1)}T10:00`;
    drag.past = a < todayIdx;
    drag.bad = drag.past || clash(drag.vehicleId, drag.from, drag.to);
    const n = b - a + 1;
    drag.el.style.left = `${(a / days) * 100}%`;
    drag.el.style.width = `${(n / days) * 100}%`;
    drag.el.classList.toggle('bad', drag.bad);
    drag.el.textContent = drag.past ? 'No se puede reservar en el pasado' : drag.bad ? 'Ocupado en esas fechas' : `${n} día${n > 1 ? 's' : ''} · ${fmtD(drag.from)} → ${fmtD(drag.to)}`;
  };

  const start = (track, pointerId, x) => {
    const startDay = dayAt(track, x);
    drag = { track, vehicleId: Number(track.dataset.vehicle), startDay, endDay: startDay, x0: x, moved: false, el: document.createElement('div') };
    drag.el.className = 'pl-sel';
    track.appendChild(drag.el);
    try {
      track.setPointerCapture(pointerId);
    } catch {
      // el dedo ya se levantó: no hay a quién capturar
    }
    paint();
  };
  // Con el mouse se arrastra (o un clic reserva ese día). Con el dedo, deslizar mueve el calendario
  // y se reserva con dos toques: el día de retiro y después el de devolución (el mismo día otra vez: un día).
  let tap = null;
  let pick = null;
  const clearPick = () => {
    pick?.el.remove();
    pick = null;
  };
  container.addEventListener('pointerdown', (e) => {
    const track = e.target.closest('.pl-drag');
    if (!track || e.target.closest('.pl-bar') || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.pointerType === 'mouse') return start(track, e.pointerId, e.clientX);
    tap = { track, x: e.clientX, y: e.clientY };
  });

  container.addEventListener('pointermove', (e) => {
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) tap = null; // se está moviendo el calendario
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x0) > 6) drag.moved = true;
    const d = dayAt(drag.track, e.clientX);
    if (d !== drag.endDay) {
      drag.endDay = d;
      paint();
    }
  });

  const go = (d) => {
    if (d.bad) return toast(d.past ? 'No se puede reservar en días que ya pasaron' : 'Ese auto ya está ocupado (o en taller) en esas fechas', true);
    location.hash = `#/reservas/nueva?vehiculo=${d.vehicleId}&desde=${d.from.slice(0, 10)}&hasta=${d.to.slice(0, 10)}`;
  };
  const touchTap = (t) => {
    const day = dayAt(t.track, t.x);
    if (pick && pick.track === t.track && day >= pick.startDay) {
      // Segundo toque: el día de devolución.
      drag = pick;
      pick = null;
      drag.endDay = day;
      paint();
      const d = drag;
      drag = null;
      d.el.remove();
      return go(d);
    }
    // Primer toque (o un día anterior, u otro auto): ese es el día de retiro.
    clearPick();
    start(t.track, null, t.x);
    pick = drag;
    drag = null;
    if (pick.bad) {
      go(pick);
      return clearPick();
    }
    pick.el.textContent = 'Retiro';
    toast(`Retiro el ${fmtD(pick.from)}. Ahora tocá el día de devolución`);
  };
  const finish = (e) => {
    if (tap) {
      const t = tap;
      tap = null;
      if (e.type !== 'pointercancel') touchTap(t);
      return;
    }
    if (!drag) return;
    const d = drag;
    drag = null;
    d.el.remove();
    if (e.type === 'pointercancel') return;
    go(d);
  };
  container.addEventListener('pointerup', finish);
  container.addEventListener('pointercancel', finish);
}

/**
 * Mover una reserva arrastrando su barra con el mouse: a otro auto de la categoría, a otros días (días enteros, misma hora),
 * o sobre otra reserva para intercambiar los autos. En el celular se hace desde la reserva: "Cambiar de auto o intercambiar".
 */
function enableDragToMove(container, p, days) {
  const find = (id) => p.reservations.find((r) => r.id === Number(id));
  const shift = (at, n) => localISO(addDays(new Date(at), n)).slice(0, 16);
  let drag = null;

  const move = async (r, vehicleId, delta) => {
    const before = { vehicle_id: r.vehicle_id, pickup_at: r.pickup_at, return_at: r.return_at };
    const after = await run(() => PUT(`/reservations/${r.id}`, { vehicle_id: vehicleId, pickup_at: shift(r.pickup_at, delta), return_at: shift(r.return_at, delta) }));
    const oldTotal = Number(r.total);
    const changed = Number.isFinite(oldTotal) && Number(after.total) !== oldTotal;
    await route();
    toastUndo(changed ? `${L('Reserva movida. Nuevo total:', 'Booking moved. New total:')} ${money(after.total)}` : L('Reserva movida', 'Booking moved'), async () => {
      await run(() => PUT(`/reservations/${r.id}`, before));
      route();
    });
  };
  const swap = (r, other) =>
    openModal(
      'Intercambiar autos',
      `<form><p>${esc(r.customer_name)} ${L('se queda con el auto de', 'gets the car of')} ${esc(other.customer_name)}, ${L('y al revés. Las fechas y los precios no cambian.', 'and vice versa. Dates and prices stay the same.')}</p>
        <div class="actions"><button class="btn primary" type="submit">${L('Intercambiar', 'Swap')}</button></div></form>`,
      async () => {
        await POST(`/reservations/${r.id}/swap`, { reservation_id: other.id });
        toast('Autos intercambiados');
        route();
      },
    );

  container.addEventListener('pointerdown', (e) => {
    const bar = e.target.closest('.pl-move');
    if (!bar || e.pointerType !== 'mouse' || e.button !== 0) return;
    drag = { bar, r: find(bar.dataset.id), x0: e.clientX, y0: e.clientY, moved: false };
    bar.setPointerCapture(e.pointerId);
  });
  container.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    drag.bar.classList.add('pl-moving');
    drag.bar.style.transform = `translate(${dx}px, ${dy}px)`;
  });
  const finish = async (e) => {
    if (!drag) return;
    const { bar, r, x0, moved } = drag;
    drag = null;
    bar.classList.remove('pl-moving');
    bar.style.transform = '';
    if (!moved || e.type === 'pointercancel') return;
    window.addEventListener('click', (c) => c.stopPropagation(), { capture: true, once: true }); // soltar no abre la reserva
    setTimeout(() => window.dispatchEvent(new Event('click')), 0); // por si soltó fuera de la barra y no hubo clic
    bar.style.visibility = 'hidden';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    bar.style.visibility = '';
    const otherBar = under && under.closest('.pl-bar[data-id]');
    const track = under && under.closest('.pl-track[data-vehicle]');
    if (otherBar && otherBar !== bar) {
      const other = find(otherBar.dataset.id);
      if (!['pendiente', 'confirmada'].includes(other.status)) return toast('Ese auto ya está entregado: no se puede intercambiar', true);
      return swap(r, other);
    }
    if (!track) return;
    const vehicle = p.vehicles.find((v) => v.id === Number(track.dataset.vehicle));
    if (!vehicle) return;
    if (vehicle.category_id !== r.category_id) return toast('Sólo se puede mover a un auto de la misma categoría. Para cambiar de categoría, usá "Modificar fechas o datos".', true);
    if (['mantenimiento', 'fuera_servicio'].includes(vehicle.status)) return toast('Ese auto está en el taller', true);
    const delta = Math.round((e.clientX - x0) / (track.getBoundingClientRect().width / days));
    if (!delta && vehicle.id === r.vehicle_id) return;
    if (delta && shift(r.pickup_at, delta) < localISO(new Date()).slice(0, 16)) return toast('No se puede mover a una fecha que ya pasó', true);
    move(r, vehicle.id, delta).catch(() => {});
  };
  container.addEventListener('pointerup', finish);
  container.addEventListener('pointercancel', finish);
}

/* ============================================================
   Pantallas de ABM (flota, clientes, tarifas, mantenimiento)
   ============================================================ */
const CUSTOMER_FIELDS = [
  { name: 'full_name', label: 'Nombre y apellido', required: true, full: true },
  { name: 'doc_type', label: 'Tipo doc.', type: 'select', options: ['DNI', 'Pasaporte', 'CI', 'CUIT', 'RUT', 'Otro'].map((x) => [x, x]), default: 'DNI' },
  { name: 'doc_number', label: 'Número de documento' },
  { name: 'phone', label: 'Teléfono / WhatsApp' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'birth_date', label: 'Fecha de nacimiento', type: 'date' },
  { name: 'license_number', label: 'Licencia de conducir N°' },
  { name: 'license_expiry', label: 'Vencimiento licencia', type: 'date' },
  { name: 'address', label: 'Domicilio', full: true },
  // Choferes: licencia profesional, apps en las que trabaja y su garante.
  { name: 'license_class', label: 'Clase de licencia (ej. D1 profesional)', when: () => choferesMode() },
  { name: 'work_apps', label: 'Trabaja con (Uber, DiDi, Cabify, PedidosYa, remis…)', when: () => choferesMode() },
  { name: 'guarantor_name', label: 'Garante: nombre y apellido', when: () => choferesMode() },
  { name: 'guarantor_doc', label: 'Garante: DNI', when: () => choferesMode() },
  { name: 'guarantor_phone', label: 'Garante: teléfono', when: () => choferesMode() },
  { name: 'guarantor_address', label: 'Garante: domicilio', when: () => choferesMode() },
  { name: 'notes', label: 'Notas', type: 'textarea', full: true },
];

const VEHICLE_FIELDS = [
  { name: 'plate', label: 'Patente', required: true },
  { name: 'category_id', label: 'Categoría', type: 'select', required: true, options: () => state.categories.map((c) => [c.id, `${c.code} · ${c.name}`]) },
  // Agencias con modalidad de pago: la modalidad y el monto van primero; su monto manda sobre la categoría.
  { name: 'pay_every', label: 'Modalidad de pago', type: 'select', required: true, options: [[24, 'Cada 24 horas'], [12, 'Cada 12 horas']], default: 24, when: payModes },
  { name: 'period_rate', label: 'Monto que abona en cada pago (0 = el de la categoría)', type: 'number', default: 0, when: payModes },
  { name: 'brand', label: 'Marca' },
  { name: 'model', label: 'Modelo' },
  { name: 'year', label: 'Año', type: 'number' },
  { name: 'color', label: 'Color' },
  { name: 'branch_id', label: 'Sucursal actual', type: 'select', options: branchOptions },
  { name: 'status', label: 'Estado', type: 'select', required: true, options: ['disponible', 'alquilado', 'mantenimiento', 'fuera_servicio'], default: 'disponible' },
  { name: 'km', label: 'Kilometraje', type: 'number', default: 0 },
  { name: 'fuel', label: 'Combustible (octavos)', type: 'number', default: 8, attrs: 'min="0" max="8"' },
  { name: 'insurance_expiry', label: 'Vencimiento seguro', type: 'date' },
  { name: 'vtv_expiry', label: 'Vencimiento VTV', type: 'date' },
  { name: 'insurance_company', label: 'Aseguradora' },
  { name: 'insurance_policy', label: 'N° de póliza' },
  { name: 'insurance_cost', label: 'Cuota mensual del seguro (se carga sola como gasto el día 1)', type: 'number', default: 0 },
  { name: 'permit_number', label: 'N° de habilitación (remis / apps)', when: () => choferesMode() },
  { name: 'permit_expiry', label: 'Vencimiento de la habilitación', type: 'date', when: () => choferesMode() },
  { name: 'service_every_km', label: 'Service cada (km, 0 = sin aviso)', type: 'number', default: 0, when: () => choferesMode() },
  // Cada auto puede cobrar distinto: su precio manda sobre el de la categoría.
  { name: 'period_rate', get label() { return `Precio por ${periodWord()} de este auto (0 = el de la categoría)`; }, type: 'number', default: 0, when: () => choferesMode() && !payModes() },
  { name: 'rest_day_rate', label: 'Precio de domingos y feriados de este auto (0 = el mismo)', type: 'number', default: 0, when: () => choferesMode() && state.settings.rent_period === 'dia' },
  { name: 'rest_day_free', label: 'Domingos y feriados libres (no se cobran)', type: 'checkbox', full: true, when: () => choferesMode() && state.settings.rent_period === 'dia' },
  { name: 'notes', label: 'Notas', type: 'textarea', full: true },
];

/** Pantalla de listado + alta/edición/baja genérica. */
// rowFilter: qué filas mostrar (p. ej. solo los seguros); defaults: valores que se agregan al crear.
// summary(rows): una línea arriba de la tabla (p. ej. el total de los gastos que se ven).
function crudPage({ title, endpoint, fields, columns, searchable, after, before, extraActions, canWrite = () => true, canDelete, nav, rowFilter, defaults, summary }) {
  const mayDelete = () => (canDelete ? canDelete() : canWrite());
  return async (view) => {
    if (before) await before();
    view.innerHTML = `<div class="page-head"><h1>${esc(title)}</h1>${canWrite() ? '<button class="btn primary" data-new>+ Agregar</button>' : ''}</div>
      ${searchable ? '<div class="toolbar"><input id="crud-q" placeholder="Buscar…"/></div>' : ''}
      ${summary ? '<div id="crud-summary"></div>' : ''}<div class="table-wrap" id="crud-table"></div>`;
    const load = async () => {
      const q = searchable ? $('#crud-q').value.trim() : '';
      const all = await GET(`/${endpoint}${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      const rows = rowFilter ? all.filter(rowFilter) : all;
      if (summary) $('#crud-summary').innerHTML = summary(rows);
      $('#crud-table').innerHTML = rows.length
        ? `<table><thead><tr>${columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}<th></th></tr></thead><tbody>
          ${rows
            .map(
              (r) => `<tr data-id="${r.id}">${columns.map((c) => `<td>${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}
              <td class="right nowrap">${extraActions ? extraActions(r) : ''}${canWrite() ? '<button class="btn small" data-edit>Editar</button>' : ''}${mayDelete() ? ' <button class="btn small danger" data-del>Borrar</button>' : ''}</td></tr>`,
            )
            .join('')}</tbody></table>`
        : '<div class="card muted">Todavía no hay registros.</div>';
      $$('[data-edit]', view).forEach((b) =>
        b.addEventListener('click', () => {
          const row = rows.find((r) => r.id === Number(b.closest('tr').dataset.id));
          openModal(`Editar · ${title}`, formHtml(fields, row), async (d) => {
            await PUT(`/${endpoint}/${row.id}`, d);
            toast('Guardado');
            if (after) await after();
            load();
          });
        }),
      );
      $$('[data-del]', view).forEach((b) =>
        b.addEventListener('click', async () => {
          if (!(await confirmModal({ title: `Borrar · ${title}`, text: 'Se borra para siempre de la lista.', ok: 'Borrar', danger: true }))) return;
          await run(() => DEL(`/${endpoint}/${b.closest('tr').dataset.id}`), 'Borrado');
          if (after) await after();
          load();
        }),
      );
      if (nav) $$('tbody tr', view).forEach((tr) => nav(tr, rows.find((r) => r.id === Number(tr.dataset.id))));
    };
    const nb = $('[data-new]', view);
    if (nb)
      nb.addEventListener('click', () =>
        openModal(`Agregar · ${title}`, formHtml(fields), async (d) => {
          await POST(`/${endpoint}`, { ...d, ...(defaults || {}) });
          toast('Guardado');
          if (after) await after();
          load();
        }),
      );
    if (searchable) {
      let t;
      $('#crud-q').addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(load, 250);
      });
    }
    await load();
  };
}

const isAdmin = () => state.user && state.user.role === 'admin';

/* ---------- Autos: una tarjeta por auto. Primero qué auto es y si está libre; después los datos. ---------- */
const FLEET_FILTERS = [
  ['', 'Todos'],
  ['disponible', 'Disponibles'],
  ['alquilado', 'Alquilados'],
  ['mantenimiento', 'En el taller'],
  ['fuera_servicio', 'Fuera de servicio'],
];
// "Alquilado" no se elige a mano: lo ponen la entrega y la devolución (el servidor también lo controla).
const vehicleFields = (v) =>
  VEHICLE_FIELDS.map((f) =>
    f.name !== 'status'
      ? f
      : v && v.status === 'alquilado'
        ? { ...f, options: [['alquilado', 'Alquilado (vuelve a libre al registrar la devolución)']] }
        : { ...f, options: f.options.filter((o) => o !== 'alquilado') },
  );

// Taller: tipos de trabajo, con nombre para leer.
const MAINT_KINDS = [
  ['service', 'Service'],
  ['reparacion', 'Reparación'],
  ['neumaticos', 'Neumáticos'],
  ['chapa_pintura', 'Chapa y pintura'],
  ['limpieza', 'Limpieza'],
  ['otro', 'Otro'],
];
const maintKind = (k) => (MAINT_KINDS.find(([v]) => v === k) || [k, k])[1];

/** "hoy 10:00", "mañana 09:30" o "03/11 10:00": cuándo pasa algo, para leer de un vistazo. */
const whenShort = (s) => {
  const day = String(s).slice(0, 10);
  const today = localISO(new Date()).slice(0, 10);
  const label = day === today ? 'hoy' : day === localISO(addDays(new Date(), 1)).slice(0, 10) ? 'mañana' : day < today ? `el ${fmtD(s)} (atrasada)` : `el ${fmtD(s)}`;
  return `${label} ${esc(String(s).slice(11, 16))}`;
};
// Tarjeta del auto: además del estado de ahora, qué le toca después (sale, vuelve) y qué se le hace en el taller.
const nextMove = (v) => {
  const lines = [];
  if (v.status === 'mantenimiento' && v.shop_kind) lines.push(`${ICON.wrench}<span><b>${esc(maintKind(v.shop_kind))}</b> desde el ${fmtD(v.shop_since)}</span>`);
  if (v.back_at) lines.push(`${ICON.in}<span>Vuelve <b>${whenShort(v.back_at)}</b></span>`);
  if (v.next_out) lines.push(`${ICON.out}<span>Próxima salida <b>${whenShort(v.next_out)}</b></span>`);
  const soon = v.next_out && v.next_out.slice(0, 10) <= localISO(new Date()).slice(0, 10);
  return lines.length ? `<div class="vcard-next${soon ? ' soon' : ''}">${lines.map((l) => `<p>${l}</p>`).join('')}</div>` : '';
};

on(
  /^\/flota(?:\?estado=(\w+))?$/,
  async (view, estado) => {
    let filter = FLEET_FILTERS.some(([k]) => k === estado) ? estado : '';
    view.innerHTML = `<div class="page-head"><h1>Autos</h1><button class="btn primary" data-new>${ICON.plus}Agregar auto</button></div>
      <div class="fleet-bar"><input id="fleet-q" type="search" placeholder="Buscar por patente, marca o modelo" aria-label="Buscar auto"/>
        <div class="chips" id="fleet-chips" role="group" aria-label="Estado"></div></div>
      <div id="fleet"></div>`;
    // Seguro y VTV: rojo si venció, ámbar si vence en 30 días.
    const doc = (label, d) => `<div><dt>${label}</dt><dd class="doc-${d ? dueTone(d) : 'wait'}">${d ? fmtD(d) : '—'}</dd></div>`;
    const card = (v) => `<article class="vcard st-${v.status}" data-id="${v.id}">
        <div class="vcard-top">
          <div class="vcard-name"><b>${esc([v.brand, v.model].filter(Boolean).join(' ') || v.category_name)}</b><small>${[v.year, `Cat. ${esc(v.category_code)}`, esc(v.color || ''), choferesMode() && v.period_rate > 0 ? `${moneyRound(v.period_rate)} ${payModes() && Number(v.pay_every) === 12 ? 'cada 12 h' : `por ${periodWord()}`}` : '', payModes() && !(v.period_rate > 0) && Number(v.pay_every) === 12 ? 'paga cada 12 h' : '', choferesMode() && v.rest_day_free ? 'domingos libres' : ''].filter(Boolean).join(' · ')}</small></div>
          ${badge(v.status)}
        </div>
        <div class="vcard-id"><span class="plate">${esc(v.plate)}</span><span class="muted">${esc(v.branch_name || '')}</span></div>
        ${nextMove(v)}
        <dl class="vcard-facts">
          <div><dt>Km</dt><dd>${num(v.km || 0)}</dd></div>
          <div><dt>Combustible</dt><dd>${fuel(v.fuel) || '—'}</dd></div>
          ${doc('Seguro', v.insurance_expiry)}${doc('VTV', v.vtv_expiry)}${choferesMode() && v.permit_expiry ? doc('Habilitación', v.permit_expiry) : ''}
        </dl>
        <div class="vcard-actions">
          <button class="btn pill small" type="button" data-hist>${ICON.list}Historial</button>
          <button class="btn pill small" type="button" data-edit>Editar</button>
          ${v.status !== 'alquilado' && branchOptions().length > 1 ? '<button class="btn pill small" type="button" data-branch>Cambiar sucursal</button>' : ''}
          ${v.status === 'alquilado' ? '' : `<button class="btn pill small${v.status === 'mantenimiento' ? ' warm' : ''}" type="button" data-shop>${ICON.wrench}${v.status === 'mantenimiento' ? 'Sacar del taller' : 'Mandar al taller'}</button>`}
          ${isAdmin() ? `<button class="btn icon danger" type="button" data-del aria-label="Borrar ${esc(v.plate)}" title="Borrar">${ICON.trash}</button>` : ''}
        </div>
      </article>`;
    let rows = [];
    const paint = () => {
      const counts = Object.fromEntries(FLEET_FILTERS.map(([k]) => [k, k ? rows.filter((v) => v.status === k).length : rows.length]));
      $('#fleet-chips').innerHTML = FLEET_FILTERS.filter(([k]) => !k || counts[k] || k === filter)
        .map(([k, l]) => `<button type="button" class="chip${k === filter ? ' on' : ''}" data-f="${k}" aria-pressed="${k === filter}">${l} <span class="chip-n">${counts[k]}</span></button>`)
        .join('');
      const list = filter ? rows.filter((v) => v.status === filter) : rows;
      $('#fleet').innerHTML = list.length
        ? `<div class="fleet">${list.map(card).join('')}</div>`
        : `<div class="card muted">${rows.length ? 'No hay autos en este estado.' : 'Todavía no cargaste autos. Tocá "Agregar auto" o pasalos desde una planilla en Más → Pasar datos de una planilla.'}</div>`;
    };
    const load = async () => {
      const q = $('#fleet-q').value.trim();
      rows = await GET(`/vehicles${q ? `?q=${encodeURIComponent(q)}${branchQS('&')}` : branchQS()}`);
      paint();
    };
    $('#fleet-chips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-f]');
      if (!b) return;
      filter = b.dataset.f;
      paint();
    });
    let t;
    $('#fleet-q').addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => run(load), 250);
    });
    $('#fleet').addEventListener('click', async (e) => {
      const box = e.target.closest('.vcard');
      if (!box) return;
      const v = rows.find((x) => x.id === Number(box.dataset.id));
      const shopJobs = async () => (await GET(`/maintenance?q=${encodeURIComponent(v.plate)}`)).filter((m) => m.vehicle_id === v.id);
      if (e.target.closest('[data-hist]')) {
        const [hist, jobs] = await Promise.all([GET(`/reservations?vehicle_id=${v.id}&limit=50`), shopJobs()]);
        openModal(
          `Historial · ${v.plate}`,
          `<h3>Reservas</h3>${historyTable(hist)}<h3>Taller</h3>${
            jobs.length
              ? `<table class="mini"><thead><tr><th>Fechas</th><th>Trabajo</th><th>Costo</th><th>Estado</th></tr></thead><tbody>${jobs
                  .map(
                    (m) =>
                      `<tr><td class="nowrap">${fmtD(m.start_date)} → ${fmtD(m.end_date) || '…'}</td><td><b>${esc(maintKind(m.kind))}</b>${m.description ? `<br><small class="muted">${esc(m.description)}</small>` : ''}</td><td class="nowrap">${m.cost ? money(m.cost) : '—'}</td><td>${m.status === 'abierto' ? '<span class="badge b-mantenimiento">En el taller</span>' : '<span class="badge b-finalizada">Terminado</span>'}</td></tr>`,
                  )
                  .join('')}</tbody></table>`
              : '<p class="muted">Nunca fue al taller.</p>'
          }`,
          null,
          { wide: true },
        );
      } else if (e.target.closest('[data-shop]')) {
        const today = new Date().toISOString().slice(0, 10);
        if (v.status === 'mantenimiento') {
          // Sacar del taller: se cierran sus trabajos abiertos (con la fecha y el costo final) y vuelve a disponible.
          const open = (await shopJobs()).filter((m) => m.status === 'abierto');
          openModal(
            `Sacar del taller · ${v.plate}`,
            `${open.map((m) => `<p><b>${esc(maintKind(m.kind))}</b> desde el ${fmtD(m.start_date)}${m.description ? ` · ${esc(m.description)}` : ''}</p>`).join('')}` +
              formHtml(
                [
                  { name: 'end_date', label: 'Salió el', type: 'date', required: true },
                  { name: 'cost', label: 'Costo total (opcional)', type: 'number' },
                ],
                { end_date: today, cost: open.length === 1 ? open[0].cost || '' : '' },
                'Sacar del taller',
              ) +
              '<p class="muted">El auto vuelve a <b>Disponible</b> y el trabajo queda en su historial.</p>',
            async (d) => {
              for (const m of open) await PUT(`/maintenance/${m.id}`, { ...m, status: 'cerrado', end_date: d.end_date, cost: open.length === 1 && d.cost !== '' ? d.cost : m.cost });
              // Sin trabajos abiertos (quedó en taller a mano): se pasa a disponible desde la ficha.
              if (!open.length) await PUT(`/vehicles/${v.id}`, { ...v, status: 'disponible' });
              toast(`${v.plate} volvió a la flota`);
              load();
            },
          );
        } else {
          openModal(
            `Mandar al taller · ${v.plate}`,
            formHtml(
              [
                { name: 'kind', label: 'Qué se le hace', type: 'select', required: true, options: MAINT_KINDS },
                { name: 'start_date', label: 'Entra el', type: 'date', required: true },
                { name: 'km', label: 'Km', type: 'number' },
                { name: 'cost', label: 'Costo (opcional)', type: 'number' },
                { name: 'description', label: 'Detalle', type: 'textarea', full: true, rows: 2 },
              ],
              { kind: 'service', start_date: today, km: v.km },
              'Mandar al taller',
            ) + '<p class="muted">Mientras esté en el taller no se puede reservar ni entregar. Cuando vuelva, tocá <b>Sacar del taller</b>.</p>',
            async (d) => {
              // Reservas que todavía no salieron y tenían este auto: avisar antes de sacarlo de circulación.
              const ahead = (await GET(`/reservations?vehicle_id=${v.id}&status=pendiente,confirmada&from=${d.start_date}`)).sort((a, b) => a.pickup_at.localeCompare(b.pickup_at));
              if (
                ahead.length &&
                !(await confirmModal({
                  title: `${v.plate} tiene ${plural(ahead.length, 'reserva', 'reservas')} por delante`,
                  text: `${ahead.map((r) => `${r.code} · ${r.customer_name} · retira el ${fmtD(r.pickup_at)}`).join(' — ')}. Si lo mandás al taller, a cada una se le asigna otro auto libre de la misma categoría; si no hay, queda sin auto para que la resuelvas.`,
                  ok: 'Mandar y reasignar',
                }))
              )
                return false;
              await POST('/maintenance', { ...d, vehicle_id: v.id, status: 'abierto' });
              if (ahead.length) {
                const moved = await POST(`/vehicles/${v.id}/release`, { reservation_ids: ahead.map((r) => r.id) });
                const lost = moved.filter((m) => !m.plate);
                toast(
                  lost.length
                    ? `${v.plate} quedó en el taller. ${plural(lost.length, 'reserva quedó', 'reservas quedaron')} sin auto: ${lost.map((m) => m.code).join(', ')}`
                    : `${v.plate} quedó en el taller y sus reservas pasaron a ${moved.map((m) => m.plate).join(', ')}`,
                  lost.length > 0,
                );
              } else toast(`${v.plate} quedó en el taller`);
              load();
            },
          );
        }
      } else if (e.target.closest('[data-branch]')) {
        openModal(
          `Cambiar sucursal · ${v.plate}`,
          formHtml([{ name: 'branch_id', label: 'Sucursal', type: 'select', options: branchOptions, required: true }], v, 'Cambiar sucursal'),
          async (d) => {
            await PUT(`/vehicles/${v.id}`, { ...v, branch_id: Number(d.branch_id) });
            toast('Sucursal cambiada');
            load();
          },
        );
      } else if (e.target.closest('[data-edit]')) {
        openModal(`Editar · ${v.plate}`, formHtml(vehicleFields(v), v), async (d) => {
          await PUT(`/vehicles/${v.id}`, d);
          toast('Guardado');
          load();
        });
      } else if (e.target.closest('[data-del]')) {
        if (!(await confirmModal({ title: `Borrar ${v.plate}`, text: 'El auto se borra de la flota. Si tiene reservas, no se puede borrar: ponelo "Fuera de servicio".', ok: 'Borrar auto', danger: true }))) return;
        await run(() => DEL(`/vehicles/${v.id}`), 'Auto borrado');
        load();
      }
    });
    $('[data-new]', view).addEventListener('click', () =>
      openModal('Agregar auto', formHtml(vehicleFields(null)), async (d) => {
        await POST('/vehicles', d);
        toast('Auto agregado');
        load();
      }),
    );
    await load();
  },
  'flota',
);

on(
  /^\/clientes$/,
  crudPage({
    title: 'Clientes',
    endpoint: 'customers',
    fields: CUSTOMER_FIELDS,
    searchable: true,
    canWrite: () => true,
    canDelete: () => isAdmin(),
    columns: [
      { label: 'Nombre', render: (r) => `<b>${esc(r.full_name)}</b>${r.anonymized_at ? ' <span class="badge">anonimizado</span>' : ''}` },
      { label: 'Documento', render: (r) => `${esc(r.doc_type || '')} ${esc(r.doc_number || '')}` },
      { label: 'Teléfono', key: 'phone' },
      { label: 'Email', key: 'email' },
      { label: 'Licencia', render: (r) => (r.license_number ? `${esc(r.license_number)} <small class="muted">${fmtD(r.license_expiry)}</small>` : '<span class="badge b-pendiente">Falta</span>') },
    ],
    extraActions: (r) =>
      `<button class="btn small" data-hist="${r.id}">Reservas</button> ${r.anonymized_at ? '' : `<button class="btn small" data-docs="${r.id}">Carnet y DNI</button> `}${isAdmin() && !r.anonymized_at ? `<button class="btn small" data-anon="${r.id}">Anonimizar</button> ` : ''}`,
    nav: (tr, r) => {
      const b = tr.querySelector('[data-hist]');
      if (b)
        b.addEventListener('click', async () => {
          const rows = await GET(`/reservations?customer_id=${r.id}&limit=50`);
          openModal(`Reservas de ${r.full_name}`, historyTable(rows));
        });
      tr.querySelector('[data-docs]')?.addEventListener('click', () => openDocuments(r.id, r.full_name));
      const a = tr.querySelector('[data-anon]');
      if (a)
        a.addEventListener('click', () =>
          openModal(
            `Anonimizar a ${r.full_name}`,
            `<p>Se borran para siempre sus datos personales (nombre, documento, contacto, licencia, domicilio y notas).
             Sus reservas, pagos y contratos se conservan sin datos personales, para la contabilidad.</p>
             <p>Usalo cuando el cliente pida la baja de sus datos. <b>No se puede deshacer.</b></p>
             <form><div class="actions"><button class="btn danger" type="submit">Anonimizar</button><button class="btn" type="button" data-close>Cancelar</button></div></form>`,
            async () => {
              await POST(`/customers/${r.id}/anonymize`);
              toast('Cliente anonimizado');
              route();
            },
          ),
        );
    },
  }),
  'clientes',
);

function historyTable(rows) {
  return rows.length
    ? `<table><thead><tr><th>Código</th><th>Fechas</th><th>Cliente / Vehículo</th><th>Estado</th><th class="right">Total</th></tr></thead><tbody>${rows
        .map(
          (r) =>
            `<tr class="click" data-href="#/reservas/${r.id}"><td>${esc(r.code)}</td><td class="nowrap">${fmtD(r.pickup_at)} → ${fmtD(r.return_at)}</td><td>${esc(r.customer_name)} · ${esc(r.vehicle_plate || r.category_code)}</td><td>${badge(r.status)}</td><td class="right">${money(r.total)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">Sin reservas.</p>';
}
document.addEventListener('click', (e) => {
  if (e.target.closest('#modal [data-href]')) closeModal();
});

/* ---------- Gastos de cada auto (modo choferes): se restan en la caja de Estadísticas. ---------- */
const EXPENSE_KINDS = [
  ['taller', 'Taller / mecánico'],
  ['repuestos', 'Repuestos'],
  ['combustible', 'Combustible / GNC'],
  ['seguro', 'Seguro'],
  ['patente', 'Patente e impuestos'],
  ['lavado', 'Lavado'],
  ['otro', 'Otro'],
];
let expenseVehicles = [];
on(
  /^\/gastos$/,
  crudPage({
    title: 'Gastos de los autos',
    endpoint: 'expenses',
    before: async () => {
      expenseVehicles = await GET('/vehicles');
    },
    fields: [
      { name: 'date', label: 'Fecha', type: 'date', required: true },
      { name: 'vehicle_id', label: 'Auto (vacío = gasto general)', type: 'select', options: () => expenseVehicles.map((v) => [v.id, [v.plate, v.brand, v.model].filter(Boolean).join(' · ')]) },
      { name: 'kind', label: 'Tipo', type: 'select', required: true, options: EXPENSE_KINDS, default: 'taller' },
      { name: 'amount', label: 'Importe', type: 'number', required: true },
      { name: 'description', label: 'Detalle', full: true },
    ],
    searchable: true,
    canDelete: () => isAdmin(),
    // Total de lo que se ve (con la búsqueda aplicada) y lo de este mes.
    summary: (rows) => {
      const month = localISO(new Date()).slice(0, 7);
      const sum = (list) => list.reduce((a, e) => a + Number(e.amount || 0), 0);
      return `<div class="stat-tiles" style="margin-bottom:12px">
        <div class="stat-tile"><b>${money(sum(rows))}</b><span>gasto total (${plural(rows.length, 'gasto', 'gastos')})</span></div>
        <div class="stat-tile"><b>${money(sum(rows.filter((e) => String(e.date).startsWith(month))))}</b><span>gastado este mes</span></div>
      </div>`;
    },
    columns: [
      { label: 'Fecha', render: (e) => fmtD(e.date) },
      { label: 'Auto', render: (e) => (e.plate ? `<b>${esc(e.plate)}</b>` : '<span class="muted">General</span>') },
      { label: 'Tipo', render: (e) => esc((EXPENSE_KINDS.find(([k]) => k === e.kind) || [e.kind, e.kind])[1]) },
      { label: 'Detalle', key: 'description' },
      { label: 'Importe', render: (e) => money(e.amount) },
    ],
  }),
  'mas',
);

// El taller se maneja desde cada auto (botón "Taller"): la pantalla vieja lleva a Autos filtrado.
on(
  /^\/mantenimiento$/,
  () => {
    location.hash = '#/flota?estado=mantenimiento';
  },
  'flota',
);
/* ---------- Tarifas y sucursales (pestañas) ---------- */
on(/^\/tarifas$/, async (view) => {
  const tabs = [
    {
      key: 'categories',
      label: 'Categorías y tarifas',
      fields: [
        { name: 'code', label: 'Código (el que usa el cotizador)', required: true },
        { name: 'name', label: 'Nombre', required: true },
        { name: 'daily_rate', label: 'Tarifa diaria', type: 'number', default: 0 },
        { name: 'weekly_rate', label: 'Tarifa semanal (7+ días, opcional)', type: 'number', default: 0 },
        { name: 'monthly_rate', label: 'Tarifa mensual (choferes)', type: 'number', default: 0, when: () => choferesMode() },
        { name: 'deposit', label: 'Garantía', type: 'number', default: 0 },
        { name: 'km_per_day', label: 'Km incluidos por día (0 = libres)', type: 'number', default: 0 },
        { name: 'km_per_period', label: 'Km incluidos por período de alquiler (choferes, 0 = libres)', type: 'number', default: 0, when: () => choferesMode() },
        { name: 'rest_day_rate', label: 'Tarifa domingos y feriados (cobro por día, 0 = la diaria)', type: 'number', default: 0, when: () => choferesMode() },
        { name: 'extra_km_rate', label: 'Precio km excedente', type: 'number', default: 0 },
        { name: 'seats', label: 'Plazas', type: 'number' },
        { name: 'transmission', label: 'Transmisión', type: 'select', options: [['Manual', 'Manual'], ['Automática', 'Automática']] },
        { name: 'active', label: 'Activa', type: 'checkbox', default: 1 },
        { name: 'aliases', label: 'Alias (nombres que usa el sitio web / cotizador, separados por coma)', full: true },
        { name: 'description', label: 'Descripción', type: 'textarea', full: true },
      ],
      columns: [
        { label: 'Código', render: (r) => `<b>${esc(r.code)}</b>` },
        { label: 'Nombre', key: 'name' },
        { label: 'Diaria', render: (r) => money(r.daily_rate) },
        { label: 'Semanal', render: (r) => (r.weekly_rate ? money(r.weekly_rate) : '—') },
        { label: 'Garantía', render: (r) => money(r.deposit) },
        { label: 'Km/día', render: (r) => esc(r.km_per_day || 'Libres') + (r.active ? '' : ' <span class="badge">inactiva</span>') },
      ],
    },
    {
      key: 'extras',
      label: 'Adicionales',
      fields: [
        { name: 'code', label: 'Código' },
        { name: 'name', label: 'Nombre', required: true },
        { name: 'price', label: 'Precio', type: 'number', default: 0 },
        { name: 'charge_type', label: 'Se cobra', type: 'select', options: [['dia', 'Por día'], ['fijo', 'Por alquiler']], required: true, default: 'dia' },
        { name: 'max_price', label: 'Tope por alquiler (0 = sin tope)', type: 'number', default: 0 },
        { name: 'active', label: 'Activo', type: 'checkbox', default: 1 },
        { name: 'aliases', label: 'Alias (separados por coma)', full: true },
      ],
      columns: [
        { label: 'Código', key: 'code' },
        { label: 'Nombre', key: 'name' },
        { label: 'Precio', render: (r) => `${money(r.price)} ${r.charge_type === 'dia' ? '/día' : '/alquiler'}` },
        { label: 'Tope', render: (r) => (r.max_price ? money(r.max_price) : '—') },
        { label: 'Activo', render: (r) => (r.active ? '✔' : '—') },
      ],
      rowFilter: (r) => r.kind !== 'seguro',
    },
    {
      // Los seguros son adicionales de tipo "seguro": en cada reserva se elige uno (y figura su franquicia).
      key: 'seguros',
      endpoint: 'extras',
      label: 'Seguros',
      intro: 'Cargá las coberturas que ofrecés, con su precio y su franquicia (lo que paga el cliente si hay un daño). En cada reserva se elige una, y figura en el voucher y en el contrato.',
      fields: [
        { name: 'name', label: 'Nombre del seguro', required: true, full: true, attrs: 'placeholder="Ej.: Cobertura total (sin franquicia)"' },
        { name: 'price', label: 'Precio (0 = incluido en la tarifa)', type: 'number', default: 0 },
        { name: 'charge_type', label: 'Se cobra', type: 'select', options: [['dia', 'Por día'], ['fijo', 'Por alquiler']], required: true, default: 'dia' },
        { name: 'deductible', label: 'Franquicia (0 = sin franquicia)', type: 'number', default: 0 },
        { name: 'max_price', label: 'Tope por alquiler (0 = sin tope)', type: 'number', default: 0 },
        { name: 'code', label: 'Código (opcional)' },
        { name: 'active', label: 'Activo', type: 'checkbox', default: 1 },
      ],
      columns: [
        { label: 'Seguro', render: (r) => `<b>${esc(r.name)}</b>` },
        { label: 'Precio', render: (r) => (r.price ? `${money(r.price)} ${r.charge_type === 'dia' ? '/día' : '/alquiler'}` : 'Incluido') },
        { label: 'Franquicia', render: (r) => (r.deductible ? money(r.deductible) : 'Sin franquicia') },
        { label: 'Activo', render: (r) => (r.active ? '✔' : '—') },
      ],
      rowFilter: (r) => r.kind === 'seguro',
      defaults: { kind: 'seguro' },
    },
    {
      key: 'seasons',
      label: 'Temporadas',
      fields: [
        { name: 'name', label: 'Nombre', required: true, full: true },
        { name: 'start_date', label: 'Desde', type: 'date', required: true },
        { name: 'end_date', label: 'Hasta', type: 'date', required: true },
        { name: 'multiplier', label: 'Multiplicador (1.3 = +30%)', type: 'number', default: 1 },
      ],
      columns: [
        { label: 'Temporada', key: 'name' },
        { label: 'Desde', render: (r) => fmtD(r.start_date) },
        { label: 'Hasta', render: (r) => fmtD(r.end_date) },
        { label: 'Ajuste', render: (r) => `${r.multiplier >= 1 ? '+' : ''}${Math.round((r.multiplier - 1) * 100)}%` },
      ],
    },
    {
      key: 'promotions',
      label: 'Promociones',
      intro: 'Elegí el auto, el precio y los días. El cotizador la muestra sola, con tu tarifa tachada.',
      fields: [
        { name: 'name', label: 'Nombre de la promo', required: true, full: true },
        { name: 'category_id', label: 'Auto', type: 'select', required: true, options: () => state.categories.map((x) => [x.id, x.name]) },
        { name: 'promo_rate', label: 'Precio por día con la promo', type: 'number', required: true },
        { name: 'start_date', label: 'Desde', type: 'date', required: true },
        { name: 'days', label: 'Cantidad de días', type: 'number' },
        { name: 'end_date', label: 'O hasta esta fecha', type: 'date' },
        { name: 'active', label: 'Activa', type: 'checkbox', default: 1 },
      ],
      columns: [
        { label: 'Promo', render: (r) => `<b>${esc(r.name)}</b>${r.active ? '' : ' <span class="badge">pausada</span>'}` },
        { label: 'Auto', render: (r) => esc((state.categories.find((x) => x.id === r.category_id) || {}).name || '—') },
        { label: 'Precio por día', render: (r) => `<s>${money((state.categories.find((x) => x.id === r.category_id) || {}).daily_rate || 0)}</s> ${money(r.promo_rate)}` },
        { label: 'Días', render: (r) => `${fmtD(r.start_date)} → ${fmtD(r.end_date)}` },
      ],
    },
    {
      key: 'branches',
      label: 'Sucursales / lugares de entrega',
      fields: [
        { name: 'code', label: 'Código', required: true },
        { name: 'name', label: 'Nombre', required: true },
        { name: 'address', label: 'Dirección', full: true },
        { name: 'phone', label: 'Teléfono' },
        { name: 'active', label: 'Activa', type: 'checkbox', default: 1 },
        { name: 'aliases', label: 'Alias (cómo lo nombra el sitio web, separados por coma)', full: true },
      ],
      columns: [
        { label: 'Código', render: (r) => `<b>${esc(r.code)}</b>` },
        { label: 'Nombre', key: 'name' },
        { label: 'Dirección', key: 'address' },
        { label: 'Alias', render: (r) => `<small class="muted">${esc(r.aliases || '')}</small>` },
        { label: 'Activa', render: (r) => (r.active ? '✔' : '—') },
      ],
    },
  ];
  if (choferesMode()) tabs.splice(0, tabs.length, ...tabs.filter((t) => !['extras', 'seguros', 'seasons'].includes(t.key)));
  const current = tabs.some((t) => t.key === state.tarifasTab) ? state.tarifasTab : 'categories';
  view.innerHTML = `<div class="tabs">${tabs.map((t) => `<button data-tab="${t.key}" class="${t.key === current ? 'active' : ''}">${t.label}</button>`).join('')}</div><div id="tab-body"></div>
    ${isAdmin() ? '' : '<p class="muted">Sólo los administradores pueden modificar tarifas.</p>'}`;
  $$('[data-tab]', view).forEach((b) =>
    b.addEventListener('click', () => {
      state.tarifasTab = b.dataset.tab;
      route();
    }),
  );
  const tab = tabs.find((t) => t.key === current);
  await crudPage({ title: tab.label, endpoint: tab.endpoint || tab.key, fields: tab.fields, columns: tab.columns, canWrite: isAdmin, after: loadCatalogs, rowFilter: tab.rowFilter, defaults: tab.defaults })($('#tab-body'));
  if (tab.intro) $('#tab-body .page-head').insertAdjacentHTML('afterend', `<p class="muted tab-intro">${esc(tab.intro)}</p>`);
}, 'tarifas');

/* ============================================================
   Cotizador / formulario web
   ============================================================ */
on(/^\/cotizador$/, async (view) => {
  const d = await GET('/integration');
  const copy = (id, value) => `<div class="copy"><input id="${id}" readonly value="${esc(value)}"/><button class="btn small" type="button" data-copy="${id}">Copiar</button></div>`;
  const tab = state.cotTab || 'web';
  const tabs = [
    ['web', 'Formulario web'],
    ['api', 'API del cotizador'],
    ['inbox', `Bandeja (${d.inbox.filter((x) => x.status === 'error').length} con error)`],
    ['out', 'Avisos salientes y WhatsApp'],
  ];
  view.innerHTML = `
    <div class="page-head"><h1>Integración con el cotizador</h1></div>
    <p class="muted">Las cotizaciones aceptadas en el sitio web o en el cotizador entran solas como reservas, sin volver a cargar los datos a mano.</p>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div id="cot-body"></div>`;
  $$('[data-tab]', view).forEach((b) =>
    b.addEventListener('click', () => {
      state.cotTab = b.dataset.tab;
      route();
    }),
  );
  const body = $('#cot-body');

  if (tab === 'web') {
    const fromWeb = d.inbox.filter((i) => i.channel === 'web');
    const siteSet = d.webform.allowed_origins && !/discoverushuaia/.test(d.webform.allowed_origins);
    const devNote = `Hola! Necesito conectar el formulario de cotización de mi página con mi sistema de reservas. Pegá esta línea antes de </body> en la página del cotizador:\n\n${d.webform.script_tag}\n\nEl formulario sigue funcionando igual: solo manda una copia de cada pedido al sistema. Si la página tiene más de un formulario, cambiá data-form="form" por el selector del cotizador.`;
    const guide = proOn()
      ? `<div class="card stack" style="margin-bottom:16px">
        <h2>Dejar tu página conectada</h2>
        <form id="site-form" class="stack"><label><b>1.</b> Dirección de tu página<input name="webform_site" required placeholder="mipagina.com" value="${siteSet ? esc(d.webform.allowed_origins.split(',').pop()) : ''}"/></label>
          ${siteSet ? '<small class="muted">Ya acepta pedidos de esa página.</small>' : '<small class="error">Falta: sin esto, los pedidos de tu página no entran.</small>'}
          <div class="actions"><button class="btn">Guardar la dirección</button></div></form>
        <label><b>2.</b> Mandale esto a quien hace tu página<textarea id="dev-note" readonly rows="7" data-notr>${esc(devNote)}</textarea></label>
        <div class="actions"><button class="btn" type="button" data-copy="dev-note">Copiar</button></div>
        <p><b>3.</b> Mandá una cotización de prueba desde tu página. ${fromWeb.length ? `<span class="badge b-confirmada">Conectada</span> Último pedido: ${esc(fromWeb[0].received_at)}` : '<span class="badge b-pendiente">Todavía no llegó ningún pedido</span>'}</p>
      </div>`
      : '';
    body.innerHTML = `${guide}
      <div class="grid cols-2">
        <div class="card stack">
          <h2>Conectar el formulario del sitio</h2>
          <p>Opción A (recomendada): pegar esta línea en la página del cotizador, antes de <code>&lt;/body&gt;</code>. El formulario sigue funcionando igual que hoy y además envía una copia al sistema:</p>
          ${copy('wf-script', d.webform.script_tag)}
          <p>Opción B: que el formulario envíe directamente a esta dirección (<code>action</code> del form, método POST):</p>
          ${copy('wf-action', d.webform.action_url)}
          <p class="muted">Cada solicitud entra como <b>reserva pendiente</b> con origen "Formulario web". El precio se calcula con tus tarifas.
          Si falta un dato o no se reconoce la categoría/lugar, queda en la Bandeja para resolverla a mano.</p>
        </div>
        <form class="card stack" id="wf-form">
          <h2>Configuración</h2>
          <label class="check"><input type="checkbox" name="webform_enabled" ${d.webform.enabled ? 'checked' : ''}/> Recibir solicitudes del formulario web</label>
          <label>Sitios autorizados (separados por coma)<input name="webform_allowed_origins" value="${esc(d.webform.allowed_origins)}"/></label>
          <label>Página de "gracias" a la que volver (opción B, opcional)<input name="webform_redirect_url" value="${esc(d.webform.redirect_url)}" placeholder="https://www.discoverushuaia.com.ar/gracias.html"/></label>
          <label><span>Mapeo de campos: dato del sistema → atributo <code>name</code> del campo en el formulario</span>
            <textarea class="code" name="webform_mapping">${esc(JSON.stringify(d.webform.mapping, null, 2))}</textarea></label>
          <p class="muted"><b>No hace falta completar el mapeo a mano:</b> los campos que no figuran acá se reconocen solos por su nombre
          (nombre, email, teléfono, fecha y hora de retiro/devolución, lugar, vehículo, vuelo, comentarios…). El mapeo sólo sirve para forzar un campo puntual.
          Si la fecha y la hora están en campos separados, usá <code>pickup_at</code> + <code>pickup_time</code>. La categoría y el lugar se reconocen por código, nombre o los <b>alias</b> cargados en Tarifas y sucursales.</p>
          <div class="actions"><button class="btn primary">Guardar</button></div>
        </form>
      </div>
      <div class="card stack" style="margin-top:16px">
        <h2>Probar con datos del formulario</h2>
        <p class="muted">Pegá un ejemplo de lo que envía el formulario (JSON, o texto tipo <code>nombre=Ana&amp;email=…</code>) para ver cómo se interpreta.</p>
        <textarea class="code" id="wf-sample" style="min-height:140px">${esc(
          state.cotSample || JSON.stringify(
            {
              nombre: 'Ana López',
              email: 'ana@example.com',
              telefono: '+54 9 11 5555-0000',
              vehiculo: 'SUV',
              fecha_retiro: '15/01/2027',
              hora_retiro: '10:00',
              fecha_devolucion: '20/01/2027',
              hora_devolucion: '10:00',
              lugar_retiro: 'Aeropuerto',
              lugar_devolucion: 'Aeropuerto',
              comentarios: 'Llego en el vuelo AR1872',
            },
            null,
            2,
          ),
        )}</textarea>
        <div class="actions"><button class="btn" id="wf-preview">Ver interpretación</button><button class="btn primary" id="wf-import">Crear reserva con estos datos</button></div>
        <pre id="wf-out" class="hidden"></pre>
      </div>`;
    const sample = () => {
      const raw = $('#wf-sample').value.trim();
      if (raw.startsWith('{')) return JSON.parse(raw);
      return Object.fromEntries(new URLSearchParams(raw));
    };
    $('#site-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await run(() => PUT('/integration', { webform_site: formData(e.target).webform_site }), 'Dirección guardada');
      route();
    });
    $('#wf-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      await run(() => PUT('/integration', { ...f, webform_enabled: !!f.webform_enabled, webform_mapping: JSON.parse(f.webform_mapping) }), 'Configuración guardada');
    });
    $('#wf-preview').addEventListener('click', async () => {
      const out = await run(() => POST('/integration/preview', { channel: 'web', payload: sample(), mapping: JSON.parse($('[name=webform_mapping]').value) }));
      $('#wf-out').classList.remove('hidden');
      $('#wf-out').textContent = JSON.stringify(out, null, 2);
    });
    $('#wf-import').addEventListener('click', async () => {
      const out = await run(() => POST('/integration/import', { channel: 'web', payload: sample() }));
      toast(`Reserva ${out.reservation.code} creada`);
      location.hash = `#/reservas/${out.reservation.id}`;
    });
  }

  if (tab === 'api') {
    body.innerHTML = `
      <div class="grid cols-2">
        <div class="card stack">
          <h2>Credenciales</h2>
          <label><span>API key (header <code>X-API-Key</code>)</span>${copy('api-key', d.api_key)}</label>
          <div class="actions"><button class="btn danger" id="regen">Regenerar API key</button></div>
          <h3>Direcciones</h3>
          <label>Catálogo (categorías, sucursales, adicionales)${copy('ep-cat', 'GET ' + d.endpoints.catalog)}</label>
          <label>Disponibilidad y precios${copy('ep-av', 'GET ' + d.endpoints.availability + '?pickup_at=2027-01-15T10:00&return_at=2027-01-20T10:00&pickup_branch=USH')}</label>
          <label>Cotizar una categoría${copy('ep-q', 'POST ' + d.endpoints.quote)}</label>
          <label>Crear reserva (formato estándar)${copy('ep-r', 'POST ' + d.endpoints.reservations)}</label>
          <label>Webhook con formato propio del cotizador (usa el mapeo)${copy('ep-in', 'POST ' + d.endpoints.inbound_webhook)}</label>
        </div>
        <form class="card stack" id="api-form">
          <h2>Reglas</h2>
          <label>Precio de las reservas del cotizador<select name="quote_price_source">
            <option value="cotizador" ${d.quote_price_source === 'cotizador' ? 'selected' : ''}>Respetar el total que envía el cotizador</option>
            <option value="sistema" ${d.quote_price_source === 'sistema' ? 'selected' : ''}>Recalcular con las tarifas del sistema</option></select></label>
          <label class="check"><input type="checkbox" name="quote_auto_confirm" ${d.quote_auto_confirm === '1' ? 'checked' : ''}/> Confirmar automáticamente (si no, entran como pendientes)</label>
          <label><span>Mapeo de campos del webhook: dato del sistema → ruta en el JSON del cotizador</span>
            <textarea class="code" name="mapping">${esc(JSON.stringify(d.mapping, null, 2))}</textarea></label>
          <div class="actions"><button class="btn primary">Guardar</button></div>
        </form>
      </div>
      <div class="card" style="margin-top:16px"><h2>Ejemplo</h2>
<pre>curl -X POST ${esc(d.endpoints.reservations)} \\
  -H "X-API-Key: ${esc(d.api_key)}" -H "Content-Type: application/json" \\
  -d '{"id":"COT-1001","customer":{"full_name":"Ana López","doc_number":"30111222","email":"ana@example.com","phone":"+54 9 2901 555555"},
       "category_code":"D","pickup_at":"2027-01-15T10:00","return_at":"2027-01-20T10:00",
       "pickup_branch":"USH","return_branch":"USH","extras":["GPS","CAD"],"total":420000}'</pre>
      <p class="muted">Si se envía dos veces el mismo <code>id</code> no se duplica la reserva.</p></div>`;
    $('#regen').addEventListener('click', async () => {
      if (!(await confirmModal({ title: 'Generar una clave nueva', text: 'La clave actual deja de andar enseguida: el cotizador de tu página no va a funcionar hasta que cargues la nueva.', ok: 'Generar clave nueva', danger: true }))) return;
      await run(() => POST('/integration/regenerate-key'), 'Nueva API key generada');
      route();
    });
    $('#api-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      await run(() => PUT('/integration', { quote_price_source: f.quote_price_source, quote_auto_confirm: !!f.quote_auto_confirm, mapping: JSON.parse(f.mapping) }), 'Guardado');
    });
  }

  if (tab === 'inbox') {
    body.innerHTML = `
      <div class="card stack">
        <h2>Solicitudes recibidas</h2>
        ${
          d.inbox.length
            ? `<table><thead><tr><th>#</th><th>Recibida</th><th>Origen</th><th>Id externo</th><th>Estado</th><th>Detalle</th><th></th></tr></thead><tbody>${d.inbox
                .map(
                  (i) => `<tr><td>${i.id}</td><td class="nowrap">${esc(i.received_at)}</td><td>${esc(STATUS_LABEL[i.channel] || i.channel)}</td><td>${esc(i.external_id || '')}</td><td>${badge(i.status)}</td>
                  <td>${esc(i.message || '')}</td><td class="right nowrap"><button class="btn small" data-view="${i.id}">Ver datos</button>
                  ${i.reservation_id ? `<a class="btn small" href="#/reservas/${i.reservation_id}">Reserva</a>` : `<button class="btn small" data-retry="${i.id}">Reintentar</button>`}</td></tr>`,
                )
                .join('')}</tbody></table>`
            : '<p class="muted">Todavía no llegaron solicitudes.</p>'
        }
        <p class="muted">Si una solicitud falló (por ejemplo, categoría o lugar desconocido), corregí el alias o el mapeo y tocá "Reintentar".</p>
      </div>`;
    $$('[data-retry]', body).forEach((b) =>
      b.addEventListener('click', async () => {
        await run(() => POST(`/integration/inbox/${b.dataset.retry}/reprocess`), 'Reserva creada');
        route();
      }),
    );
    $$('[data-view]', body).forEach((b) =>
      b.addEventListener('click', async () => {
        const row = await GET(`/integration/inbox/${b.dataset.view}`);
        openModal(
          `Solicitud #${row.id}`,
          `<div class="grid cols-2"><div><h3>Lo que llegó</h3><pre>${esc(JSON.stringify(row.payload, null, 2))}</pre></div>
           <div><h3>Cómo se interpretó</h3><pre>${esc(JSON.stringify(row.interpreted, null, 2))}</pre></div></div>
           <p class="muted">${esc(row.message || '')}</p>
           <div class="actions"><button class="btn" id="use-sample">Usar como ejemplo en el probador</button></div>`,
          null,
          { wide: true },
        );
        $('#use-sample').addEventListener('click', () => {
          state.cotTab = row.channel === 'web' ? 'web' : 'api';
          state.cotSample = JSON.stringify(row.payload, null, 2);
          closeModal();
          route();
        });
      }),
    );
  }

  if (tab === 'out') {
    body.innerHTML = `
      <div class="grid cols-2">
        <form class="card stack" id="out-form">
          <h2>Avisar al cotizador los cambios</h2>
          <p class="muted">Cada vez que una reserva se crea, confirma, cancela, entrega o devuelve, se envía un POST JSON a esta URL (firmado con HMAC-SHA256 en el header <code>X-Signature</code>).</p>
          <label>URL del webhook<input name="webhook_url" value="${esc(d.webhook_url)}" placeholder="https://…"/></label>
          <label>Secreto de firma${copy('wh-secret', d.webhook_secret)}</label>
          <div class="actions"><button class="btn primary">Guardar</button><button class="btn" type="button" id="wh-test">Enviar prueba</button><button class="btn danger" type="button" id="wh-regen">Regenerar secreto</button></div>
        </form>
        <form class="card stack" id="wa-form">
          <h2>WhatsApp automático</h2>
          <p class="muted">Con el WhatsApp Business de la agencia conectado (Cloud API de Meta), los links de firma, fotos, devolución y tarjeta salen solos, sin abrir WhatsApp. Va con una plantilla aprobada por Meta, con una sola variable <code>{{1}}</code> para el mensaje. Por ejemplo: <i>Mensaje de tu alquiler: {{1}} Cualquier duda, respondé este mensaje.</i></p>
          <label>Identificador del número (Phone number ID)<input name="wa_phone_id" inputmode="numeric" value="${esc(d.whatsapp.phone_id)}"/></label>
          <label>Token de acceso<input name="wa_token" type="password" autocomplete="off" placeholder="${d.whatsapp.has_token ? 'Cargado. Dejalo vacío para no cambiarlo' : 'EAAG…'}"/></label>
          <label>Nombre de la plantilla<input name="wa_template" value="${esc(d.whatsapp.template)}" placeholder="floty_aviso"/></label>
          <label>Idioma de la plantilla<input name="wa_template_lang" value="${esc(d.whatsapp.lang || 'es')}"/></label>
          <p>${d.whatsapp.phone_id && d.whatsapp.has_token && d.whatsapp.template ? badge('confirmada') + ' Conectado' : '<span class="muted">Sin conectar: los mensajes salen con tu WhatsApp, como siempre.</span>'}</p>
          <div class="actions"><button class="btn primary">Guardar</button></div>
        </form>
        <div class="card"><h2>Últimos envíos</h2>${
          d.webhook_log.length
            ? `<table><tbody>${d.webhook_log
                .map((w) => `<tr><td class="nowrap"><small>${esc(w.created_at)}</small></td><td>${esc(w.event)}</td><td>${w.status >= 200 && w.status < 300 ? badge('procesada') : `<span class="badge b-error">${w.status || 'sin respuesta'}</span>`}</td></tr>`)
                .join('')}</tbody></table>`
            : '<p class="muted">Sin envíos.</p>'
        }</div>
      </div>`;
    $('#out-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await run(() => PUT('/integration', { webhook_url: formData(e.target).webhook_url || '' }), 'Guardado');
    });
    $('#wa-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await run(() => PUT('/integration', formData(e.target)), 'Guardado');
      state.settings = await GET('/settings');
      route();
    });
    $('#wh-test').addEventListener('click', async () => {
      const r = await run(() => POST('/integration/test-webhook'));
      toast(`Respuesta del servidor: ${r.status || 'sin respuesta'}`, !(r.status >= 200 && r.status < 300));
      route();
    });
    $('#wh-regen').addEventListener('click', async () => {
      await run(() => POST('/integration/regenerate-secret'), 'Secreto regenerado');
      route();
    });
  }

  $$('[data-copy]', view).forEach((b) =>
    b.addEventListener('click', () => {
      const input = $(`#${b.dataset.copy}`);
      input.select();
      (navigator.clipboard ? navigator.clipboard.writeText(input.value) : Promise.resolve(document.execCommand('copy'))).then(() => toast('Copiado'));
    }),
  );
}, 'cotizador');

/* ============================================================
   Configuración y usuarios
   ============================================================ */
const CURRENCIES = [
  ['ARS', 'Peso argentino (ARS)'], ['CLP', 'Peso chileno (CLP)'], ['UYU', 'Peso uruguayo (UYU)'], ['PYG', 'Guaraní (PYG)'],
  ['BOB', 'Boliviano (BOB)'], ['PEN', 'Sol (PEN)'], ['COP', 'Peso colombiano (COP)'], ['MXN', 'Peso mexicano (MXN)'],
  ['CRC', 'Colón (CRC)'], ['DOP', 'Peso dominicano (DOP)'], ['GTQ', 'Quetzal (GTQ)'], ['BRL', 'Real (BRL)'],
  ['USD', 'Dólar (USD)'], ['EUR', 'Euro (EUR)'],
];
const LOCALES = [
  ['es-AR', 'Argentina'], ['es-CL', 'Chile'], ['es-UY', 'Uruguay'], ['es-PY', 'Paraguay'], ['es-BO', 'Bolivia'], ['es-PE', 'Perú'],
  ['es-CO', 'Colombia'], ['es-EC', 'Ecuador'], ['es-MX', 'México'], ['es-CR', 'Costa Rica'], ['es-PA', 'Panamá'],
  ['es-DO', 'República Dominicana'], ['es-GT', 'Guatemala'], ['es-ES', 'España'], ['es-US', 'Estados Unidos'], ['es-419', 'Latinoamérica (general)'],
];

on(/^\/config$/, async (view) => {
  const s = await GET('/settings');
  const presets = s.country_presets || {};
  view.innerHTML = `<div class="page-head"><h1>Configuración</h1></div><div class="card">${formHtml(
    [
      { name: 'company_name', label: 'Nombre de la empresa', required: true },
      { name: 'country', label: 'País (completa moneda, impuesto y formato)', type: 'select', options: Object.entries(presets).map(([k, p]) => [k, p.name]), required: true },
      { name: 'business_mode', label: 'Tipo de negocio', type: 'select', required: true, options: [['turismo', 'Alquiler turístico (por días)'], ['choferes', 'Autos para choferes de apps (se renueva solo)']] },
      { name: 'rent_period', label: 'Se cobra por adelantado y se renueva cada', type: 'select', required: true, options: [['dia', 'Día'], ['semana', 'Semana'], ['mes', 'Mes']], when: () => choferesMode() },
      { name: 'late_fee_per_day', label: 'Recargo por cada día de atraso en el pago', type: 'number', attrs: 'min="0"', when: () => choferesMode() },
      { name: 'late_grace_days', label: 'Días de tolerancia antes del recargo', type: 'number', attrs: 'min="0"', when: () => choferesMode() },
      { name: 'holidays', label: 'Feriados con tarifa de domingo (DD/MM/AAAA, separados por coma)', full: true, when: () => choferesMode() },
      { name: 'company_tax_id', label: `${s.tax_id_label || 'CUIT'} de la empresa` },
      { name: 'company_phone', label: 'Teléfono' },
      { name: 'company_address', label: 'Dirección', full: true },
      { name: 'currency', label: 'Moneda', type: 'select', options: CURRENCIES, required: true },
      { name: 'tax_name', label: 'Nombre del impuesto (IVA, IGV, ITBIS, IGIC…)' },
      { name: 'tax_rate', label: 'Impuesto %', type: 'number' },
      { name: 'prices_include_tax', label: 'Las tarifas incluyen el impuesto', type: 'checkbox' },
      { name: 'tax_id_label', label: 'Nombre de la identificación fiscal (CUIT, RUT, RFC, NIF…)' },
      { name: 'locale', label: 'Formato de números y fechas', type: 'select', options: LOCALES },
      { name: 'grace_hours', label: 'Tolerancia (horas) antes de cobrar un día más', type: 'number' },
      { name: 'one_way_fee', label: 'Recargo por devolver en otro lugar', type: 'number', when: () => !choferesMode() },
      { name: 'fuel_charge_per_eighth', label: 'Cargo por cada 1/8 de combustible faltante', type: 'number' },
      { name: 'turnaround_minutes', label: 'Minutos libres entre la devolución de un auto y su próximo alquiler', type: 'number', attrs: 'min="0"', when: () => proOn() },
      { name: 'dynamic_pricing_rules', label: 'Subir precios según ocupación (ocupación:recargo, por ejemplo 70:10, 90:20)', when: () => proOn() && !choferesMode() },
      { name: 'min_driver_age', label: 'Edad mínima del conductor', type: 'number' },
      { name: 'deductible_amount', label: 'Franquicia del seguro (vacío = la de la póliza)', type: 'number' },
      { name: 'jurisdiction', label: 'Jurisdicción del contrato (tribunales de...)', full: true },
      { name: 'contract_terms_choferes', label: 'Contrato para choferes (un párrafo por cláusula; {periodo}, {precio_periodo}, {recargo_atraso}, {garante} y las demás se completan solas)', type: 'textarea', full: true, rows: 16, when: () => choferesMode() },
      { name: 'contract_terms', label: 'Condiciones generales del contrato (un párrafo por cláusula, separadas por una línea en blanco)', type: 'textarea', full: true, rows: 16, when: () => !choferesMode() },
      // Factura electrónica: por ahora sólo de prueba (ver src/invoicing).
      { name: 'invoice_provider', label: 'Factura electrónica (sólo prueba)', type: 'select', options: [['arca', 'ARCA · Argentina'], ['sii', 'SII · Chile']] },
      { name: 'invoice_mode', label: 'Modo', type: 'select', required: true, options: [['simulado', 'Simulado (no se envía a ningún lado)'], ['homologacion', 'Homologación (servidor de prueba, necesita certificado)']] },
      { name: 'invoice_tax_id', label: 'CUIT o RUT de prueba' },
      { name: 'invoice_point_of_sale', label: 'Punto de venta (Argentina)', type: 'number' },
      { name: 'invoice_tax_condition', label: 'Condición frente al IVA (Argentina)', type: 'select', required: true, options: [['RI', 'Responsable Inscripto (Factura A o B)'], ['MONO', 'Monotributo (Factura C)']] },
      // Política de devolución de dinero al cancelar (src/refunds.js).
      { name: 'refund_full_hours', label: 'Devolución del 100 % si cancela con esta anticipación o más (horas)', type: 'number', attrs: 'min="0"', when: () => !choferesMode() },
      { name: 'refund_partial_hours', label: 'Devolución parcial si cancela con esta anticipación o más (horas)', type: 'number', attrs: 'min="0"', when: () => !choferesMode() },
      { name: 'refund_partial_pct', label: 'Porcentaje de la devolución parcial (%)', type: 'number', attrs: 'min="0" max="100"', when: () => !choferesMode() },
      { name: 'refund_terms', label: 'Condiciones extra de cancelación y devoluciones', type: 'textarea', full: true, rows: 3, when: () => !choferesMode() },
      // Versión en inglés: contrato, voucher y política cuando la app está en inglés (i18n.js).
      { name: 'jurisdiction_en', label: 'Jurisdicción del contrato en inglés (courts of...)', full: true, when: () => !choferesMode() },
      { name: 'contract_terms_en', label: 'Condiciones generales del contrato en inglés (se usan cuando la app está en inglés)', type: 'textarea', full: true, rows: 12, when: () => !choferesMode() },
      { name: 'refund_terms_en', label: 'Condiciones extra de cancelación y devoluciones en inglés', type: 'textarea', full: true, rows: 3, when: () => !choferesMode() },
    ],
    s,
  )}</div>`;
  $('form', view).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    f.prices_include_tax = f.prices_include_tax ? '1' : '0';
    await run(() => PUT('/settings', f), 'Configuración guardada');
    const modeChanged = f.business_mode !== state.settings.business_mode;
    await loadCatalogs();
    if (modeChanged) route(); // aparecen o se van los campos del modo choferes
  });
  $('[data-close]', view).remove();
  // Al elegir el país se completan moneda, impuesto y formato (se pueden ajustar a mano después).
  const form = $('form', view);
  form.country.addEventListener('change', () => {
    const p = presets[form.country.value];
    if (!p) return;
    for (const k of ['currency', 'tax_name', 'tax_rate', 'tax_id_label', 'locale']) if (form[k]) form[k].value = p[k];
    toast(`Datos de ${p.name} cargados: revisalos y tocá Guardar`);
  });
  // En el modo autos para trabajo, la ayuda y "Restaurar" son del contrato para choferes.
  const work = choferesMode();
  const terms = $(work ? '[name=contract_terms_choferes]' : '[name=contract_terms]', view);
  const help = document.createElement('div');
  help.className = 'full';
  help.innerHTML = `<p class="muted" style="margin:0 0 8px">Estas palabras se completan solas en cada contrato: <code>{empresa}</code> ${
    work
      ? '<code>{periodo}</code> <code>{precio_periodo}</code> <code>{recargo_atraso}</code> <code>{dias_gracia}</code> <code>{garante}</code> <code>{uso}</code>'
      : '<code>{tolerancia}</code> <code>{edad_minima}</code> <code>{cargo_combustible}</code>'
  }
    <code>{kilometraje}</code> <code>{franquicia}</code> <code>{garantia}</code> <code>{jurisdiccion}</code>.
    Son condiciones de uso habitual: conviene que las revise un abogado antes de usarlas.</p>
    <button type="button" class="btn small" id="terms-reset">Restaurar condiciones sugeridas</button>`;
  terms.closest('label').after(help);
  const invNote = document.createElement('div');
  invNote.className = 'full';
  invNote.innerHTML = `<h2 style="margin:12px 0 4px">Factura electrónica</h2><p class="muted" style="margin:0">Por ahora funciona <b>sólo en modo de prueba</b>: las facturas no tienen validez fiscal. Para facturar de verdad faltan el certificado digital de la empresa y su ${esc(s.tax_id_label || 'CUIT')} habilitado para factura electrónica (lo gestiona el contador).</p>`;
  $('[name=invoice_provider]', view).closest('label').before(invNote);
  const refNote = document.createElement('div');
  refNote.className = 'full';
  refNote.innerHTML = `<h2 style="margin:12px 0 4px">Cancelaciones y devolución de dinero</h2><p class="muted" style="margin:0">Con menos horas que la devolución parcial, o si el cliente no se presenta, no hay devolución. Al cancelar una reserva, el sistema calcula cuánto corresponde devolver y lo deja registrado (no mueve dinero). Esta política sale en el voucher y en el contrato. <b>Los valores y el texto son un ejemplo: cada agencia los tiene que revisar según las leyes de su país</b> (por ejemplo, las de defensa del consumidor).</p>`;
  $('#terms-reset', view).addEventListener('click', async () => {
    if (!(await confirmModal({ title: 'Usar las condiciones sugeridas', text: 'Se reemplaza el texto actual. El cambio queda recién cuando tocás Guardar.', ok: 'Reemplazar' }))) return;
    terms.value = (work ? s.contract_terms_choferes_default : s.contract_terms_default) || '';
  });
  if (work) return; // lo que sigue (cancelaciones y textos en inglés) es del alquiler turístico
  $('[name=refund_full_hours]', view).closest('label').before(refNote);
  const enNote = document.createElement('div');
  enNote.className = 'full';
  enNote.innerHTML = `<h2 style="margin:12px 0 4px">Textos en inglés</h2><p class="muted" style="margin:0">Cuando la app está en inglés, el contrato, el voucher y la política de devolución usan estos textos. Si quedan vacíos se usan los de arriba.</p>`;
  $('[name=jurisdiction_en]', view).closest('label').before(enNote);
  const termsEn = $('[name=contract_terms_en]', view);
  const resetEn = document.createElement('div');
  resetEn.className = 'full';
  resetEn.innerHTML = '<button type="button" class="btn small">Restaurar condiciones sugeridas en inglés</button>';
  termsEn.closest('label').after(resetEn);
  $('button', resetEn).addEventListener('click', async () => {
    if (!(await confirmModal({ title: 'Usar las condiciones sugeridas', text: 'Se reemplaza el texto actual. El cambio queda recién cuando tocás Guardar.', ok: 'Reemplazar' }))) return;
    termsEn.value = s.contract_terms_en_default || '';
  });
}, 'config');

const AUDIT_LABEL = {
  login: 'Ingreso',
  login_fallido: 'Login fallido',
  login_bloqueado: 'Login bloqueado por intentos',
  logout: 'Salida',
  cambio_clave: 'Cambio de contraseña',
  cambio_clave_fallido: 'Cambio de contraseña fallido',
  usuario_creado: 'Usuario creado',
  usuario_modificado: 'Usuario modificado',
  cliente_anonimizado: 'Cliente anonimizado',
  registro_borrado: 'Registro borrado',
  archivo_borrado: 'Foto o documento borrado',
  configuracion_modificada: 'Configuración modificada',
  integracion_modificada: 'Integración modificada',
  api_key_regenerada: 'API key regenerada',
  secreto_webhook_regenerado: 'Secreto de webhook regenerado',
  importacion: 'Importación de datos',
};

on(/^\/usuarios$/, async (view) => {
  const [users, log] = await Promise.all([GET('/users'), GET('/audit')]);
  view.innerHTML = `<div class="page-head"><h1>Usuarios</h1><button class="btn primary" data-new>+ Agregar</button></div>
    <div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Activo</th><th></th></tr></thead><tbody>${users
      .map(
        (u) =>
          `<tr data-id="${u.id}"><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.role === 'admin' ? 'Administrador' : 'Operador'}</td><td>${u.active ? '✔' : '—'}${u.must_change_password ? ' <span class="badge b-pendiente">cambia la clave al entrar</span>' : ''}</td><td class="right"><button class="btn small" data-edit>Editar</button></td></tr>`,
      )
      .join('')}</tbody></table></div>
    <p class="muted">Los operadores manejan reservas, flota y clientes. Los administradores además configuran tarifas, el cotizador y los usuarios, y son los únicos que pueden borrar o anonimizar clientes. Cada persona debería tener su propio usuario.</p>
    <div class="card" style="margin-top:16px"><h2>Actividad reciente</h2>
      <p class="muted">Ingresos, intentos fallidos y cambios importantes. Muchos "login fallido" seguidos pueden ser alguien probando contraseñas.</p>
      <div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Qué pasó</th><th>Usuario</th><th>Detalle</th><th>IP</th></tr></thead><tbody>${
        log
          .map(
            (a) =>
              `<tr><td class="nowrap">${esc(new Date(a.at).toLocaleString(locale(), { hour12: false }))}</td><td>${esc(AUDIT_LABEL[a.action] || a.action)}</td><td>${esc(a.email || '')}</td><td><small>${esc(a.detail || '')}</small></td><td><small class="muted">${esc(a.ip || '')}</small></td></tr>`,
          )
          .join('') || '<tr><td colspan="5" class="muted">Sin actividad registrada.</td></tr>'
      }</tbody></table></div></div>`;
  const roleField = { name: 'role', label: 'Rol', type: 'select', options: [['operador', 'Operador'], ['admin', 'Administrador']], required: true };
  $('[data-new]', view).addEventListener('click', () =>
    openModal(
      'Nuevo usuario',
      formHtml(
        [
          { name: 'name', label: 'Nombre', required: true },
          { name: 'email', label: 'Email', type: 'email', required: true },
          { name: 'password', label: 'Contraseña inicial (la persona la cambia al entrar)', type: 'password', required: true, attrs: 'minlength="8" autocomplete="new-password"' },
          roleField,
        ],
        { role: 'operador' },
      ) + `<p class="muted">${PASSWORD_HINT}</p>`,
      async (d) => {
        await POST('/users', d);
        toast('Usuario creado');
        route();
      },
    ),
  );
  $$('[data-edit]', view).forEach((b) =>
    b.addEventListener('click', () => {
      const u = users.find((x) => x.id === Number(b.closest('tr').dataset.id));
      openModal(
        `Editar ${u.name}`,
        formHtml([{ name: 'name', label: 'Nombre', required: true }, roleField, { name: 'active', label: 'Activo', type: 'checkbox' }, { name: 'password', label: 'Nueva contraseña (dejar vacío para no cambiar)', type: 'password', attrs: 'minlength="8" autocomplete="new-password"' }], u) +
          `<p class="muted">${PASSWORD_HINT} Si le ponés una contraseña nueva, la persona la tiene que cambiar en su próximo ingreso y se cierran sus sesiones abiertas.</p>`,
        async (d) => {
          await PUT(`/users/${u.id}`, d);
          toast('Usuario actualizado');
          route();
        },
      );
    }),
  );
}, 'usuarios');

/* ---------- Estadísticas: qué autos se piden, por categoría, seguros, rendimiento, daños y taller (administradores) ---------- */
// Períodos cerrados (desde, hasta): por defecto el mes en curso, sin mezclar lo pasado con lo que viene.
const ymd = (d) => localISO(d).slice(0, 10);
const STATS_PERIODS = [
  ['month', 'Este mes', (t) => [ymd(new Date(t.getFullYear(), t.getMonth(), 1)), ymd(new Date(t.getFullYear(), t.getMonth() + 1, 0))]],
  ['prev', 'Mes pasado', (t) => [ymd(new Date(t.getFullYear(), t.getMonth() - 1, 1)), ymd(new Date(t.getFullYear(), t.getMonth(), 0))]],
  ['next', 'Próximos 30 días', (t) => [ymd(t), ymd(addDays(t, 30))]],
  ['year', 'Este año', (t) => [ymd(new Date(t.getFullYear(), 0, 1)), ymd(new Date(t.getFullYear(), 11, 31))]],
];
// Importes grandes sin centavos: en las tarjetas se leen completos.
const moneyRound = (n) => money(Math.round(n || 0)).replace(/[.,]00(?=\D*$)/, '');
const SOURCE_TEXT = { manual: 'Mostrador', web: 'Por internet', cotizador: 'Cotizador', importado: 'Importadas' };

on(
  /^\/estadisticas$/,
  async (view) => {
    if (!isAdmin()) {
      view.innerHTML = '<div class="card"><p class="muted">Sólo los administradores ven las estadísticas.</p></div>';
      return;
    }
    await statsView(view, '/stats');
  },
  'estadisticas',
);

// El dueño de Floty ve las estadísticas de cada agencia desde su panel, sin entrar a su cuenta.
on(/^\/empresas\/(\d+)\/estadisticas$/, (view, id) => statsView(view, `/platform/companies/${id}/stats`, { owner: true }), 'empresas');

/** Pantalla de estadísticas: la de la agencia o, con owner, la de una agencia vista desde el Panel de Floty. */
async function statsView(view, url, { owner = false } = {}) {
  const key = STATS_PERIODS.some(([k]) => k === state.statsPeriod) ? state.statsPeriod : window.__demoReset ? 'prev' : 'month'; // la demo abre en un mes entero ya cerrado
  const [from, to] = STATS_PERIODS.find(([k]) => k === key)[2](new Date());
  const s = await GET(`${url}?from=${from}&to=${to}`);
  // Desde el panel del dueño no hay pantallas de la agencia a las que saltar: el texto va sin enlace.
  const link = (href, text) => (owner ? text : `<a href="${href}">${text}</a>`);
  const t = s.totals;
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  // Barras: una fila por ítem, el largo relativo al más alto. Un resultado negativo (pierde plata) va en rojo.
  const bars = (rows, value, label, sub, fmt = num) => {
    const max = Math.max(1, ...rows.map((r) => Math.abs(value(r))));
    return rows.length
      ? `<div class="bars">${rows
          .map(
            (r) => `<div class="bar-row${value(r) < 0 ? ' neg' : ''}"><div class="bar-label"><b>${label(r)}</b>${sub ? `<small>${sub(r)}</small>` : ''}</div>
              <div class="bar"><i style="width:${Math.max(2, (Math.abs(value(r)) / max) * 100)}%"></i></div><b class="bar-value">${fmt(value(r))}</b></div>`,
          )
          .join('')}</div>`
      : '<p class="muted">Todavía no hay datos en este período.</p>';
  };
  const tile = (v, l, tone = '') => `<div class="stat-tile ${tone}"><b>${v}</b><span>${l}</span></div>`;
  view.innerHTML = `
    <div class="page-head">${owner ? `<a class="btn link" href="#/empresas">← ${L('Tus agencias', 'Your agencies')}</a>` : ''}<h1>${owner ? `Estadísticas · ${esc(s.company.name)}` : 'Estadísticas'}</h1></div>
    <div class="chips" role="group" aria-label="Período">${STATS_PERIODS.map(([k, l]) => `<button type="button" class="chip${k === key ? ' on' : ''}" data-period="${k}" aria-pressed="${k === key}">${l}</button>`).join('')}</div>
    <p class="muted stats-range">Reservas que se retiran entre el ${fmtD(s.from)} y el ${fmtD(s.to)}.</p>
    <h2 class="stats-sub">Plata</h2>
    <div class="stat-tiles">
      ${tile(moneyRound(t.collected), 'cobrado', 'good')}
      ${tile(moneyRound(t.to_collect), `por cobrar${t.booked_ahead ? ` (${moneyRound(t.booked_ahead)} de reservas que todavía no salieron)` : ''}`)}
      ${tile(moneyRound(t.shop_cost), 'gastos de taller')}
      ${tile(moneyRound(t.net), 'resultado: cobrado menos taller', t.net < 0 ? 'bad' : 'good')}
    </div>
    ${
      s.cash && (choferesMode() || s.cash.expenses)
        ? `<h2 class="stats-sub">Caja: lo que entró y lo que salió en el período</h2>
    <div class="stat-tiles">
      ${tile(moneyRound(s.cash.income), 'cobrado (por fecha de pago)', 'good')}
      ${tile(moneyRound(s.cash.shop_cost + s.cash.expenses), `gastos (taller ${moneyRound(s.cash.shop_cost)}, otros ${moneyRound(s.cash.expenses)})`)}
      ${tile(moneyRound(s.cash.net), 'ganancia: cobrado menos gastos', s.cash.net < 0 ? 'bad' : 'good')}
    </div>`
        : ''
    }
    <h2 class="stats-sub">Alquileres</h2>
    <div class="stat-tiles">
      ${tile(num(t.rentals), `alquileres (de ${plural(t.requested, 'reserva pedida', 'reservas pedidas')})`)}
      ${tile(moneyRound(t.avg_ticket), 'por alquiler, en promedio')}
      ${tile(plural(t.avg_days, 'día', 'días'), 'duración promedio')}
      ${tile(`${pct(t.cancelled, t.requested)} %`, `canceladas o no show (${num(t.cancelled)})`, pct(t.cancelled, t.requested) > 20 ? 'warn' : '')}
    </div>
    <div class="stats-grid">
      <section class="card">
        <h2>Qué categorías dejan más</h2>
        ${bars(s.categories.filter((c) => c.requested || c.shop_cost), (c) => c.net, (c) => `${esc(c.code)} · ${esc(c.name)}`, (c) => `${plural(c.requested, 'reserva', 'reservas')} · ${plural(c.days, 'día alquilado', 'días alquilados')} · cobrado ${moneyRound(c.collected)}${c.shop_cost ? ` · taller ${moneyRound(c.shop_cost)}` : ''}${c.occupancy !== null ? ` · ocupación ${c.occupancy} %` : ''}`, moneyRound)}
      </section>
      <section class="card">
        <h2>Modelos que más facturan</h2>
        ${bars(s.models, (m) => m.revenue, (m) => esc([m.brand, m.model].filter(Boolean).join(' ')), (m) => `${plural(m.rentals, 'alquiler', 'alquileres')} · ${plural(m.days, 'día', 'días')}`, moneyRound)}
      </section>
      ${
        choferesMode()
          ? ''
          : `<section class="card">
        <h2>Seguros que llevan</h2>
        <p class="muted">${t.rentals ? `${pct(t.with_insurance, t.rentals)} % de los alquileres tiene un seguro elegido.` : ''} Los seguros se cargan en ${link('#/tarifas', 'Precios y lugares → Seguros')}.</p>
        ${bars(s.insurance, (x) => x.times, (x) => esc(x.name), (x) => (x.deductible ? `franquicia ${money(x.deductible)}` : 'sin franquicia'))}
      </section>
      <section class="card">
        <h2>Adicionales más pedidos</h2>
        ${bars(s.extras, (x) => x.times, (x) => esc(x.name))}
      </section>
      <section class="card">
        <h2>De dónde vienen las reservas</h2>
        ${bars(s.sources, (x) => x.requested, (x) => esc(SOURCE_TEXT[x.source] || x.source), (x) => `${x.rentals} concretadas · ${money(x.revenue)}`)}
      </section>`
      }
      <section class="card">
        <h2>Daños y accidentes</h2>
        ${
          s.damages.length
            ? `<p><b>${plural(s.damages.length, 'devolución', 'devoluciones')}</b> con daños · <b>${money(s.damages.reduce((x, d) => x + d.amount, 0))}</b> cobrados</p>
               <ul class="stats-list">${s.damages.map((d) => `<li>${link(`#/reservas/${d.id}`, esc(d.code))} ·<span class="plate">${esc(d.plate || '—')}</span> ${esc(d.vehicle)} · ${fmtD(d.at)} · ${d.amount ? money(d.amount) : plural(d.noted, 'daño anotado', 'daños anotados')}</li>`).join('')}</ul>`
            : '<p class="muted">Ninguna devolución con daños en este período. Los daños se cargan al recibir el auto.</p>'
        }
      </section>
      <section class="card">
        <h2>Taller</h2>
        ${bars(s.shop, (x) => x.jobs, (x) => esc(maintKind(x.kind)), (x) => money(x.cost))}
      </section>
    </div>
    <section class="card" style="margin-top:16px">
      <h2>Cada auto: cuánto deja</h2>
      <p class="muted">Tocá el título de una columna para ordenar.</p>
      <div class="table-scroll"><table class="mini sortable"><thead><tr>${VEHICLE_COLS.map(([k, l]) => `<th${k === 'plate' ? '' : ' class="right"'}><button type="button" class="th-sort" data-sort="${k}">${l}</button></th>`).join('')}</tr></thead><tbody data-rows></tbody></table></div>
    </section>`;
  // La tabla por auto se ordena por cualquier columna (por defecto, por resultado: del que más deja al que menos).
  let sort = ['net', -1];
  const paintRows = () => {
    const [k, dir] = sort;
    const rows = [...s.vehicles].sort((x, y) => (k === 'plate' ? x.plate.localeCompare(y.plate) : x[k] - y[k]) * dir);
    $('[data-rows]', view).innerHTML = rows
      .map(
        (v) => `<tr><td><span class="plate">${esc(v.plate)}</span> ${esc([v.brand, v.model].filter(Boolean).join(' '))} <small class="muted">${esc(v.category_code)}</small></td>
          <td class="right">${num(v.rentals)}</td><td class="right">${num(v.days)}</td>
          <td class="right"><span class="occ ${v.occupancy >= 60 ? 'hi' : v.occupancy >= 25 ? 'mid' : 'lo'}">${v.occupancy} %</span></td>
          <td class="right nowrap">${moneyRound(v.collected)}</td><td class="right nowrap">${v.shop_cost ? moneyRound(v.shop_cost) : '—'}</td>
          <td class="right nowrap"><b class="${v.net < 0 ? 'neg-text' : ''}">${moneyRound(v.net)}</b></td></tr>`,
      )
      .join('');
    $$('[data-sort]', view).forEach((b) => b.closest('th').setAttribute('aria-sort', b.dataset.sort === k ? (dir > 0 ? 'ascending' : 'descending') : 'none'));
  };
  paintRows();
  $$('[data-sort]', view).forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.sort;
      sort = [k, sort[0] === k ? -sort[1] : k === 'plate' ? 1 : -1];
      paintRows();
    }),
  );
  $$('[data-period]', view).forEach((btn) =>
    btn.addEventListener('click', () => {
      state.statsPeriod = btn.dataset.period;
      route();
    }),
  );
}
const VEHICLE_COLS = [
  ['plate', 'Auto'],
  ['rentals', 'Alquileres'],
  ['days', 'Días'],
  ['occupancy', 'Ocupación'],
  ['collected', 'Cobrado'],
  ['shop_cost', 'Taller'],
  ['net', 'Resultado'],
];

/* ---------- Panel de Floty: las agencias, sus direcciones y si todo funciona (sólo el dueño de Floty) ---------- */
/** "hace 3 días", "hoy", "nunca": para leer de un vistazo cuándo pasó algo. */
function ago(iso) {
  if (!iso) return L('nunca', 'never');
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return L('hoy', 'today');
  if (days === 1) return L('ayer', 'yesterday');
  return L(`hace ${days} días`, `${days} days ago`);
}
/** Días que faltan para una fecha AAAA-MM-DD (negativo si ya pasó); null sin fecha. */
function daysTo(s) {
  if (!s) return null;
  const t = new Date();
  return Math.round((new Date(`${s}T12:00:00`) - new Date(t.getFullYear(), t.getMonth(), t.getDate(), 12)) / 86400000);
}
/** "vence hoy", "en 12 días", "venció hace 3 días". */
function dueText(s) {
  const n = daysTo(s);
  if (n === null) return L('sin fecha', 'no date');
  if (n === 0) return L('vence hoy', 'due today');
  if (n > 0) return n === 1 ? L('vence mañana', 'due tomorrow') : L(`en ${n} días`, `in ${n} days`);
  return L(`venció hace ${plural(-n, 'día', 'días')}`, `${plural(-n, 'day', 'days')} overdue`);
}
/** Tono de un vencimiento: rojo vencido, ámbar a 7 días, celeste a 30, gris lejos o sin fecha. */
const dueTone = (s, soon = 30) => {
  const n = daysTo(s);
  return n === null ? 'wait' : n < 0 ? 'bad' : n <= 7 ? 'warn' : n <= soon ? 'info' : 'ok';
};
/** Estado del abono de una agencia: [tono, texto]. */
function charge(c) {
  const t = daysTo(c.trial_ends);
  if (t !== null && t >= 0) return ['info', L(`En prueba hasta el ${fmtD(c.trial_ends)}`, `On trial until ${fmtD(c.trial_ends)}`)];
  if (!c.next_charge) return c.plan_price ? ['warn', L('Falta la fecha de cobro', 'Billing date missing')] : ['wait', L('Sin abono cargado', 'No plan set')];
  const n = daysTo(c.next_charge);
  if (n < 0) return ['bad', L('Atrasada', 'Overdue')];
  if (n <= 5) return ['warn', L('Por vencer', 'Due soon')];
  return ['ok', L('Al día', 'Up to date')];
}
const REPEAT_LABEL = { anual: 'Todos los años', mensual: 'Todos los meses', una_vez: 'Una sola vez' };

on(/^\/empresas$/, async (view) => {
  if (!state.user.platform_admin) {
    view.innerHTML = '<div class="card"><p class="muted">Sólo el dueño de Floty maneja las agencias.</p></div>';
    return;
  }
  const d = await GET('/platform/overview');
  const own = d.companies.find((c) => c.principal);
  const agencies = d.companies.filter((c) => !c.principal);
  const hoursSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 3600000 : Infinity);
  const backupOk = d.backups.enabled && hoursSince(d.backups.last) < 30;
  const activeWeek = agencies.filter((c) => hoursSince(c.last_login) < 24 * 7).length;

  // Avisos en palabras simples: lo que conviene mirar hoy.
  const warnings = [];
  if (!d.backups.enabled) warnings.push(['bad', L('Las copias de seguridad están apagadas. Si se rompe algo, no hay cómo volver atrás.', 'Backups are turned off. If something breaks, there is no way back.')]);
  else if (!backupOk) warnings.push(['warn', d.backups.last ? L(`La última copia de seguridad es de ${ago(d.backups.last)}. Debería hacerse una por día.`, `The last backup was ${ago(d.backups.last)}. There should be one a day.`) : L('Todavía no se hizo ninguna copia de seguridad. La primera se hace un minuto después de arrancar.', 'No backup yet. The first one runs a minute after starting.')]);
  for (const c of agencies) {
    if (!c.last_login && hoursSince(c.created_at) > 72) warnings.push(['warn', L(`${c.name} todavía no entró nunca. ¿Le llegaron el usuario y la contraseña?`, `${c.name} has never signed in. Did they get their user and password?`)]);
    else if (c.last_login && hoursSince(c.last_login) > 24 * 14) warnings.push(['warn', L(`${c.name} no entra desde ${ago(c.last_login)}.`, `${c.name} hasn't signed in since ${ago(c.last_login)}.`)]);
    if (c.last_login && !c.vehicles) warnings.push(['info', L(`${c.name} entró pero todavía no cargó autos.`, `${c.name} signed in but hasn't added cars yet.`)]);
    const [tone] = charge(c);
    if (tone === 'bad') warnings.push(['bad', L(`${c.name} debe el abono desde el ${fmtD(c.next_charge)}.`, `${c.name} owes the subscription since ${fmtD(c.next_charge)}.`)]);
    else if (tone === 'warn' && c.next_charge) warnings.push(['warn', L(`Cobrarle el abono a ${c.name}: ${dueText(c.next_charge)} (${fmtD(c.next_charge)}).`, `Charge ${c.name}: ${dueText(c.next_charge)} (${fmtD(c.next_charge)}).`)]);
    const t = daysTo(c.trial_ends);
    if (t !== null && t >= 0 && t <= 7) warnings.push(['warn', L(`A ${c.name} se le termina la prueba gratis ${dueText(c.trial_ends)}.`, `${c.name}'s free trial ends ${dueText(c.trial_ends)}.`)]);
    else if (t !== null && t < 0 && !c.next_charge) warnings.push(['warn', L(`A ${c.name} se le terminó la prueba gratis. ¿Arranca a pagar?`, `${c.name}'s free trial is over. Will they start paying?`)]);
    for (const [k, what] of [['domain_expires', L('el dominio propio', 'their own domain')], ['cert_expires', L('el certificado de factura', 'the invoice certificate')]]) {
      const tone2 = dueTone(c[k]);
      if (['bad', 'warn', 'info'].includes(tone2)) warnings.push([tone2 === 'info' ? 'warn' : tone2, L(`Avisale a ${c.name}: ${what} ${daysTo(c[k]) < 0 ? 'venció' : 'vence'} el ${fmtD(c[k])} (${dueText(c[k])}).`, `Tell ${c.name}: ${what} expires on ${fmtD(c[k])} (${dueText(c[k])}).`)]);
    }
  }
  for (const r of d.reminders) {
    const tone = dueTone(r.due_date);
    if (['bad', 'warn', 'info'].includes(tone)) warnings.push([tone, L(`${r.title}: ${daysTo(r.due_date) < 0 ? 'venció' : 'vence'} el ${fmtD(r.due_date)} (${dueText(r.due_date)}).`, `${r.title}: due ${fmtD(r.due_date)} (${dueText(r.due_date)}).`)]);
  }
  const diskPct = d.disk && d.disk.total ? Math.round((d.disk.used / d.disk.total) * 100) : null;
  if (diskPct >= 80) warnings.push([diskPct >= 95 ? 'bad' : 'warn', L(`El disco está al ${diskPct} %. Conviene agrandarlo en Render antes de que se llene.`, `The disk is ${diskPct}% full. Grow it in Render before it fills up.`)]);
  const ORDER = { bad: 0, warn: 1, info: 2 };
  warnings.sort((a, b) => ORDER[a[0]] - ORDER[b[0]]);
  const overdue = agencies.filter((c) => charge(c)[0] === 'bad').length;
  const gb = (n) => `${(n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 1 : 0)} GB`;

  const host = (a) => esc(String(a || '').replace(/^https:\/\//, ''));
  const card = (c) => `<article class="agency" data-id="${c.id}">
      <div class="agency-top">
        <span class="agency-ic" aria-hidden="true">${c.logo ? `<img src="${esc(c.logo)}" alt="">` : ICON.building}</span>
        <div class="agency-name"><b>${esc(c.name)}</b><small>${L('Alta', 'Created')} ${fmtD(c.created_at)}${c.business_mode === 'choferes' ? ` · ${L('Autos para trabajo', 'Work cars')}` : ''}</small></div>
        <span class="st wait" data-status>${c.address ? L('Revisando…', 'Checking…') : L('Sin dirección', 'No address')}</span>
      </div>
      <div class="agency-addr">${
        c.address
          ? `<a href="${esc(c.address)}" target="_blank" rel="noopener" data-notr>${host(c.address)}</a>${c.domain ? ` <span class="tag">${L('dominio propio', 'own domain')}</span>` : ''}<button class="btn icon" type="button" data-copy="${esc(c.address)}" aria-label="Copiar dirección" title="Copiar dirección">${ICON.copy}</button>`
          : `<span class="muted">${L('Falta conectar el dominio de Floty (FLOTY_DOMAIN).', 'Floty domain not connected yet (FLOTY_DOMAIN).')}</span>`
      }</div>
      <dl class="agency-facts">
        <div><dt>${L('Administrador', 'Admin')}</dt><dd data-notr>${esc(c.admin_email || '—')}</dd></div>
        <div><dt>${L('Último ingreso', 'Last sign-in')}</dt><dd>${ago(c.last_login)}</dd></div>
        <div><dt>${L('Autos', 'Cars')}</dt><dd>${c.vehicles}</dd></div>
        <div><dt>${L('Reservas (30 días)', 'Bookings (30 days)')}</dt><dd>${c.reservations_30d}</dd></div>
        ${
          c.contact_name || c.contact_phone
            ? `<div class="wide"><dt>${L('Contacto', 'Contact')}</dt><dd>${esc(c.contact_name || '')}${
                c.contact_phone ? ` <a href="https://wa.me/${esc(String(c.contact_phone).replace(/\D/g, ''))}" target="_blank" rel="noopener" data-notr>${esc(c.contact_phone)}</a>` : ''
              }</dd></div>`
            : ''
        }
      </dl>
      ${c.notes ? `<p class="agency-notes">${esc(c.notes)}</p>` : ''}
      <div class="agency-charge">
        <span class="st ${charge(c)[0]}">${charge(c)[1]}</span>
        <span class="muted">${c.next_charge ? `${L('Próximo cobro', 'Next charge')} ${fmtD(c.next_charge)}${c.plan_price ? ` · ${money(c.plan_price)}` : ''}` : c.plan_price ? money(c.plan_price) : ''}</span>
        ${c.next_charge || c.plan_price ? `<button class="btn pill small" type="button" data-charge>${ICON.check}Marcar pagado</button>` : ''}
      </div>
      <div class="agency-actions">
        <button class="btn primary pill" type="button" data-profile>${ICON.building}Editar agencia</button>
        <button class="btn pill" type="button" data-account>${ICON.user}Ficha y abono</button>
        <a class="btn pill" href="#/empresas/${c.id}/estadisticas">${ICON.chart}Estadísticas</a>
        <div class="agency-actions-2">
          <button class="btn pill" type="button" data-check>${ICON.reset}Probar dirección</button>
          <button class="btn pill" type="button" data-domain>${ICON.globe}Dominio propio</button>
          <button class="btn pill danger" type="button" data-remove>Eliminar</button>
        </div>
      </div>
    </article>`;
  // Vencimientos del dueño y, de solo lectura, los dominios propios y certificados de las agencias.
  const dueRow = (r) => `<li class="due" data-rem="${r.id}">
      <span class="st ${dueTone(r.due_date)}">${r.due_date ? fmtD(r.due_date) : L('Sin fecha', 'No date')}</span>
      <div class="due-what"><b>${esc(r.title)}</b><small>${esc(REPEAT_LABEL[r.repeat] || r.repeat)}${r.amount ? ` · ${money(r.amount)}` : ''}${r.due_date ? ` · ${dueText(r.due_date)}` : ''}${r.note ? ` · ${esc(r.note)}` : ''}</small></div>
      <div class="due-actions">${r.due_date || r.repeat === 'una_vez' ? `<button class="btn pill small" type="button" data-rem-paid>${ICON.check}Pagado</button>` : ''}<button class="btn pill small" type="button" data-rem-edit>Editar</button></div>
    </li>`;
  const agencyDues = agencies.flatMap((c) =>
    [
      ['domain_expires', L('Dominio propio', 'Own domain')],
      ['cert_expires', L('Certificado de factura', 'Invoice certificate')],
    ]
      .filter(([k]) => c[k])
      .map(([k, what]) => ({ c, date: c[k], what })),
  );
  const agencyDueRow = ({ c, date: dd, what }) => `<li class="due">
      <span class="st ${dueTone(dd)}">${fmtD(dd)}</span>
      <div class="due-what"><b>${esc(what)} · ${esc(c.name)}</b><small>${L('Lo paga la agencia: avisale antes', 'The agency pays it: remind them')} · ${dueText(dd)}</small></div>
      <div class="due-actions"><button class="btn pill small" type="button" data-account-of="${c.id}">Ficha</button></div>
    </li>`;
  const expenseAmount = (currency, n) => `${currency} ${Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const expenseTotals = ['ARS', 'USD']
    .map((cur) => [cur, d.expenses.filter((x) => x.currency === cur).reduce((sum, x) => sum + x.amount, 0)])
    .filter(([, total]) => total > 0)
    .map(([cur, total]) => expenseAmount(cur, total))
    .join(' + ');
  const expenseRow = (x) => `<li class="due" data-expense="${x.id}">
      <span class="st">${fmtD(x.paid_on)}</span>
      <div class="due-what"><b>${esc(x.concept)}</b><small>${expenseAmount(x.currency, x.amount)}${x.note ? ` · ${esc(x.note)}` : ''}</small></div>
      <div class="due-actions"><button class="btn pill small" type="button" data-expense-edit>Editar</button></div>
    </li>`;

  view.innerHTML = `
    <div class="own-head">
      <div><h1>Tus agencias</h1><p class="muted">Solo lo ves vos. Desde acá das de alta agencias, les conectás su dirección y revisás que todo ande.</p></div>
      <button class="btn primary pill big" type="button" data-new>${ICON.plus}Nueva agencia</button>
    </div>
    <div class="own-tiles">
      <div class="own-tile"><span class="ic out" aria-hidden="true">${ICON.building}</span><b>${agencies.length}</b><span>${L('agencias', 'agencies')}</span></div>
      <div class="own-tile"><span class="ic free" aria-hidden="true">${ICON.user}</span><b>${activeWeek}</b><span>${L('entraron esta semana', 'signed in this week')}</span></div>
      <div class="own-tile ${backupOk ? 'good' : d.backups.enabled ? 'warn' : 'bad'}"><span class="ic" aria-hidden="true">${ICON.backup}</span><b>${backupOk ? L('Al día', 'Up to date') : d.backups.enabled ? L('Atrasadas', 'Behind') : L('Apagadas', 'Off')}</b><span>${L('copias de seguridad', 'backups')}${d.backups.last ? ` · ${L('última', 'last')} ${ago(d.backups.last)}` : ''}</span></div>
      <div class="own-tile" data-up-tile><span class="ic out" aria-hidden="true">${ICON.globe}</span><b data-up>—</b><span>${L('direcciones funcionando', 'addresses working')}</span></div>
      <div class="own-tile ${overdue ? 'bad' : agencies.some((c) => c.next_charge) ? 'good' : ''}"><span class="ic" aria-hidden="true">${ICON.money}</span><b>${overdue}</b><span>${L('cobros atrasados', 'overdue charges')}</span></div>
      ${
        diskPct === null
          ? ''
          : `<div class="own-tile ${diskPct >= 95 ? 'bad' : diskPct >= 80 ? 'warn' : 'good'}"><span class="ic" aria-hidden="true">${ICON.disk}</span><b>${diskPct} %</b><span>${L('del disco', 'of the disk')} · ${gb(d.disk.used)} ${L('de', 'of')} ${gb(d.disk.total)}</span></div>`
      }
    </div>
    ${
      warnings.length
        ? `<section class="own-warn"><h2>Para mirar</h2><ul>${warnings.map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join('')}</ul></section>`
        : `<section class="own-warn calm-ok"><p>${ICON.check} ${L('Todo en orden: no hay nada para revisar.', 'All good: nothing to check.')}</p></section>`
    }
    <section class="own-dues">
      <div class="own-sec-head"><h2>Mis vencimientos</h2><button class="btn pill small" type="button" data-rem-new>${ICON.plus}Agregar</button></div>
      <p class="muted">Lo que tenés que pagar o renovar. Te avisamos en "Para mirar" 30 días antes, más fuerte a 7 días y en rojo si ya venció. Al marcarlo pagado, la fecha pasa sola al mes o al año siguiente.</p>
      <ul class="dues">${d.reminders.map(dueRow).join('') + agencyDues.map(agencyDueRow).join('') || `<li class="muted">${L('No hay vencimientos cargados.', 'No due dates yet.')}</li>`}</ul>
    </section>
    <section class="own-dues">
      <div class="own-sec-head"><h2>Mis gastos</h2><button class="btn pill small" type="button" data-expense-new>${ICON.plus}Agregar</button></div>
      <p class="muted">Lo que ya pagaste para sostener Floty.${expenseTotals ? ` Total: <b data-notr>${expenseTotals}</b>.` : ''} Cada moneda se suma por separado, sin convertir.</p>
      <ul class="dues">${d.expenses.map(expenseRow).join('') || '<li class="muted">No hay gastos cargados.</li>'}</ul>
    </section>
    <h2 class="own-sec-title">Agencias</h2>
    ${
      agencies.length
        ? `<div class="agencies">${agencies.map(card).join('')}</div>`
        : `<div class="card own-empty"><span class="agency-ic" aria-hidden="true">${ICON.building}</span><h2>Todavía no hay agencias</h2>
             <p class="muted">Cuando un cliente te compre Floty, tocá <b>Nueva agencia</b>: en un minuto tiene su dirección, su usuario y su contraseña.</p></div>`
    }
    <details class="own-help"><summary>¿Cómo funcionan las direcciones?</summary>
      <p>Cada agencia entra por su dirección de Floty${d.floty_domain ? `, por ejemplo <b data-notr>su-agencia.${esc(d.floty_domain)}</b>` : ''}. Se crea sola al dar de alta la agencia.</p>
      <p>Si la agencia quiere usar un dominio suyo (por ejemplo <b data-notr>reservas.suagencia.com.ar</b>): quien maneja ese dominio agrega un registro <b>CNAME</b> que apunte a Floty, vos lo cargás en <b>Dominio propio</b> y también en Render (Settings → Custom Domains). Puede tardar hasta 24 horas.</p>
      <p>Tu entrada a este panel es <b data-notr>${own && own.address ? host(own.address) : esc(location.host)}</b>.</p>
    </details>`;

  // Probar todas las direcciones al abrir: el estado aparece en cada tarjeta.
  let up = 0;
  const withAddress = agencies.filter((c) => c.address);
  const upEl = $('[data-up]', view);
  if (!withAddress.length) upEl.textContent = '—';
  const check = async (c) => {
    const box = $(`.agency[data-id="${c.id}"]`, view);
    const st = $('[data-status]', box);
    st.className = 'st wait';
    st.textContent = L('Revisando…', 'Checking…');
    const r = await POST(`/platform/companies/${c.id}/check`).catch((e) => ({ ok: false, reason: e.message }));
    st.className = `st ${r.ok ? 'ok' : 'bad'}`;
    st.textContent = r.ok ? L('Funciona', 'Working') : L('No responde', 'Not responding');
    st.title = r.ok ? `${r.ms} ms` : r.reason || `HTTP ${r.status}`;
    return r.ok;
  };
  // El número se pinta: rojo apenas una falla, verde cuando respondieron todas.
  let done = 0;
  withAddress.forEach((c) =>
    check(c).then((ok) => {
      done++;
      if (ok) up++;
      upEl.textContent = `${up} / ${withAddress.length}`;
      $('[data-up-tile]', view).classList.toggle('bad', up < done);
      $('[data-up-tile]', view).classList.toggle('good', done === withAddress.length && up === done);
    }),
  );

  const history = (list) =>
    list.length
      ? `<h3>Pagos anotados</h3><ul class="pay-history">${list.map((p) => `<li><b>${fmtD(p.paid_at)}</b> ${p.amount ? money(p.amount) : ''}${p.period ? ` <span class="muted">(${L('vencía', 'was due')} ${fmtD(p.period)})</span>` : ''}${p.note ? ` · ${esc(p.note)}` : ''}</li>`).join('')}</ul>`
      : '';
  // "Pagado": confirma el monto (se puede cambiar) y lo anota en el historial.
  const payDialog = (title, value, url, okMsg) =>
    openModal(
      title,
      formHtml(
        [
          { name: 'amount', label: 'Monto (opcional)', type: 'number' },
          { name: 'note', label: 'Nota (opcional)', attrs: 'placeholder="Transferencia, efectivo…"' },
        ],
        { amount: value ?? '' },
        'Marcar pagado',
      ),
      async (f) => {
        const r = await POST(url, f);
        route();
        toastUndo(okMsg, async () => {
          await run(() => POST(`/platform/payments/${r.payment_id}/undo`), 'Listo: quedó como estaba');
          route();
        });
      },
    );
  const ACCOUNT_FIELDS = [
    { name: 'contact_name', label: 'Responsable' },
    { name: 'contact_phone', label: 'WhatsApp o teléfono', attrs: 'placeholder="+54 9 2901 …"' },
    { name: 'notes', label: 'Notas', type: 'textarea', full: true, rows: 3, attrs: 'placeholder="Le prometí cargarle la flota…"' },
    { name: 'plan_price', label: 'Precio del plan (por mes)', type: 'number' },
    { name: 'billing_day', label: 'Día de cobro (1 a 31)', type: 'number', step: '1' },
    { name: 'next_charge', label: 'Próximo cobro', type: 'date' },
    { name: 'trial_ends', label: 'Fin de la prueba gratis', type: 'date' },
    { name: 'domain_expires', label: 'Su dominio propio vence el', type: 'date' },
    { name: 'cert_expires', label: 'Su certificado de factura (ARCA o SII) vence el', type: 'date' },
  ];
  // Datos de la agencia: nombre, tipo de negocio, logo y su administrador; y una contraseña nueva si la perdió.
  const openProfile = (c) => {
    let logo; // undefined = no se toca; '' = se quita; data URL = el nuevo
    openModal(
      `Datos de la agencia · ${c.name}`,
      `<div class="agency-logo-edit"><span class="agency-ic big" data-logo-preview>${c.logo ? `<img src="${esc(c.logo)}" alt="">` : ICON.building}</span>
        <div><label class="btn small">Elegir logo o foto<input type="file" accept="image/png,image/jpeg,image/webp" data-logo-file hidden></label>
        ${c.logo ? '<button type="button" class="btn small link" data-logo-remove>Quitar</button>' : ''}
        <p class="muted" style="margin:6px 0 0">Aparece en tu panel y arriba a la izquierda en el sistema de la agencia.</p></div></div>` +
        formHtml(
          [
            { name: 'name', label: 'Nombre de la agencia', required: true, full: true },
            { name: 'business_mode', label: 'Tipo de negocio', type: 'select', required: true, options: [['turismo', 'Alquiler turístico'], ['choferes', 'Autos para trabajo (choferes de apps)']] },
            { name: 'pay_modes', label: 'Modalidad de pago por auto: cada 24 o cada 12 horas (autos para trabajo, cobro por día)', type: 'checkbox', full: true },
            { name: 'pro_features', label: 'Funciones en prueba: precios por demanda, intervalo entre alquileres, firma, entrega express y tarjeta', type: 'checkbox', full: true },
            { name: 'admin_name', label: 'Nombre del administrador' },
            { name: 'admin_email', label: 'Email del administrador (con el que entra)', type: 'email', required: true, full: true },
          ],
          { name: c.name, business_mode: c.business_mode || 'turismo', pay_modes: c.pay_modes || 0, pro_features: c.pro_features || 0, admin_name: c.admin_name || '', admin_email: c.admin_email || '' },
          'Guardar',
        ) +
        `<div class="card" style="margin-top:14px"><b>¿El administrador no puede entrar?</b>
          <p class="muted" style="margin:4px 0 8px">Le damos una contraseña inicial nueva. La anterior deja de servir y, al entrar, elige una propia.</p>
          <button type="button" class="btn small" data-reset-pw>Darle una contraseña nueva</button></div>
        <div class="card" style="margin-top:14px"><b>Ejemplo para presentar</b>
          <p class="muted" style="margin:4px 0 8px">Carga una agencia de Panamá ficticia donde el mismo auto sube de precio según la disponibilidad. Solo funciona en una agencia vacía.</p>
          <button type="button" class="btn small" data-demand-example>Ver el ejemplo de precios</button></div>`,
      async (f) => {
        await run(() => PUT(`/platform/companies/${c.id}/profile`, { ...f, ...(logo !== undefined ? { logo } : {}) }), 'Datos de la agencia guardados');
        route();
      },
    );
    const preview = $('#modal [data-logo-preview]');
    $('#modal [data-logo-file]').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        logo = await logoDataUrl(file);
        preview.innerHTML = `<img src="${logo}" alt="">`;
      } catch {
        toast('No se pudo leer esa imagen. Probá con un PNG o un JPG.', true);
      }
    });
    $('#modal [data-logo-remove]')?.addEventListener('click', () => {
      logo = '';
      preview.innerHTML = ICON.building;
    });
    $('#modal [data-demand-example]').addEventListener('click', async () => {
      const ex = await run(() => POST(`/platform/companies/${c.id}/demand-example`));
      if (!ex) return;
      const fmt = (n, cur) => new Intl.NumberFormat('es-PA', { style: 'currency', currency: cur }).format(n);
      const sep = ex.booking_url.includes('?') ? '&' : '?';
      openModal(
        `Precios según disponibilidad · ${c.name}`,
        `<p class="muted">El mismo ${esc(ex.scenarios[0].category)}, ${ex.scenarios[0].days} días. Tocá cada fila para abrir el cotizador en esas fechas.</p>
        <div class="demand-rows">${ex.scenarios
          .map(
            (s) => `<a class="demand-row" target="_blank" rel="noopener" href="${esc(`${ex.booking_url}${sep}desde=${s.pickup_at.slice(0, 10)}&dias=${s.days}`)}">
              <span><b>${esc(s.label)}</b><small>${fmtD(s.pickup_at)} · ${s.booked} de ${s.fleet} reservados</small></span>
              <span class="demand-price"><b>${esc(fmt(s.total, s.currency))}</b><small class="${s.pct ? 'up' : ''}">${s.pct ? `+${s.pct}%` : 'Precio normal'}</small></span>
            </a>`,
          )
          .join('')}</div>`,
      );
    });
    $('#modal [data-reset-pw]').addEventListener('click', async () => {
      if (!(await confirmModal({ title: `Contraseña nueva · ${c.name}`, text: `El administrador (${c.admin_email}) va a tener que entrar con la contraseña nueva. La anterior deja de servir.`, ok: 'Darle una nueva' }))) return;
      const r = await run(() => POST(`/platform/companies/${c.id}/reset-password`));
      if (r) setTimeout(() => showCredentials('Contraseña nueva', `Pasale estos datos al administrador de <b>${esc(c.name)}</b>.`, r.address, r.email, r.password));
    });
  };
  const openAccount = (c) =>
    openModal(
      `Ficha y abono · ${c.name}`,
      formHtml(ACCOUNT_FIELDS, c, 'Guardar') +
        '<p class="muted">Floty no cobra nada solo: esto es para que lleves la cuenta. El certificado de factura se carga a mano (vence una vez por año o cada dos, según cómo lo haya sacado la agencia).</p>' +
        history(c.payments),
      async (f) => {
        await run(() => PUT(`/platform/companies/${c.id}/account`, f), 'Ficha guardada');
        route();
      },
    );
  const openReminder = (r) => {
    openModal(
      r ? `Editar · ${r.title}` : 'Nuevo vencimiento',
      formHtml(
        [
          { name: 'title', label: 'Qué hay que pagar o renovar', required: true, full: true, attrs: 'placeholder="Dominio, servidor, contador…"' },
          { name: 'due_date', label: 'Vence el', type: 'date' },
          { name: 'repeat', label: 'Se repite', type: 'select', required: true, options: Object.entries(REPEAT_LABEL) },
          { name: 'amount', label: 'Monto (opcional)', type: 'number' },
          { name: 'note', label: 'Nota (opcional)', full: true },
        ],
        r || { repeat: 'anual' },
        'Guardar',
      ) +
        (r ? `<div class="actions" style="margin-top:12px"><button class="btn danger small" type="button" data-rem-del>Borrar este vencimiento</button></div>${history(r.payments)}` : ''),
      async (f) => {
        await run(() => (r ? PUT(`/platform/reminders/${r.id}`, f) : POST('/platform/reminders', f)), 'Vencimiento guardado');
        route();
      },
    );
    $('#modal [data-rem-del]')?.addEventListener('click', async () => {
      if (!(await confirmModal({ title: `Borrar "${r.title}"`, text: 'Se borra de tus vencimientos junto con su historial de pagos.', ok: 'Borrar', danger: true }))) return;
      await run(() => DEL(`/platform/reminders/${r.id}`), 'Vencimiento borrado');
      closeModal();
      route();
    });
  };
  const openExpense = (x) => {
    openModal(
      x ? `Editar · ${x.concept}` : 'Nuevo gasto',
      formHtml(
        [
          { name: 'paid_on', label: 'Fecha del pago', type: 'date', required: true },
          { name: 'concept', label: 'Qué pagaste', required: true, attrs: 'placeholder="Servidor, dominio, publicidad…"' },
          { name: 'amount', label: 'Monto', type: 'number', required: true },
          { name: 'currency', label: 'Moneda', type: 'select', required: true, options: [['ARS', 'Pesos (ARS)'], ['USD', 'Dólares (USD)']] },
          { name: 'note', label: 'Nota (opcional)', full: true },
        ],
        x || { currency: 'USD' },
        'Guardar',
      ) + (x ? '<div class="actions" style="margin-top:12px"><button class="btn danger small" type="button" data-expense-del>Borrar este gasto</button></div>' : ''),
      async (f) => {
        await run(() => (x ? PUT(`/platform/expenses/${x.id}`, f) : POST('/platform/expenses', f)), 'Gasto guardado');
        route();
      },
    );
    $('#modal [data-expense-del]')?.addEventListener('click', async () => {
      if (!(await confirmModal({ title: `Borrar "${x.concept}"`, text: 'Se borra de tus gastos.', ok: 'Borrar', danger: true }))) return;
      await run(() => DEL(`/platform/expenses/${x.id}`), 'Gasto borrado');
      closeModal();
      route();
    });
  };
  $('[data-expense-new]', view).addEventListener('click', () => openExpense(null));
  $$('[data-expense]', view).forEach((li) => {
    $('[data-expense-edit]', li).addEventListener('click', () => openExpense(d.expenses.find((x) => x.id === Number(li.dataset.expense))));
  });
  $('[data-rem-new]', view).addEventListener('click', () => openReminder(null));
  $$('[data-rem]', view).forEach((li) => {
    const r = d.reminders.find((x) => x.id === Number(li.dataset.rem));
    $('[data-rem-edit]', li).addEventListener('click', () => openReminder(r));
    $('[data-rem-paid]', li)?.addEventListener('click', () => payDialog(`Pagado · ${r.title}`, r.amount, `/platform/reminders/${r.id}/paid`, 'Anotado como pagado'));
  });
  $$('[data-account-of]', view).forEach((b) => b.addEventListener('click', () => openAccount(agencies.find((x) => x.id === Number(b.dataset.accountOf)))));

  $$('.agency', view).forEach((box) => {
    const c = agencies.find((x) => x.id === Number(box.dataset.id));
    $('[data-account]', box).addEventListener('click', () => openAccount(c));
    $('[data-profile]', box).addEventListener('click', () => openProfile(c));
    $('[data-remove]', box).addEventListener('click', async () => {
      const text = `${c.name} deja de poder entrar al sistema y sale de tu panel. Sus datos no se borran: quedan guardados en el servidor.`;
      if (!(await confirmModal({ title: `Eliminar · ${c.name}`, text, ok: 'Eliminar agencia', danger: true }))) return;
      if (await run(() => DEL(`/platform/companies/${c.id}`), 'Agencia eliminada')) route();
    });
    $('[data-charge]', box)?.addEventListener('click', () => payDialog(`Abono pagado · ${c.name}`, c.plan_price, `/platform/companies/${c.id}/paid`, 'Cobro anotado'));
    $('[data-check]', box).addEventListener('click', () => (c.address ? check(c) : toast(L('Esta agencia todavía no tiene dirección.', 'This agency has no address yet.'), true)));
    $('[data-copy]', box)?.addEventListener('click', (e) =>
      (navigator.clipboard ? navigator.clipboard.writeText(e.currentTarget.dataset.copy) : Promise.reject()).then(() => toast('Copiado'), () => toast('Seleccioná el texto y copialo', true)),
    );
    $('[data-domain]', box).addEventListener('click', () =>
      openModal(
        `Dominio propio · ${c.name}`,
        formHtml([{ name: 'domain', label: 'Dominio (vacío = sin dominio propio)', full: true, attrs: 'placeholder="reservas.suagencia.com.ar"' }], { domain: c.domain || '' }) +
          '<p class="muted">Primero, quien maneja el dominio (en NIC.ar si es .com.ar, o donde lo haya comprado) agrega un registro <b>CNAME</b> que apunte a la dirección de Floty. Después se carga acá y en Render (Settings → Custom Domains). Puede tardar hasta 24 horas en funcionar.</p>',
        async (f) => {
          await run(() => PUT(`/platform/companies/${c.id}/domain`, { domain: f.domain }), 'Dominio guardado');
          route();
        },
      ),
    );
  });

  $('[data-new]', view).addEventListener('click', () =>
    openModal(
      'Nueva agencia',
      formHtml(
        [
          { name: 'name', label: 'Nombre de la agencia', required: true, full: true },
          { name: 'country', label: 'País', type: 'select', options: Object.entries(state.settings.country_presets || { AR: { name: 'Argentina' } }).map(([k, p]) => [k, p.name]), required: true },
          { name: 'business_mode', label: 'Tipo de negocio', type: 'select', required: true, options: [['turismo', 'Alquiler turístico'], ['choferes', 'Autos para trabajo (choferes de apps)']] },
          { name: 'admin_name', label: 'Nombre del administrador', required: true },
          { name: 'admin_email', label: 'Email del administrador', type: 'email', required: true, full: true },
        ],
        { country: 'AR', business_mode: 'turismo' },
        'Crear agencia',
      ) + '<p class="muted">Se crea vacía, con los datos del país elegido, y con su dirección propia. Te mostramos una contraseña inicial para pasarle al administrador: la cambia en su primer ingreso.</p>',
      async (f) => {
        const r = await POST('/platform/companies', f);
        // La contraseña se muestra una sola vez: no queda guardada en ningún lado.
        setTimeout(() => showCredentials('Agencia creada', `<b>${esc(r.company.name)}</b> ya está lista. Pasale estos datos al administrador.`, r.company.address, r.admin.email, r.admin.password));
        route();
      },
    ),
  );
}, 'empresas');

/** Usuario y contraseña inicial de una agencia, con botón para copiar (se muestran una sola vez). */
function showCredentials(title, intro, address, email, password) {
  openModal(
    title,
    `<p>${intro} La contraseña mandala aparte (en persona, por llamada o en otro mensaje).</p>
     <dl class="info"><dt>Dirección</dt><dd data-notr>${esc(address || location.origin)}</dd><dt>Usuario</dt><dd data-notr><b>${esc(email)}</b></dd>
       <dt>Contraseña inicial</dt><dd data-notr><code style="font-size:18px;letter-spacing:.06em">${esc(password)}</code> <button type="button" class="btn small" data-copy-pw>Copiar</button></dd></dl>
     <p class="muted">No tiene letras que se confundan (como I y l, u O y 0). Esta contraseña no se vuelve a mostrar: al entrar, la app le pide elegir una propia.</p>
     <div class="actions"><button class="btn primary" data-close>Listo</button></div>`,
  );
  $('#modal [data-copy-pw]').addEventListener('click', () =>
    (navigator.clipboard ? navigator.clipboard.writeText(password) : Promise.reject()).then(() => toast('Contraseña copiada'), () => toast('Seleccioná la contraseña y copiala', true)),
  );
}

/** Logo de una agencia: se achica a 256 px en el navegador y se guarda como imagen dentro de su configuración. */
async function logoDataUrl(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  // PNG mantiene el fondo transparente de los logos; las fotos van en JPG, que pesa menos.
  return file.type === 'image/png' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
}

/* ============================================================
   Importar datos de sistemas anteriores (sólo administradores)
   ============================================================ */
const IMPORT_KINDS = [
  { key: 'flota', label: '1 · Flota', hint: 'Patente, marca, modelo, año, categoría, estado, km, vencimientos de seguro y VTV.' },
  { key: 'clientes', label: '2 · Clientes', hint: 'Nombre, documento, email, teléfono, domicilio, licencia, fecha de nacimiento.' },
  { key: 'reservas', label: '3 · Reservas', hint: 'Cliente, fechas y horas de entrega y devolución, patente o categoría, estado, total y seña.' },
];
const IMPORT_ACTION = {
  creado: ['Nuevo', 'b-en_curso'],
  actualizado: ['Actualizado', 'b-confirmada'],
  sin_cambios: ['Sin cambios', 'b-finalizada'],
  omitido: ['Ya existía', 'b-finalizada'],
  error: ['Error', 'b-error'],
};

/** Lee el archivo como texto: las planillas de Google vienen en UTF-8; las de Excel a veces en Windows-1252. */
async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

on(/^\/importar$/, async (view) => {
  if (!isAdmin()) {
    view.innerHTML = '<div class="card"><p class="muted">Sólo los administradores pueden importar datos.</p></div>';
    return;
  }
  const st = { kind: 'flota', text: '', fileName: '', analysis: null };
  view.innerHTML = `<div class="page-head"><h1>Importar datos</h1></div>
    <div class="card import-intro">
      <p>Pasá acá lo que tenían en el Drive y en el sistema anterior. Conviene seguir este orden: <b>primero la flota, después los clientes y al final las reservas</b> (así cada reserva encuentra su auto y su cliente).</p>
      <details><summary>¿Cómo saco los datos de la planilla?</summary>
        <ul>
          <li><b>Google Drive (Hojas de cálculo):</b> abrí la planilla → <i>Archivo</i> → <i>Descargar</i> → <i>Valores separados por comas (.csv)</i>. Si tiene varias pestañas, descargá cada una.</li>
          <li><b>Excel:</b> <i>Archivo</i> → <i>Guardar como</i> → tipo <i>CSV UTF-8</i>.</li>
          <li><b>Otra página o sistema:</b> buscá un botón "Exportar" / "Descargar Excel". Si no tiene, seleccioná la tabla con el mouse, copiala y pegala abajo.</li>
          <li>También podés <b>copiar las celdas</b> directo de la planilla (incluida la fila de títulos) y pegarlas en el cuadro de texto.</li>
        </ul>
      </details>
      <p class="muted">Los datos se procesan en este sistema y no se envían a ningún otro lado. El archivo no se guarda: sólo los registros importados. Después de importar, borrá el archivo descargado de tu computadora y dejá de compartir la planilla vieja.</p>
    </div>
    <div class="seg import-kinds">${IMPORT_KINDS.map((k) => `<button type="button" class="btn${k.key === st.kind ? ' primary' : ''}" data-kind="${k.key}">${k.label}</button>`).join('')}</div>
    <div class="card">
      <p class="muted" id="imp-hint"></p>
      <div class="form-grid">
        <label class="full">Archivo CSV<input type="file" id="imp-file" accept=".csv,.tsv,.txt,text/csv,text/plain"></label>
        <label class="full">…o pegá acá las celdas copiadas<textarea id="imp-paste" rows="5" placeholder="Copiá de la planilla las columnas con sus títulos y pegalas acá"></textarea></label>
      </div>
      <div class="actions" style="margin-top:14px"><button class="btn primary" id="imp-analyze" type="button">Leer datos</button></div>
    </div>
    <div id="imp-step2"></div>
    <div id="imp-report"></div>`;

  const setKind = (kind) => {
    st.kind = kind;
    st.analysis = null;
    $$('[data-kind]', view).forEach((b) => b.classList.toggle('primary', b.dataset.kind === kind));
    $('#imp-hint').textContent = `Columnas que se reconocen: ${IMPORT_KINDS.find((k) => k.key === kind).hint} Las columnas pueden tener otros nombres: después podés corregir cuál es cuál.`;
    $('#imp-step2').innerHTML = '';
    $('#imp-report').innerHTML = '';
  };
  $$('[data-kind]', view).forEach((b) => b.addEventListener('click', () => setKind(b.dataset.kind)));
  setKind(st.kind);

  $('#imp-analyze').addEventListener('click', async () => {
    const file = $('#imp-file').files[0];
    const pasted = $('#imp-paste').value;
    try {
      if (file) {
        if (/\.(xlsx?|ods|numbers)$/i.test(file.name)) throw new Error('Ese archivo es de Excel/Hojas de cálculo: guardalo como CSV (ver "¿Cómo saco los datos?") o copiá y pegá las celdas.');
        if (file.size > 5 * 1024 * 1024) throw new Error('El archivo pesa más de 5 MB: dividilo en partes.');
        st.text = await readTextFile(file);
        st.fileName = file.name;
      } else if (pasted.trim()) {
        st.text = pasted;
        st.fileName = 'datos pegados';
      } else throw new Error('Elegí un archivo o pegá los datos');
      st.analysis = await POST('/import/analyze', { kind: st.kind, text: st.text });
      renderMapping();
    } catch (e) {
      toast(e.message, true);
    }
  });

  function renderMapping() {
    const a = st.analysis;
    const opt = (sel) => `<option value="">— no está —</option>${a.headers.map((h, i) => `<option value="${i}"${sel === i ? ' selected' : ''}>${esc(h)}</option>`).join('')}`;
    const needsCategory = st.kind !== 'clientes';
    $('#imp-step2').innerHTML = `<div class="card" style="margin-top:16px">
      <h2>¿Qué es cada columna?</h2>
      <p class="muted">${esc(st.fileName)} · ${plural(a.total_rows, 'fila', 'filas')}. Revisá lo que reconoció el sistema y corregí lo que haga falta.</p>
      <div class="form-grid">${a.fields
        .map((f) => `<label>${esc(f.label)}${f.required ? ' *' : ''}<select data-map="${f.key}">${opt(a.mapping[f.key])}</select></label>`)
        .join('')}</div>
      <h3 style="margin-top:18px">Primeras filas</h3>
      <div class="table-wrap table-scroll"><table><thead><tr>${a.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${a.preview
        .map((r) => `<tr>${a.headers.map((_, i) => `<td class="nowrap">${esc(r[i] || '')}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></div>
      <div class="form-grid" style="margin-top:18px">
        ${
          st.kind === 'reservas'
            ? ''
            : `<label>Si ya estaba cargado<select id="imp-mode"><option value="completar">Completar sólo los datos que faltan</option><option value="reemplazar">Reemplazar con los datos del archivo</option><option value="omitir">No tocarlo</option></select></label>`
        }
        ${
          needsCategory
            ? `<label>Categoría por defecto (si falta o no se reconoce)<select id="imp-cat"><option value="">— ninguna —</option>${(state.categories || [])
                .map((c) => `<option value="${c.id}">${esc(c.code)} · ${esc(c.name)}</option>`)
                .join('')}</select></label>`
            : ''
        }
        <label class="check full"><input type="checkbox" id="imp-extra" checked> Guardar las columnas que no tienen lugar en "Observaciones" (para no perder nada)</label>
      </div>
      <p class="muted">${
        st.kind === 'reservas'
          ? 'Las reservas que ya se importaron antes (mismo número, o mismo cliente y fechas) se saltean, así que podés volver a importar el archivo sin duplicar. Los clientes que no estén cargados se crean.'
          : 'Los registros repetidos se detectan solos (clientes por documento, email o teléfono; autos por patente), así que podés volver a importar sin duplicar.'
      }</p>
      <div class="actions" style="margin-top:14px"><button class="btn" id="imp-test" type="button">Probar (no guarda nada)</button><button class="btn primary" id="imp-run" type="button">Importar</button></div>
    </div>`;
    $('#imp-test').addEventListener('click', () => run(true));
    $('#imp-run').addEventListener('click', () => run(false));
  }

  async function run(dryRun) {
    const mapping = {};
    $$('[data-map]', view).forEach((s) => {
      if (s.value !== '') mapping[s.dataset.map] = Number(s.value);
    });
    const options = {
      dry_run: dryRun,
      mode: $('#imp-mode') ? $('#imp-mode').value : undefined,
      default_category_id: $('#imp-cat') ? $('#imp-cat').value || null : null,
      keep_extra: $('#imp-extra').checked,
    };
    if (!dryRun && !(await confirmModal({ title: 'Importar los datos', text: `Se cargan ${plural(st.analysis.total_rows, 'fila', 'filas')} de ${IMPORT_KINDS.find((k) => k.key === st.kind).label.slice(4)}. Revisá antes la prueba: lo que se importa no se deshace solo.`, ok: 'Importar', danger: true }))) return;
    const buttons = $$('#imp-test, #imp-run', view);
    buttons.forEach((b) => (b.disabled = true));
    try {
      const r = await POST('/import/run', { kind: st.kind, text: st.text, mapping, options });
      renderReport(r);
      if (!dryRun) {
        toast('Importación terminada');
        $('#imp-file').value = '';
        $('#imp-paste').value = '';
      }
    } catch (e) {
      toast(e.message, true);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  function renderReport(r) {
    const c = r.counts;
    const pill = (n, label, cls) => `<div class="imp-count ${cls}"><b>${n}</b><span>${label}</span></div>`;
    const issues = r.rows.filter((x) => x.action === 'error' || x.messages.length);
    const rowHtml = (x) => {
      const [label, cls] = IMPORT_ACTION[x.action] || [x.action, ''];
      return `<tr><td class="nowrap">Fila ${x.line}</td><td><span class="badge ${cls}">${label}</span></td><td>${esc(x.label)}</td><td><small>${x.messages.map(esc).join('<br>')}</small></td></tr>`;
    };
    $('#imp-report').innerHTML = `<div class="card" style="margin-top:16px">
      <h2>${r.dry_run ? 'Prueba: así quedaría (todavía no se guardó nada)' : 'Resultado de la importación'}</h2>
      <div class="imp-counts">${pill(c.creado, r.dry_run ? 'se crearían' : 'nuevos', 'ok')}${pill(c.actualizado, r.dry_run ? 'se actualizarían' : 'actualizados', 'info')}${pill(c.omitido + c.sin_cambios, 'ya estaban', '')}${pill(c.error, 'con error', c.error ? 'bad' : '')}${pill(r.warnings, 'avisos', r.warnings ? 'warn' : '')}</div>
      ${
        r.dry_run
          ? `<p class="muted">${c.error ? 'Las filas con error no se van a importar: corregilas en la planilla y volvé a leer el archivo, o importá igual y cargalas a mano.' : 'Si está todo bien, tocá <b>Importar</b>.'}</p>`
          : `<p class="muted">Quedó registrado en la actividad de Usuarios. ${st.kind === 'reservas' ? 'Las reservas importadas dicen "importado" como origen.' : ''}</p>`
      }
      ${
        issues.length
          ? `<h3>Filas para revisar (${issues.length})</h3><div class="table-wrap table-scroll"><table><thead><tr><th>Fila</th><th>Resultado</th><th>Registro</th><th>Detalle</th></tr></thead><tbody>${issues.map(rowHtml).join('')}</tbody></table></div>`
          : '<p>Ninguna fila tiene avisos.</p>'
      }
      <details style="margin-top:12px"><summary>Ver todas las filas (${r.rows.length})</summary><div class="table-wrap table-scroll"><table><tbody>${r.rows.map(rowHtml).join('')}</tbody></table></div></details>
    </div>`;
    $('#imp-report').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}, 'importar');

/* ============================================================
   Link de reservas (y el chat para pegar en la página web de la agencia)
   ============================================================ */
function loadChatScript() {
  if (window.RentChat) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = '/chat.js';
    sc.setAttribute('data-manual', '1');
    sc.onload = resolve;
    sc.onerror = () => reject(new Error('No se pudo cargar el asistente'));
    document.head.append(sc);
  });
}

on(/^\/asistente$/, async (view) => {
  if (!isAdmin()) {
    view.innerHTML = '<div class="card"><p class="muted">Sólo los administradores configuran el link de reservas.</p></div>';
    return;
  }
  const s = await GET('/settings');
  // En una instalación con varias empresas, el link y el código llevan la empresa (salvo la principal).
  const co = state.user.company;
  const empresa = co && !co.principal ? co.slug : '';
  const link = clientLink('reservar');
  const share = `https://wa.me/?text=${encodeURIComponent(`${L('Reservá tu auto acá', 'Book your car here')}: ${link}`)}`;
  const snippet = `<script src="${location.origin}/chat.js"${empresa ? ` data-empresa="${empresa}"` : ''} async></script>`;
  const copy = (text) =>
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Copiado'), () => toast('Seleccioná el texto y copialo', true));
  view.innerHTML = `<div class="page-head"><h1>Link de reservas</h1></div>
    <div class="grid cols-2">
      <div class="card">
        <h2>Tu link</h2>
        <p class="muted">Es opcional: sirve si tu agencia no tiene reservas por internet. Si ya tenés tu página o tu link de reservas, dejalo apagado y conectá tu página en <a href="#/cotizador">Página web: formulario</a>.</p>
        <p class="muted">Ponelo en la biografía de Instagram y mandalo por WhatsApp. El cliente elige las fechas, ve los autos libres con su precio y pide la reserva. Te aparece en Hoy, en "Para confirmar".</p>
        <input id="link-url" readonly value="${esc(link)}" data-notr/>
        <div class="actions" style="margin-top:10px">
          <button class="btn primary" type="button" id="copy-link">Copiar el link</button>
          <a class="btn" href="${esc(link)}" target="_blank" rel="noopener">Abrir</a>
          <a class="btn" href="${esc(share)}" target="_blank" rel="noopener">${WA_ICON}Compartir por WhatsApp</a>
        </div>
        ${s.chat_enabled === '1' ? '' : '<p class="notice warn" style="margin-top:12px">El link está apagado: activalo abajo y guardá.</p>'}
      </div>
      <div class="card">
        <h2>Lo que ve el cliente</h2>
        <form id="chat-form" class="form-grid">
          <label class="check full"><input type="checkbox" name="chat_enabled" ${s.chat_enabled === '1' ? 'checked' : ''}/> Link de reservas activado</label>
          <label class="full">Mensaje de bienvenida<input name="chat_welcome" maxlength="300" placeholder="¡Hola! Elegí las fechas y te mostramos los autos libres." value="${esc(s.chat_welcome || '')}"/></label>
          <label class="full">WhatsApp de la agencia (con código de país, ej. 5492901123456)<input name="chat_whatsapp" maxlength="30" value="${esc(s.chat_whatsapp || '')}"/></label>
          <label class="full">Preguntas frecuentes (una por línea: Pregunta | Respuesta)<textarea name="chat_faq" rows="7">${esc(s.chat_faq || s.chat_faq_default || '')}</textarea></label>
          <div class="actions full"><button class="btn primary" type="submit">Guardar</button></div>
        </form>
      </div>
    </div>
    <details class="card" id="chat-web" style="margin-top:16px">
      <summary>Si tenés página web: un chat de reservas para pegar en ella</summary>
      <p class="muted">Hace lo mismo que el link, pero adentro de tu página. Quien administra la página tiene que pegar esta línea antes de <code>&lt;/body&gt;</code>:</p>
      <pre class="snippet">${esc(snippet)}</pre>
      <div class="actions"><button class="btn" type="button" id="copy-snippet">Copiar</button></div>
      <p class="muted">La dirección de la página tiene que estar en <a href="#/cotizador">Cotizador web → sitios autorizados</a>. Opcional: <code>data-color="#0a7"</code> cambia el color del botón.</p>
      <h3>Vista previa</h3>
      <p class="muted">Las reservas que pidas acá entran de verdad como pendientes.</p>
      <div id="chat-preview"></div>
    </details>`;
  $('#copy-link', view).addEventListener('click', () => copy(link));
  $('#copy-snippet', view).addEventListener('click', () => copy(snippet));
  const details = $('#chat-web', view);
  const preview = async () => {
    const box = $('#chat-preview', view);
    if (!details.open) return;
    box.replaceChildren();
    if (s.chat_enabled !== '1') {
      box.innerHTML = '<p class="muted">Activá el link de reservas y guardá para verlo.</p>';
      return;
    }
    try {
      await loadChatScript();
      const host = document.createElement('div');
      box.append(host);
      window.RentChat.mount(host, { base: '' });
    } catch (e) {
      box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  };
  details.addEventListener('toggle', preview);
  $('#chat-form', view).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    f.chat_enabled = f.chat_enabled ? '1' : '0';
    await run(() => PUT('/settings', f), 'Link de reservas guardado');
    route(); // vuelve a dibujar la pantalla (el aviso de apagado y la vista previa)
  });
}, 'asistente');

/* ============================================================
   Páginas públicas (sin usuario): el link de reservas y la hoja "Cómo funciona"
   ============================================================ */
function publicPage(html) {
  document.body.classList.add('public-mode');
  const page = document.createElement('main');
  page.className = 'pub';
  page.innerHTML = html;
  page.appendChild(languageSwitch());
  document.body.appendChild(page);
  return page;
}

/** /reservar[?empresa=slug]: la página que la agencia pone en Instagram y manda por WhatsApp. */
async function bookingPage() {
  const empresa = new URLSearchParams(location.search).get('empresa');
  const call = async (method, p, body) => {
    const res = await fetch(`/api/public/chat${p}${empresa ? `?empresa=${encodeURIComponent(empresa)}` : ''}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  };
  let cfg;
  try {
    cfg = await call('GET', '/config');
  } catch {
    publicPage('<div class="card pub-done"><h1>Reservas</h1><p class="muted">Este link de reservas no está disponible por ahora.</p></div>');
    return;
  }
  Object.assign(state.settings, { currency: cfg.currency, locale: cfg.locale });
  document.title = `${cfg.company} · ${L('Reservas', 'Bookings')}`;
  const t = new Date();
  let from = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 10, 0);
  let to = addDays(from, 3);
  // Se puede entrar con las fechas elegidas (?desde=AAAA-MM-DD&dias=3): así otro cotizador o un aviso pueden mandar directo acá.
  const wanted = new URLSearchParams(location.search);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(wanted.get('desde') || '') ? new Date(`${wanted.get('desde')}T10:00`) : null;
  if (start && !Number.isNaN(start.getTime()) && start >= new Date(t.getFullYear(), t.getMonth(), t.getDate())) {
    from = start;
    to = addDays(from, Math.min(90, Math.max(1, Number(wanted.get('dias')) || 3)));
  }
  const picked = new Set();
  let options = [];
  let pick = null;
  const QUICK = [
    [1, '1 día'],
    [3, '3 días'],
    [7, '1 semana'],
  ];
  const placeSelect = (name, label) =>
    `<label class="qr-field">${label}<select name="${name}">${cfg.branches.map((b) => `<option value="${esc(b.code)}">${esc(b.name)}</option>`).join('')}</select></label>`;
  const extraPrice = (x) => `${money(x.price)}${x.charge_type === 'fijo' ? '' : ` ${L('por día', 'per day')}`}`;
  const page = publicPage(`
    <header class="pub-head quoter-head"><h1>${esc(cfg.company)}</h1><p>${esc(cfg.welcome)}</p></header>
    <form class="qr quoter" id="bk" novalidate>
      <section class="quoter-step">
        <h2><span>1</span>${L('¿Cuándo y dónde?', 'When and where?')}</h2>
        <div class="qr-dates">
          <label class="qr-field">${L('Retiro', 'Pick-up')}<input type="datetime-local" name="from" required></label>
          <label class="qr-field">${L('Devolución', 'Return')}<input type="datetime-local" name="to" required></label>
        </div>
        <div class="chips">${QUICK.map(([n, label]) => `<button type="button" class="chip" data-days="${n}">${label}</button>`).join('')}</div>
        ${cfg.branches.length > 1 ? `<div class="qr-dates" style="margin-top:8px">${placeSelect('branch', L('Lugar de retiro', 'Pick-up place'))}${placeSelect('return_branch', L('Lugar de devolución', 'Return place'))}</div>` : ''}
      </section>
      <section class="quoter-step">
        <h2><span>2</span>${L('Elegí el auto', 'Choose your car')}</h2>
        <div class="cars" id="bk-cars" aria-live="polite"><div class="car-skeleton"></div><div class="car-skeleton"></div></div>
      </section>
      ${
        cfg.extras.length
          ? `<section class="quoter-step">
        <h2><span>3</span>${L('Sumá lo que necesites', 'Add what you need')} <small class="muted">${L('opcional', 'optional')}</small></h2>
        <div class="quoter-extras">${cfg.extras
          .map(
            (x) => `<label class="quoter-extra"><input type="checkbox" value="${esc(x.code)}" data-extra data-kind="${esc(x.kind)}"><span>${esc(x.name)}</span><small>${extraPrice(x)}</small></label>`,
          )
          .join('')}</div>
      </section>`
          : ''
      }
      <section class="quoter-step">
        <h2><span>${cfg.extras.length ? 4 : 3}</span>${L('Tus datos', 'Your details')}</h2>
        <div style="display:flex;flex-direction:column;gap:8px">
          <label class="qr-field">${L('Nombre y apellido', 'Full name')}<input name="name" autocomplete="name" maxlength="120" required></label>
          <label class="qr-field">${L('WhatsApp (con código de país)', 'WhatsApp (with country code)')}<input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="40" placeholder="${esc(cfg.phone_hint)}" required></label>
          <label class="qr-field">${L('Email (opcional)', 'Email (optional)')}<input name="email" type="email" autocomplete="email" maxlength="160"></label>
          <label class="trap" aria-hidden="true">No completar<input name="_gotcha" tabindex="-1" autocomplete="off"></label>
        </div>
      </section>
      <div class="qr-total">
        <div class="sum"><span class="muted" id="bk-what">${L('Elegí un auto', 'Choose a car')}</span><b id="bk-sum"></b></div>
        <button class="btn primary big" type="submit">${L('Pedir la reserva', 'Request booking')}</button>
        <small class="muted">${L('No pagás nada ahora. La agencia te confirma por WhatsApp.', 'You pay nothing now. The agency confirms by WhatsApp.')}</small>
      </div>
    </form>
    ${
      cfg.faq.length
        ? `<section class="pub-faq"><h2>Preguntas frecuentes</h2>${cfg.faq.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</section>`
        : ''
    }`);
  const form = $('#bk', page);
  const days = () => Math.max(1, Math.round((to - from) / 86400000));
  const set = () => {
    form.from.value = localISO(from);
    form.to.value = localISO(to);
    form.from.min = localISO(new Date(t.getFullYear(), t.getMonth(), t.getDate()));
    $$('.chip', form).forEach((c) => c.classList.toggle('on', Number(c.dataset.days) === Math.round((to - from) / 86400000)));
  };
  const dayWord = (n) => (n === 1 ? L('día', 'day') : L('días', 'days'));
  const summary = () => {
    const o = options.find((x) => x.code === pick);
    $('#bk-what', form).textContent = o ? `${o.name} · ${o.days} ${dayWord(o.days)}` : L('Elegí un auto', 'Choose a car');
    $('#bk-sum', form).textContent = o ? money(o.total) : '';
  };
  const paint = () => {
    if (!options.some((o) => o.code === pick)) pick = null;
    $('#bk-cars', form).innerHTML = options.length
      ? options
          .map((o) => {
            const info = [o.description, o.seats ? `${o.seats} ${L('asientos', 'seats')}` : ''].filter(Boolean).join(' · ');
            return `<button type="button" class="car${o.code === pick ? ' on' : ''}" data-cat="${esc(o.code)}" aria-pressed="${o.code === pick}">
              <span class="car-info"><b>${esc(o.name)}</b>${info ? `<small>${esc(info)}</small>` : ''}${
                o.promo || o.high_demand || o.few_left
                  ? `<span class="car-tags">${o.promo ? `<i class="tag-promo">${esc(o.promo.name)}</i>` : ''}${o.high_demand ? `<i class="tag-demand">${L('Alta demanda', 'High demand')}</i>` : ''}${o.few_left ? `<i class="tag-few">${L('Último disponible', 'Last one left')}</i>` : ''}</span>`
                  : ''
              }</span>
              <span class="price">${o.promo ? `<s class="price-before">${money(o.promo.before_total)}</s>` : ''}${money(o.total)}<small class="muted">${money(o.total / o.days)} ${L('por día', 'per day')}</small></span>
            </button>`;
          })
          .join('')
      : '<p class="hoy-empty">No quedan autos libres en esas fechas. Probá con otras.</p>';
    summary();
  };
  // Disponibilidad y precio de cada categoría (al público nunca se le dice cuántos autos quedan).
  let lastLoad = 0;
  const load = async () => {
    // Si el cliente cambia algo mientras carga, vale la última consulta: una respuesta vieja no pisa el precio.
    const mine = ++lastLoad;
    $('#bk-cars', form).classList.add('loading');
    try {
      const found = (await call('POST', '/quote', { pickup_at: localISO(from), return_at: localISO(to), pickup_branch: form.branch ? form.branch.value : undefined, return_branch: form.return_branch ? form.return_branch.value : undefined, extras: [...picked] })).options;
      if (mine !== lastLoad) return;
      options = found;
      $('#bk-cars', form).classList.remove('loading');
      paint();
    } catch (e) {
      if (mine !== lastLoad) return;
      $('#bk-cars', form).classList.remove('loading');
      options = [];
      summary();
      $('#bk-cars', form).innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  };
  form.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-days]');
    if (chip) {
      to = addDays(from, Number(chip.dataset.days));
      set();
      load();
    }
    const c = e.target.closest('[data-cat]');
    if (c) {
      pick = c.dataset.cat;
      paint();
    }
  });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'branch' && form.return_branch) form.return_branch.value = form.branch.value; // lo normal: devuelve donde retira
    if (e.target.name === 'branch' || e.target.name === 'return_branch') return load();
    if (e.target.matches('[data-extra]')) {
      // Un solo seguro por reserva.
      if (e.target.checked && e.target.dataset.kind === 'seguro') $$('[data-extra][data-kind=seguro]', form).forEach((x) => (x.checked = x === e.target));
      picked.clear();
      $$('[data-extra]:checked', form).forEach((x) => picked.add(x.value));
      return load();
    }
    if (e.target.name !== 'from' && e.target.name !== 'to') return;
    const f = new Date(form.from.value);
    const tt = new Date(form.to.value);
    if (Number.isNaN(f.getTime()) || Number.isNaN(tt.getTime())) return;
    // Si cambia el retiro, la devolución se corre igual: se mantienen los días elegidos.
    if (e.target.name === 'from') to = addDays(f, days());
    else to = tt;
    from = f;
    set();
    load();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const o = options.find((x) => x.code === pick);
    const name = form.name.value.trim();
    const phone = form.phone.value.trim();
    if (!o) return toast(L('Elegí un auto', 'Choose a car'), true);
    if (name.length < 3) return toast(L('Escribí tu nombre y apellido', 'Write your full name'), true);
    if (phone.replace(/\D/g, '').length < 6) return toast(L('Escribí tu WhatsApp con el código de país', 'Write your WhatsApp number with the country code'), true);
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const r = await call('POST', '/book', {
        pickup_at: localISO(from),
        return_at: localISO(to),
        pickup_branch: form.branch ? form.branch.value : cfg.branches[0] && cfg.branches[0].code,
        return_branch: form.return_branch ? form.return_branch.value : undefined,
        extras: [...picked],
        category: o.code,
        name,
        phone,
        email: form.email.value.trim(),
        _gotcha: form._gotcha.value,
        notes: L('', 'El cliente eligió inglés'),
      });
      const when = `${dayName(localISO(from))} ${fmtDT(localISO(from)).slice(11)} → ${dayName(localISO(to))} ${fmtDT(localISO(to)).slice(11)}`;
      const text = L(
        `Hola, soy ${name}. Acabo de pedir una reserva${r.code ? ` (${r.code})` : ''}: ${o.name}, ${when}.`,
        `Hi, I'm ${name}. I just requested a booking${r.code ? ` (${r.code})` : ''}: ${o.name}, ${when}.`,
      );
      form.remove();
      $('.pub-faq', page)?.remove();
      $('.pub-head', page).insertAdjacentHTML(
        'afterend',
        `<div class="card pub-done">
          <div class="pub-ok" aria-hidden="true">✓</div>
          <h1>¡Listo! Te confirmamos por WhatsApp</h1>
          <p>${esc(o.name)} · ${when} · <b>${money(o.total)}</b></p>
          <p class="muted">${L(`${esc(cfg.company)} te va a escribir para confirmar la reserva.`, `${esc(cfg.company)} will message you to confirm the booking.`)}</p>
          ${r.card_url ? `<a class="btn primary big" href="${esc(r.card_url)}" rel="noopener">${ICON.money}${L('Dejar mi tarjeta', 'Leave my card')}</a>` : ''}
          ${cfg.whatsapp ? `<a class="btn ok big" href="https://wa.me/${esc(cfg.whatsapp)}?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">${WA_ICON}Escribirle a la agencia</a>` : ''}
        </div>`,
      );
      window.scrollTo(0, 0);
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });
  set();
  load();
}

/** /como-funciona: una hoja para mostrar o imprimir cuando se le explica Floty a una agencia. */
function howItWorksPage() {
  document.title = L('Cómo funciona Floty', 'How Floty works');
  // En la demo el logo va dentro de la página (no hay archivos aparte): se toma el de la pantalla de ingreso.
  const logo = $('.login-brand img')?.getAttribute('src') || '/floty.svg';
  const page = publicPage(`<article class="card sheet">
    <div class="login-brand"><img src="${esc(logo)}" alt="" width="44" height="44"><div><h1>Floty</h1><p class="muted">Gestión simple para tu rent a car</p></div></div>
    <h2>Qué es</h2>
    <p>Un sistema para llevar las reservas, los autos y los clientes de un rent a car. Se usa desde la compu o desde el celular, y cada persona del equipo entra con su usuario.</p>
    <h2>Qué hace</h2>
    <ol class="sheet-list">
      <li><b>Hoy</b><span>Al abrirlo ves quién retira y quién devuelve un auto, cuánto debe cada cliente y los pedidos para confirmar.</span></li>
      <li><b>Reservas en un minuto</b><span>Fechas, auto y cliente. El voucher y el contrato salen solos y se mandan por WhatsApp.</span></li>
      <li><b>Calendario y autos</b><span>Qué auto está ocupado cada día, cuáles están en el taller y qué seguro o VTV está por vencer.</span></li>
      <li><b>Pedidos de internet</b><span>Los pedidos de tu página web entran solos y los confirmás con un toque. Si no tenés reservas por internet, podés activar un link para Instagram y WhatsApp.</span></li>
    </ol>
    <h2>Qué hace falta para arrancar</h2>
    <ul>
      <li>Una compu o un celular con internet.</li>
      <li>Los datos de la agencia y los lugares de entrega (aeropuerto, oficina, hoteles).</li>
      <li>Las categorías de autos con su tarifa diaria.</li>
      <li>Los autos: uno por uno o desde una planilla de Excel.</li>
      <li>Un usuario para cada persona del equipo.</li>
    </ul>
    <h2>Probalo</h2>
    <p>Demo con datos de ejemplo: <a href="https://pruebarent.netlify.app" data-notr>pruebarent.netlify.app</a></p>
    <p class="muted">Usuario y clave: <span data-notr>admin@rentacar.local</span> / <span data-notr>admin123</span></p>
    <div class="actions no-print"><button class="btn primary" type="button" id="print">Imprimir</button><a class="btn" href="/">Entrar a Floty</a></div>
  </article>`);
  $('#print', page).addEventListener('click', () => window.print());
}

/* ============================================================
   Inicio
   ============================================================ */
// Limpia el token que guardaban las versiones anteriores (ahora la sesión es una cookie protegida).
try {
  localStorage.removeItem('token');
} catch {}
// El link de reservas y la hoja "Cómo funciona" son públicos: no piden usuario.
/** /hotel/<código>[?empresa=slug]: el cliente completa los datos del hotel donde le llevamos el auto. */
async function hotelPage() {
  const token = location.pathname.split('/')[2] || '';
  const empresa = new URLSearchParams(location.search).get('empresa');
  const url = `/api/public/hotel/${encodeURIComponent(token)}${empresa ? `?empresa=${encodeURIComponent(empresa)}` : ''}`;
  let d;
  try {
    const res = await fetch(url);
    d = await res.json();
    if (!res.ok) throw new Error(d.error);
  } catch {
    publicPage(`<div class="card pub-done"><h1>${L('Datos del hotel', 'Hotel details')}</h1><p class="muted">${L('Este link ya no está disponible. Escribile a la agencia.', 'This link is no longer available. Please contact the agency.')}</p></div>`);
    return;
  }
  document.title = `${d.company} · ${L('Datos del hotel', 'Hotel details')}`;
  const what = [d.hotel.deliver && L('te llevamos el auto', 'we bring you the car'), d.hotel.return && L('lo retiramos', 'we pick it up')].filter(Boolean).join(L(' y ', ' and '));
  const page = publicPage(`<div class="pub-head"><h1>${L('Hola', 'Hi')} ${esc(d.first_name)}</h1>
      <p>${esc(d.company)} · ${L('Reserva', 'Booking')} ${esc(d.code)}</p></div>
    <form class="card qr" id="hotel-form">
      <p style="margin:0">${L(`Para el ${fmtDT(d.pickup_at)} ${what} en tu hotel. Completá estos datos:`, `On ${fmtDT(d.pickup_at)} ${what} at your hotel. Please fill in:`)}</p>
      ${d.fee ? `<p class="hotel-fee">${ICON.money}<span>${L(`La entrega en hotel tiene un costo de <b>${money(d.fee)}</b>, ya incluido en tu reserva.`, `Hotel delivery costs <b>${money(d.fee)}</b>, already included in your booking.`)}</span></p>` : ''}
      <div class="qr-hotel-grid">${hotelInputs(d.hotel)}</div>
      <button class="btn primary big" type="submit">${L('Enviar los datos', 'Send details')}</button>
      <p class="error" id="hotel-err"></p>
    </form>`);
  const form = $('#hotel-form', page);
  form.h_name.required = true;
  form.h_address.required = true;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#hotel-err', page).textContent = '';
    const btn = $('[type=submit]', form);
    btn.disabled = true;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(hotelFrom(form)) });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.error || `Error ${res.status}`);
      form.outerHTML = `<div class="card pub-done"><div class="pub-ok">✓</div><h1>${L('¡Listo, gracias!', 'Done, thank you!')}</h1><p>${L('La agencia ya tiene los datos de tu hotel.', 'The agency has your hotel details.')}</p></div>`;
    } catch (err) {
      $('#hotel-err', page).textContent = err.message;
      btn.disabled = false;
    }
  });
}

const empresaQuery = () => {
  const empresa = new URLSearchParams(location.search).get('empresa');
  return empresa ? `?empresa=${encodeURIComponent(empresa)}` : '';
};
const linkGone = (title) =>
  publicPage(`<div class="card pub-done"><h1>${title}</h1><p class="muted">${L('Este link ya no está disponible. Escribile a la agencia.', 'This link is no longer available. Please contact the agency.')}</p></div>`);

/** Dibujar la firma con el dedo o el mouse. Devuelve cómo saber si firmó y cómo limpiarla. */
function signaturePad(canvas) {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * ratio;
  canvas.height = canvas.clientHeight * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#111';
  let drawing = false;
  let length = 0;
  let last = null;
  const at = (e) => {
    const b = canvas.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top];
  };
  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    last = at(e);
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = at(e);
    ctx.beginPath();
    ctx.moveTo(...last);
    ctx.lineTo(...p);
    ctx.stroke();
    length += Math.hypot(p[0] - last[0], p[1] - last[1]);
    last = p;
  });
  const stop = () => (drawing = false);
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  return {
    signed: () => length > 40, // un punto o una rayita no es una firma
    clear: () => {
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      length = 0;
    },
  };
}

/** /firmar/<código>: el cliente lee el contrato y lo firma desde el celular. */
async function signPage() {
  const url = `/api/public/entrega/contrato/${encodeURIComponent(location.pathname.split('/')[2] || '')}${empresaQuery()}`;
  let d;
  try {
    const res = await fetch(url);
    d = await res.json();
    if (!res.ok) throw new Error(d.error);
  } catch {
    linkGone(L('Contrato', 'Agreement'));
    return;
  }
  state.settings = { ...state.settings, currency: d.currency, locale: d.locale };
  document.title = `${d.company} · ${L('Contrato', 'Agreement')} ${d.code}`;
  const row = (l, v) => (v ? `<dt>${esc(l)}</dt><dd>${v}</dd>` : '');
  const summary = `<dl class="info">
      ${row(L('Cliente', 'Customer'), `${esc(d.customer_name)}${d.customer_doc ? ` · ${esc(d.customer_doc)}` : ''}`)}
      ${row(L('Auto', 'Car'), d.plate ? `${esc(d.vehicle)} · ${esc(d.plate)}` : esc(d.category_name))}
      ${row(L('Retiro', 'Pick-up'), `${fmtDT(d.pickup_at)}${d.pickup_place ? ` · ${esc(d.pickup_place)}` : ''}`)}
      ${row(L('Devolución', 'Return'), `${fmtDT(d.return_at)}${d.return_place ? ` · ${esc(d.return_place)}` : ''}`)}
      ${row(L('Total', 'Total'), `<b>${money(d.total)}</b>`)}
      ${row(L('Garantía', 'Deposit'), money(d.deposit))}
    </dl>`;
  const terms = `<div class="sign-terms">${d.terms.map((t) => `<p>${t.title ? `<b>${esc(t.title)}</b> ` : ''}${esc(t.body)}</p>`).join('')}</div>`;
  const photosUrl = `${location.origin}/fotos/${encodeURIComponent(d.photos_token)}${empresaQuery()}`;
  const signedHtml = (s, place) => {
    const text = `${L('Mi contrato firmado', 'My signed agreement')} · ${d.company} · ${d.code}: ${location.href}\n${L('Fotos del auto', 'Car photos')}: ${photosUrl}${place ? `\n${L('El auto está en', 'The car is at')}: ${place}` : ''}`;
    return `<div class="card stack"><div class="pub-ok" aria-hidden="true">✓</div><h2>${L('Contrato firmado', 'Agreement signed')}</h2>
      ${place ? `<dl class="info"><dt>${L('Dónde está el auto', 'Where the car is')}</dt><dd><b>${esc(place)}</b></dd></dl>` : ''}
      <img class="sign-image" src="${esc(s.image)}" alt=""/>
      <p>${esc(s.name)} · ${esc(s.doc)}<br><small class="muted">${fmtDT(stampLocal(s.at))} · ${L('Huella', 'Fingerprint')} ${esc(String(s.hash).slice(0, 16))}</small></p>
      <div class="actions no-print"><a class="btn ok" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">${WA_ICON}${L('Guardar contrato y fotos en WhatsApp', 'Save agreement and photos to WhatsApp')}</a>
      <button class="btn" type="button" id="sign-print">${L('Imprimir o guardar', 'Print or save')}</button></div></div>`;
  };
  const head = `<div class="pub-head"><h1>${L('Contrato de alquiler', 'Rental agreement')}</h1><p>${esc(d.company)} · ${esc(d.code)}</p></div>
    <div class="card stack">${summary}${terms}</div>
    ${d.photos.length || d.condition ? `<div class="card stack"><h2>${L('Fotos y estado del auto', 'Car photos and condition')}</h2>${carConditionHtml({ condition: d.condition, photos: d.photos }, encodeURIComponent(d.photos_token))}</div>` : ''}`;
  const seen = d.photos.length ? L(', y vi las fotos y el estado del auto', ', and I have seen the photos and condition of the car') : '';
  const bindPrint = (page) => $('#sign-print', page)?.addEventListener('click', () => window.print());
  if (!d.can_sign) {
    const page = publicPage(`${head}${d.signed ? signedHtml(d.signed, d.left_place) : `<div class="card"><p class="notice warn">${L('Este contrato cambió o ya no se puede firmar. Pedile a la agencia un link nuevo.', 'This agreement has changed or can no longer be signed. Ask the agency for a new link.')}</p></div>`}`);
    bindPrint(page);
    return;
  }
  const page = publicPage(`${head}
    <form class="card qr" id="sign-form">
      <label>${L('Nombre y apellido', 'Full name')}<input name="name" required maxlength="120" value="${esc(d.customer_name || '')}"/></label>
      <label>${L('Documento', 'ID or passport')}<input name="doc" required maxlength="40" value="${esc(d.customer_doc || '')}"/></label>
      <label class="check"><input type="checkbox" name="accepted" required/> ${L('Leí y acepto este contrato y sus condiciones', 'I have read and accept this agreement and its terms')}${seen}</label>
      <div><b>${L('Firmá acá con el dedo', 'Sign here with your finger')}</b><canvas class="sign-pad" id="sign-pad" aria-label="${L('Espacio para firmar', 'Signature area')}"></canvas>
      <button class="btn small link" type="button" id="sign-clear">${L('Borrar y volver a firmar', 'Clear and sign again')}</button></div>
      <button class="btn primary big" type="submit">${L('Firmar el contrato', 'Sign the agreement')}</button>
      <p class="error" id="sign-err"></p>
    </form>`);
  const form = $('#sign-form', page);
  const canvas = $('#sign-pad', page);
  const pad = signaturePad(canvas);
  $('#sign-clear', page).addEventListener('click', pad.clear);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#sign-err', page);
    err.textContent = '';
    if (!pad.signed()) {
      err.textContent = L('Dibujá tu firma en el recuadro', 'Draw your signature in the box');
      return;
    }
    const btn = $('[type=submit]', form);
    btn.disabled = true;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name.value, doc: form.doc.value, accepted: form.accepted.checked, image: canvas.toDataURL('image/png') }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.error || `Error ${res.status}`);
      form.insertAdjacentHTML('afterend', '<div id="sign-done"></div>');
      $('#sign-done', page).innerHTML = signedHtml({ at: r.at, hash: r.hash, name: form.name.value, doc: form.doc.value, image: canvas.toDataURL('image/png') }, r.left_place);
      form.remove();
      bindPrint(page);
      $('#sign-done', page).scrollIntoView(); // arriba está el contrato: el lugar del auto queda a la vista
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  });
}

/** /fotos/<código>: las fotos del auto al entregarlo, para que el cliente las tenga. */
async function photosPage() {
  const token = encodeURIComponent(location.pathname.split('/')[2] || '');
  let d;
  try {
    const res = await fetch(`/api/public/entrega/fotos/${token}${empresaQuery()}`);
    d = await res.json();
    if (!res.ok) throw new Error(d.error);
  } catch {
    linkGone(L('Fotos del auto', 'Car photos'));
    return;
  }
  document.title = `${d.company} · ${L('Fotos del auto', 'Car photos')}`;
  publicPage(`<div class="pub-head"><h1>${L('Fotos del auto', 'Car photos')}</h1><p>${esc(d.company)} · ${esc(d.code)}</p></div>
    <div class="card stack">${carConditionHtml(d, token)}</div>`);
}

/** Lugar (si ya se puede ver), km, combustible, estado y fotos de la entrega. Lo mismo en la firma y en el link de fotos. */
function carConditionHtml(d, token) {
  const c = d.condition;
  const details = [
    d.left_place && [L('Dónde está el auto', 'Where the car is'), d.left_place],
    c && [L('Kilómetros', 'Mileage'), c.out_km],
    c && [L('Combustible', 'Fuel'), fuel(c.out_fuel)],
    c && c.out_notes && [L('Estado del auto', 'Car condition'), c.out_notes],
  ].filter(Boolean);
  const src = (p) => `/api/public/entrega/fotos/${token}/${p.id}${empresaQuery()}`;
  return `${details.length ? `<dl class="info">${details.map(([l, v]) => `<dt>${esc(l)}</dt><dd>${esc(String(v))}</dd>`).join('')}</dl>` : ''}
    <p class="muted">${L('Así estaba el auto al momento de la entrega.', 'This is how the car was at delivery.')}</p>
    ${d.photos.length ? `<div class="pub-photos">${d.photos.map((p) => `<a href="${src(p)}" target="_blank" rel="noopener"><img loading="lazy" alt="${esc(p.name || '')}" src="${src(p)}"/></a>`).join('')}</div>` : `<p>${L('Todavía no hay fotos. La agencia las va a subir enseguida.', 'There are no photos yet. The agency will upload them soon.')}</p>`}`;
}

/** /devolucion/<código>: el cliente saca las fotos del auto al dejarlo y le llegan a la agencia. */
async function returnPage() {
  const url = `/api/public/entrega/devolucion/${encodeURIComponent(location.pathname.split('/')[2] || '')}`;
  const title = L('Devolución del auto', 'Car return');
  let d;
  try {
    const res = await fetch(url + empresaQuery());
    d = await res.json();
    if (!res.ok) throw new Error(d.error);
  } catch {
    linkGone(title);
    return;
  }
  document.title = `${d.company} · ${title}`;
  if (!d.can_upload) {
    publicPage(`<div class="card pub-done"><h1>${title}</h1><p class="muted">${L('Este alquiler ya está cerrado. Si necesitás algo, escribile a la agencia.', 'This rental is already closed. If you need anything, please contact the agency.')}</p></div>`);
    return;
  }
  const page = publicPage(`<div class="pub-head"><h1>${title}</h1><p>${esc(d.company)} · ${esc(d.code)}</p></div>
    <div class="card stack"><p>${L('Sacale fotos al auto donde lo dejaste: frente, laterales, cola, interior y tablero con km y combustible.', 'Take photos of the car where you left it: front, sides, rear, interior and dashboard showing mileage and fuel.')}</p>
    <input id="ret-files" type="file" accept="image/*" multiple hidden/>
    <button class="btn primary" type="button" id="ret-add">${L('Sacar o elegir fotos', 'Take or choose photos')}</button>
    <p id="ret-status" class="muted" role="status"></p>
    <div class="pub-photos" id="ret-thumbs"></div></div>`);
  const input = $('#ret-files', page);
  const add = $('#ret-add', page);
  const status = $('#ret-status', page);
  let sent = 0;
  add.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = [...input.files];
    add.disabled = true;
    try {
      for (const [i, f] of files.entries()) {
        status.textContent = L(`Subiendo ${i + 1} de ${files.length}…`, `Uploading ${i + 1} of ${files.length}…`);
        const blob = await shrinkImage(f);
        const q = `${empresaQuery() ? `${empresaQuery()}&` : '?'}name=${encodeURIComponent(f.name)}`;
        const res = await fetch(url + q, { method: 'POST', headers: { 'Content-Type': blob.type || f.type || 'application/octet-stream' }, body: blob });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || L('No se pudo subir la foto. Probá de nuevo.', 'The photo could not be uploaded. Please try again.'));
        sent += 1;
        const img = new Image();
        img.alt = f.name;
        img.src = URL.createObjectURL(blob);
        $('#ret-thumbs', page).appendChild(img);
      }
      status.textContent = L(`Listo: la agencia ya tiene ${sent} foto${sent === 1 ? '' : 's'}. Podés agregar más.`, `Done: the agency has ${sent} photo${sent === 1 ? '' : 's'}. You can add more.`);
    } catch (e) {
      status.textContent = e.message;
    }
    add.disabled = false;
    input.value = '';
  });
}

/** ¿El número de tarjeta está bien escrito? (dígito verificador) */
function cardNumberOk(digits) {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  [...digits].reverse().forEach((c, i) => {
    const n = Number(c) * (i % 2 ? 2 : 1);
    sum += n > 9 ? n - 9 : n;
  });
  return sum % 10 === 0;
}
const cardBrand = (digits) => (/^4/.test(digits) ? 'Visa' : /^(5[1-5]|2[2-7])/.test(digits) ? 'Mastercard' : /^3[47]/.test(digits) ? 'American Express' : 'Otra');

/**
 * /tarjeta/<código>: el cliente deja su tarjeta. El número se comprueba acá y no sale del navegador:
 * al servidor van la marca y los últimos 4 dígitos. El campo no lleva name para que ningún envío lo incluya.
 */
async function cardPage() {
  const url = `/api/public/entrega/tarjeta/${encodeURIComponent(location.pathname.split('/')[2] || '')}${empresaQuery()}`;
  let d;
  try {
    const res = await fetch(url);
    d = await res.json();
    if (!res.ok) throw new Error(d.error);
  } catch {
    linkGone(L('Tu tarjeta', 'Your card'));
    return;
  }
  state.settings = { ...state.settings, currency: d.currency, locale: d.locale };
  document.title = `${d.company} · ${L('Tu tarjeta', 'Your card')}`;
  const done = (c) => `<div class="card pub-done"><div class="pub-ok" aria-hidden="true">✓</div><h1>${L('¡Listo, gracias!', 'Done, thank you!')}</h1>
    <p><b>${esc(c.brand)} ${L('terminada en', 'ending in')} ${esc(c.last4)}</b> · ${L('vence', 'expires')} ${esc(c.exp)}</p>
    <p class="muted">${L('Traé esta tarjeta cuando retires el auto. No se realizó ningún cobro.', 'Bring this card when you pick up the car. No charge was made.')}</p></div>`;
  const page = publicPage(`<div class="pub-head"><h1>${L('Hola', 'Hi')} ${esc(d.first_name)}</h1><p>${esc(d.company)} · ${L('Reserva', 'Booking')} ${esc(d.code)}</p></div>
    <form class="card qr" id="card-form" autocomplete="on">
      <p style="margin:0">${L('Dejá los datos de la tarjeta con la que vas a retirar el auto. <b>No se te cobra nada.</b>', 'Leave the details of the card you will use to pick up the car. <b>You will not be charged.</b>')}${d.deposit ? ` ${L(`La garantía de ${money(d.deposit)} se toma al retirar.`, `The ${money(d.deposit)} deposit is taken at pick-up.`)}` : ''}</p>
      ${d.card ? `<p class="notice">${L('Ya dejaste', 'You already left')} ${esc(d.card.brand)} ${L('terminada en', 'ending in')} ${esc(d.card.last4)}. ${L('Si cargás otra, reemplaza a esa.', 'A new one replaces it.')}</p>` : ''}
      <label>${L('Titular, como figura en la tarjeta', 'Cardholder, as shown on the card')}<input name="holder" required maxlength="80" autocomplete="cc-name"/></label>
      <label>${L('Número de tarjeta', 'Card number')}<input id="card-number" required inputmode="numeric" maxlength="23" autocomplete="cc-number" placeholder="0000 0000 0000 0000" data-notr/></label>
      <label>${L('Vencimiento (MM/AA)', 'Expiry (MM/YY)')}<input name="exp" required maxlength="5" inputmode="numeric" autocomplete="cc-exp" placeholder="MM/AA" data-notr/></label>
      <label class="check"><input type="checkbox" name="accepted" required/> ${L('Es mi tarjeta y la voy a presentar al retirar el auto', 'This is my card and I will present it at pick-up')}</label>
      <button class="btn primary big" type="submit">${L('Guardar', 'Save')}</button>
      <small class="muted">${L('Por seguridad guardamos solo el titular, la marca, los últimos 4 dígitos y el vencimiento. El número completo no se guarda y no te pedimos el código de seguridad.', 'For security we only keep the cardholder, the brand, the last 4 digits and the expiry. The full number is not stored and we do not ask for the security code.')}</small>
      <p class="error" id="card-err"></p>
    </form>`);
  const form = $('#card-form', page);
  const number = $('#card-number', page);
  number.addEventListener('input', () => (number.value = number.value.replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ')));
  form.exp.addEventListener('input', () => (form.exp.value = form.exp.value.replace(/\D/g, '').replace(/^(\d{2})(\d)/, '$1/$2')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#card-err', page);
    err.textContent = '';
    const digits = number.value.replace(/\D/g, '');
    if (!cardNumberOk(digits)) {
      err.textContent = L('Revisá el número de la tarjeta', 'Check the card number');
      return;
    }
    const btn = $('[type=submit]', form);
    btn.disabled = true;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holder: form.holder.value, exp: form.exp.value, accepted: form.accepted.checked, brand: cardBrand(digits), last4: digits.slice(-4) }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.error || `Error ${res.status}`);
      form.outerHTML = done(r.card);
      window.scrollTo(0, 0);
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  });
}

const PUBLIC_PAGES = { '/reservar': bookingPage, '/como-funciona': howItWorksPage };
const TOKEN_PAGES = [[/^\/hotel\/[\w-]+$/, hotelPage], [/^\/firmar\/[\w-]+$/, signPage], [/^\/fotos\/[\w-]+$/, photosPage], [/^\/devolucion\/[\w-]+$/, returnPage], [/^\/tarjeta\/[\w-]+$/, cardPage]];
const publicPath = location.pathname.replace(/\/+$/, '');
(PUBLIC_PAGES[publicPath] || (TOKEN_PAGES.find(([re]) => re.test(publicPath)) || [])[1] || startSession)();
