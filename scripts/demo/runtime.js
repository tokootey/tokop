/*
 * Runtime de la demo: hace funcionar el servidor de la app (src/) dentro del navegador.
 * - SQLite en el navegador (sql.js) en lugar de node:sqlite.
 * - Un mini Express que atiende las llamadas a /api/... interceptando fetch().
 * - Los datos se guardan en el navegador (localStorage) para que sobrevivan a una recarga.
 * Lo usa scripts/build-demo.js, que completa `modules` con el código de src/.
 */
(function () {
  'use strict';
  const STORE_KEY = 'rentacar-demo-db-v1';
  const COOKIE_KEY = 'rentacar-demo-cookies';

  /* ---------- Cookies (la sesión de la app es una cookie; acá se guarda en el navegador) ---------- */
  let jar = {};
  try {
    jar = JSON.parse(localStorage.getItem(COOKIE_KEY) || '{}');
  } catch {
    jar = {};
  }
  const saveJar = () => {
    try {
      localStorage.setItem(COOKIE_KEY, JSON.stringify(jar));
    } catch {}
  };
  const cookieHeader = () =>
    Object.entries(jar)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('; ');
  const modules = __MODULES__;

  /* ---------- Buffer mínimo ---------- */
  class Buffer extends Uint8Array {
    static from(v, enc) {
      if (typeof v === 'string') {
        if (enc === 'hex') {
          const b = new Buffer(v.length / 2);
          for (let i = 0; i < b.length; i++) b[i] = parseInt(v.substr(i * 2, 2), 16);
          return b;
        }
        const u = new TextEncoder().encode(v);
        const b = new Buffer(u.length);
        b.set(u);
        return b;
      }
      const b = new Buffer(v.length);
      b.set(v);
      return b;
    }
    static isBuffer(x) {
      return x instanceof Uint8Array;
    }
    toString(enc) {
      if (enc === 'hex') return Array.from(this, (x) => x.toString(16).padStart(2, '0')).join('');
      return new TextDecoder().decode(this);
    }
  }
  globalThis.Buffer = globalThis.Buffer || Buffer;
  globalThis.process = globalThis.process || { env: {} };

  /* ---------- node:crypto (suficiente para una demo; no es criptografía real) ---------- */
  const hashBytes = (str, len) => {
    const out = new Buffer(len);
    let h = 2166136261;
    const s = String(str);
    for (let i = 0; i < len; i++) {
      for (let j = 0; j < s.length; j++) {
        h ^= s.charCodeAt(j) + i;
        h = Math.imul(h, 16777619) >>> 0;
      }
      out[i] = h & 255;
    }
    return out;
  };
  const nodeCrypto = {
    randomBytes(n) {
      const b = new Buffer(n);
      crypto.getRandomValues(b);
      return b;
    },
    scryptSync: (pw, salt, len) => hashBytes(`${pw}:${salt}`, len),
    timingSafeEqual: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
    createHmac(_alg, key) {
      let data = '';
      return { update(d) { data += d; return this; }, digest: () => hashBytes(key + data, 32).toString('hex') };
    },
    createHash() {
      let data = '';
      return { update(d) { data += String(d); return this; }, digest: () => hashBytes(data, 20).toString('hex') };
    },
  };

  const nodeFs = {
    mkdirSync() {},
    existsSync: () => false,
    readFileSync() {
      throw new Error('Sin sistema de archivos en la demo');
    },
    writeFileSync() {},
    rmSync() {},
  };
  const nodePath = {
    join: (...p) => p.filter(Boolean).join('/').replace(/\/+/g, '/'),
    dirname: (p) => String(p).replace(/\/[^/]*$/, '') || '.',
  };

  /* ---------- node:sqlite sobre sql.js ---------- */
  let SQL;
  let current = null; // base abierta (para exportarla)
  let initialBytes = null;
  class DatabaseSync {
    constructor() {
      this.raw = initialBytes ? new SQL.Database(initialBytes) : new SQL.Database();
      current = this;
    }
    exec(sql) {
      this.raw.exec(sql);
    }
    prepare(sql) {
      const db = this.raw;
      const norm = (args) => args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
      return {
        run: (...args) => {
          db.run(sql, norm(args));
          const changes = db.getRowsModified();
          const r = db.exec('SELECT last_insert_rowid()');
          return { changes, lastInsertRowid: r[0].values[0][0] };
        },
        get: (...args) => {
          const st = db.prepare(sql);
          try {
            st.bind(norm(args));
            return st.step() ? st.getAsObject() : undefined;
          } finally {
            st.free();
          }
        },
        all: (...args) => {
          const st = db.prepare(sql);
          const out = [];
          try {
            st.bind(norm(args));
            while (st.step()) out.push(st.getAsObject());
          } finally {
            st.free();
          }
          return out;
        },
      };
    }
  }

  /* ---------- Mini Express ---------- */
  function compile(path, end) {
    if (path instanceof RegExp) return { re: path, keys: [] };
    const keys = [];
    const src = path
      .replace(/\/$/, '')
      .replace(/[.]/g, '\\.')
      .replace(/:(\w+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      });
    return { re: new RegExp('^' + src + (end ? '/?$' : '(?=/|$)')), keys };
  }
  function Router() {
    const layers = [];
    const router = (req, res, next) => router.handle(req, res, next);
    const add = (method, end) => (path, ...handlers) => {
      if (typeof path === 'function') {
        handlers.unshift(path);
        path = null;
      }
      const { re, keys } = path === null ? { re: /^/, keys: [] } : compile(path, end);
      for (const h of handlers.flat()) layers.push({ method, re, keys, h, mount: !end });
      return router;
    };
    router.use = add(null, false);
    for (const m of ['get', 'post', 'put', 'delete']) router[m] = add(m.toUpperCase(), true);
    router.handle = (req, res, out) => {
      let i = 0;
      const basePath = req.path;
      const next = (err) => {
        req.path = basePath;
        const layer = layers[i++];
        if (!layer) return out(err);
        if (layer.method && layer.method !== req.method) return next(err);
        const m = layer.re.exec(basePath || '/');
        if (!m) return next(err);
        const isErrHandler = layer.h.length === 4;
        if (err ? !isErrHandler : isErrHandler) return next(err);
        if (layer.keys.length) {
          req.params = { ...req.params };
          layer.keys.forEach((k, j) => (req.params[k] = decodeURIComponent(m[j + 1])));
        }
        if (layer.mount) req.path = basePath.slice(m[0].length) || '/';
        try {
          const r = err ? layer.h(err, req, res, next) : layer.h(req, res, next);
          if (r && typeof r.then === 'function') r.catch(next);
        } catch (e) {
          next(e);
        }
      };
      next();
    };
    return router;
  }
  function express() {
    const app = Router();
    app.disable = () => {};
    app.set = () => {};
    return app;
  }
  const passthrough = () => (_req, _res, next) => next();
  express.Router = Router;
  express.json = passthrough;
  express.urlencoded = passthrough;
  express.raw = passthrough;
  express.static = passthrough;

  /* ---------- Cargador de módulos (CommonJS) ---------- */
  const builtins = { 'node:sqlite': { DatabaseSync }, 'node:crypto': nodeCrypto, 'node:fs': nodeFs, 'node:path': nodePath, express };
  const cache = {};
  function resolve(from, name) {
    const parts = from.split('/').slice(0, -1);
    for (const seg of name.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    return parts.join('/');
  }
  function makeRequire(from) {
    return (name) => {
      if (builtins[name]) return builtins[name];
      let p = resolve(from, name);
      if (!modules[p] && modules[p + '.js']) p += '.js';
      if (!modules[p]) throw new Error(`Módulo no incluido en la demo: ${name}`);
      if (cache[p]) return cache[p].exports;
      const module = { exports: {} };
      cache[p] = module;
      modules[p](module, module.exports, makeRequire(p), `/app/${p}`, `/app/${p}`.replace(/\/[^/]*$/, ''));
      return module.exports;
    };
  }

  /* ---------- Guardado en el navegador ---------- */
  const toB64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const bytes = current.raw.export();
        current.raw.exec('PRAGMA foreign_keys = ON;'); // export() reabre la base
        localStorage.setItem(STORE_KEY, toB64(bytes));
      } catch (e) {
        console.warn('No se pudieron guardar los datos de la demo en este navegador', e);
      }
    }, 300);
  }

  /* ---------- Arranque del "servidor" ---------- */
  let app;
  const ready = (async () => {
    SQL = await initSqlJs();
    let saved = null;
    try {
      saved = localStorage.getItem(STORE_KEY);
    } catch {
      saved = null;
    }
    if (saved) {
      try {
        initialBytes = fromB64(saved);
      } catch {
        initialBytes = null;
      }
    }
    const req = makeRequire('');
    const { openDb, setSetting } = req('./src/db.js');
    const { createApp, ensureAdmin } = req('./src/app.js');
    const db = openDb(':memory:');
    if (!initialBytes) {
      ensureAdmin(db);
      req('./src/seed.js').seed(db);
      setSetting(db, 'company_name', 'Rent a Car Ushuaia');
      scheduleSave();
    }
    // En la demo no se obliga a cambiar la contraseña de ejemplo.
    db.prepare('UPDATE users SET must_change_password = 0').run();
    app = createApp(db);
  })();

  async function handle(url, init) {
    await ready;
    const u = new URL(url, location.href);
    const headers = new Headers(init.headers || {});
    const method = (init.method || 'GET').toUpperCase();
    const ctype = (headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    let body = {};
    if (init.body != null) {
      if (ctype === 'application/json') {
        try {
          body = JSON.parse(typeof init.body === 'string' ? init.body : await new Response(init.body).text());
        } catch {
          return new Response(JSON.stringify({ error: 'JSON inválido' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
      } else if (ctype === 'application/x-www-form-urlencoded') {
        body = Object.fromEntries(new URLSearchParams(String(init.body)));
      } else {
        body = init.body instanceof Blob ? init.body : new Blob([init.body]);
      }
    }
    const req = {
      method,
      url: u.pathname + u.search,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      params: {},
      body,
      ip: 'demo',
      protocol: location.protocol.replace(':', ''),
      get: (h) => {
        const name = h.toLowerCase();
        if (name === 'host') return location.host;
        if (name === 'cookie') return cookieHeader() || undefined;
        return headers.get(h) ?? undefined;
      },
      is: (t) => ctype.includes(String(t).replace('*', '')),
      accepts: (list) => (Array.isArray(list) ? list[0] : list),
    };
    return new Promise((resolveResponse) => {
      const out = { status: 200, headers: new Headers() };
      let done = false;
      const finish = (payload) => {
        if (done) return;
        done = true;
        const noBody = out.status === 204 || out.status === 304;
        resolveResponse(new Response(noBody ? null : payload, { status: out.status, headers: out.headers }));
        if (method !== 'GET') scheduleSave();
      };
      const res = {
        status(n) {
          out.status = n;
          return res;
        },
        set(k, v) {
          out.headers.set(k, String(v));
          return res;
        },
        type(t) {
          out.headers.set('Content-Type', t === 'html' ? 'text/html' : t);
          return res;
        },
        json(o) {
          out.headers.set('Content-Type', 'application/json');
          finish(JSON.stringify(o));
        },
        send: (s) => finish(s),
        end: () => finish(null),
        redirect(code, to) {
          out.status = code;
          out.headers.set('Location', to);
          finish(null);
        },
        sendFile() {
          out.status = 404;
          finish(null);
        },
        blob: (b) => finish(b),
        cookie(name, value) {
          jar[name] = value;
          saveJar();
          return res;
        },
        clearCookie(name) {
          delete jar[name];
          saveJar();
          return res;
        },
      };
      app.handle(req, res, (err) => {
        if (err) {
          console.error(err);
          out.status = 500;
          res.json({ error: err.message });
        } else {
          out.status = 404;
          res.json({ error: 'Ruta inexistente' });
        }
      });
    });
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (u.origin === location.origin && u.pathname.startsWith('/api/')) return handle(u.href, init);
    return realFetch(input, init);
  };

  /* ---------- Ajustes de la interfaz para la demo ---------- */
  // El visor no muestra diálogos del navegador: se aceptan solos.
  window.confirm = () => true;
  window.prompt = (_msg, def) => def ?? '';
  // "Imprimir contrato" abre otra ventana; en la demo se muestra el contrato en pantalla.
  window.open = () => {
    let html = '';
    return {
      focus() {},
      print() {},
      document: {
        write: (h) => (html += h),
        close: () => {
          const box = document.createElement('div');
          box.className = 'demo-contract';
          box.innerHTML = '<button type="button" class="btn demo-close">Cerrar contrato</button><div class="demo-paper"></div>';
          const shadow = box.querySelector('.demo-paper').attachShadow({ mode: 'open' });
          shadow.innerHTML = html.replace(/<script[\s\S]*?<\/script>/gi, '');
          box.querySelector('.demo-close').addEventListener('click', () => box.remove());
          document.body.appendChild(box);
        },
      },
    };
  };

  window.__demoReset = () => {
    try {
      localStorage.removeItem(STORE_KEY);
      localStorage.removeItem(COOKIE_KEY);
      localStorage.removeItem('token');
    } catch {}
    location.hash = '#/panel';
    location.reload();
  };

  document.addEventListener('DOMContentLoaded', () => {});
  window.__demoReady = ready;
})();
