'use strict';

const { HttpError, pick } = require('./util');
const { proOn } = require('./db');

const ROLES = ['admin', 'operador', 'auxiliar', 'contable'];

/**
 * Auxiliar de flota: saca las fotos de entrega y devolución, carga km y combustible, mueve autos de sucursal
 * y ve qué sale y vuelve hoy, el calendario y los vencimientos. No entra a las reservas ni ve precios.
 * Lista cerrada: lo que no está acá, no lo puede hacer.
 */
const ALLOWED = [
  ['GET', /^\/(settings|branches|categories|extras|vehicles|dashboard|planning)$/],
  ['GET', /^\/vehicles\/\d+$/],
  ['PUT', /^\/vehicles\/\d+$/],
  ['GET', /^\/reservations\/\d+\/files$/],
  ['POST', /^\/reservations\/\d+\/files$/],
  ['POST', /^\/reservations\/\d+\/note$/],
  ['GET', /^\/files\/\d+$/],
];
// Funciones en prueba: también manda autos al taller y los saca. Costos no ve ni carga.
// shortcut: no reasigna las reservas que tenía ese auto; eso lo hace un operador desde Autos.
const SHOP = [
  ['GET', /^\/maintenance$/],
  ['POST', /^\/maintenance$/],
  ['PUT', /^\/maintenance\/\d+$/],
];
const SHOP_FIELDS = ['vehicle_id', 'kind', 'description', 'start_date', 'end_date', 'km', 'status'];
const PHOTO_STAGES = ['entrega', 'devolucion'];
// De un auto solo cambia dónde está y cómo está.
const VEHICLE_FIELDS = ['branch_id', 'km', 'fuel', 'panapass'];
// Todo lo que sea plata se saca de lo que recibe, esté donde esté.
const MONEY = new Set([
  'total', 'paid', 'pricing', 'deposit', 'discount_pct', 'discount_amount', 'final_total', 'charges', 'balance', 'payments', 'amount', 'cost',
  'month_revenue', 'owing', 'daily_rate', 'weekly_rate', 'monthly_rate', 'rest_day_rate', 'period_rate', 'extra_km_rate', 'price', 'max_price', 'one_day_price',
  'deductible', 'insurance_cost', 'rate_1', 'rate_6', 'rate_10', 'young_rate', 'no_deposit_fee', 'fuel_charge', 'fee_by_category', 'weekend_rate', 'holiday_rate', 'fee',
]);
const strip = (v) =>
  Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !MONEY.has(k)).map(([k, x]) => [k, strip(x)])) : v;

function auxiliarGuard(db) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== 'auxiliar') return next();
    const deny = () => next(new HttpError(403, 'Tu usuario no tiene permiso para eso'));
    const is = (list) => list.some(([method, path]) => method === req.method && path.test(req.path));
    const shop = proOn(db) && is(SHOP);
    if (!is(ALLOWED) && !shop) return deny();
    if (shop && req.method !== 'GET') req.body = pick(req.body, SHOP_FIELDS);
    else if (req.method === 'PUT') req.body = pick(req.body, VEHICLE_FIELDS);
    if (req.method === 'POST' && /\/files$/.test(req.path) && !PHOTO_STAGES.includes(req.query.stage)) return deny();
    const file = req.path.match(/^\/files\/(\d+)$/);
    if (file && !PHOTO_STAGES.includes((db.prepare('SELECT stage FROM reservation_files WHERE id = ?').get(Number(file[1])) || {}).stage)) return deny();
    const listing = /\/files$/.test(req.path) && req.method === 'GET';
    const json = res.json.bind(res);
    res.json = (body) => json(strip(listing && Array.isArray(body) ? body.filter((f) => PHOTO_STAGES.includes(f.stage)) : body));
    next();
  };
}

/**
 * Contabilidad: consulta todo lo que ve un operador más las estadísticas (caja, pagos, contratos, autos, gastos),
 * y lo único que carga son gastos de los autos. No crea ni cambia reservas, contratos, autos ni clientes.
 * Lista cerrada, como la del auxiliar: lo que no está acá, no lo puede hacer.
 */
const CONTABLE_WRITE = [
  ['POST', /^\/expenses$/],
  ['PUT', /^\/expenses\/\d+$/],
];
function contableGuard() {
  return (req, _res, next) => {
    if (!req.user || req.user.role !== 'contable') return next();
    if (req.method === 'GET' || CONTABLE_WRITE.some(([method, p]) => method === req.method && p.test(req.path))) return next();
    next(new HttpError(403, 'Tu usuario es de consulta: lo único que puede cargar son gastos de los autos'));
  };
}

module.exports = { auxiliarGuard, contableGuard, ROLES };
