# Rent a Car · Sistema de gestión

Aplicación web para el día a día del rent a car (flota, reservas, contratos, cobros y tarifas), en la línea de Rently / One Mobility, y conectada al cotizador del sitio web (discoverushuaia.com.ar) o a cualquier otro cotizador por API.

## Qué incluye

| Módulo | Para qué sirve |
| --- | --- |
| **Panel** | Entregas y devoluciones del día, devoluciones vencidas, ocupación, cobrado del mes, vencimientos de seguro/VTV y solicitudes del cotizador con error. |
| **Nueva reserva** | Cotiza en el momento: muestra el precio y la disponibilidad de cada categoría según las fechas, el lugar y los adicionales. Busca o crea el cliente y asigna el auto. |
| **Reservas** | Listado con filtros. En cada reserva: confirmar, asignar auto, **entregar** (abre el contrato con km y combustible), **devolver** (calcula km excedentes, combustible faltante, días de demora y daños), registrar pagos y garantías, imprimir el contrato y ver el historial. |
| **Planning** | Grilla de vehículos por días (estilo Rently): reservas por estado, autos en taller y reservas sin auto asignado. |
| **Flota** | Vehículos, estado, km, combustible, sucursal, vencimientos de seguro y VTV, historial de cada auto. |
| **Clientes** | Datos, documento, licencia (no deja entregar sin licencia o con licencia vencida) e historial. |
| **Contrato para imprimir** | Desde cualquier reserva, también antes de entregar el auto (pre-contrato con km y combustible para completar). Son 2 hojas A4: datos del cliente, conductor adicional, auto, período, entrega y devolución, diagrama para marcar daños, precio, pagos, firmas y condiciones generales (15 cláusulas). Las condiciones, la franquicia y la jurisdicción se editan en *Configuración*. |
| **Fotos y documentación** | Al entregar y al recibir un auto se sacan o se suben fotos (y PDF) del estado del vehículo. Quedan en la reserva, separadas en Entrega y Devolución, con quién y cuándo las subió. Las fotos del celular se achican solas antes de subirse. |
| **Mantenimiento** | Mientras hay un mantenimiento abierto, el auto sale de la flota disponible. Al cerrarlo, vuelve a la flota. |
| **Tarifas y sucursales** | Categorías (tarifa diaria y semanal, garantía, km incluidos), adicionales (por día o por alquiler, con tope), temporadas (+%) y lugares de entrega. |
| **Cotizador** | Conexión con el formulario web y con la API del cotizador, bandeja de solicitudes recibidas y avisos salientes. |
| **Usuarios** | Perfil *operador* (mostrador) y perfil *administrador* (también configura tarifas, el cotizador y los usuarios). |

## Ver la app en tu computadora (sin saber programar)

1. Instalá **Node.js** desde [nodejs.org](https://nodejs.org) (botón **LTS**, siguiente, siguiente, finalizar).
2. En esta página de GitHub tocá el botón verde **Code** → **Download ZIP**. Descomprimí el archivo (clic derecho → *Extraer todo*).
3. Abrí la carpeta y hacé doble clic en:
   - **Windows:** `iniciar-windows.bat`. Si aparece un aviso azul de Windows, tocá *Más información* → *Ejecutar de todas formas*.
   - **Mac:** `iniciar-mac.command`. Si macOS lo bloquea: clic derecho → *Abrir*.
4. La primera vez tarda un minuto. Después se abre el navegador con la app, cargada con datos de ejemplo. Usuario `admin@rentacar.local`, contraseña `admin123`. La primera vez la app te pide elegir una contraseña propia.

La app queda abierta mientras esté abierta la ventana negra. Así solo la ves vos, en tu computadora. Para que funcione con el sitio web hay que publicarla (sección *Publicarla en internet*).

## Puesta en marcha

Requiere **Node.js 22.5 o superior** (usa la base SQLite que ya trae Node, sin instalar ningún motor de base de datos).

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
   - Se usa un plan pago básico con un disco de 1 GB, para que los datos no se borren. Render muestra el precio antes de confirmar.
5. Esperá a que diga **Live**, en verde. Arriba vas a ver la dirección de la app, por ejemplo `https://rentacar-ushuaia.onrender.com`.
6. Para ver la contraseña del administrador, entrá al servicio y abrí la pestaña **Environment**. El usuario es `admin@rentacar.local` y la contraseña es el valor de `ADMIN_PASSWORD`.
7. Entrá a la app con ese usuario y contraseña. Ya podés cargar autos, tarifas y usuarios.
8. En **Cotizador → Formulario web**, copiá la línea `<script …>`. Ya trae la dirección real de la app. Mandásela a quien administra el sitio web para que la pegue en la página del cotizador.

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
  pricing.js         cálculo de precios y de cargos al devolver
  availability.js    disponibilidad por categoría y por vehículo
  reservations.js    ciclo de vida de la reserva (crear, entregar, devolver, pagos)
  integration.js     traducción de cotizaciones externas a reservas
  webhooks.js        avisos salientes firmados
  routes/            API interna, API pública y formulario web
public/              interfaz web (sin necesidad de compilar)
test/                pruebas automáticas
```
