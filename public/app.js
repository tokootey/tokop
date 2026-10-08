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

const money = (n) => {
  const cur = state.settings.currency || 'ARS';
  try {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n || 0);
  } catch {
    return `${cur} ${Number(n || 0).toFixed(2)}`;
  }
};
// Las fechas también se escapan: se muestran dentro de HTML.
const fmtDT = (s) => (s ? esc(`${String(s).slice(8, 10)}/${String(s).slice(5, 7)}/${String(s).slice(0, 4)} ${String(s).slice(11, 16)}`) : '');
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
  mantenimiento: 'Mantenimiento',
  fuera_servicio: 'Fuera de servicio',
  procesada: 'Procesada',
  duplicada: 'Duplicada',
  error: 'Error',
  recibida: 'Recibida',
  cotizador: 'Cotizador',
  web: 'Formulario web',
  manual: 'Mostrador',
  abierto: 'Abierto',
  cerrado: 'Cerrado',
};
const badge = (s) => `<span class="badge b-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
const sourceBadge = (s) => (s === 'manual' ? '' : ` <span class="badge b-cotizador">${esc(STATUS_LABEL[s] || s)}</span>`);
const fuel = (n) => (n === null || n === undefined ? '' : `${n}/8`);

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
        await onSubmit(formData(form), form);
        closeModal();
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
document.addEventListener('click', (e) => {
  if (e.target.matches('[data-close]') || e.target.id === 'modal') closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

/* ---------- Formularios genéricos ---------- */
function field(f, value) {
  const v = value === undefined || value === null ? (f.default ?? '') : value;
  const cls = f.full ? ' class="full"' : '';
  const req = f.required ? ' required' : '';
  if (f.type === 'photos') {
    return `<label class="full">${esc(f.label)}<input name="${f.name}" type="file" accept="image/*,application/pdf" multiple/>
      <small class="muted">Desde el celular podés sacar la foto en el momento o elegirla de la galería. Se pueden elegir varias.</small></label>`;
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
const formHtml = (fields, values = {}, submit = 'Guardar') =>
  `<form><div class="form-grid">${fields.map((f) => field(f, values[f.name])).join('')}</div>
   <div class="actions" style="margin-top:16px"><button class="btn primary" type="submit">${esc(submit)}</button><button class="btn" type="button" data-close>Cancelar</button></div></form>`;

/* ============================================================
   Sesión
   ============================================================ */
async function loadCatalogs() {
  const [settings, branches, categories, extras] = await Promise.all([GET('/settings'), GET('/branches'), GET('/categories'), GET('/extras')]);
  Object.assign(state, { settings, branches, categories, extras });
  $('#brand').textContent = settings.company_name || 'Rent a Car';
  document.title = `${settings.company_name || 'Rent a Car'} · Gestión`;
}

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
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', state.user.role !== 'admin'));
  await loadCatalogs();
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

async function route() {
  if (!state.user) return;
  const hash = location.hash.replace(/^#/, '') || '/panel';
  for (const r of routes) {
    const m = hash.match(r.pattern);
    if (m) {
      $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === r.navKey));
      const view = $('#view');
      view.innerHTML = '<p class="muted">Cargando…</p>';
      try {
        await r.handler(view, ...m.slice(1));
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
on(/^\/panel$/, async (view) => {
  const d = await GET('/dashboard');
  // Lista de reservas del día: hora | cliente | auto, cada fila lleva a la reserva.
  const list = (rows, kind, empty) =>
    rows.length
      ? `<div class="daylist">${rows
          .map((r) => {
            const at = kind === 'pickup' ? r.pickup_at : r.return_at;
            const branch = kind === 'pickup' ? r.pickup_branch_name : r.return_branch_name;
            return `<div class="dayrow click" data-href="#/reservas/${r.id}">
              <div class="when"><b>${fmtDT(at).slice(11)}</b><small>${fmtD(at).slice(0, 5)}</small></div>
              <div class="who"><b>${esc(r.customer_name)}</b><small>${esc(r.code)}${r.customer_phone ? ` · ${esc(r.customer_phone)}` : ''}${branch ? ` · ${esc(branch)}` : ''}</small></div>
              <div class="what">${r.vehicle_plate ? `<span class="plate">${esc(r.vehicle_plate)}</span>` : '<span class="badge b-pendiente">sin auto</span>'}<small>Cat. ${esc(r.category_code)}</small></div>
            </div>`;
          })
          .join('')}</div>`
      : `<p class="empty">${empty}</p>`;
  const count = (n) => `<span class="count">${n}</span>`;
  const kpi = (label, value, sub = '', extra = '') => `<div class="kpi"><div class="l">${label}</div><div class="v">${value}</div>${sub ? `<div class="s">${sub}</div>` : ''}${extra}</div>`;
  view.innerHTML = `
    <div class="page-head"><h1>Panel</h1><a class="btn primary" href="#/reservas/nueva">+ Nueva reserva</a></div>
    <div class="kpis">
      ${kpi('Flota operativa', `${d.fleet.operational}<small> / ${d.fleet.total}</small>`, 'autos que se pueden alquilar')}
      ${kpi('Disponibles', d.fleet.disponible || 0, 'listos para entregar')}
      ${kpi('Alquilados', d.fleet.alquilado || 0, 'en la calle ahora')}
      ${kpi('En taller', d.fleet.mantenimiento || 0, `${d.alerts.maintenance_open} mantenimiento(s) abierto(s)`)}
      ${kpi('Ocupación', `${d.occupancy}%`, '', `<div class="meter"><i style="width:${Math.min(100, Number(d.occupancy) || 0)}%"></i></div>`)}
      ${kpi('Cobrado este mes', money(d.month_revenue), 'pagos registrados')}
      ${kpi('Reservas del mes', d.month_reservations, `${d.from_quoter_month} desde el cotizador o la web`)}
      ${kpi('A confirmar', d.pending_confirmation, `${d.unassigned_next_7d} sin auto en los próximos 7 días`)}
    </div>
    ${
      d.quote_errors
        ? `<div class="notice warn">Hay <b>${d.quote_errors}</b> solicitud(es) del cotizador o del formulario web con error. <a href="#/cotizador">Revisar bandeja</a></div>`
        : ''
    }
    <div class="dash">
      <div class="card"><h2>Entregas de hoy ${count(d.pickups_today.length)}</h2>${list(d.pickups_today, 'pickup', 'No hay entregas para hoy.')}</div>
      <div class="card"><h2>Devoluciones de hoy ${count(d.returns_today.length)}</h2>${list(d.returns_today, 'return', 'No hay devoluciones para hoy.')}</div>
      <div class="card ${d.overdue.length ? 'alert' : ''}"><h2>Devoluciones vencidas ${count(d.overdue.length)}</h2>${list(d.overdue, 'return', 'Todos los autos volvieron a tiempo.')}</div>
      <div class="card ${d.late_pickups.length ? 'alert' : ''}"><h2>Clientes que no retiraron ${count(d.late_pickups.length)}</h2>${list(d.late_pickups, 'pickup', 'Nadie quedó sin retirar.')}</div>
      <div class="card wide"><h2>Vencimientos de documentación (próximos 30 días) ${count(d.alerts.documents.length)}</h2>${
        d.alerts.documents.length
          ? `<div class="daylist">${d.alerts.documents
              .map(
                (v) =>
                  `<div class="dayrow docs"><span class="plate">${esc(v.plate)}</span><div><small>Seguro</small><b>${fmtD(v.insurance_expiry) || '—'}</b></div><div><small>VTV</small><b>${fmtD(v.vtv_expiry) || '—'}</b></div></div>`,
              )
              .join('')}</div>`
          : '<p class="empty">Ningún seguro ni VTV vence en los próximos 30 días.</p>'
      }</div>
    </div>`;
}, 'panel');

document.addEventListener('click', (e) => {
  const tr = e.target.closest('[data-href]');
  if (tr && !e.target.closest('button, a, input, select')) location.hash = tr.dataset.href;
});

/* ============================================================
   Reservas: listado
   ============================================================ */
on(/^\/reservas$/, async (view) => {
  view.innerHTML = `
    <div class="page-head"><h1>Reservas</h1><a class="btn primary" href="#/reservas/nueva">+ Nueva reserva</a></div>
    <form class="toolbar" id="res-filter">
      <label>Buscar<input name="q" placeholder="Código, cliente, DNI, patente…"/></label>
      <label>Estado<select name="status"><option value="">Activas</option><option value="all">Todas</option>
        ${['pendiente', 'confirmada', 'en_curso', 'finalizada', 'cancelada', 'no_show'].map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join('')}</select></label>
      <label>Origen<select name="source"><option value="">Todos</option><option value="manual">Mostrador</option><option value="cotizador">Cotizador</option><option value="web">Formulario web</option></select></label>
      <label>Desde<input type="date" name="from"/></label>
      <label>Hasta<input type="date" name="to"/></label>
      <button class="btn">Filtrar</button>
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
  await load();
}, 'reservas');

/* ============================================================
   Nueva reserva / cotización en mostrador
   ============================================================ */
const branchOptions = () => state.branches.filter((b) => b.active).map((b) => [b.id, b.name]);

on(/^\/reservas\/nueva(?:\?(.*))?$/, async (view, query) => {
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
  const dayAt10 = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? new Date(`${d}T10:00`) : null);
  if (dayAt10(pre.get('desde')) && dayAt10(pre.get('hasta'))) {
    p0 = dayAt10(pre.get('desde'));
    r0 = dayAt10(pre.get('hasta'));
  }
  if (preVehicle) sel.category_id = preVehicle.category_id;
  view.innerHTML = `
    <div class="page-head"><h1>Nueva reserva</h1></div>
    ${
      preVehicle
        ? `<div class="card" style="border-color:var(--primary);margin-bottom:16px">Reserva para <b>${esc(preVehicle.plate)}</b> ${esc(preVehicle.brand || '')} ${esc(preVehicle.model || '')}, del ${fmtD(localISO(p0))} al ${fmtD(localISO(r0))}, elegida desde el Planning. Completá el cliente y guardá.</div>`
        : ''
    }
    <form id="new-res" class="stack">
      <div class="card">
        <h2>1 · Fechas y lugares</h2>
        <div class="form-grid">
          <label>Retiro<input type="datetime-local" name="pickup_at" value="${localISO(p0)}" required/></label>
          <label>Devolución<input type="datetime-local" name="return_at" value="${localISO(r0)}" required/></label>
          ${field({ name: 'pickup_branch_id', label: 'Lugar de retiro', type: 'select', options: branchOptions, required: true })}
          ${field({ name: 'return_branch_id', label: 'Lugar de devolución', type: 'select', options: branchOptions, required: true })}
        </div>
        <h3 style="margin-top:16px">Adicionales</h3>
        <div class="actions">${state.extras
          .filter((x) => x.active)
          .map(
            (x) =>
              `<label class="check"><input type="checkbox" name="extra_${x.id}"/> ${esc(x.name)} <small class="muted">(${money(x.price)}${x.charge_type === 'dia' ? '/día' : ''})</small></label>`,
          )
          .join('')}</div>
        <div class="form-grid" style="margin-top:12px">
          <label>Descuento %<input type="number" name="discount_pct" min="0" max="100" step="any" value="0"/></label>
          <label>Vuelo / referencia<input name="flight"/></label>
        </div>
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
  if (preVehicle && preVehicle.branch_id && branchOptions().some(([id]) => id === preVehicle.branch_id)) pb.value = preVehicle.branch_id;
  form.return_branch_id.value = pb.value;
  pb.addEventListener('change', () => (form.return_branch_id.value = pb.value));

  const params = () => {
    const f = formData(form);
    const extras = state.extras.filter((x) => f[`extra_${x.id}`]).map((x) => x.id);
    return { ...f, extras };
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
      extras: f.extras.join(','),
    });
    try {
      quotes = await GET(`/availability?${qs}`);
    } catch (e) {
      $('#cats').innerHTML = `<p class="error">${esc(e.message)}</p>`;
      return;
    }
    $('#cats').innerHTML = quotes
      .map(
        (c) => `<div class="cat-card ${c.available ? '' : 'none'} ${sel.category_id === c.id ? 'selected' : ''}" data-cat="${c.id}">
          <div class="cat-name"><span class="cat-code">${esc(c.code)}</span>${esc(c.name)}</div>
          <div class="muted">${c.available} disponible(s) · ${c.quote.days} día(s)</div>
          <div class="price">${money(c.quote.total)}</div>
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
    $('#summary').innerHTML = breakdownHtml(c.quote) + (c.available ? '' : '<p class="error">Sin disponibilidad: se guardará igual como sobreventa si confirmás.</p>');
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
        : '<p class="muted">Sin resultados.</p>';
      $$('[data-cust]').forEach((tr) => tr.addEventListener('click', () => pickCustomer(rows.find((c) => c.id === Number(tr.dataset.cust)))));
    }, 250);
  });
  $('#cust-q').addEventListener('keydown', (e) => e.key === 'Enter' && e.preventDefault());
  $('#cust-new').addEventListener('click', () =>
    openModal('Cliente nuevo', formHtml(CUSTOMER_FIELDS), async (data) => {
      pickCustomer(await POST('/customers', data));
    }),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = e.submitter ? e.submitter.dataset.status : 'pendiente';
    if (!sel.category_id) return toast('Elegí una categoría', true);
    if (!sel.customer_id) return toast('Elegí o cargá un cliente', true);
    const f = params();
    const c = quotes.find((x) => x.id === sel.category_id);
    if (c && !c.available && !confirm('No hay disponibilidad en esa categoría. ¿Guardar igual (sobreventa)?')) return;
    const body = {
      customer_id: sel.customer_id,
      category_id: sel.category_id,
      vehicle_id: f.vehicle_id ? Number(f.vehicle_id) : null,
      pickup_branch_id: Number(f.pickup_branch_id),
      return_branch_id: Number(f.return_branch_id),
      pickup_at: f.pickup_at,
      return_at: f.return_at,
      discount_pct: f.discount_pct || 0,
      flight: f.flight,
      notes: f.notes,
      extras: f.extras.map((id) => ({ extra_id: id, quantity: 1 })),
      status,
      allow_overbooking: c && !c.available,
    };
    const r = await run(() => POST('/reservations', body), 'Reserva creada');
    location.hash = `#/reservas/${r.id}`;
  });

  await refresh();
}, 'nueva');

function breakdownHtml(q) {
  const row = (l, v, cls = '') => `<tr class="${cls}"><td>${l}</td><td class="right">${v}</td></tr>`;
  return `<table class="breakdown"><tbody>
    ${row(`${esc(q.category ? q.category.name : '')} · ${q.days} día(s) × ${money(q.per_day)}`, money(q.base))}
    ${q.season_extra ? row('Recargo de temporada', money(q.season_extra)) : ''}
    ${(q.extras || []).map((x) => row(`${esc(x.name)}${x.quantity > 1 ? ` ×${x.quantity}` : ''}`, money(x.amount))).join('')}
    ${q.one_way_fee ? row('Devolución en otra sucursal', money(q.one_way_fee)) : ''}
    ${q.discount ? row(`Descuento ${q.discount_pct}%`, '−' + money(q.discount)) : ''}
    ${q.tax_rate ? row(`IVA ${q.tax_rate}% ${q.tax_included ? '(incluido)' : ''}`, money(q.tax)) : ''}
    ${q.calculated_total !== undefined ? row('<span class="muted">Precio según tarifas del sistema</span>', `<span class="muted">${money(q.calculated_total)}</span>`) : ''}
    ${row(q.calculated_total !== undefined ? `Total (precio del ${STATUS_LABEL[q.source] || q.source})` : 'Total', money(q.total), 'total')}
    </tbody></table>
    <p class="muted">Garantía: ${money(q.deposit)}${q.km_included ? ` · Km incluidos: ${q.km_included}` : ' · Km libres'}</p>`;
}

/* ============================================================
   Reserva: detalle y operación (entrega, devolución, pagos)
   ============================================================ */
on(/^\/reservas\/(\d+)$/, async (view, id) => {
  const r = await GET(`/reservations/${id}`);
  const c = r.contract;
  const canEdit = ['pendiente', 'confirmada'].includes(r.status);
  const actions = [];
  if (r.status === 'pendiente') actions.push('<button class="btn primary" data-act="confirm">Confirmar</button>');
  if (canEdit) {
    actions.push('<button class="btn ok" data-act="checkout">Entregar vehículo</button>');
    actions.push('<button class="btn" data-act="assign">Asignar vehículo</button>');
    actions.push('<button class="btn" data-act="edit">Modificar</button>');
    actions.push('<button class="btn danger" data-act="noshow">No show</button>');
    actions.push('<button class="btn danger" data-act="cancel">Cancelar</button>');
  }
  if (r.status === 'en_curso') actions.push('<button class="btn ok" data-act="checkin">Registrar devolución</button>');
  if (['cancelada', 'no_show'].includes(r.status)) actions.push('<button class="btn" data-act="reopen">Reabrir</button>');
  if (!['cancelada', 'no_show'].includes(r.status)) {
    actions.push('<button class="btn primary" data-act="pdf">Contrato PDF</button>');
    actions.push('<button class="btn" data-act="print">Imprimir contrato</button>');
  }

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
          <dt>Cliente</dt><dd><b>${esc(r.customer_name)}</b><br><small>${esc(r.customer_doc || '')} · ${esc(r.customer_phone || '')} · ${esc(r.customer_email || '')}</small></dd>
          <dt>Retiro</dt><dd>${fmtDT(r.pickup_at)} · ${esc(r.pickup_branch_name || '')}</dd>
          <dt>Devolución</dt><dd>${fmtDT(r.return_at)} · ${esc(r.return_branch_name || '')}</dd>
          <dt>Categoría</dt><dd>${esc(r.category_code)} · ${esc(r.category_name)}</dd>
          <dt>Vehículo</dt><dd>${r.vehicle_plate ? `<b>${esc(r.vehicle_plate)}</b> ${esc(r.vehicle_brand)} ${esc(r.vehicle_model)}` : '<span class="badge b-pendiente">Sin asignar</span>'}</dd>
          <dt>Adicionales</dt><dd>${r.extras.map((x) => esc(x.name)).join(', ') || '—'}</dd>
          ${r.flight ? `<dt>Vuelo</dt><dd>${esc(r.flight)}</dd>` : ''}
          <dt>Notas</dt><dd>${esc(r.notes || '—')}</dd>
        </dl>
      </div>
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
                    `<tr><td class="nowrap">${fmtDT(String(p.created_at).replace(' ', 'T')).slice(0, 5)} ${esc(String(p.created_at).slice(11, 16))}</td><td>${esc(PAYMENT_KINDS[p.kind] || p.kind)}</td><td>${esc(p.method || '')} ${p.reference ? `<small class="muted">${esc(p.reference)}</small>` : ''}</td><td class="right">${money(p.amount)}</td></tr>`,
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
            (l) => `<li><div class="t-head"><b>${esc(LOG_LABEL[l.action] || l.action)}</b><small>${fmtDT(String(l.at).replace(' ', 'T'))} · ${esc(l.user_name || 'sistema')}</small></div>${
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
    confirm: () => run(() => POST(`/reservations/${r.id}/status`, { status: 'confirmada' }), 'Reserva confirmada').then(reload),
    cancel: () => {
      const reason = prompt('Motivo de la cancelación (opcional):');
      if (reason === null) return;
      run(() => POST(`/reservations/${r.id}/status`, { status: 'cancelada', reason }), 'Reserva cancelada').then(reload);
    },
    noshow: () => confirm('¿Marcar como no show?') && run(() => POST(`/reservations/${r.id}/status`, { status: 'no_show' }), 'Marcada como no show').then(reload),
    reopen: () => run(() => POST(`/reservations/${r.id}/status`, { status: 'pendiente' }), 'Reserva reabierta').then(reload),
    assign: async () => {
      const list = await GET(`/reservations/${r.id}/available-vehicles`);
      openModal(
        'Asignar vehículo',
        formHtml([{ name: 'vehicle_id', label: 'Vehículo disponible', type: 'select', full: true, options: list.map((v) => [v.id, `${v.plate} · ${v.brand} ${v.model} · ${v.km} km · ${v.branch_name || ''}`]) }], { vehicle_id: r.vehicle_id }),
        async (d) => {
          await POST(`/reservations/${r.id}/assign`, { vehicle_id: d.vehicle_id ? Number(d.vehicle_id) : null });
          toast('Vehículo asignado');
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
          reload();
        },
      ),
    pay: () =>
      openModal(
        'Registrar movimiento',
        formHtml(
          [
            { name: 'kind', label: 'Tipo', type: 'select', options: Object.entries(PAYMENT_KINDS), required: true },
            { name: 'method', label: 'Medio', type: 'select', options: ['efectivo', 'tarjeta', 'transferencia', 'mercadopago', 'otro'].map((m) => [m, m]), required: true },
            { name: 'amount', label: 'Importe', type: 'number', required: true },
            { name: 'reference', label: 'Referencia / comprobante' },
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
            { name: 'flight', label: 'Vuelo / referencia' },
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
    print: () => printContract(r),
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
          { stage: r.status === 'finalizada' ? 'devolucion' : r.status === 'en_curso' ? 'entrega' : 'otro' },
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
  wireFiles(view, r, reload);
}, 'reservas');

const LOG_LABEL = {
  creada: 'Reserva creada',
  modificada: 'Reserva modificada',
  confirmada: 'Confirmada',
  cancelada: 'Cancelada',
  no_show: 'No se presentó',
  pendiente: 'Reabierta',
  vehiculo_asignado: 'Vehículo asignado',
  entregado: 'Auto entregado',
  devuelto: 'Auto devuelto',
  pago: 'Pago registrado',
  devolucion: 'Devolución de dinero',
  garantia: 'Garantía recibida',
  devolucion_garantia: 'Garantía devuelta',
  archivo_subido: 'Archivo subido',
  archivo_borrado: 'Archivo borrado',
};
const DETAIL_KEY = { status: 'estado', source: 'origen', contrato: 'contrato', km: 'km', combustible: 'combustible', cargos: 'cargos' };

function logDetail(d) {
  if (!d) return '';
  try {
    const o = JSON.parse(d);
    return typeof o === 'object' && o
      ? Object.entries(o)
          .map(([k, v]) => `${DETAIL_KEY[k] || k}: ${k === 'combustible' ? `${v}/8` : k === 'cargos' ? money(v) : STATUS_LABEL[v] || v}`)
          .join(' · ')
      : String(o);
  } catch {
    return d;
  }
}

/* ---------- Fotos y documentación del alquiler ---------- */
const STAGE_LABEL = { entrega: 'Entrega', devolucion: 'Devolución', contrato: 'Contratos', otro: 'Otros documentos' };

/** Achica las fotos antes de subirlas (las del celular pesan varios MB); los PDF van tal cual. */
async function shrinkImage(file, max = 1600, quality = 0.82) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || !window.createImageBitmap) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5e6) return file;
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
         <p class="muted">Subido el ${esc(fmtDT(f.created_at.replace(' ', 'T')))}${f.user_name ? ` por ${esc(f.user_name)}` : ''}.</p>
         <div class="actions"><a class="btn" href="${url}" target="_blank" rel="noopener">Abrir en otra pestaña</a>
         <button class="btn danger" type="button" id="file-del">Borrar</button></div>`,
      );
      $('#file-del').addEventListener('click', async () => {
        if (!confirm('¿Borrar este archivo?')) return;
        await run(() => DEL(`/files/${f.id}`), 'Archivo borrado');
        closeModal();
        reload();
      });
    }),
  );
}

const FUEL_OPTS = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, n === 8 ? '8/8 (lleno)' : n === 0 ? '0/8 (vacío)' : `${n}/8`]);
const PAYMENT_KINDS = { pago: 'Pago', devolucion: 'Devolución de dinero', garantia: 'Garantía (depósito)', devolucion_garantia: 'Devolución de garantía' };

/**
 * Condiciones del contrato con las {palabras} completadas, como lista de cláusulas { title, body } en texto plano.
 * La usan el contrato impreso y el PDF.
 */
function contractTermsList(r) {
  const s = state.settings;
  const km = Number(r.category_km_per_day) || 0;
  const values = {
    empresa: s.company_name || 'la Empresa',
    tolerancia: Number(s.grace_hours) || 0,
    edad_minima: Number(s.min_driver_age) || 21,
    cargo_combustible: Number(s.fuel_charge_per_eighth) > 0 ? money(s.fuel_charge_per_eighth) : 'el valor del combustible faltante más un cargo por servicio',
    kilometraje:
      km > 0
        ? `El alquiler incluye ${km} km por día (${km * (r.days || 1)} km en total). Cada km excedente se cobrará ${money(r.category_extra_km_rate)}.`
        : 'El alquiler tiene kilometraje libre.',
    franquicia: Number(s.deductible_amount) > 0 ? money(s.deductible_amount) : 'el monto de la franquicia de la póliza vigente',
    garantia: money(r.deposit),
    jurisdiccion: s.jurisdiction || 'la ciudad donde se celebra este contrato',
  };
  return String(s.contract_terms || '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const filled = p.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m)).replace(/\s+/g, ' ');
      const title = filled.match(/^(\d+\.\s*[^.]{2,60}\.)\s*/);
      return title ? { title: title[1], body: filled.slice(title[0].length) } : { title: '', body: filled };
    });
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
    q.base !== undefined ? [`Alquiler ${esc(r.days)} día(s)${q.per_day ? ` × ${money(q.per_day)}` : ''}`, money(q.base)] : null,
    q.season_extra ? ['Recargo de temporada', money(q.season_extra)] : null,
    ...(q.extras || []).map((x) => [esc(x.name) + (x.quantity > 1 ? ` ×${esc(x.quantity)}` : ''), money(x.amount)]),
    q.one_way_fee ? ['Devolución en otro lugar', money(q.one_way_fee)] : null,
    q.discount ? [`Descuento ${esc(q.discount_pct)}%`, '−' + money(q.discount)] : null,
    q.tax_rate ? [`IVA ${esc(q.tax_rate)}%${q.tax_included ? ' (incluido)' : ''}`, money(q.tax)] : null,
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
    <div>${esc(s.company_phone || '')}${s.company_tax_id ? ' · CUIT ' + esc(s.company_tax_id) : ''}</div></div>
  <div class="right"><b>${title}</b><br>
    ${delivered ? `N° <b>${esc(c.number)}</b>` : '<span class="badge">Sin entregar todavía</span>'}<br>
    Reserva ${esc(r.code)} · Emitido ${esc(new Date().toLocaleDateString('es-AR'))}</div>
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
  <h2>Conductor adicional</h2><table>
    ${line('Nombre y apellido', '')}${line('Documento', '')}${line('Licencia N° / vence', '')}
  </table></div>
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
    ${line('Kilómetros', outKm !== null && outKm !== undefined && outKm !== '' ? `${Number(outKm).toLocaleString('es-AR')} km${delivered ? '' : ' <span class="muted">(según flota, verificar)</span>'}` : '')}
    ${line('Combustible', fuelGauge(outFuel))}
  </table></div>
  <div><h2>Devolución del vehículo</h2><table>
    ${line('Fecha y hora', c && c.in_at ? fmtDT(c.in_at) : '')}
    ${line('Kilómetros', c && c.in_at ? `${Number(c.in_km).toLocaleString('es-AR')} km` : '')}
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
  <div>Conductor adicional<small>Aclaración:<br>DNI:</small></div>
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
  w.focus();
  setTimeout(() => w.print(), 300);
}

/* ============================================================
   Planning (grilla de ocupación, estilo Rently)
   ============================================================ */
let planningFrom = null;
on(/^\/planning$/, async (view) => {
  if (!planningFrom) {
    const t = new Date();
    planningFrom = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1);
  }
  const days = 14;
  const fromStr = localISO(planningFrom).slice(0, 10);
  const p = await GET(`/planning?from=${fromStr}&days=${days}`);
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
    return `<div class="pl-bar ${r.status}" style="left:${l}%;width:${Math.max(rr - l, 0.8)}%" data-href="#/reservas/${r.id}"
      title="${esc(r.code)} · ${esc(r.customer_name)} · ${fmtDT(r.pickup_at)} → ${fmtDT(r.return_at)}">${esc(r.customer_name)}</div>`;
  };
  const mbar = (m) => {
    const l = Math.max(0, pos(`${m.start_date || fromStr}T00:00`));
    const endD = m.end_date || localISO(addDays(planningFrom, days)).slice(0, 10);
    const rr = Math.min(100, pos(`${endD}T23:59`));
    if (rr <= 0 || l >= 100) return '';
    return `<div class="pl-bar mant" style="left:${l}%;width:${rr - l}%" title="Mantenimiento: ${esc(m.kind || '')}">Taller</div>`;
  };
  const todayStr = localISO(new Date()).slice(0, 10);
  const dayCells = Array.from({ length: days }, (_, i) => {
    const d = addDays(planningFrom, i);
    const ds = localISO(d).slice(0, 10);
    const wk = d.getDay() === 0 || d.getDay() === 6;
    return `<div class="${ds === todayStr ? 'today' : wk ? 'weekend' : ''}">${['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá'][d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}</div>`;
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
    <div class="page-head"><h1>Planning de flota</h1>
      <div class="actions"><button class="btn" data-nav="-7">◀ Semana</button><button class="btn" data-nav="0">Hoy</button><button class="btn" data-nav="7">Semana ▶</button></div></div>
    <div class="legend" style="margin-bottom:10px">
      <span style="--c:#e0a100">Pendiente</span><span style="--c:#1f6feb">Confirmada</span><span style="--c:#1a9b5b">En curso</span>
      <span style="--c:#8b94a6">Finalizada</span><span style="--c:#d1373a">Taller</span><span>· Tocá una barra para abrir la reserva · <b>Deslizá el dedo (o arrastrá con el mouse) sobre la fila de un auto para crear una reserva</b></span></div>
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

  container.addEventListener('pointerdown', (e) => {
    const track = e.target.closest('.pl-drag');
    if (!track || e.target.closest('.pl-bar') || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const startDay = dayAt(track, e.clientX);
    drag = { track, vehicleId: Number(track.dataset.vehicle), startDay, endDay: startDay, x0: e.clientX, moved: false, el: document.createElement('div') };
    drag.el.className = 'pl-sel';
    track.appendChild(drag.el);
    track.setPointerCapture(e.pointerId);
    paint();
  });

  container.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x0) > 6) drag.moved = true;
    const d = dayAt(drag.track, e.clientX);
    if (d !== drag.endDay) {
      drag.endDay = d;
      paint();
    }
  });

  const finish = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.el.remove();
    if (e.type === 'pointercancel' || !d.moved) return;
    if (d.bad) return toast(d.past ? 'No se puede reservar en días que ya pasaron' : 'Ese auto ya está ocupado (o en taller) en esas fechas', true);
    location.hash = `#/reservas/nueva?vehiculo=${d.vehicleId}&desde=${d.from.slice(0, 10)}&hasta=${d.to.slice(0, 10)}`;
  };
  container.addEventListener('pointerup', finish);
  container.addEventListener('pointercancel', finish);
}

/* ============================================================
   Pantallas de ABM (flota, clientes, tarifas, mantenimiento)
   ============================================================ */
const CUSTOMER_FIELDS = [
  { name: 'full_name', label: 'Nombre y apellido', required: true, full: true },
  { name: 'doc_type', label: 'Tipo doc.', type: 'select', options: ['DNI', 'Pasaporte', 'CI', 'Otro'].map((x) => [x, x]), default: 'DNI' },
  { name: 'doc_number', label: 'Número de documento' },
  { name: 'phone', label: 'Teléfono / WhatsApp' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'birth_date', label: 'Fecha de nacimiento', type: 'date' },
  { name: 'license_number', label: 'Licencia de conducir N°' },
  { name: 'license_expiry', label: 'Vencimiento licencia', type: 'date' },
  { name: 'address', label: 'Domicilio', full: true },
  { name: 'notes', label: 'Notas', type: 'textarea', full: true },
];

const VEHICLE_FIELDS = [
  { name: 'plate', label: 'Patente', required: true },
  { name: 'category_id', label: 'Categoría', type: 'select', required: true, options: () => state.categories.map((c) => [c.id, `${c.code} · ${c.name}`]) },
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
  { name: 'notes', label: 'Notas', type: 'textarea', full: true },
];

/** Pantalla de listado + alta/edición/baja genérica. */
function crudPage({ title, endpoint, fields, columns, searchable, after, before, extraActions, canWrite = () => true, canDelete, nav }) {
  const mayDelete = () => (canDelete ? canDelete() : canWrite());
  return async (view) => {
    if (before) await before();
    view.innerHTML = `<div class="page-head"><h1>${esc(title)}</h1>${canWrite() ? '<button class="btn primary" data-new>+ Agregar</button>' : ''}</div>
      ${searchable ? '<div class="toolbar"><input id="crud-q" placeholder="Buscar…"/></div>' : ''}
      <div class="table-wrap" id="crud-table"></div>`;
    const load = async () => {
      const q = searchable ? $('#crud-q').value.trim() : '';
      const rows = await GET(`/${endpoint}${q ? `?q=${encodeURIComponent(q)}` : ''}`);
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
          if (!confirm('¿Borrar este registro?')) return;
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
          await POST(`/${endpoint}`, d);
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

on(
  /^\/flota$/,
  crudPage({
    title: 'Flota',
    endpoint: 'vehicles',
    canDelete: () => isAdmin(),
    fields: VEHICLE_FIELDS,
    searchable: true,
    columns: [
      { label: 'Patente', render: (r) => `<b>${esc(r.plate)}</b>` },
      { label: 'Vehículo', render: (r) => `${esc(r.brand || '')} ${esc(r.model || '')} ${r.year ? `<small class="muted">${esc(r.year)}</small>` : ''}` },
      { label: 'Categoría', render: (r) => esc(r.category_code) },
      { label: 'Sucursal', key: 'branch_name' },
      { label: 'Km', render: (r) => Number(r.km).toLocaleString('es-AR') },
      { label: 'Comb.', render: (r) => fuel(r.fuel) },
      { label: 'Estado', render: (r) => badge(r.status) },
      { label: 'Seguro / VTV', render: (r) => `<small>${fmtD(r.insurance_expiry)} / ${fmtD(r.vtv_expiry)}</small>` },
    ],
    extraActions: (r) => `<a class="btn small" href="#/reservas?vehiculo=${r.id}" data-hist="${r.id}">Historial</a> `,
    nav: (tr, r) => {
      const a = tr.querySelector('[data-hist]');
      if (a)
        a.addEventListener('click', async (e) => {
          e.preventDefault();
          const rows = await GET(`/reservations?vehicle_id=${r.id}&limit=50`);
          openModal(`Historial · ${r.plate}`, historyTable(rows));
        });
    },
  }),
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
      `<button class="btn small" data-hist="${r.id}">Reservas</button> ${isAdmin() && !r.anonymized_at ? `<button class="btn small" data-anon="${r.id}">Anonimizar</button> ` : ''}`,
    nav: (tr, r) => {
      const b = tr.querySelector('[data-hist]');
      if (b)
        b.addEventListener('click', async () => {
          const rows = await GET(`/reservations?customer_id=${r.id}&limit=50`);
          openModal(`Reservas de ${r.full_name}`, historyTable(rows));
        });
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

on(
  /^\/mantenimiento$/,
  crudPage({
    title: 'Mantenimiento y taller',
    endpoint: 'maintenance',
    canDelete: () => isAdmin(),
    before: async () => {
      state.vehiclesCache = await GET('/vehicles');
    },
    searchable: true,
    fields: [
      { name: 'vehicle_id', label: 'Vehículo', type: 'select', required: true, options: () => (state.vehiclesCache || []).map((v) => [v.id, `${v.plate} · ${v.brand} ${v.model}`]) },
      { name: 'kind', label: 'Tipo', type: 'select', options: ['service', 'reparacion', 'neumaticos', 'chapa_pintura', 'limpieza', 'otro'].map((x) => [x, x]), default: 'service' },
      { name: 'status', label: 'Estado', type: 'select', options: [['abierto', 'Abierto (vehículo en taller)'], ['cerrado', 'Cerrado (vuelve a la flota)']], required: true, default: 'abierto' },
      { name: 'start_date', label: 'Desde', type: 'date' },
      { name: 'end_date', label: 'Hasta', type: 'date' },
      { name: 'km', label: 'Km', type: 'number' },
      { name: 'cost', label: 'Costo', type: 'number', default: 0 },
      { name: 'description', label: 'Descripción', type: 'textarea', full: true },
    ],
    columns: [
      { label: 'Vehículo', render: (r) => `<b>${esc(r.plate)}</b> <small>${esc(r.brand)} ${esc(r.model)}</small>` },
      { label: 'Tipo', key: 'kind' },
      { label: 'Descripción', key: 'description' },
      { label: 'Fechas', render: (r) => `${fmtD(r.start_date)} → ${fmtD(r.end_date) || '…'}` },
      { label: 'Costo', render: (r) => money(r.cost) },
      { label: 'Estado', render: (r) => badge(r.status) },
    ],
  }),
  'mantenimiento',
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
        { name: 'deposit', label: 'Garantía', type: 'number', default: 0 },
        { name: 'km_per_day', label: 'Km incluidos por día (0 = libres)', type: 'number', default: 0 },
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
        { label: 'Km/día', render: (r) => esc(r.km_per_day || 'Libres') },
        { label: 'Alias', render: (r) => `<small class="muted">${esc(r.aliases || '')}</small>` },
        { label: 'Activa', render: (r) => (r.active ? '✔' : '—') },
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
  const current = state.tarifasTab || 'categories';
  view.innerHTML = `<div class="tabs">${tabs.map((t) => `<button data-tab="${t.key}" class="${t.key === current ? 'active' : ''}">${t.label}</button>`).join('')}</div><div id="tab-body"></div>
    ${isAdmin() ? '' : '<p class="muted">Sólo los administradores pueden modificar tarifas.</p>'}`;
  $$('[data-tab]', view).forEach((b) =>
    b.addEventListener('click', () => {
      state.tarifasTab = b.dataset.tab;
      route();
    }),
  );
  const tab = tabs.find((t) => t.key === current);
  await crudPage({ title: tab.label, endpoint: tab.key, fields: tab.fields, columns: tab.columns, canWrite: isAdmin, after: loadCatalogs })($('#tab-body'));
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
    ['out', 'Avisos salientes'],
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
    body.innerHTML = `
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
      if (!confirm('El cotizador dejará de funcionar hasta que cargues la nueva clave. ¿Continuar?')) return;
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
on(/^\/config$/, async (view) => {
  const s = await GET('/settings');
  view.innerHTML = `<div class="page-head"><h1>Configuración</h1></div><div class="card">${formHtml(
    [
      { name: 'company_name', label: 'Nombre de la empresa', required: true },
      { name: 'company_tax_id', label: 'CUIT' },
      { name: 'company_phone', label: 'Teléfono' },
      { name: 'company_address', label: 'Dirección', full: true },
      { name: 'currency', label: 'Moneda', type: 'select', options: [['ARS', 'Pesos (ARS)'], ['USD', 'Dólares (USD)']], required: true },
      { name: 'tax_rate', label: 'IVA %', type: 'number' },
      { name: 'prices_include_tax', label: 'Las tarifas incluyen IVA', type: 'checkbox' },
      { name: 'grace_hours', label: 'Tolerancia (horas) antes de cobrar un día más', type: 'number' },
      { name: 'one_way_fee', label: 'Recargo por devolver en otro lugar', type: 'number' },
      { name: 'fuel_charge_per_eighth', label: 'Cargo por cada 1/8 de combustible faltante', type: 'number' },
      { name: 'min_driver_age', label: 'Edad mínima del conductor', type: 'number' },
      { name: 'deductible_amount', label: 'Franquicia del seguro (vacío = la de la póliza)', type: 'number' },
      { name: 'jurisdiction', label: 'Jurisdicción del contrato (tribunales de...)', full: true },
      { name: 'contract_terms', label: 'Condiciones generales del contrato (un párrafo por cláusula, separadas por una línea en blanco)', type: 'textarea', full: true, rows: 16 },
    ],
    s,
  )}</div>`;
  $('form', view).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    f.prices_include_tax = f.prices_include_tax ? '1' : '0';
    await run(() => PUT('/settings', f), 'Configuración guardada');
    await loadCatalogs();
  });
  $('[data-close]', view).remove();
  const terms = $('[name=contract_terms]', view);
  const help = document.createElement('div');
  help.className = 'full';
  help.innerHTML = `<p class="muted" style="margin:0 0 8px">Estas palabras se completan solas en cada contrato: <code>{empresa}</code> <code>{tolerancia}</code> <code>{edad_minima}</code>
    <code>{cargo_combustible}</code> <code>{kilometraje}</code> <code>{franquicia}</code> <code>{garantia}</code> <code>{jurisdiccion}</code>.
    Son condiciones de uso habitual: conviene que las revise un abogado antes de usarlas.</p>
    <button type="button" class="btn small" id="terms-reset">Restaurar condiciones sugeridas</button>`;
  terms.closest('label').after(help);
  $('#terms-reset', view).addEventListener('click', () => {
    if (!confirm('¿Reemplazar el texto actual por las condiciones sugeridas? (se aplica al guardar)')) return;
    terms.value = s.contract_terms_default || '';
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
              `<tr><td class="nowrap">${esc(new Date(a.at).toLocaleString('es-AR', { hour12: false }))}</td><td>${esc(AUDIT_LABEL[a.action] || a.action)}</td><td>${esc(a.email || '')}</td><td><small>${esc(a.detail || '')}</small></td><td><small class="muted">${esc(a.ip || '')}</small></td></tr>`,
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
      <p class="muted">${esc(st.fileName)} · ${a.total_rows} fila(s). Revisá lo que reconoció el sistema y corregí lo que haga falta.</p>
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
    if (!dryRun && !confirm(`¿Importar ${st.analysis.total_rows} fila(s) de ${IMPORT_KINDS.find((k) => k.key === st.kind).label.slice(4)}?`)) return;
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
   Inicio
   ============================================================ */
// Limpia el token que guardaban las versiones anteriores (ahora la sesión es una cookie protegida).
try {
  localStorage.removeItem('token');
} catch {}
startSession();
