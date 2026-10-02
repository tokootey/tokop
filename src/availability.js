'use strict';

/** Estados de reserva que ocupan un vehículo / cupo de categoría. */
const BLOCKING = ['pendiente', 'confirmada', 'en_curso'];
/** Estados de vehículo que lo sacan de la flota operativa. */
const OUT_OF_FLEET = ['mantenimiento', 'fuera_servicio'];

const inList = (arr) => arr.map((s) => `'${s}'`).join(',');

/** Vehículos de una categoría libres en el rango (sin reservas solapadas). */
function availableVehicles(db, { category_id, pickup_at, return_at, exclude_reservation_id = 0 }) {
  return db
    .prepare(
      `SELECT v.*, b.name AS branch_name FROM vehicles v
       LEFT JOIN branches b ON b.id = v.branch_id
       WHERE v.category_id = ? AND v.status NOT IN (${inList(OUT_OF_FLEET)})
         AND v.id NOT IN (
           SELECT vehicle_id FROM reservations
           WHERE vehicle_id IS NOT NULL AND status IN (${inList(BLOCKING)})
             AND pickup_at < ? AND return_at > ? AND id <> ?
         )
       ORDER BY v.plate`,
    )
    .all(category_id, return_at, pickup_at, exclude_reservation_id);
}

/** Verifica que un vehículo puntual esté libre en el rango. */
function isVehicleFree(db, { vehicle_id, pickup_at, return_at, exclude_reservation_id = 0 }) {
  const v = db.prepare('SELECT status FROM vehicles WHERE id = ?').get(vehicle_id);
  if (!v || OUT_OF_FLEET.includes(v.status)) return false;
  const clash = db
    .prepare(
      `SELECT 1 FROM reservations WHERE vehicle_id = ? AND status IN (${inList(BLOCKING)})
       AND pickup_at < ? AND return_at > ? AND id <> ? LIMIT 1`,
    )
    .get(vehicle_id, return_at, pickup_at, exclude_reservation_id);
  return !clash;
}

/**
 * Cupo por categoría en un rango: flota operativa menos reservas solapadas
 * (con o sin vehículo asignado).
 */
function categoryAvailability(db, { pickup_at, return_at, exclude_reservation_id = 0 }) {
  return db
    .prepare(
      `SELECT c.*,
        (SELECT COUNT(*) FROM vehicles v WHERE v.category_id = c.id AND v.status NOT IN (${inList(OUT_OF_FLEET)})) AS fleet,
        (SELECT COUNT(*) FROM reservations r WHERE r.category_id = c.id AND r.status IN (${inList(BLOCKING)})
           AND r.pickup_at < ? AND r.return_at > ? AND r.id <> ?) AS booked
       FROM categories c WHERE c.active = 1 ORDER BY c.daily_rate`,
    )
    .all(return_at, pickup_at, exclude_reservation_id)
    .map((c) => ({ ...c, available: Math.max(0, c.fleet - c.booked) }));
}

module.exports = { BLOCKING, OUT_OF_FLEET, availableVehicles, isVehicleFree, categoryAvailability };
