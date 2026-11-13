'use strict';

const { HttpError, pick } = require('./util');

const ROLES = ['admin', 'operador', 'auxiliar'];

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
const PHOTO_STAGES = ['entrega', 'devolucion'];
// De un auto solo cambia dónde está y cómo está.
const VEHICLE_FIELDS = ['branch_id', 'km', 'fuel', 'panapass'];
// Todo lo que sea plata se saca de lo que recibe, esté donde esté.
const MONEY = new Set([
  'total', 'paid', 'pricing', 'deposit', 'discount_pct', 'discount_amount', 'final_total', 'charges', 'balance', 'payments', 'amount', 'cost',
  'month_revenue', 'owing', 'daily_rate', 'weekly_rate', 'monthly_rate', 'rest_day_rate', 'period_rate', 'extra_km_rate', 'price', 'max_price',
  'deductible', 'insurance_cost',
]);
const strip = (v) =>
  Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !MONEY.has(k)).map(([k, x]) => [k, strip(x)])) : v;

function auxiliarGuard(db) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== 'auxiliar') return next();
    const deny = () => next(new HttpError(403, 'Tu usuario no tiene permiso para eso'));
    if (!ALLOWED.some(([method, path]) => method === req.method && path.test(req.path))) return deny();
    if (req.method === 'PUT') req.body = pick(req.body, VEHICLE_FIELDS);
    if (req.method === 'POST' && /\/files$/.test(req.path) && !PHOTO_STAGES.includes(req.query.stage)) return deny();
    const file = req.path.match(/^\/files\/(\d+)$/);
    if (file && !PHOTO_STAGES.includes((db.prepare('SELECT stage FROM reservation_files WHERE id = ?').get(Number(file[1])) || {}).stage)) return deny();
    const listing = /\/files$/.test(req.path) && req.method === 'GET';
    const json = res.json.bind(res);
    res.json = (body) => json(strip(listing && Array.isArray(body) ? body.filter((f) => PHOTO_STAGES.includes(f.stage)) : body));
    next();
  };
}

module.exports = { auxiliarGuard, ROLES };
