# Rent a Car · Sistema de gestión

Aplicación web para el día a día del rent a car (flota, reservas, contratos, cobros y tarifas), en la línea de Rently / One Mobility, y conectada al cotizador del sitio web (discoverushuaia.com.ar) o a cualquier otro cotizador por API.

## Qué incluye

| Módulo | Para qué sirve |
| --- | --- |
| **Hoy** | Quién sale y quién vuelve hoy (y los atrasados), con botones para entregar o recibir el auto y para escribirle por WhatsApp; cuánto debe cada uno, autos libres, alquilados y en el taller, y cuántos salen y vuelven mañana. |
| **Nueva reserva** | En un minuto desde el celular: fechas (1 día, 3 días, 1 semana…), un auto de los libres con su precio, nombre y WhatsApp; se guarda confirmada y abre el voucher para mandarlo. La **reserva con más opciones** (en *Más*) cotiza en el momento: muestra el precio y la disponibilidad de cada categoría según las fechas, el lugar y los adicionales. Busca o crea el cliente y asigna el auto. |
| **Reservas** | Listado con filtros. En cada reserva: confirmar, asignar auto, **entregar** (abre el contrato con km y combustible), **devolver** (calcula km excedentes, combustible faltante, días de demora y daños), registrar pagos y garantías, imprimir el contrato y ver el historial. |
| **Calendario** | Grilla de vehículos por días (estilo Rently): reservas por estado, autos en taller y reservas sin auto asignado. |
| **Flota** | Vehículos, estado, km, combustible, sucursal, vencimientos de seguro y VTV, historial de cada auto. |
| **Clientes** | Datos, documento, licencia (no deja entregar sin licencia o con licencia vencida) e historial. |
| **Contrato para imprimir** | Botón **Contrato PDF**: genera el contrato en un archivo PDF con los datos del cliente, lo descarga y guarda una copia en la reserva (*Fotos y documentación → Contratos*). También **Imprimir contrato**. Las dos opciones funcionan desde cualquier reserva, también antes de entregar el auto (pre-contrato con km y combustible para completar). Son 2 hojas A4: datos del cliente, conductor adicional, auto, período, entrega y devolución, diagrama para marcar daños, precio, pagos, firmas y condiciones generales (15 cláusulas). Las condiciones, la franquicia y la jurisdicción se editan en *Configuración*. |
| **Fotos y documentación** | Al entregar y al recibir un auto se sacan o se suben fotos (y PDF) del estado del vehículo. Quedan en la reserva, separadas en Entrega y Devolución, con quién y cuándo las subió. Las fotos del celular se achican solas antes de subirse. |
| **Mantenimiento** | Mientras hay un mantenimiento abierto, el auto sale de la flota disponible. Al cerrarlo, vuelve a la flota. |
| **Tarifas y sucursales** | Categorías (tarifa diaria y semanal, garantía, km incluidos), adicionales (por día o por alquiler, con tope), temporadas (+%) y lugares de entrega. |
| **Cotizador** | Conexión con el formulario web y con la API del cotizador, bandeja de solicitudes recibidas y avisos salientes. |
| **Usuarios** | Perfil *operador* (mostrador) y perfil *administrador* (también configura tarifas, el cotizador y los usuarios). |

El menú tiene cuatro secciones: **Hoy**, **Calendario**, **Autos** y **Más** (todas las reservas, clientes, taller y ajustes). En el celular queda abajo, como una app, con el botón **Nueva reserva** siempre a mano.

## Ver la app en tu computadora (sin saber programar)

1. Instalá **Node.js** desde [nodejs.org](https://nodejs.org) (botón **LTS**, siguiente, siguiente, finalizar).
2. En esta página de GitHub tocá el botón verde **Code** → **Download ZIP**. Descomprimí el archivo (clic derecho → *Extraer todo*).
3. Abrí la carpeta y hacé doble clic en:
   - **Windows:** `iniciar-windows.bat`. Si aparece un aviso azul de Windows, tocá *Más información* → *Ejecutar de todas formas*.
   - **Mac:** `iniciar-mac.command`. Si macOS lo bloquea: clic derecho → *Abrir*.
4. La primera vez tarda un minuto. Después se abre el navegador con la app, cargada con datos de ejemplo. Usuario `admin@rentacar.local`, contraseña `admin123`. La primera vez la app te pide elegir una contraseña propia.

La app queda abierta mientras esté abierta la ventana negra. Así solo la ves vos, en tu computadora. Para que funcione con el sitio web hay que publicarla (sección *Publicarla en internet*).

## Puesta en marcha

Requiere **Node.js 22.13 o superior** (usa la base SQLite que ya trae Node, sin instalar ningún motor de base de datos).

```bash
npm install
npm run seed     # opcional: carga datos de ejemplo (Ushuaia)
npm start        # http://localhost:3000
```

Usuario inicial: `admin@rentacar.local` / `admin123`. **Cambiá la contraseña** desde *Usuarios*. También podés definir otro usuario antes del primer inicio con `ADMIN_EMAIL` y `ADMIN_PASSWORD`.

Variables de entorno: `PORT` (por defecto 3000), `DB_FILE` (por defecto `data/rentacar.db`), `UPLOADS_DIR` (fotos y documentos; por defecto `uploads/` junto a la base de datos), `TRUST_PROXY` (por ejemplo `1` si el sistema está detrás de un proxy o de Nginx).

Para que el sitio web pueda enviar las cotizaciones, el sistema tiene que estar publicado en internet con HTTPS. Sirve cualquier VPS, Render, Railway o Fly.io. Hacé una copia de seguridad de la carpeta `data/`, que tiene la base (`rentacar.db`) y las fotos (`uploads/`).

```bash
npm test         # pruebas automáticas
```

## Versión de prueba para compartir

`npm run demo` genera `demo/rentacar-demo.html` (con `npm run demo -- demo/sitio/index.html --standalone` sale lista para subir a Netlify o GitHub Pages): la app completa en un solo archivo, que funciona entera en el navegador, sin servidor. Usa el mismo código, con SQLite para el navegador (sql.js) y datos de ejemplo. Sirve para mandar un link y que alguien la pruebe. Cada persona ve sus propios datos, guardados solo en su navegador, y no recibe pedidos del sitio web.

## Publicarla en internet (paso a paso, sin saber programar)

La app ya está preparada para publicarse en [Render](https://render.com). Lleva unos 10 minutos.

1. Entrá a [render.com](https://render.com) y tocá **Get Started**. Registrate con **GitHub**, con la misma cuenta donde está este repositorio.
2. Arriba a la derecha tocá **New** y después **Blueprint**.
3. Elegí el repositorio **tokootey/tokop**. Si no aparece, tocá *Configure account* y dale acceso.
4. Render lee la configuración sola (archivo `render.yaml`) y muestra lo que va a crear. Tocá **Apply** o **Deploy Blueprint**.
   - Se usa un plan pago básico (*Starter*) con un disco de 5 GB, para que los datos no se borren. Render muestra el precio antes de confirmar.
5. Esperá a que diga **Live**, en verde. Arriba vas a ver la dirección de la app, por ejemplo `https://rentacar-ushuaia.onrender.com`.
6. Para ver la contraseña del administrador, entrá al servicio y abrí la pestaña **Environment**. El usuario es `admin@rentacar.local` y la contraseña es el valor de `ADMIN_PASSWORD`.
7. Entrá a la app con ese usuario y contraseña. Ya podés cargar autos, tarifas y usuarios.
8. En **Cotizador → Formulario web**, copiá la línea `<script …>`. Ya trae la dirección real de la app. Mandásela a quien administra el sitio web para que la pegue en la página del cotizador.
9. Opcional: en **Settings → Custom Domains** podés usar una dirección propia (por ejemplo `gestion.tuagencia.com`).

Las versiones nuevas se publican solas cada vez que se acepta un cambio en `main`. Los datos quedan en el disco y no se tocan.

## Copias de seguridad

La app hace sola **una copia por día** de todas las bases de datos (la de cada empresa y el registro de empresas) y guarda las **últimas 14**. En Render quedan en `/var/data/respaldos`, cada una en una carpeta con la fecha y hora, por ejemplo `2026-10-20_030000`. Las fotos no entran en la copia, porque ocupan mucho: quedan en el disco.

**Volver a una copia en Render** (por ejemplo, si se borró algo por error):

1. En el servicio, abrí **Logs** y buscá la línea `Copia de seguridad hecha: …` del día al que querés volver. Ese es el nombre de la copia.
2. En **Environment** tocá **Add Environment Variable**: nombre `RESTAURAR_RESPALDO`, valor el nombre de la copia (por ejemplo `2026-10-20_030000`).
3. Tocá **Save, rebuild and deploy**. Al arrancar, la app vuelve a esa copia. Antes guarda lo que había en una copia nueva, así se puede deshacer.
4. Cuando diga **Live**, borrá la variable `RESTAURAR_RESPALDO`. Aunque te olvides, no se vuelve a aplicar.

Ojo: se pierde todo lo cargado después de esa copia, en todas las empresas.

**En una computadora** (con la app cerrada):

```bash
npm run respaldo                               # hace una copia ahora
npm run respaldo -- lista                      # muestra las copias
npm run respaldo -- restaurar 2026-10-20_030000
```

Variables: `BACKUP_DIR` (carpeta de las copias; por defecto, `respaldos` al lado de la base), `BACKUP_KEEP` (cuántas guardar, 14) y `BACKUP_DISABLED=1` (no hacer copias).

## Pasar los datos del sistema anterior (Drive, Excel u otra página)

**Ajustes → Importar datos** (sólo administradores). Conviene seguir este orden: **1 · Flota**, **2 · Clientes**, **3 · Reservas**.

1. Sacá los datos de la planilla: en Google Drive, *Archivo → Descargar → Valores separados por comas (.csv)*; en Excel, *Guardar como → CSV UTF-8*. También se pueden copiar las celdas (con la fila de títulos) y pegarlas.
2. Tocá **Leer datos**: el sistema reconoce las columnas por su nombre ("Dominio", "Fecha entrega", "Seña", "DNI", "Venc. licencia"…) y te deja corregir cuál es cuál.
3. Tocá **Probar (no guarda nada)**: muestra exactamente qué se va a crear, actualizar u omitir, y qué filas tienen errores o avisos.
4. Tocá **Importar**.

- Entiende fechas `15/01/2027`, `15-1-27 10:30`, `2027-01-15`, fechas de Excel y planillas en formato inglés (mes/día); horas `10hs`, `10:30`, `6:30 p. m.`; importes `$ 150.000`; combustible `3/4`, `lleno`, `50%`.
- No duplica: clientes por documento, email o teléfono (dos personas con el mismo nombre y distinto DNI quedan separadas); autos por patente; reservas por su número anterior o por cliente + fechas. Se puede volver a importar el mismo archivo.
- Si un cliente o auto ya existe se puede *completar sólo lo que falta*, *reemplazar* o *no tocarlo*.
- Las reservas en curso abren su contrato, así la devolución se registra desde la app. Si un auto ya está ocupado en esas fechas, la reserva entra sin auto y con aviso. La seña se carga como pago.
- Las columnas que no tienen lugar se guardan en "Observaciones" para no perder nada.
- El archivo no se guarda; en la actividad de Usuarios queda sólo quién importó y cuántas filas (sin datos personales). Después de importar, borrá el CSV de la computadora y dejá de compartir la planilla vieja.

## Entrega en un hotel

Si el cliente quiere el auto en su hotel, en **Nueva reserva → ¿Dónde se lo das? → En un hotel** se cargan el hotel, la dirección, la habitación, un contacto y las indicaciones (también desde la reserva: *Más acciones → Entregar o retirar en un hotel*). Se puede elegir si la devolución también es en el hotel.

Si todavía no se saben los datos, se dejan vacíos: la reserva muestra **"Faltan los datos del hotel"** con un botón para mandarle al cliente, por WhatsApp, un link propio de su reserva (`/hotel/<código>`). El cliente los completa desde el celular y aparecen en la reserva. El link deja de funcionar cuando la reserva termina o se cancela.

En Hoy, en el listado, en el voucher y en el contrato el lugar figura como "Hotel: <nombre> · hab. <número>".

## Link de reservas (opcional)

Para las agencias que no tienen reservas por internet. Viene apagado: se activa en **Más → Link de reservas (opcional)**. Si la agencia ya tiene su página o su propio link de reservas, conviene dejarlo apagado y conectar su página con **Página web: formulario** (ver *Conexión con el cotizador*).

- Es una página propia de la agencia (`/reservar`, y `/reservar?empresa=…` para las demás empresas) para poner en la biografía de Instagram y mandar por WhatsApp.
- El cliente elige fechas, ve las categorías libres con el precio y deja su nombre y WhatsApp. El pedido aparece en **Hoy → Para confirmar**, con un botón para confirmarlo y mandarle el voucher.
- Usa las mismas protecciones que el chat (límite por IP y campo trampa contra robots) y nunca muestra cuántos autos quedan.

### Chat para la página de la agencia

En la misma pantalla, abajo, está el chat para pegar en la página web de la agencia:

- El cliente elige fechas y lugar, y el chat le muestra los autos libres con su precio final. Nunca muestra cuántos autos quedan.
- El cliente deja sus datos y la reserva entra como **pendiente**, con origen "Formulario web", para que el mostrador la confirme.
- Responde preguntas frecuentes, que se cargan una por línea con el formato `Pregunta | Respuesta`, y ofrece seguir por WhatsApp con una persona.
- No usa inteligencia artificial paga, así que no tiene costo por mensaje.

Para ponerlo en la página web, quien la administra pega una línea antes de `</body>`:

```html
<script src="https://TU-SERVIDOR/chat.js" async></script>
```

`data-color="#0a7"` cambia el color del botón. El chat se dibuja aislado de los estilos de la página.

La dirección de la página tiene que estar en *Cotizador web → sitios autorizados*. Además, cada IP tiene un límite de consultas y de pedidos, y hay un campo trampa contra robots.

## Sumar otra empresa (varias agencias en la misma instalación)

Una sola instalación puede atender a varias agencias. Cada una tiene sus propios datos (reservas, flota, clientes, usuarios, tarifas y configuración del país) en su propia base, y nadie de una empresa puede ver los datos de otra.

1. Entrá como dueño de Floty. Con tu email en la variable `FLOTY_OWNERS`, al entrar ves directamente el **Panel de Floty** ("Tus agencias"), sin las pantallas del rent a car: tocá *+ Nueva agencia*. Si `FLOTY_OWNERS` está vacía, cualquier administrador de la empresa principal lo abre desde *Panel de Floty* (abajo, junto a *Salir*) y sigue viendo su rent a car. Los administradores de las agencias nunca lo ven.
   - El panel muestra cada agencia con su dirección, si responde (se prueba sola al abrir), su administrador, el último ingreso, cuántos autos cargó y sus reservas de los últimos 30 días.
   - Arriba, el estado de las copias de seguridad, y avisos en palabras simples: copias atrasadas, agencias que nunca entraron o que dejaron de entrar.
   - **Mis vencimientos:** lo que paga el dueño (dominio, servidor, página web…), con monto y nota. Avisa 30 días antes, más fuerte a 7 y en rojo si venció; al marcarlo pagado la fecha pasa sola al mes o al año siguiente y queda en el historial. Arranca con el dominio flotyapp.com.ar (20/10/2027), Render y Netlify.
   - **Ficha y abono de cada agencia:** responsable, WhatsApp, notas, precio del plan, próximo cobro, fin de la prueba gratis y los vencimientos de su dominio propio y su certificado de factura (se cargan a mano). *Marcar pagado* anota el cobro y pasa el próximo al mes siguiente. Floty no cobra nada solo: es para llevar la cuenta.
   - **Disco:** cuánto se usa del disco de datos, con aviso al 80 %.
2. Poné el nombre, el país y el nombre y email de quien la va a administrar. La app muestra una **contraseña inicial** una sola vez: pasásela a esa persona en persona o por teléfono.
3. Esa persona entra en la misma dirección con su email. La app le pide cambiar la contraseña y le muestra los primeros pasos.

Cada email puede ser usuario de una sola empresa. Si la empresa nueva usa el formulario web o el asistente, los códigos que copia desde *Ajustes* ya llevan su empresa (`data-empresa="…"`); su API del cotizador se reconoce por su propia clave.

Las instalaciones de antes siguen igual: su base pasa a ser la empresa principal, sin mover ni perder nada.

### La dirección de cada empresa (subdominio o dominio propio)

Cada empresa puede entrar por su propia dirección, como hacen Rently y otros sistemas:

- **Subdominio de Floty:** `<código de la empresa>.<dominio de Floty>`, por ejemplo `andes-rent.flotyapp.com.ar`. Funciona solo cuando la instalación tiene la variable `FLOTY_DOMAIN=flotyapp.com.ar` y el dominio tiene un registro comodín `*.flotyapp.com.ar` que apunta al servidor. En Render: *Settings → Custom Domains* → agregar `app.flotyapp.com.ar` y `*.flotyapp.com.ar`.
- **La entrada del dueño de Floty** (Panel de Floty) es **`app.flotyapp.com.ar`**. El dominio a secas (`flotyapp.com.ar` y `www`) queda para la página web de Floty, en Netlify. Ninguna agencia puede quedarse con nombres reservados como `app`, `www`, `admin` o `api`: si se da de alta una agencia llamada "App", su dirección pasa a ser `app-2`.
- **Dominio propio de la agencia:** por ejemplo `reservas.suagencia.com.ar`. Lo carga el dueño de Floty en *Panel de Floty → Dominio propio* (las agencias no pueden). Quien maneja ese dominio (en NIC.ar si es .com.ar) agrega un registro **CNAME** que apunte al servidor de Floty, y el dominio también se agrega en Render (*Custom Domains*). Puede tardar hasta 24 horas en funcionar.

Entrando por la dirección de una empresa, todo va a esa empresa: el ingreso, el link de reservas, el formulario web y el asistente (sin necesidad de `?empresa=`). Un usuario o una sesión de otra empresa no sirven ahí. Sin `FLOTY_DOMAIN` ni dominios propios, todo funciona como antes, por una sola dirección.

### Primeros pasos de una empresa

1. Entrar con el usuario que le dieron y cambiar la contraseña.
2. En el Panel aparece **Primeros pasos**: empresa y país, lugares de entrega, categorías con tarifas, autos (o *Importar datos*), usuarios y condiciones del contrato.
4. Al elegir el país en *Ajustes → Empresa y contrato* se completan solos:
   - la moneda;
   - el impuesto (IVA, IGV, ITBIS, IGIC…) y su alícuota;
   - el nombre de la identificación fiscal (CUIT, RUT, RFC, NIF…);
   - el formato de números y fechas.

   Países incluidos: Argentina, Chile, Uruguay, Paraguay, Bolivia, Perú, Colombia, Ecuador, México, Costa Rica, Panamá, República Dominicana, Guatemala, España (península y Canarias) y Estados Unidos.

## Idioma: español o inglés

Abajo de la pantalla de ingreso y en el menú (debajo del usuario) se elige **Español** o **English**. El idioma queda guardado en ese navegador.

- En inglés se traducen todas las pantallas, los avisos y los mensajes de error.
- También salen en inglés el **contrato** (impreso y PDF), el **voucher** (WhatsApp, email y PDF) y la política de devolución.
- Las condiciones del contrato, la jurisdicción y las condiciones extra de cancelación tienen su versión en inglés en *Ajustes → Empresa y contrato → Textos en inglés*. Vienen con una traducción sugerida de las condiciones de fábrica; si una empresa cambió las suyas en español, tiene que actualizar también las de inglés.
- Lo que carga cada empresa (nombres de categorías, adicionales, lugares, notas) se muestra tal como está escrito.
- El chat de la página web de la agencia (asistente) sigue en español.

Las traducciones están en `public/i18n.js`. Un texto nuevo de la pantalla sale en español hasta que se agregue ahí.

## Seguridad y datos de los clientes

**Acceso**
- Cada persona entra con su propio usuario. La contraseña de fábrica (`admin123`) y las que asigna el administrador se tienen que cambiar en el primer ingreso.
- Las contraseñas tienen que tener al menos 8 caracteres, con letras y números, y no pueden ser fáciles de adivinar. Se guardan cifradas (scrypt).
- Después de 5 intentos fallidos, ese usuario queda bloqueado 15 minutos. Además hay un límite de intentos por conexión.

**Sesión**
- La sesión es una cookie `HttpOnly` y `SameSite=Strict`, que ningún script puede leer.
- En la base solo se guarda el hash del token.
- La sesión vence a las 12 horas sin uso y, como máximo, a los 7 días.
- Cambiar la contraseña o desactivar un usuario cierra sus otras sesiones.

**Navegador**
- Encabezados de seguridad: política de contenido estricta (solo código propio), protección contra que otro sitio incruste la app, `nosniff`, sin referer y datos de la API sin caché. Con HTTPS se suman HSTS y la redirección automática de http a https.
- Los pedidos que modifican datos tienen que venir de la propia app (protección CSRF).
- Todo lo que escriben los clientes, por ejemplo en el formulario web, se muestra como texto. Nunca se ejecuta como código; está probado con ataques reales en los tests.

**Permisos**
- Solo los administradores pueden borrar clientes, autos y mantenimientos, y ver el registro de actividad.
- **Anonimizar cliente** (en *Clientes*): sirve para un pedido de baja de datos personales. Borra para siempre sus datos personales y conserva las reservas y los importes para la contabilidad.

**Registro de actividad** (en *Usuarios*): ingresos, intentos fallidos, bloqueos, cambios de contraseña, altas y bajas de usuarios, borrados, anonimizaciones y cambios de configuración. Cada evento queda con fecha, usuario e IP.

**Fotos y documentos**
- Se verifica el contenido real del archivo: tiene que ser una foto o un PDF, no alcanza con que lo diga.
- Solo los ve un usuario con sesión iniciada, y se muestran aislados, para que un archivo manipulado no pueda ejecutar nada.

**Formulario web y API**
- El formulario web solo acepta envíos desde los sitios autorizados. Recorta los campos demasiado largos y no le muestra errores internos al público.
- La API key del cotizador solo se acepta en el encabezado `X-API-Key`, nunca en la dirección.

**Recomendaciones al publicar**
- Usar siempre HTTPS. En Render ya viene incluido, con `TRUST_PROXY=1`.
- Hacer copias de seguridad de la carpeta `data/`.
- Dar de baja enseguida a quien deje de trabajar.
- Revisar de vez en cuando el registro de actividad.

## Conexión con el cotizador de discoverushuaia.com.ar

En **Cotizador → Formulario web** hay dos formas de conectarlo.

**Opción A (recomendada).** Agregar una línea en la página del cotizador, antes de `</body>`:

```html
<script src="https://TU-SERVIDOR/webform.js" data-form="form"></script>
```

El formulario sigue funcionando igual que hoy (por ejemplo, si manda un mail) y además envía una copia al sistema, que la registra como **reserva pendiente** con origen "Formulario web". El mostrador sólo tiene que revisarla y confirmarla.

**Opción B.** Cambiar el `action` del formulario a `https://TU-SERVIDOR/api/public/webform` (método POST). Al enviar, el cliente vuelve a la página de "gracias" que configures.

**No hace falta saber cómo se llaman los campos del formulario.** El sistema los reconoce solo por su nombre, en español o en inglés: nombre / nombre y apellido / name, email / correo, teléfono / celular / WhatsApp, fecha y hora de retiro / desde / pickup, de devolución / hasta / dropoff, lugar, vehículo / categoría, vuelo y comentarios. Si los nombres no dicen nada, toma las dos primeras fechas como retiro y devolución, sin confundirlas con la fecha de nacimiento.

En *Cotizador → Bandeja*, "Ver datos" muestra lo que llegó y cómo se interpretó. Si algún dato se interpretó mal, se puede forzar en el *mapeo de campos*, indicando qué atributo `name` corresponde a ese dato. Cómo traducir lo que escribe el cliente:

- La **categoría** y el **lugar** se reconocen por código, por nombre o por los **alias** que cargues en *Tarifas y sucursales*. Por ejemplo, "SUV, camioneta" → categoría D, y "aeropuerto" → USH.
- Las fechas pueden llegar como `15/01/2027`, `15-01-2027` o `2027-01-15`. Si la hora viene en un campo aparte (`10:00`, `8 hs`), se une a la fecha.
- Los adicionales que no existen en el sistema no frenan la reserva: quedan anotados en las notas.
- Con el recuadro **Probar con datos del formulario** podés ver cómo se interpreta un envío antes de activarlo.

**Seguridad.** Sólo se aceptan envíos desde los sitios autorizados (encabezado `Origin`). Además hay un campo trampa antispam (`_gotcha`) y un límite de 20 envíos cada 10 minutos por IP.

Si una solicitud no se puede convertir en reserva (por ejemplo, una categoría desconocida o sin disponibilidad), queda en **Cotizador → Bandeja** con el motivo. Ahí podés corregir el alias o el mapeo y tocar *Reintentar*.

## API para cotizadores (u otros sistemas)

Se autentica con el header `X-API-Key`. La clave se ve y se regenera en *Cotizador → API del cotizador*.

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/public/v1/catalog` | Categorías, sucursales y adicionales activos. |
| GET | `/api/public/v1/availability?pickup_at=&return_at=&pickup_branch=&return_branch=&extras=GPS,CAD` | Disponibilidad y precio de cada categoría. |
| POST | `/api/public/v1/quote` | Cotiza una categoría (`category_code`, fechas, lugares, extras). |
| POST | `/api/public/v1/reservations` | Crea una reserva desde una cotización aceptada. Si se repite el mismo `id`, no se duplica. |
| GET | `/api/public/v1/reservations/:codigo-o-id-externo` | Estado de una reserva. |
| POST | `/api/public/v1/reservations/:codigo-o-id-externo/cancel` | Cancela una reserva. |
| POST | `/api/public/v1/quotes/inbound` | Webhook genérico: recibe el JSON en el formato propio del cotizador y lo traduce con el mapeo configurado. |

```bash
curl -X POST https://TU-SERVIDOR/api/public/v1/reservations \
  -H "X-API-Key: rk_..." -H "Content-Type: application/json" \
  -d '{"id":"COT-1001","customer":{"full_name":"Ana López","doc_number":"30111222","email":"ana@example.com"},
       "category_code":"D","pickup_at":"2027-01-15T10:00","return_at":"2027-01-20T10:00",
       "pickup_branch":"USH","extras":["GPS","CAD"],"total":420000}'
```

**Precio.** Se puede respetar el total que envía el cotizador o recalcularlo con las tarifas del sistema. Las reservas pueden entrar confirmadas automáticamente o como pendientes.

**Avisos salientes.** Si configurás una URL, el sistema envía un POST cuando una reserva se crea, modifica, confirma, cancela, entrega, devuelve o registra un pago. Los eventos son `reservation.created`, `reservation.confirmed`, `reservation.checked_out`, etc. Cada aviso va firmado con HMAC-SHA256 en el header `X-Signature`.

## Cancelaciones y devolución de dinero

Cada empresa configura su política en *Ajustes → Empresa y contrato → Cancelaciones y devolución de dinero*. Por defecto:

- cancela con **72 h o más** de anticipación al retiro: se devuelve el **100 %** de lo pagado;
- entre **72 y 24 h**: el **50 %**;
- con **menos de 24 h** o si **no se presenta**: no hay devolución.

Más un texto libre con condiciones extra. **Los valores y el texto son un ejemplo: cada agencia los revisa según las leyes de su país.**

Al cancelar una reserva, la app muestra cuánto corresponde devolver y lo deja registrado en el historial de la reserva. No mueve dinero: la devolución se hace aparte y se anota en *Pagos* como "Devolución de dinero". La garantía se devuelve completa. La política sale en el voucher (WhatsApp, email y PDF) y como última cláusula del contrato.

## Factura electrónica (sólo prueba)

Desde una reserva confirmada, en curso o finalizada se puede emitir la factura: *Más acciones → Facturar (prueba)*. **Por ahora todo es de prueba y no tiene validez fiscal.**

- **Argentina (ARCA, ex AFIP):** Factura A (cliente con CUIT), B (consumidor final) o C (monotributo), con el pedido real del web service WSFE (`FECAESolicitar`).
- **Chile (SII):** boleta electrónica (tipo 39) o factura electrónica (tipo 33, cliente con RUT), con el DTE armado.

Cada empresa carga sus datos en *Ajustes → Empresa y contrato → Factura electrónica*: sistema (ARCA o SII), modo, CUIT o RUT de prueba, punto de venta y condición frente al IVA.

- **Simulado:** arma el pedido como lo pide el organismo pero no lo envía; el CAE o Track ID es inventado.
- **Homologación:** es el servidor de prueba del organismo. Necesita el certificado de prueba de la empresa; mientras no esté, la app avisa qué falta y no emite nada.

**Qué falta para facturar de verdad** (detalle en `src/invoicing/arca.js` y `src/invoicing/sii.js`):

1. El CUIT o RUT de cada agencia habilitado para factura electrónica (punto de venta "Web Services" en ARCA; emisor electrónico en el SII). Lo gestiona el contador con la clave fiscal.
2. El certificado digital de cada agencia: en ARCA, asociado al servicio `wsfe`; en el SII, un `.pfx` de una persona autorizada, más los folios (CAF).
3. Conectar el envío real: pedir el permiso al WSAA (ARCA) o el token (SII), firmar y mandar el pedido que la app ya arma, y guardar la respuesta.

## Reglas de cálculo

- **Días.** Se cobran bloques de 24 h. Si el cliente devuelve con hasta *N* horas de tolerancia (por defecto 2), no se cobra un día extra.
- **7 días o más.** Si la categoría tiene tarifa semanal, se usa esa tarifa prorrateada por día.
- **Temporadas.** El multiplicador se aplica a cada día que cae dentro de la temporada.
- **Adicionales.** Se cobran por día o por alquiler, con un tope opcional.
- **Recargos y descuentos.** Hay un recargo por devolver el auto en otro lugar y un descuento en %. El IVA puede estar incluido o sumarse aparte.
- **Al devolver el auto** se suman:
  - los km excedentes (km incluidos por día × días);
  - el combustible faltante (por octavo);
  - los días de demora respecto de la devolución pactada;
  - los daños.

## Estructura

```
src/
  server.js          arranque
  app.js             rutas y manejo de errores
  db.js              esquema SQLite y configuración
  platform.js        varias empresas: una base por empresa y el registro empresas.db
  pricing.js         cálculo de precios y de cargos al devolver
  availability.js    disponibilidad por categoría y por vehículo
  reservations.js    ciclo de vida de la reserva (crear, entregar, devolver, pagos)
  integration.js     traducción de cotizaciones externas a reservas
  webhooks.js        avisos salientes firmados
  invoicing/         factura electrónica de prueba (ARCA Argentina, SII Chile)
  routes/            API interna, API pública y formulario web
public/              interfaz web (sin necesidad de compilar)
test/                pruebas automáticas
```
