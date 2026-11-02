'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Copia externa en Supabase Storage, para que los datos no queden sólo en el disco de Render.
 *
 * Después de cada copia diaria sube al bucket (privado):
 *  - respaldos/<copia>/...  la copia de las bases, y borra las más viejas (quedan las mismas `keep` que en el disco);
 *  - archivos/...           las fotos y contratos que todavía no se subieron (uploads/ y empresas/*-archivos/).
 * Se usa la API REST de Storage con fetch, sin dependencias. Sólo lee del disco: si falla, lo local no cambia.
 */

/** Datos de Supabase desde SUPABASE_URL, SUPABASE_SERVICE_KEY y SUPABASE_BUCKET. Si falta alguno, null (apagado). */
function offsiteConfig(env = process.env) {
  const { SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key, SUPABASE_BUCKET: bucket } = env;
  if (!url || !key || !bucket) return null;
  return { url: url.replace(/\/+$/, ''), key, bucket };
}

function storage({ url, key, bucket }, fetchFn = fetch) {
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  const call = async (method, route, body, headers = {}) => {
    const res = await fetchFn(`${url}/storage/v1/${route}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, apikey: key, ...headers },
      body,
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
    if (!res.ok) throw new Error(`Supabase respondió ${res.status} en ${method} ${route}: ${(await res.text()).slice(0, 200)}`);
    return res;
  };
  const json = (method, route, data) => call(method, route, JSON.stringify(data), { 'Content-Type': 'application/json' }).then((r) => r.json());
  return {
    upload: (name, file) =>
      call('POST', `object/${enc(bucket)}/${enc(name)}`, fs.readFileSync(file), { 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' }),
    /** Nombres completos de todos los archivos bajo `prefix` (entra en las subcarpetas). */
    async listAll(prefix) {
      const out = [];
      for (let offset = 0; ; offset += 1000) {
        const items = await json('POST', `object/list/${enc(bucket)}`, { prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
        for (const it of items) {
          const name = `${prefix}/${it.name}`;
          if (it.id) out.push(name);
          else out.push(...(await this.listAll(name))); // carpeta
        }
        if (items.length < 1000) return out;
      }
    },
    /** Carpetas que hay directamente bajo `prefix`. */
    folders: (prefix) => json('POST', `object/list/${enc(bucket)}`, { prefix, limit: 1000, offset: 0 }).then((items) => items.filter((it) => !it.id).map((it) => it.name)),
    remove: (names) => json('DELETE', `object/${enc(bucket)}`, { prefixes: names }),
  };
}

/** Archivos de una carpeta y sus subcarpetas, como rutas relativas con "/". */
function walk(dir, rel = '') {
  if (!fs.existsSync(path.join(dir, rel))) return [];
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = path.posix.join(rel, e.name);
    return e.isDirectory() ? walk(dir, r) : e.isFile() ? [r] : [];
  });
}

/** Carpetas de fotos y contratos: la de la empresa principal y las de cada empresa (empresas/<slug>-archivos). */
function fileDirs(dataDir, uploadsDir) {
  const empresas = path.join(dataDir, 'empresas');
  const others = fs.existsSync(empresas)
    ? fs.readdirSync(empresas).filter((d) => d.endsWith('-archivos')).map((d) => [path.join(empresas, d), `archivos/empresas/${d}`])
    : [];
  return [[uploadsDir, 'archivos/uploads'], ...others];
}

/**
 * Sube la copia `stamp` y los archivos nuevos, y borra de Supabase las copias que sobran.
 * Los archivos subidos se anotan en <backupDir>/.supabase-archivos para no volver a subirlos:
 * cada foto tiene un nombre único y no cambia.
 */
async function syncOffsite({ remote, dataDir, backupDir, uploadsDir, stamp, keep = 14, fetchFn = fetch }) {
  const s = storage(remote, fetchFn);
  const local = path.join(backupDir, stamp);
  for (const rel of walk(local)) await s.upload(`respaldos/${stamp}/${rel}`, path.join(local, rel));

  const old = (await s.folders('respaldos')).filter((d) => /^\d{4}-\d{2}-\d{2}_\d{6}$/.test(d)).sort();
  for (const d of old.slice(0, Math.max(0, old.length - keep))) {
    const names = await s.listAll(`respaldos/${d}`);
    if (names.length) await s.remove(names);
  }

  const manifest = path.join(backupDir, '.supabase-archivos');
  const done = new Set(fs.existsSync(manifest) ? fs.readFileSync(manifest, 'utf8').split('\n') : []);
  let uploaded = 0;
  for (const [dir, prefix] of fileDirs(dataDir, uploadsDir)) {
    for (const rel of walk(dir)) {
      const name = `${prefix}/${rel}`;
      if (done.has(name)) continue;
      await s.upload(name, path.join(dir, rel));
      fs.appendFileSync(manifest, `${name}\n`); // de a uno: si se corta a la mitad, no se vuelve a subir lo que ya está
      uploaded++;
    }
  }
  return { stamp, uploaded };
}

module.exports = { offsiteConfig, syncOffsite };
