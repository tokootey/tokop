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
// --perfil=discover: demo personalizada con los datos de una agencia (scripts/demo/perfiles/discover.js).
const profile = (args.find((a) => a.startsWith('--perfil=')) || '').slice(9) || null;
if (profile && !/^[a-z0-9-]+$/.test(profile)) throw new Error(`Perfil inválido: ${profile}`);
const outArg = args.find((a) => !a.startsWith('--'));
const out = path.resolve(outArg || path.join(root, 'demo', profile ? `${profile}-demo.html` : 'rentacar-demo.html'));
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
const profileCode = profile ? read(`scripts/demo/perfiles/${profile}.js`) : null;
if (profileCode) sources['src/perfil.js'] = profileCode; // vive en src/ para usar require('./db'), etc.
const profileCompany = profileCode ? (profileCode.match(/const company = '([^']+)'/) || [])[1] : null;
const modules = `{\n${Object.entries(sources)
  .map(([name, code]) => `${JSON.stringify(name)}: function (module, exports, require, __filename, __dirname) {\n${code}\n}`)
  .join(',\n')}\n}`;

const runtime = read('scripts/demo/runtime.js')
  .replace('const modules = __MODULES__;', () => `const modules = ${modules};`)
  .replace('const PROFILE = __PROFILE__;', `const PROFILE = ${JSON.stringify(profile)};`);
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
/* Pantalla de elegir el tipo: al pasar por cada opción, el fondo muestra de qué se trata (viaje o trabajo). */
.login { position: relative; overflow: hidden; }
.login-card { position: relative; z-index: 1; }
.demo-escena { position: absolute; inset: 0; opacity: 0; transition: opacity .45s ease; pointer-events: none; }
.demo-escena svg { width: 100%; height: 100%; display: block; }
.login[data-escena=turismo] .demo-escena-turismo, .login[data-escena=trabajo] .demo-escena-trabajo { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .demo-escena { transition: none; } }
`;

// Corre enseguida: el HTML de la app ya está arriba de este script.
const demoUi = `
(function () {
  var form = document.getElementById('login-form');
  if (form) {
    // La demo entra con un botón y sin tocar el campo de contraseña: si se llena y se manda el formulario,
    // Chrome ofrece guardarla y avisa que "admin123" apareció en una filtración.
    // api() y startSession() son de app.js, que carga después; se usan recién al tocar el botón.
    var enter = function () {
      return api('POST', '/auth/login', { email: 'admin@rentacar.local', password: 'admin123' }).then(function () {
        startSession();
      });
    };
    Array.prototype.forEach.call(form.querySelectorAll('label, button[type=submit], .login-brand + p'), function (el) {
      el.style.display = 'none';
    });
    var hint = document.createElement('p');
    hint.className = 'demo-hint';
    var err = document.getElementById('login-error');
    form.insertBefore(hint, err);
    var button = function (label, onClick) {
      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'btn primary big';
      go.textContent = label;
      go.addEventListener('click', function () {
        go.disabled = true;
        onClick().catch(function (e) {
          go.disabled = false;
          err.textContent = e.message;
        });
      });
      form.insertBefore(go, err);
      return go;
    };
    if (window.__demoTipo) {
      // Demo general: el mismo sistema, con datos de ejemplo de un rent a car turístico o de una flota para choferes.
      hint.innerHTML = '<b>Demo de Floty.</b> Elegí qué tipo de alquiler tenés. No hace falta usuario ni contraseña: los datos se guardan solo en este navegador.';
      var login = document.getElementById('login');
      // Fondos dibujados (sin fotos: la demo es un solo archivo que anda sin internet).
      // Paisajes con capas y luz, no íconos sueltos: cordillera y canal al atardecer, y una calle de ciudad al anochecer.
      var semilla = 7;
      var azar = function () { semilla = (semilla * 9301 + 49297) % 233280; return semilla / 233280; };
      var cordon = function (y, alto, paso, color) {
        var d = 'M0 900 L0 ' + y;
        for (var x = 0; x <= 1440; x += paso) d += ' L' + x + ' ' + Math.round(y - azar() * alto);
        return '<path d="' + d + ' L1440 900 Z" fill="' + color + '"/>';
      };
      var bosque = '';
      for (var bx = -10; bx < 1450; bx += 13) {
        var bh = 16 + Math.round(azar() * 26);
        bosque += 'M' + bx + ' 742 L' + (bx + 8) + ' ' + (742 - bh) + ' L' + (bx + 16) + ' 742 Z ';
      }
      var turismo = '<svg viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs>' +
        '<linearGradient id="dcielo" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7d9fc4"/><stop offset=".45" stop-color="#d9c7b4"/><stop offset=".72" stop-color="#f0ad82"/></linearGradient>' +
        '<radialGradient id="dsol" cx="1040" cy="560" r="420" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff3dc" stop-opacity=".95"/><stop offset=".25" stop-color="#ffd6a3" stop-opacity=".5"/><stop offset="1" stop-color="#ffd6a3" stop-opacity="0"/></radialGradient>' +
        '<linearGradient id="dbruma" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4dcc4" stop-opacity="0"/><stop offset="1" stop-color="#f4dcc4" stop-opacity=".45"/></linearGradient>' +
        '<linearGradient id="dagua" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8d9fb8"/><stop offset="1" stop-color="#2f4663"/></linearGradient>' +
        '</defs>' +
        '<rect width="1440" height="900" fill="url(#dcielo)"/><rect width="1440" height="900" fill="url(#dsol)"/>' +
        cordon(560, 170, 40, '#a9b3c6') +
        '<path d="M800 560 L880 352 L902 384 L928 300 L958 372 L986 340 L1080 560 Z" fill="#9ca8bf"/>' +
        '<path d="M928 300 L914 336 L926 330 L934 348 L944 334 L952 344 Z" fill="#eef2f7" opacity=".8"/>' +
        '<rect y="460" width="1440" height="200" fill="url(#dbruma)"/>' +
        cordon(640, 130, 30, '#75859e') +
        cordon(705, 80, 22, '#4b5b72') +
        '<rect y="735" width="1440" height="165" fill="url(#dagua)"/>' +
        '<g stroke="#ffe2bd" stroke-linecap="round" opacity=".35" stroke-width="3"><path d="M930 780 h120 M990 806 h150 M900 836 h90 M1060 860 h140 M260 800 h80 M420 850 h110"/></g>' +
        '<path d="' + bosque + '" fill="#223529"/>' +
        '<path d="M0 860 C 240 830, 420 880, 640 900 H0 Z" fill="#1b2a22"/>' +
        '</svg>';
      var ciudad = '';
      [[560, 120, 300, '#2b3150'], [610, 80, 250, '#1d2238']].forEach(function (capa, n) {
        for (var cx = -20; cx < 1460;) {
          var ancho = 40 + Math.round(azar() * 80), alto = capa[1] + Math.round(azar() * capa[2]);
          ciudad += '<rect x="' + cx + '" y="' + (capa[0] - alto) + '" width="' + ancho + '" height="' + (alto + 300) + '" fill="' + capa[3] + '"/>';
          if (n === 1) {
            for (var wy = capa[0] - alto + 16; wy < capa[0] - 10; wy += 22) {
              for (var wx = cx + 10; wx < cx + ancho - 12; wx += 18) {
                if (azar() < .28) ciudad += '<rect x="' + wx + '" y="' + wy + '" width="7" height="10" fill="#f4c27a" opacity=".55"/>';
              }
            }
          }
          cx += ancho + 4;
        }
      });
      var luces = '';
      var tonos = ['#ffcf7a', '#ff8a5b', '#fff1c9', '#ff5d5d'];
      for (var k = 0; k < 28; k++) {
        luces += '<circle cx="' + Math.round(azar() * 1440) + '" cy="' + Math.round(380 + azar() * 250) + '" r="' + Math.round(10 + azar() * 26) + '" fill="' + tonos[k % 4] + '" opacity="' + (.22 + azar() * .35).toFixed(2) + '"/>';
      }
      var lineas = '';
      for (var ly = 620, largo = 6; ly < 900; ly += largo * 2.4, largo *= 1.28) {
        lineas += '<path d="M' + (720 - largo * .08) + ' ' + Math.round(ly) + ' L' + (720 + largo * .08) + ' ' + Math.round(ly) + ' L' + (720 + largo * .1) + ' ' + Math.round(ly + largo) + ' L' + (720 - largo * .1) + ' ' + Math.round(ly + largo) + ' Z" fill="#d8c27a" opacity=".7"/>';
      }
      var trabajo = '<svg viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs>' +
        '<linearGradient id="docaso" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#18213d"/><stop offset=".42" stop-color="#3a3f63"/><stop offset=".62" stop-color="#b5675a"/><stop offset=".7" stop-color="#e39a6b"/></linearGradient>' +
        '<linearGradient id="dasfalto" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f3442"/><stop offset="1" stop-color="#101219"/></linearGradient>' +
        '<filter id="dbokeh" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>' +
        '<filter id="dtrazo" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="2.5"/></filter>' +
        '</defs>' +
        '<rect width="1440" height="900" fill="url(#docaso)"/>' +
        ciudad +
        '<rect y="610" width="1440" height="290" fill="#14161f"/>' +
        '<path d="M0 900 L1440 900 L790 610 L650 610 Z" fill="url(#dasfalto)"/>' +
        lineas +
        '<g fill="none" stroke-linecap="round" filter="url(#dtrazo)">' +
        '<path d="M705 612 C 600 700, 380 820, 90 900" stroke="#ff4d4d" stroke-width="7" opacity=".85"/>' +
        '<path d="M695 614 C 560 724, 300 846, 0 884" stroke="#ff7b54" stroke-width="3" opacity=".7"/>' +
        '<path d="M738 612 C 860 704, 1110 824, 1440 884" stroke="#ffe9b0" stroke-width="7" opacity=".85"/>' +
        '<path d="M748 614 C 900 726, 1160 846, 1420 900" stroke="#fff6d8" stroke-width="3" opacity=".7"/>' +
        '</g>' +
        '<g filter="url(#dbokeh)">' + luces + '</g>' +
        '</svg>';
      [['turismo', turismo], ['trabajo', trabajo]].forEach(function (e) {
        var capa = document.createElement('div');
        capa.className = 'demo-escena demo-escena-' + e[0];
        capa.innerHTML = e[1];
        login.insertBefore(capa, login.firstChild);
      });
      [['turismo', 'Alquiler turístico'], ['trabajo', 'Autos para trabajo (choferes de apps)']].forEach(function (t) {
        var elegir = button(t[1], function () {
          if (t[0] === window.__demoTipo) return enter();
          // La otra demo tiene su propia base: se recarga con ese tipo y entra sola.
          try {
            localStorage.setItem('rentacar-demo-tipo', t[0]);
          } catch (e) {}
          location.search = '?elegido';
          return new Promise(function () {});
        });
        var mostrar = function () { login.setAttribute('data-escena', t[0]); };
        var quitar = function () { login.removeAttribute('data-escena'); };
        elegir.addEventListener('mouseenter', mostrar);
        elegir.addEventListener('focus', mostrar);
        elegir.addEventListener('mouseleave', quitar);
        elegir.addEventListener('blur', quitar);
      });
    } else {
      hint.innerHTML = '<b>Demo de Floty.</b> No hace falta usuario ni contraseña. Los datos se guardan solo en este navegador.';
      button('Entrar a la demo', enter);
    }
    // Con ?entrar (el botón "Probar la demo" de flotyapp.com.ar) entra solo, una vez, y se ve directo la app.
    // En la demo general no: primero se elige el tipo, y ?elegido es la recarga después de elegir.
    if (/[?&]elegido\\b/.test(location.search) || (!window.__demoTipo && /[?&]entrar\\b/.test(location.search))) {
      history.replaceState(null, '', location.pathname + location.hash);
      var login = document.getElementById('login');
      new MutationObserver(function (_, obs) {
        if (login.classList.contains('hidden')) return;
        obs.disconnect();
        enter();
      }).observe(login, { attributes: true, attributeFilter: ['class'] });
    }
  }
  // "Reiniciar datos" está en la pantalla Más (un cartel flotante tapaba el menú de abajo en el celular).
})();
`;

const html = `<title>${profileCompany ? `${profileCompany} · Demo de Floty` : 'Floty · Demo del sistema para rent a car'}</title>
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
