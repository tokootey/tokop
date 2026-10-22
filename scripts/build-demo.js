'use strict';

/*
 * Arma una versión de prueba de la app en UN solo archivo HTML, que funciona entera en el navegador
 * (sin servidor): sirve para mandar un link y que otra persona la pruebe.
 *
 *   node scripts/build-demo.js [salida.html] [--standalone]
 *
 * Por defecto genera demo/rentacar-demo.html. Con --standalone agrega <!doctype html>, <head> y <body>
 * para subirlo como index.html a cualquier hosting estático (Netlify, GitHub Pages, etc.).
 *
 * Incluye el mismo código de src/ y public/, SQLite compilado para el navegador (sql.js)
 * y scripts/demo/runtime.js, que reemplaza a Node y Express.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const standalone = args.includes('--standalone');
const outArg = args.find((a) => !a.startsWith('--'));
const out = path.resolve(outArg || path.join(root, 'demo', 'rentacar-demo.html'));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
// Evita que un "</script" dentro del código cierre la etiqueta antes de tiempo.
const safe = (code) => code.replace(/<\/script/gi, '<\\/script');

function listJs(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return listJs(rel);
    return e.name.endsWith('.js') ? [rel] : [];
  });
}

const sources = {};
for (const file of listJs('src')) {
  if (file === 'src/server.js') continue;
  sources[file] = file === 'src/routes/files.js' ? read('scripts/demo/files-demo.js') : read(file);
}
const modules = `{\n${Object.entries(sources)
  .map(([name, code]) => `${JSON.stringify(name)}: function (module, exports, require, __filename, __dirname) {\n${code}\n}`)
  .join(',\n')}\n}`;

const runtime = read('scripts/demo/runtime.js').replace('const modules = __MODULES__;', () => `const modules = ${modules};`);
const sqljs = fs.readFileSync(require.resolve('sql.js/dist/sql-asm-memory-growth.js'), 'utf8');

const index = read('public/index.html');
const logo = `data:image/svg+xml;base64,${Buffer.from(read('public/floty.svg')).toString('base64')}`;
const body = index
  .slice(index.indexOf('<body>') + 6, index.indexOf('</body>'))
  .replace(/<script src="[^"]*"><\/script>\s*/g, '')
  .split('/floty.svg').join(logo)
  .trim();

// La letra va dentro del archivo: la demo es un solo HTML.
const font = `data:font/woff2;base64,${fs.readFileSync(path.join(root, 'public/fonts/jakarta.woff2')).toString('base64')}`;

const demoCss = `
.demo-hint { background: #eef5ff; border: 1px solid #c9dcff; border-radius: 8px; padding: 10px 12px; font-size: 13px; color: #1d2433; }
.demo-contract { position: fixed; inset: 0; z-index: 80; background: rgba(15,23,42,.55); overflow-y: auto; padding: 24px 12px; }
.demo-contract .demo-close { display: block; margin: 0 auto 12px; background: #fff; }
.demo-paper { background: #fff; max-width: 820px; margin: 0 auto; padding: 8px 16px; border-radius: 8px; }
`;

// Corre enseguida: el HTML de la app ya está arriba de este script.
const demoUi = `
(function () {
  var form = document.getElementById('login-form');
  if (form) {
    form.email.value = 'admin@rentacar.local';
    form.password.value = 'admin123';
    var hint = document.createElement('p');
    hint.className = 'demo-hint';
    hint.innerHTML = '<b>Demo de Floty.</b> Ya están cargados el usuario y la contraseña de ejemplo: tocá <b>Ingresar</b>. Los datos se guardan solo en este navegador.';
    form.insertBefore(hint, form.querySelector('button'));
  }
  // "Reiniciar datos" está en la pantalla Más (un cartel flotante tapaba el menú de abajo en el celular).
})();
`;

const html = `<title>Floty · Demo del sistema para rent a car</title>
<link rel="icon" href="${logo}" type="image/svg+xml">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
${read('public/styles.css').split('/fonts/jakarta.woff2').join(font)}
${demoCss}
</style>
${body}
<script>
${safe(sqljs)}
</script>
<script>
${safe(runtime)}
${safe(demoUi)}
</script>
<script>
${safe(fs.readFileSync(path.join(path.dirname(require.resolve('jspdf')), 'jspdf.umd.min.js'), 'utf8'))}
</script>
<script>
${safe(fs.readFileSync(path.join(path.dirname(require.resolve('jspdf-autotable')), 'jspdf.plugin.autotable.min.js'), 'utf8'))}
</script>
<script>
${safe(read('public/i18n.js'))}
</script>
<script>
${safe(read('public/contract-pdf.js'))}
</script>
<script>
${safe(read('public/chat.js'))}
</script>
<script>
${safe(read('public/app.js'))}
</script>
`;

const page = standalone
  ? html.replace(/^<title>/, '<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<title>').replace('</style>\n', '</style>\n</head>\n<body>\n') + '</body>\n</html>\n'
  : html;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
// En un hosting estático (Netlify), cualquier dirección del sitio muestra la app.
if (standalone) fs.writeFileSync(path.join(path.dirname(out), '_redirects'), '/*    /index.html   200\n');
console.log(`Demo generada: ${out} (${(page.length / 1024 / 1024).toFixed(2)} MB)`);
