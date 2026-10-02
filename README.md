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
| **Mantenimiento** | Mientras hay un mantenimiento abierto, el auto sale de la flota disponible. Al cerrarlo, vuelve a la flota. |
| **Tarifas y sucursales** | Categorías (tarifa diaria y semanal, garantía, km incluidos), adicionales (por día o por alquiler, con tope), temporadas (+%) y lugares de entrega. |
| **Cotizador** | Conexión con el formulario web y con la API del cotizador, bandeja de solicitudes recibidas y avisos salientes. |
| **Usuarios** | Perfil *operador* (mostrador) y perfil *administrador* (también configura tarifas, el cotizador y los usuarios). |

## Puesta en marcha

Requiere **Node.js 22.5 o superior** (usa la base SQLite que ya trae Node, sin instalar ningún motor de base de datos).

```bash
npm install
npm run seed     # opcional: carga datos de ejemplo (Ushuaia)
npm start        # http://localhost:3000
```

Usuario inicial: `admin@rentacar.local` / `admin123`. **Cambiá la contraseña** desde *Usuarios*. También podés definir otro usuario antes del primer inicio con `ADMIN_EMAIL` y `ADMIN_PASSWORD`.

Variables de entorno: `PORT` (por defecto 3000), `DB_FILE` (por defecto `data/rentacar.db`), `TRUST_PROXY` (por ejemplo `1` si el sistema está detrás de un proxy o de Nginx).

Para que el sitio web pueda enviar las cotizaciones, el sistema tiene que estar publicado en internet con HTTPS. Sirve cualquier VPS, Render, Railway o Fly.io. Hacé una copia de seguridad del archivo `data/rentacar.db`.

```bash
npm test         # pruebas automáticas
```

## Conexión con el cotizador de discoverushuaia.com.ar

En **Cotizador → Formulario web** hay dos formas de conectarlo.

**Opción A (recomendada).** Agregar una línea en la página del cotizador, antes de `</body>`:

```html
<script src="https://TU-SERVIDOR/webform.js" data-form="form"></script>
```

El formulario sigue funcionando igual que hoy (por ejemplo, si manda un mail) y además envía una copia al sistema, que la registra como **reserva pendiente** con origen "Formulario web". El mostrador sólo tiene que revisarla y confirmarla.

**Opción B.** Cambiar el `action` del formulario a `https://TU-SERVIDOR/api/public/webform` (método POST). Al enviar, el cliente vuelve a la página de "gracias" que configures.

**Ajustar los campos.** En el *mapeo de campos* se indica qué atributo `name` del formulario corresponde a cada dato (nombre, email, fecha y hora de retiro, vehículo, lugar, etc.). Cómo traducir lo que escribe el cliente:

- La **categoría** y el **lugar** se reconocen por código, por nombre o por los **alias** que cargues en *Tarifas y sucursales*. Por ejemplo, "SUV, camioneta" → categoría D, y "aeropuerto" → USH.
- Las fechas pueden llegar como `15/01/2027` o `2027-01-15`. Si la hora viene en un campo aparte, se usan `pickup_time` y `return_time`.
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
