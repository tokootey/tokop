/*
 * Asistente de reservas para la página web de la agencia.
 *
 *   <script src="https://TU-SERVIDOR/chat.js" async></script>
 *
 * Opcional: data-color="#1f6feb" (color del botón) y data-open="1" (abre solo al cargar).
 * Muestra una burbuja de chat: responde qué autos hay libres y cuánto cuestan, contesta las
 * preguntas frecuentes y deja la reserva pendiente en el sistema para que la agencia la confirme.
 * Todo se dibuja dentro de un Shadow DOM para no mezclarse con los estilos de la página.
 */
(function () {
  'use strict';
  if (window.RentChat) return;

  const script = document.currentScript;
  const scriptBase = script && script.src ? new URL(script.src, location.href).origin : '';

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.fab { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; border: 0; border-radius: 999px; padding: 13px 18px; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; box-shadow: 0 8px 24px rgba(0,0,0,.22); }
.panel { position: fixed; right: 18px; bottom: 76px; z-index: 2147483000; width: min(380px, calc(100vw - 24px)); height: min(560px, calc(100vh - 100px)); background: #fff; color: #1d2433; border-radius: 16px; box-shadow: 0 16px 48px rgba(0,0,0,.25); display: flex; flex-direction: column; overflow: hidden; }
.inline .panel, .inline .fab { position: static; }
.inline .panel { width: 100%; height: 540px; box-shadow: 0 2px 10px rgba(0,0,0,.08); border: 1px solid #e3e8ef; }
.head { padding: 14px 16px; color: #fff; display: flex; justify-content: space-between; align-items: center; }
.head b { font-size: 15px; }
.head button { background: none; border: 0; color: #fff; font-size: 20px; cursor: pointer; line-height: 1; }
.log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; background: #f6f8fb; }
.msg { max-width: 88%; padding: 10px 12px; border-radius: 12px; font-size: 14px; line-height: 1.45; white-space: pre-line; }
.bot { background: #fff; border: 1px solid #e3e8ef; align-self: flex-start; }
.me { color: #fff; align-self: flex-end; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 1px solid; background: #fff; border-radius: 999px; padding: 7px 12px; font-size: 13px; cursor: pointer; }
.card { background: #fff; border: 1px solid #e3e8ef; border-radius: 12px; padding: 10px 12px; display: grid; gap: 4px; font-size: 14px; }
.card .price { font-size: 17px; font-weight: 700; }
.card small { color: #5b6577; }
form { display: grid; gap: 8px; background: #fff; border: 1px solid #e3e8ef; border-radius: 12px; padding: 12px; }
label { display: grid; gap: 3px; font-size: 12px; color: #5b6577; font-weight: 600; }
input, select, textarea { font: inherit; font-size: 14px; padding: 8px 9px; border: 1px solid #cfd6e1; border-radius: 8px; width: 100%; color: #1d2433; background: #fff; }
.row { display: grid; grid-template-columns: 1fr 96px; gap: 8px; }
.go { border: 0; color: #fff; border-radius: 8px; padding: 10px; font-size: 14px; font-weight: 600; cursor: pointer; }
.go:disabled { opacity: .6; cursor: default; }
.err { color: #b42318; font-size: 13px; }
.trap { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; }
.foot { padding: 8px 12px; font-size: 11px; color: #8a94a6; text-align: center; border-top: 1px solid #eef1f5; }
`;

  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  }

  function mount(target, opts = {}) {
    const base = opts.base !== undefined ? opts.base : scriptBase;
    const color = opts.color || '#1f6feb';
    const inline = Boolean(target);
    const host = target || document.body.appendChild(el('div', { id: 'rent-chat' }));
    const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.append(el('style', {}, CSS));
    const wrap = el('div', { class: inline ? 'inline' : '' });
    root.append(wrap);

    let cfg = null;
    let money = (n) => String(n);
    let lastSearch = null;

    const api = async (path, body) => {
      const res = await fetch(`${base}/api/public/chat${path}${opts.empresa ? `?empresa=${encodeURIComponent(opts.empresa)}` : ''}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No pudimos responder ahora. Probá de nuevo en un rato.');
      return data;
    };

    const fab = el('button', { class: 'fab', style: `background:${color}`, type: 'button' }, 'Consultá disponibilidad');
    const log = el('div', { class: 'log', role: 'log', 'aria-live': 'polite' });
    const title = el('b', {}, 'Reservas');
    const panel = el(
      'div',
      { class: 'panel', role: 'dialog', 'aria-label': 'Asistente de reservas', style: inline ? '' : 'display:none' },
      el('div', { class: 'head', style: `background:${color}` }, title, inline ? null : el('button', { type: 'button', 'aria-label': 'Cerrar', onclick: () => toggle(false) }, '×')),
      log,
      el('div', { class: 'foot' }, 'La agencia confirma cada reserva por email o teléfono.'),
    );
    if (!inline) wrap.append(fab);
    wrap.append(panel);

    const say = (text, who = 'bot') => {
      const m = el('div', { class: `msg ${who}`, style: who === 'me' ? `background:${color}` : '' }, text);
      log.append(m);
      log.scrollTop = log.scrollHeight;
      return m;
    };
    const put = (node) => {
      log.append(node);
      log.scrollTop = log.scrollHeight;
      return node;
    };
    const chips = (items) =>
      put(el('div', { class: 'chips' }, items.map(([label, fn]) => el('button', { class: 'chip', type: 'button', style: `color:${color};border-color:${color}`, onclick: fn }, label))));

    function menu() {
      const items = [['Ver autos y precios', () => { say('Quiero ver autos y precios', 'me'); askDates(); }]];
      for (const f of cfg.faq) items.push([f.q, () => { say(f.q, 'me'); say(f.a); menu(); }]);
      if (cfg.whatsapp) items.push(['Hablar con una persona', () => { say('Quiero hablar con una persona', 'me'); whatsapp(); }]);
      chips(items);
    }

    function whatsapp(context) {
      const text = encodeURIComponent(context || `Hola ${cfg.company}, quiero consultar por un alquiler.`);
      put(el('div', { class: 'card' }, 'Escribinos por WhatsApp y te atiende una persona:', el('a', { href: `https://wa.me/${cfg.whatsapp}?text=${text}`, target: '_blank', rel: 'noopener' }, 'Abrir WhatsApp')));
    }

    const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    function askDates() {
      say('¿Para qué fechas lo necesitás?');
      const today = new Date();
      const f = el('form', {});
      const pd = el('input', { type: 'date', name: 'pd', required: true, min: isoDay(today), value: isoDay(new Date(today.getTime() + 86400000)) });
      const pt = el('input', { type: 'time', name: 'pt', value: '10:00', required: true });
      const rd = el('input', { type: 'date', name: 'rd', required: true, min: isoDay(today), value: isoDay(new Date(today.getTime() + 4 * 86400000)) });
      const rt = el('input', { type: 'time', name: 'rt', value: '10:00', required: true });
      const br = cfg.branches.length > 1 ? el('select', { name: 'br' }, cfg.branches.map((b) => el('option', { value: b.code }, b.name))) : null;
      const err = el('div', { class: 'err' });
      const btn = el('button', { class: 'go', type: 'submit', style: `background:${color}` }, 'Buscar autos disponibles');
      f.append(el('div', { class: 'row' }, el('label', {}, 'Retiro', pd), el('label', {}, 'Hora', pt)), el('div', { class: 'row' }, el('label', {}, 'Devolución', rd), el('label', {}, 'Hora', rt)), br ? el('label', {}, 'Lugar de retiro', br) : null, err, btn);
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.textContent = '';
        btn.disabled = true;
        const search = { pickup_at: `${pd.value}T${pt.value}`, return_at: `${rd.value}T${rt.value}`, pickup_branch: br ? br.value : cfg.branches[0] && cfg.branches[0].code };
        try {
          const r = await api('/quote', search);
          f.remove();
          lastSearch = search;
          const place = br ? ` en ${br.selectedOptions[0].textContent}` : '';
          say(`Del ${pd.value.split('-').reverse().join('/')} ${pt.value} al ${rd.value.split('-').reverse().join('/')} ${rt.value}${place}`, 'me');
          showOptions(r.options);
        } catch (ex) {
          err.textContent = ex.message;
          btn.disabled = false;
        }
      });
      put(f);
    }

    function showOptions(options) {
      if (!options.length) {
        say('Para esas fechas no nos quedan autos disponibles. Podés probar con otras fechas.');
        chips([['Probar otras fechas', askDates]].concat(cfg.whatsapp ? [['Hablar con una persona', () => whatsapp()]] : []));
        return;
      }
      say(`Tenemos ${options.length === 1 ? 'esta opción' : 'estas opciones'} (precio final por ${options[0].days} día${options[0].days === 1 ? '' : 's'}):`);
      for (const o of options) {
        const details = [o.seats ? `${o.seats} plazas` : '', o.transmission || ''].filter(Boolean).join(' · ');
        put(
          el(
            'div',
            { class: 'card' },
            el('b', {}, o.name),
            details ? el('small', {}, details) : null,
            o.description ? el('small', {}, o.description) : null,
            el('span', { class: 'price' }, money(o.total)),
            o.deposit ? el('small', {}, `Garantía: ${money(o.deposit)}`) : null,
            o.few_left ? el('small', { style: 'color:#b42318' }, '¡Queda poca disponibilidad!') : null,
            el('button', { class: 'go', type: 'button', style: `background:${color}`, onclick: () => { say(`Quiero el ${o.name}`, 'me'); askContact(o); } }, 'Reservar este'),
          ),
        );
      }
      chips([['Cambiar fechas', askDates]]);
    }

    function askContact(option) {
      say('¡Buena elección! Dejanos tus datos y la agencia te confirma la reserva.');
      const f = el('form', {});
      const name = el('input', { name: 'name', required: true, autocomplete: 'name', maxlength: 120 });
      const email = el('input', { name: 'email', type: 'email', autocomplete: 'email', maxlength: 160 });
      const phone = el('input', { name: 'phone', type: 'tel', autocomplete: 'tel', maxlength: 40 });
      const flight = el('input', { name: 'flight', maxlength: 40 });
      const notes = el('textarea', { name: 'notes', rows: 2, maxlength: 500 });
      const trap = el('input', { name: '_gotcha', class: 'trap', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
      const err = el('div', { class: 'err' });
      const btn = el('button', { class: 'go', type: 'submit', style: `background:${color}` }, 'Pedir la reserva');
      f.append(
        el('label', {}, 'Nombre y apellido', name),
        el('label', {}, 'Email', email),
        el('label', {}, 'Teléfono / WhatsApp', phone),
        el('label', {}, 'Vuelo (opcional)', flight),
        el('label', {}, 'Comentarios (opcional)', notes),
        trap,
        err,
        btn,
      );
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.textContent = '';
        if (!email.value && !phone.value) {
          err.textContent = 'Dejanos un email o un teléfono para confirmarte.';
          return;
        }
        btn.disabled = true;
        try {
          const r = await api('/book', { ...lastSearch, category: option.code, name: name.value, email: email.value, phone: phone.value, flight: flight.value, notes: notes.value, _gotcha: trap.value });
          f.remove();
          say(
            r.code
              ? `¡Listo! Recibimos tu pedido de reserva ${r.code}. En breve te confirmamos por ${email.value ? 'email' : 'teléfono'}.`
              : '¡Listo! Recibimos tu pedido. En breve te contactamos para confirmarlo.',
          );
          chips([['Hacer otra consulta', menu]]);
        } catch (ex) {
          err.textContent = ex.message;
          btn.disabled = false;
        }
      });
      put(f);
    }

    let started = false;
    async function start() {
      if (started) return;
      started = true;
      try {
        cfg = await api('/config');
      } catch (ex) {
        say(ex.message);
        started = false;
        return;
      }
      title.textContent = cfg.company || 'Reservas';
      try {
        const fmt = new Intl.NumberFormat(cfg.locale || 'es-AR', { style: 'currency', currency: cfg.currency || 'ARS', maximumFractionDigits: 0 });
        money = (n) => fmt.format(n || 0);
      } catch {
        money = (n) => `${cfg.currency || ''} ${Math.round(n || 0)}`;
      }
      say(cfg.welcome);
      menu();
    }

    function toggle(open) {
      panel.style.display = open ? '' : 'none';
      fab.style.display = open ? 'none' : '';
      if (open) start();
    }
    fab.addEventListener('click', () => toggle(true));
    if (inline) start();
    else if (opts.open) toggle(true);
    return { open: () => toggle(true), close: () => toggle(false) };
  }

  window.RentChat = { mount };
  // Uso normal: el script se carga en la página de la agencia y muestra la burbuja.
  if (script && script.src && !script.hasAttribute('data-manual')) {
    const go = () =>
      mount(null, { color: script.getAttribute('data-color') || undefined, open: script.getAttribute('data-open') === '1', empresa: script.getAttribute('data-empresa') || undefined });
    if (document.body) go();
    else document.addEventListener('DOMContentLoaded', go);
  }
})();
