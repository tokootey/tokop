'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operador',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  user_id INTEGER,
  email TEXT,
  ip TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_at ON audit_log(at);

CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  aliases TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT,
  daily_rate REAL NOT NULL DEFAULT 0,
  weekly_rate REAL NOT NULL DEFAULT 0,
  deposit REAL NOT NULL DEFAULT 0,
  km_per_day INTEGER NOT NULL DEFAULT 0,
  extra_km_rate REAL NOT NULL DEFAULT 0,
  seats INTEGER,
  transmission TEXT,
  aliases TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category_id INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  promo_rate REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS extras (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  charge_type TEXT NOT NULL DEFAULT 'dia',
  max_price REAL NOT NULL DEFAULT 0,
  aliases TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY,
  plate TEXT NOT NULL UNIQUE COLLATE NOCASE,
  brand TEXT,
  model TEXT,
  year INTEGER,
  color TEXT,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  branch_id INTEGER REFERENCES branches(id),
  status TEXT NOT NULL DEFAULT 'disponible',
  km INTEGER NOT NULL DEFAULT 0,
  fuel INTEGER NOT NULL DEFAULT 8,
  insurance_expiry TEXT,
  vtv_expiry TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  doc_type TEXT DEFAULT 'DNI',
  doc_number TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  birth_date TEXT,
  license_number TEXT,
  license_expiry TEXT,
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  pickup_branch_id INTEGER REFERENCES branches(id),
  return_branch_id INTEGER REFERENCES branches(id),
  pickup_at TEXT NOT NULL,
  return_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendiente',
  source TEXT NOT NULL DEFAULT 'manual',
  external_id TEXT,
  days INTEGER,
  pricing TEXT,
  total REAL NOT NULL DEFAULT 0,
  deposit REAL NOT NULL DEFAULT 0,
  discount_pct REAL NOT NULL DEFAULT 0,
  flight TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_reservations_external ON reservations(source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_reservations_dates ON reservations(pickup_at, return_at);

CREATE TABLE IF NOT EXISTS reservation_extras (
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  extra_id INTEGER NOT NULL REFERENCES extras(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (reservation_id, extra_id)
);

CREATE TABLE IF NOT EXISTS reservation_log (
  id INTEGER PRIMARY KEY,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  at TEXT DEFAULT CURRENT_TIMESTAMP,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY,
  reservation_id INTEGER NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE CASCADE,
  number TEXT UNIQUE,
  out_at TEXT, out_km INTEGER, out_fuel INTEGER, out_notes TEXT, out_user INTEGER,
  in_at TEXT, in_km INTEGER, in_fuel INTEGER, in_notes TEXT, in_user INTEGER,
  damages TEXT,
  charges TEXT,
  final_total REAL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'pago',
  method TEXT,
  amount REAL NOT NULL,
  reference TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS maintenance (
  id INTEGER PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  kind TEXT,
  description TEXT,
  start_date TEXT,
  end_date TEXT,
  km INTEGER,
  cost REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'abierto'
);

CREATE TABLE IF NOT EXISTS quote_inbox (
  id INTEGER PRIMARY KEY,
  received_at TEXT DEFAULT CURRENT_TIMESTAMP,
  external_id TEXT,
  payload TEXT,
  status TEXT,
  message TEXT,
  reservation_id INTEGER,
  channel TEXT NOT NULL DEFAULT 'cotizador'
);

CREATE TABLE IF NOT EXISTS reservation_files (
  id INTEGER PRIMARY KEY,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'otro',
  name TEXT,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_reservation_files ON reservation_files(reservation_id);

CREATE TABLE IF NOT EXISTS delivery_links (
  reservation_id INTEGER PRIMARY KEY REFERENCES reservations(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  photos_token TEXT NOT NULL UNIQUE,
  card_token TEXT NOT NULL UNIQUE,
  snapshot TEXT,
  signed_at TEXT,
  signed_name TEXT,
  signed_doc TEXT,
  signed_ip TEXT,
  signed_ua TEXT,
  signed_image TEXT,
  signed_hash TEXT,
  card_holder TEXT,
  card_brand TEXT,
  card_last4 TEXT,
  card_exp TEXT,
  card_at TEXT,
  card_ip TEXT
);

-- Licencia, DNI o cédula y pasaporte de cada cliente (uno por tipo) y licencias de otros conductores (varias): de la persona, no de un alquiler.
CREATE TABLE IF NOT EXISTS customer_files (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- Cada reserva busca sus pagos y su historial: sin índice se recorre la tabla entera.
CREATE INDEX IF NOT EXISTS ix_payments_reservation ON payments(reservation_id);
CREATE INDEX IF NOT EXISTS ix_reservation_log ON reservation_log(reservation_id);

-- Facturas electrónicas (por ahora sólo de prueba: mode = 'simulado' u 'homologacion').
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id),
  provider TEXT NOT NULL,
  mode TEXT NOT NULL,
  type INTEGER NOT NULL,
  type_name TEXT,
  point_of_sale INTEGER NOT NULL DEFAULT 1,
  number INTEGER NOT NULL,
  auth_code TEXT,
  auth_due TEXT,
  customer_name TEXT,
  customer_doc_type TEXT,
  customer_doc TEXT,
  currency TEXT,
  net REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'emitida',
  request TEXT,
  response TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_number ON invoices(provider, mode, type, point_of_sale, number);
CREATE INDEX IF NOT EXISTS ix_invoices_reservation ON invoices(reservation_id);

-- Modo "autos para choferes" (src/choferes.js): cada período del alquiler que se renueva solo,
-- los cargos aparte (multas, km extra) y los gastos de cada auto.
CREATE TABLE IF NOT EXISTS rental_periods (
  id INTEGER PRIMARY KEY,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (reservation_id, n)
);

CREATE TABLE IF NOT EXISTS rental_charges (
  id INTEGER PRIMARY KEY,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'multa',
  date TEXT,
  reference TEXT,
  description TEXT,
  km INTEGER NOT NULL DEFAULT 0,
  amount REAL NOT NULL,
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_rental_charges ON rental_charges(reservation_id);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'otro',
  description TEXT,
  amount REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_expenses_date ON expenses(date);

CREATE TABLE IF NOT EXISTS webhook_log (
  id INTEGER PRIMARY KEY,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  event TEXT,
  url TEXT,
  status INTEGER,
  response TEXT
);
`;

const DEFAULT_MAPPING = {
  external_id: 'id',
  'customer.full_name': 'customer.full_name',
  'customer.doc_type': 'customer.doc_type',
  'customer.doc_number': 'customer.doc_number',
  'customer.email': 'customer.email',
  'customer.phone': 'customer.phone',
  'customer.license_number': 'customer.license_number',
  category_code: 'category_code',
  pickup_at: 'pickup_at',
  pickup_time: 'pickup_time',
  return_at: 'return_at',
  return_time: 'return_time',
  pickup_branch: 'pickup_branch',
  return_branch: 'return_branch',
  extras: 'extras',
  total: 'total',
  flight: 'flight',
  notes: 'notes',
};

/**
 * Mapeo inicial para el formulario de cotización del sitio web (campos típicos en español).
 * Se ajusta desde la pantalla Cotizador → Formulario web según los "name" reales del formulario.
 */
const WEBFORM_MAPPING = {
  'customer.full_name': 'nombre',
  'customer.email': 'email',
  'customer.phone': 'telefono',
  'customer.doc_number': 'dni',
  category_code: 'vehiculo',
  pickup_at: 'fecha_retiro',
  pickup_time: 'hora_retiro',
  return_at: 'fecha_devolucion',
  return_time: 'hora_devolucion',
  pickup_branch: 'lugar_retiro',
  return_branch: 'lugar_devolucion',
  extras: 'adicionales',
  flight: 'vuelo',
  notes: 'comentarios',
};

const OLD_CONTRACT_TERMS =
  'El cliente declara recibir el vehículo en las condiciones detalladas y se compromete a devolverlo en el mismo estado, en la fecha, hora y lugar pactados.';

/**
 * Condiciones generales sugeridas para el contrato (editables en Configuración).
 * Las palabras entre llaves se completan con los datos de cada alquiler:
 * {empresa} {tolerancia} {edad_minima} {cargo_combustible} {kilometraje} {franquicia} {garantia} {jurisdiccion}
 */
const CONTRACT_TERMS = `1. OBJETO. {empresa} (en adelante, "la Empresa") entrega en alquiler al Cliente el vehículo descripto en este contrato, en buen estado de funcionamiento y limpieza, con la documentación obligatoria, rueda de auxilio, gato, llave de rueda, matafuego y balizas.

2. PLAZO Y DEVOLUCIÓN. El Cliente devolverá el vehículo en la fecha, hora y lugar pactados. Hay una tolerancia de {tolerancia} horas; pasado ese plazo se cobrará un día adicional por cada día o fracción de demora. La devolución anticipada no da derecho a reintegro, salvo acuerdo por escrito con la Empresa.

3. CONDUCTORES. Solo pueden conducir el Cliente y los conductores adicionales registrados en este contrato, mayores de {edad_minima} años y con licencia de conducir vigente para la categoría del vehículo. Está prohibido conducir bajo los efectos del alcohol, estupefacientes o medicamentos que afecten la conducción.

4. USO DEL VEHÍCULO. Queda prohibido: subalquilarlo o prestarlo; usarlo para transporte comercial de pasajeros o carga, competencias, pruebas, remolque o enseñanza de manejo; circular fuera de caminos habilitados; llevar más personas que las permitidas; fumar dentro del vehículo y llevar animales sin transportín.

5. SALIDA DEL PAÍS. El vehículo no puede salir del territorio argentino, incluido el paso por Chile para llegar al continente, sin autorización previa y por escrito de la Empresa, la documentación aduanera y el seguro internacional correspondientes, con los cargos que se informen.

6. COMBUSTIBLE. El vehículo se entrega con el nivel de combustible indicado en este contrato y debe devolverse con el mismo nivel. Cada octavo faltante se cobrará {cargo_combustible}.

7. KILOMETRAJE. {kilometraje}

8. SEGURO Y FRANQUICIA. El vehículo cuenta con seguro según la póliza vigente. El Cliente responde por los daños al vehículo hasta {franquicia} por evento, salvo que haya contratado la cobertura sin franquicia. Si el daño se produce por uso prohibido, conductor no autorizado, alcohol o estupefacientes, o incumplimiento de este contrato, el Cliente responde por el total del daño.

9. ACCIDENTES, ROBO Y AVERÍAS. Ante un accidente, robo, hurto o avería, el Cliente debe avisar de inmediato a la Empresa y, si corresponde, hacer la denuncia policial y entregar la documentación dentro de las 24 horas. No debe reconocer culpa ni acordar con terceros, ni hacer reparaciones sin autorización de la Empresa.

10. MULTAS, PEAJES Y ESTACIONAMIENTO. Las infracciones de tránsito, peajes y estacionamientos ocurridos durante el alquiler son a cargo del Cliente, aunque se notifiquen después de la devolución. La Empresa podrá informar los datos del conductor a la autoridad que lo requiera.

11. GARANTÍA. El Cliente deja una garantía de {garantia} (en efectivo o preautorización de tarjeta), que se devolverá al recibir el vehículo en las condiciones pactadas, descontando los cargos pendientes.

12. ESTADO DEL VEHÍCULO. El Cliente declara recibir el vehículo en el estado que consta en este contrato y en las fotos tomadas en la entrega, y se compromete a devolverlo igual, salvo el desgaste normal por el uso. Los daños no registrados en la entrega se considerarán ocurridos durante el alquiler. La limpieza extraordinaria se podrá cobrar aparte.

13. CONDICIONES CLIMÁTICAS. En temporada invernal el Cliente debe circular con precaución, usar cadenas cuando el estado del camino o la autoridad lo exijan y respetar los cortes de ruta.

14. DATOS PERSONALES. El Cliente presta su conformidad para que la Empresa trate sus datos personales con el fin de gestionar este alquiler, conforme a la Ley 25.326. Puede pedir el acceso, la rectificación o la supresión de sus datos a la Empresa.

15. JURISDICCIÓN. Para cualquier diferencia que surja de este contrato, las partes se someten a los tribunales ordinarios de {jurisdiccion}.`;

/** Las mismas condiciones en inglés: se usan cuando la app está en inglés (mismas {palabras}). */
const CONTRACT_TERMS_EN = `1. PURPOSE. {empresa} (hereinafter "the Company") rents to the Customer the vehicle described in this agreement, in good working order and clean, with the mandatory documents, spare wheel, jack, wheel wrench, fire extinguisher and warning triangles.

2. TERM AND RETURN. The Customer shall return the vehicle on the agreed date, time and place. There is a grace period of {tolerancia} hours; after that, an additional day will be charged for each day or part of a day of delay. Early return does not entitle the Customer to a refund, unless agreed in writing with the Company.

3. DRIVERS. Only the Customer and the additional drivers registered in this agreement may drive, if they are over {edad_minima} years old and hold a valid driver's license for the vehicle category. Driving under the influence of alcohol, drugs or medication that affects driving is forbidden.

4. USE OF THE VEHICLE. It is forbidden to: sublet or lend it; use it for commercial transport of passengers or goods, races, tests, towing or driving lessons; drive off authorized roads; carry more people than allowed; smoke inside the vehicle and carry animals without a carrier.

5. LEAVING THE COUNTRY. The vehicle may not leave Argentine territory, including crossing Chile to reach the mainland, without prior written authorization from the Company, the corresponding customs documents and international insurance, with the charges informed.

6. FUEL. The vehicle is delivered with the fuel level stated in this agreement and must be returned with the same level. Each missing eighth will be charged {cargo_combustible}.

7. MILEAGE. {kilometraje}

8. INSURANCE AND DEDUCTIBLE. The vehicle is insured according to the policy in force. The Customer is liable for damage to the vehicle up to {franquicia} per event, unless the no-deductible cover was purchased. If the damage results from forbidden use, an unauthorized driver, alcohol or drugs, or breach of this agreement, the Customer is liable for the full damage.

9. ACCIDENTS, THEFT AND BREAKDOWNS. In case of an accident, theft or breakdown, the Customer must notify the Company immediately and, where applicable, file a police report and hand in the documents within 24 hours. The Customer must not admit fault or settle with third parties, nor carry out repairs without the Company's authorization.

10. FINES, TOLLS AND PARKING. Traffic fines, tolls and parking incurred during the rental are paid by the Customer, even if notified after the return. The Company may report the driver's details to the authority that requests them.

11. DEPOSIT. The Customer leaves a deposit of {garantia} (in cash or as a credit card pre-authorization), which will be returned when the vehicle is received in the agreed condition, minus any outstanding charges.

12. CONDITION OF THE VEHICLE. The Customer declares receiving the vehicle in the condition recorded in this agreement and in the photos taken at pick-up, and undertakes to return it in the same condition, except for normal wear and tear. Damage not recorded at pick-up will be considered to have occurred during the rental. Extraordinary cleaning may be charged separately.

13. WEATHER CONDITIONS. In winter the Customer must drive carefully, use chains when road conditions or the authorities require it, and respect road closures.

14. PERSONAL DATA. The Customer agrees that the Company processes their personal data in order to manage this rental, in accordance with Law 25,326. The Customer may request access to, correction or deletion of their data from the Company.

15. JURISDICTION. For any dispute arising from this agreement, the parties submit to the ordinary courts of {jurisdiccion}.`;

/**
 * Contrato para el modo "autos para choferes" (auto de trabajo para Uber, DiDi, Cabify, remis o reparto).
 * Mismas reglas que CONTRACT_TERMS; además: {periodo} {precio_periodo} {recargo_atraso} {dias_gracia} {garante} {uso}
 */
const CONTRACT_TERMS_CHOFERES = `1. OBJETO. {empresa} (en adelante, "el Locador") da en alquiler al Locatario el vehículo descripto en este contrato, para que lo use como herramienta de trabajo propia. El Locatario trabaja por su cuenta y riesgo: este contrato no crea relación laboral, sociedad ni mandato entre las partes. Se rige por los artículos 1187 y siguientes del Código Civil y Comercial de la Nación.

2. VEHÍCULO. Se entrega con la cédula de identificación (o autorización para conducir), el comprobante de seguro vigente, la VTV/RTO vigente, matafuego, balizas, rueda de auxilio, gato y llave de rueda. El estado del vehículo al entregarlo consta en este contrato y en las fotos tomadas en la entrega.

3. PLAZO Y RENOVACIÓN. El alquiler es por {periodo} y empieza en la fecha de entrega que figura en este contrato. Si ninguna parte avisa por escrito con 7 días de anticipación, se renueva automáticamente por otro período igual, con el mismo precio salvo que se acuerde uno nuevo.

4. PRECIO Y FORMA DE PAGO. El alquiler es de {precio_periodo} por {periodo}, pagadero por adelantado al comienzo de cada período, por transferencia o en efectivo contra recibo. Si el pago se atrasa más de {dias_gracia} días, se cobra un recargo de {recargo_atraso} por día de atraso, y el Locador puede retener el vehículo hasta que se pague.

5. DEPÓSITO DE GARANTÍA. Al firmar, el Locatario entrega {garantia} como garantía. El Locador lo devuelve dentro de los 10 días posteriores a la devolución del vehículo, descontando alquileres impagos, recargos, multas, franquicias del seguro, daños no cubiertos y faltantes. Si esos importes superan el depósito, el Locatario paga la diferencia.{garante}

6. USO PERMITIDO. El Locatario puede usar el vehículo para {uso}. Está prohibido: subalquilarlo o prestarlo; usarlo para competencias, remolque o transporte de cargas peligrosas; sacarlo del país o de la zona sin permiso escrito del Locador; manejar bajo efectos del alcohol o drogas; y hacerle modificaciones.

7. CONDUCTOR HABILITADO. Solo puede manejar el Locatario, con licencia vigente y de la categoría que corresponda al uso (incluida la profesional, si la exige la jurisdicción). Otro conductor necesita autorización escrita del Locador y queda bajo la responsabilidad del Locatario. El Locatario se encarga de sus propias habilitaciones, inscripciones en las aplicaciones e impuestos. Si el vehículo es multado, retenido o secuestrado porque al Locatario le falta una habilitación, el Locatario paga la multa, el acarreo, la playa y el alquiler de esos días.

8. MANTENIMIENTO. El Locador paga el service programado, los neumáticos por desgaste normal y las reparaciones por fallas propias del vehículo, en el taller que elija. El Locatario paga el lavado, el control diario de aceite, agua y presión de neumáticos, y las reparaciones por mal uso o negligencia. Si aparece una falla o se enciende un testigo en el tablero, el Locatario avisa dentro de las 24 horas y deja de usar el vehículo si seguir puede dañarlo. Los días en el taller por una falla que no sea culpa del Locatario no se cobran.

9. COMBUSTIBLE Y KILOMETRAJE. El combustible, los peajes (incluido el TelePase, si el vehículo lo tiene) y el estacionamiento son a cargo del Locatario. El vehículo se devuelve con el mismo nivel de combustible con que se entregó. {kilometraje}

10. RASTREO SATELITAL (GPS). Si el vehículo tiene un dispositivo de rastreo, el Locatario lo conoce y lo acepta. El Locador lo usa solo para ubicar el vehículo, controlar el kilometraje y actuar en caso de robo o incumplimiento, y no comparte esos datos salvo pedido de una autoridad. El Locatario no puede desconectarlo ni manipularlo.

11. SEGURO Y SINIESTROS. El vehículo tiene un seguro que cubre el uso indicado en la cláusula 6. Ante un choque o siniestro, el Locatario debe avisar al Locador de inmediato, tomar datos y fotos, hacer la denuncia policial si corresponde y entregar la denuncia firmada dentro de las 72 horas. La franquicia y los daños que el seguro no cubra los paga el Locatario cuando el siniestro sea por su culpa o se haya violado este contrato o la póliza, hasta {franquicia} por siniestro, salvo dolo o culpa grave. Si el Locador tiene que pagarle a un tercero por un daño que causó el Locatario y que el seguro no cubre, el Locatario se lo devuelve.

12. MULTAS. Las multas de tránsito, fotomultas y acarreos producidos mientras el vehículo esté en poder del Locatario los paga el Locatario, aunque lleguen después de terminado el contrato. El Locador puede identificarlo ante la autoridad como conductor responsable: cuando llegue un acta, le avisa y el Locatario firma la identificación de conductor y entrega una copia de su licencia dentro de los 5 días. Las multas que lleguen después de devolver el vehículo se pueden descontar de la garantía o cobrar aparte.

13. ROBO O HURTO. En caso de robo o hurto, el Locatario hace la denuncia policial, avisa al Locador dentro de las 24 horas y le entrega las llaves y la documentación. Si el robo se produce por descuido del Locatario (por ejemplo, dejar las llaves puestas o el vehículo abierto), responde por los daños que el seguro no cubra.

14. DEVOLUCIÓN. Al terminar el contrato, el Locatario devuelve el vehículo limpio, con la documentación y los accesorios, y en el mismo estado en que lo recibió, salvo el desgaste normal por uso. Las partes revisan juntas el vehículo y registran la devolución. Por cada día de demora se cobra el precio de un día de alquiler.

15. RESCISIÓN. Cualquiera de las partes puede terminar el contrato sin dar motivo, avisando por escrito con 7 días de anticipación. El Locador puede terminarlo de inmediato y pedir la devolución del vehículo si el Locatario no paga en término, lo usa de forma no permitida, lo deja manejar a otra persona, desconecta el GPS o tiene la licencia vencida o suspendida. En ese caso, el Locatario lo devuelve dentro de las 24 horas.

16. DOMICILIOS Y JURISDICCIÓN. Las partes constituyen domicilio en los indicados en este contrato, donde son válidas todas las notificaciones, incluidas las enviadas por correo electrónico o WhatsApp a los datos informados. Para cualquier conflicto, se someten a los tribunales ordinarios de {jurisdiccion}.`;

/**
 * Datos de cada país para que la app sirva a agencias de otros lugares: al elegir el país en
 * Configuración se completan la moneda, el impuesto, el nombre de la identificación fiscal y el
 * formato de números y fechas. Las alícuotas son las generales: cada empresa las puede ajustar.
 */
const COUNTRY_PRESETS = {
  AR: { name: 'Argentina', currency: 'ARS', locale: 'es-AR', tax_name: 'IVA', tax_rate: '21', tax_id_label: 'CUIT' },
  CL: { name: 'Chile', currency: 'CLP', locale: 'es-CL', tax_name: 'IVA', tax_rate: '19', tax_id_label: 'RUT' },
  UY: { name: 'Uruguay', currency: 'UYU', locale: 'es-UY', tax_name: 'IVA', tax_rate: '22', tax_id_label: 'RUT' },
  PY: { name: 'Paraguay', currency: 'PYG', locale: 'es-PY', tax_name: 'IVA', tax_rate: '10', tax_id_label: 'RUC' },
  BO: { name: 'Bolivia', currency: 'BOB', locale: 'es-BO', tax_name: 'IVA', tax_rate: '13', tax_id_label: 'NIT' },
  PE: { name: 'Perú', currency: 'PEN', locale: 'es-PE', tax_name: 'IGV', tax_rate: '18', tax_id_label: 'RUC' },
  CO: { name: 'Colombia', currency: 'COP', locale: 'es-CO', tax_name: 'IVA', tax_rate: '19', tax_id_label: 'NIT' },
  EC: { name: 'Ecuador', currency: 'USD', locale: 'es-EC', tax_name: 'IVA', tax_rate: '15', tax_id_label: 'RUC' },
  MX: { name: 'México', currency: 'MXN', locale: 'es-MX', tax_name: 'IVA', tax_rate: '16', tax_id_label: 'RFC' },
  CR: { name: 'Costa Rica', currency: 'CRC', locale: 'es-CR', tax_name: 'IVA', tax_rate: '13', tax_id_label: 'Cédula jurídica' },
  PA: { name: 'Panamá', currency: 'USD', locale: 'es-PA', tax_name: 'ITBMS', tax_rate: '7', tax_id_label: 'RUC' },
  DO: { name: 'República Dominicana', currency: 'DOP', locale: 'es-DO', tax_name: 'ITBIS', tax_rate: '18', tax_id_label: 'RNC' },
  GT: { name: 'Guatemala', currency: 'GTQ', locale: 'es-GT', tax_name: 'IVA', tax_rate: '12', tax_id_label: 'NIT' },
  ES: { name: 'España (península y Baleares)', currency: 'EUR', locale: 'es-ES', tax_name: 'IVA', tax_rate: '21', tax_id_label: 'NIF' },
  'ES-CN': { name: 'España (Islas Canarias)', currency: 'EUR', locale: 'es-ES', tax_name: 'IGIC', tax_rate: '7', tax_id_label: 'NIF' },
  US: { name: 'Estados Unidos', currency: 'USD', locale: 'es-US', tax_name: 'Sales tax', tax_rate: '0', tax_id_label: 'EIN' },
  OTHER: { name: 'Otro país', currency: 'USD', locale: 'es-419', tax_name: 'Impuesto', tax_rate: '0', tax_id_label: 'ID fiscal' },
};

const DEFAULT_SETTINGS = {
  company_name: 'Mi Rent a Car',
  company_tax_id: '',
  company_address: '',
  company_phone: '',
  country: 'AR',
  locale: 'es-AR',
  currency: 'ARS',
  tax_name: 'IVA',
  tax_id_label: 'CUIT',
  tax_rate: '21',
  prices_include_tax: '1',
  grace_hours: '2',
  one_way_fee: '0',
  fuel_charge_per_eighth: '0',
  min_driver_age: '21',
  contract_terms: CONTRACT_TERMS,
  deductible_amount: '',
  jurisdiction: 'la ciudad de Ushuaia, Provincia de Tierra del Fuego',
  // Versión en inglés de los textos propios de la empresa (contrato y voucher con la app en inglés).
  contract_terms_en: CONTRACT_TERMS_EN,
  jurisdiction_en: 'the city of Ushuaia, Province of Tierra del Fuego',
  // Tipo de negocio: 'turismo' (alquiler por días, el de siempre) o 'choferes' (autos de trabajo para choferes de apps, src/choferes.js).
  business_mode: 'turismo',
  rent_period: 'semana', // 'dia', 'semana' o 'mes': cada cuánto se cobra y se renueva el alquiler
  // Funciones en prueba: las activa el dueño de Floty por agencia, desde el panel. Apagadas no cambian nada.
  pro_features: '0',
  turnaround_minutes: '0', // minutos entre la devolución de un auto y su próximo alquiler
  dynamic_pricing_rules: '', // recargo según ocupación de la categoría, "ocupación:recargo": 70:10, 90:20
  pay_modes: '0', // '1': cobrando por día, cada auto elige si paga cada 24 o cada 12 horas (lo activa el dueño de Floty por agencia)
  young_driver_age: '21', // conductor menor de esta edad el día del retiro: paga young_driver_fee, una vez por alquiler
  young_driver_fee: '0',
  after_hours_fee: '0', // retiro o devolución entre after_hours_from y after_hours_to: recargo fijo, una vez; después de esa hora el link de reservas no entrega
  after_hours_from: '20:00',
  after_hours_to: '23:00',
  paypal_surcharge_pct: '0', // recargo al cobrar con PayPal (%), lo carga cada agencia
  extra_pay_methods: '', // medios de pago propios de la agencia, uno por renglón: se suman a los del país al registrar un cobro
  late_fee_per_day: '0', // recargo por cada día de atraso en el pago
  late_grace_days: '0', // días de tolerancia antes de cobrar el recargo
  holidays: '', // feriados, DD/MM/AAAA separados por coma: en choferes llevan la tarifa de domingos; en turismo, la de feriado si holiday_rates_on = '1' (ahí también valen rangos DD/MM/AAAA-DD/MM/AAAA)
  weekend_rates_on: '0', // '1': retirando viernes, sábado o domingo por hasta 5 días se cobra la tarifa de fin de semana de la categoría
  holiday_rates_on: '0', // '1': los días feriados se cobran con la tarifa de feriado de la categoría
  late_hour_fee: '0', // precio de cada hora pasada de la tolerancia (0 = pasada la tolerancia se cobra un día más)
  late_hour_max: '4', // hasta cuántas horas se cobran por hora; con más, es un día entero
  km_limit_max_days: '0', // el límite de km rige en alquileres de hasta estos días (0 = siempre)
  contract_terms_choferes: CONTRACT_TERMS_CHOFERES,
  // Integración con cotizador
  api_key: '',
  quote_mapping: JSON.stringify(DEFAULT_MAPPING, null, 2),
  quote_price_source: 'cotizador', // 'cotizador' respeta el total recibido, 'sistema' recalcula con las tarifas
  quote_auto_confirm: '0',
  webhook_url: '',
  webhook_secret: '',
  // WhatsApp de la agencia (Cloud API de Meta): con los tres datos, los mensajes al cliente salen solos.
  wa_phone_id: '',
  wa_token: '',
  wa_template: '',
  wa_template_lang: 'es',
  reminder_auto: '0', // recordatorio al cliente 12 horas antes de la entrega (src/reminders.js)
  // Formulario web (ej. el cotizador de discoverushuaia.com.ar)
  webform_enabled: '1',
  webform_mapping: JSON.stringify(WEBFORM_MAPPING, null, 2),
  webform_allowed_origins: 'https://www.discoverushuaia.com.ar,https://discoverushuaia.com.ar',
  webform_redirect_url: '',
  // Asistente de reservas (chat para la página web de la agencia)
  chat_enabled: '0',
  chat_welcome: '',
  chat_whatsapp: '',
  payment_link_url: '', // link de pago de la agencia (su banco o pasarela) para cobrar la reserva
  deposit_link_url: '', // ídem para cobrar la garantía; se ofrece apenas se registra el pago de la reserva
  express_requires_payment: '0', // '1': la entrega express (pre-entrega) sólo se hace con la reserva paga
  chat_hotel: '0', // '1': el link de reservas ofrece llevar el auto al hotel del cliente
  chat_faq: '',
  // Factura electrónica, sólo de prueba (src/invoicing): cada empresa carga sus datos fiscales.
  invoice_provider: '', // 'arca' (Argentina) o 'sii' (Chile)
  invoice_mode: 'simulado', // 'simulado' u 'homologacion'
  invoice_tax_id: '', // CUIT o RUT de prueba
  invoice_point_of_sale: '1',
  invoice_tax_condition: 'RI', // Argentina: 'RI' (Responsable Inscripto) o 'MONO' (Monotributo)
  // Política de devolución de dinero al cancelar (src/refunds.js). Es un ejemplo: cada agencia la ajusta a sus leyes.
  refund_full_hours: '72', // con esta anticipación o más se devuelve el 100 %
  refund_partial_hours: '24', // entre ésta y la anterior se devuelve refund_partial_pct
  refund_partial_pct: '50',
  refund_terms:
    'La garantía se devuelve completa al cancelar. Las devoluciones se hacen por el mismo medio de pago dentro de los 10 días hábiles. Si la empresa cancela la reserva, se devuelve el 100 % de lo pagado.',
  refund_terms_en:
    'The deposit is returned in full on cancellation. Refunds are made with the same payment method within 10 business days. If the company cancels the booking, 100 % of the amount paid is refunded.',
};

function openDb(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'rentacar.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
  // Instalaciones con el texto de contrato original: pasan a las condiciones completas.
  if (getSetting(db, 'contract_terms') === OLD_CONTRACT_TERMS) setSetting(db, 'contract_terms', CONTRACT_TERMS);
  if (!getSetting(db, 'api_key')) setSetting(db, 'api_key', newApiKey());
  if (!getSetting(db, 'webhook_secret')) setSetting(db, 'webhook_secret', crypto.randomBytes(24).toString('hex'));
  return db;
}

/** Columnas agregadas después de la primera versión (las bases existentes se actualizan solas). */
function migrate(db) {
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  // Otros conductores: un cliente puede tener varias licencias "conductor"; el resto de los documentos sigue siendo uno por tipo.
  const filesSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'customer_files'").get() || {}).sql || '';
  if (filesSql.includes('UNIQUE (customer_id, kind)')) {
    db.exec(`BEGIN;
      CREATE TABLE customer_files_new (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, kind TEXT NOT NULL, name TEXT,
        mime TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL, created_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO customer_files_new SELECT id, customer_id, kind, name, mime, size, path, created_by, created_at FROM customer_files;
      DROP TABLE customer_files;
      ALTER TABLE customer_files_new RENAME TO customer_files;
      COMMIT;`);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_customer_files_kind ON customer_files(customer_id, kind) WHERE kind <> 'conductor'");
  if (!has('users', 'must_change_password')) db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  if (!has('sessions', 'created_at')) db.exec('ALTER TABLE sessions ADD COLUMN created_at TEXT');
  if (!has('sessions', 'last_seen')) db.exec('ALTER TABLE sessions ADD COLUMN last_seen TEXT');
  if (!has('customers', 'anonymized_at')) db.exec('ALTER TABLE customers ADD COLUMN anonymized_at TEXT');
  // Descuento en pesos (para redondear el total), además del porcentaje.
  if (!has('reservations', 'discount_amount')) db.exec('ALTER TABLE reservations ADD COLUMN discount_amount REAL NOT NULL DEFAULT 0');
  // Entrega o devolución en un hotel (JSON) y el código del link para que el cliente complete los datos.
  if (!has('reservations', 'hotel')) db.exec('ALTER TABLE reservations ADD COLUMN hotel TEXT');
  // Cuándo se le mandó al cliente el recordatorio de la entrega ('error': falló el envío automático).
  if (!has('reservations', 'reminder_at')) db.exec('ALTER TABLE reservations ADD COLUMN reminder_at TEXT');
  if (!has('reservations', 'hotel_token')) db.exec('ALTER TABLE reservations ADD COLUMN hotel_token TEXT');
  // El costo de la entrega en hotel es un adicional (código HOTEL): arranca en 0 y cada agencia le pone su precio.
  db.exec("INSERT OR IGNORE INTO extras (code, name, price, charge_type, max_price) VALUES ('HOTEL', 'Entrega en hotel', 0, 'fijo', 0)");
  // Seguros: un adicional con tipo "seguro" (se elige uno por reserva) y su franquicia, que carga cada agencia.
  if (!has('extras', 'kind')) db.exec("ALTER TABLE extras ADD COLUMN kind TEXT NOT NULL DEFAULT 'adicional'");
  if (!has('extras', 'deductible')) db.exec('ALTER TABLE extras ADD COLUMN deductible REAL NOT NULL DEFAULT 0');
  // Modo choferes: tarifa mensual y km por período en la categoría, datos del chofer y su garante, service cada X km.
  if (!has('categories', 'monthly_rate')) db.exec('ALTER TABLE categories ADD COLUMN monthly_rate REAL NOT NULL DEFAULT 0');
  if (!has('categories', 'km_per_period')) db.exec('ALTER TABLE categories ADD COLUMN km_per_period INTEGER NOT NULL DEFAULT 0');
  // Cobro por día: precio de los domingos y feriados (0 = el mismo de todos los días).
  if (!has('categories', 'rest_day_rate')) db.exec('ALTER TABLE categories ADD COLUMN rest_day_rate REAL NOT NULL DEFAULT 0');
  // Precio propio de cada auto por período y de sus domingos y feriados (0 = el de la categoría).
  if (!has('vehicles', 'period_rate')) db.exec('ALTER TABLE vehicles ADD COLUMN period_rate REAL NOT NULL DEFAULT 0');
  if (!has('vehicles', 'rest_day_rate')) db.exec('ALTER TABLE vehicles ADD COLUMN rest_day_rate REAL NOT NULL DEFAULT 0');
  // Cobro por día: el chofer de este auto no paga los domingos ni los feriados.
  if (!has('vehicles', 'rest_day_free')) db.exec('ALTER TABLE vehicles ADD COLUMN rest_day_free INTEGER NOT NULL DEFAULT 0');
  // Cobro por día: cada cuántas horas paga el chofer de este auto (24 o 12).
  if (!has('vehicles', 'pay_every')) db.exec('ALTER TABLE vehicles ADD COLUMN pay_every INTEGER NOT NULL DEFAULT 24');
  // Seguro de cada auto (la cuota mensual se carga sola como gasto) y su habilitación (remis / apps).
  for (const col of ['insurance_company', 'insurance_policy', 'permit_number', 'permit_expiry']) {
    if (!has('vehicles', col)) db.exec(`ALTER TABLE vehicles ADD COLUMN ${col} TEXT`);
  }
  if (!has('vehicles', 'insurance_cost')) db.exec('ALTER TABLE vehicles ADD COLUMN insurance_cost REAL NOT NULL DEFAULT 0');
  // Notas de cada pago (por ejemplo: pagó una parte y otra en un repuesto).
  // Contrato pendiente después de la devolución (saldo, daños o faltantes): se cierra aparte. Los ya devueltos quedan cerrados.
  if (!has('contracts', 'closed_at')) {
    db.exec('ALTER TABLE contracts ADD COLUMN closed_at TEXT; ALTER TABLE contracts ADD COLUMN pending_note TEXT; UPDATE contracts SET closed_at = in_at WHERE in_at IS NOT NULL');
  }
  // Contrato: titular distinto del conductor (JSON) y conductores adicionales (JSON, hasta 5); lugar de trabajo y contacto alternativo del cliente.
  for (const col of ['holder', 'drivers']) if (!has('reservations', col)) db.exec(`ALTER TABLE reservations ADD COLUMN ${col} TEXT`);
  // Cliente bloqueado: con motivo cargado no se le toman reservas (vacío = no está bloqueado).
  if (!has('customers', 'blocked_reason')) db.exec('ALTER TABLE customers ADD COLUMN blocked_reason TEXT');
  for (const col of ['workplace', 'alt_contact']) if (!has('customers', col)) db.exec(`ALTER TABLE customers ADD COLUMN ${col} TEXT`);
  if (!has('payments', 'notes')) db.exec('ALTER TABLE payments ADD COLUMN notes TEXT');
  // Sucursal donde se cobró (caja diaria). En los pagos viejos queda vacía: cuenta la sucursal de retiro.
  if (!has('payments', 'branch_id')) db.exec('ALTER TABLE payments ADD COLUMN branch_id INTEGER');
  // Gastos que se cargan solos (la cuota del seguro de cada mes): la clave evita cargarlos dos veces.
  if (!has('expenses', 'auto_key')) db.exec('ALTER TABLE expenses ADD COLUMN auto_key TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ix_expenses_auto ON expenses(auto_key)');
  for (const col of ['license_class', 'work_apps', 'guarantor_name', 'guarantor_doc', 'guarantor_phone', 'guarantor_address']) {
    if (!has('customers', col)) db.exec(`ALTER TABLE customers ADD COLUMN ${col} TEXT`);
  }
  // Autos que en la web sólo se consultan por WhatsApp (la agencia quiere escuchar ofertas): no se reservan ni se pagan online.
  if (!has('vehicles', 'web_inquiry')) db.exec('ALTER TABLE vehicles ADD COLUMN web_inquiry INTEGER NOT NULL DEFAULT 0');
  // Tarifas por tramo de días (6 a 9, 10 o más), de fin de semana y de feriado; recargo por entregar o devolver en una sucursal (gratis desde N días).
  for (const col of ['rate_6', 'rate_10', 'weekend_rate', 'holiday_rate']) if (!has('categories', col)) db.exec(`ALTER TABLE categories ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
  if (!has('branches', 'fee')) db.exec('ALTER TABLE branches ADD COLUMN fee REAL NOT NULL DEFAULT 0');
  if (!has('branches', 'fee_free_days')) db.exec('ALTER TABLE branches ADD COLUMN fee_free_days INTEGER NOT NULL DEFAULT 0');
  // Horario de retiro que acepta el cotizador público en cada sucursal (vacío = sin límite).
  for (const col of ['pickup_from', 'late_after', 'late_pickup_from']) {
    if (!has('branches', col)) db.exec(`ALTER TABLE branches ADD COLUMN ${col} TEXT`);
  }
  // Reserva express: la del link con menos de 24 hs en un lugar sin personal de la agencia (un hotel, o la sucursal marcada así).
  if (!has('branches', 'express_24h')) db.exec('ALTER TABLE branches ADD COLUMN express_24h INTEGER NOT NULL DEFAULT 0');
  if (!has('reservations', 'express')) db.exec('ALTER TABLE reservations ADD COLUMN express INTEGER NOT NULL DEFAULT 0');
  // Saldo del Panapass (peajes de Panamá): el del auto, y con cuánto salió y volvió en cada contrato.
  if (!has('vehicles', 'panapass')) db.exec('ALTER TABLE vehicles ADD COLUMN panapass REAL');
  if (!has('vehicles', 'panapass_number')) db.exec('ALTER TABLE vehicles ADD COLUMN panapass_number TEXT');
  for (const col of ['out_panapass', 'in_panapass']) if (!has('contracts', col)) db.exec(`ALTER TABLE contracts ADD COLUMN ${col} REAL`);
  // Cédula de circulación (registro del vehículo): su vencimiento se avisa como el del seguro.
  if (!has('vehicles', 'registration_expiry')) db.exec('ALTER TABLE vehicles ADD COLUMN registration_expiry TEXT');
  // Fecha del próximo service: se avisa un mes antes, como el seguro.
  if (!has('vehicles', 'service_due')) db.exec('ALTER TABLE vehicles ADD COLUMN service_due TEXT');
  if (!has('vehicles', 'service_every_km')) db.exec('ALTER TABLE vehicles ADD COLUMN service_every_km INTEGER NOT NULL DEFAULT 0');
  // Entrega express: dónde quedó el auto y el link para que el cliente suba las fotos de la devolución.
  for (const col of ['left_place', 'return_token', 'pre_delivery', 'docs_token']) {
    if (!has('delivery_links', col)) db.exec(`ALTER TABLE delivery_links ADD COLUMN ${col} TEXT`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ix_delivery_return ON delivery_links(return_token)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ix_delivery_docs ON delivery_links(docs_token)');
  // La sucursal de ejemplo "Entrega en hotel" duplicaba la opción Hotel: se apaga una sola vez (sus reservas viejas quedan igual;
  // si la agencia la vuelve a activar, no se toca más).
  if (!getSetting(db, 'migracion_sucursal_hotel')) {
    db.prepare("UPDATE branches SET active = 0 WHERE code = 'HTL' AND name = 'Entrega en hotel'").run();
    setSetting(db, 'migracion_sucursal_hotel', '1');
  }
}

const newApiKey = () => 'rk_' + crypto.randomBytes(24).toString('hex');

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

function getSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

const proOn = (db) => getSetting(db, 'pro_features') === '1';

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value === null || value === undefined ? '' : String(value),
  );
}

module.exports = { COUNTRY_PRESETS, openDb, proOn, getSetting, getSettings, setSetting, newApiKey, DEFAULT_MAPPING, WEBFORM_MAPPING, DEFAULT_SETTINGS, CONTRACT_TERMS, CONTRACT_TERMS_EN, CONTRACT_TERMS_CHOFERES };
