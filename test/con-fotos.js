'use strict';

/* Para las pruebas que entregan y reciben autos sin ocuparse de las fotos: cada reserva nueva nace con una de entrega y una de devolución. */
module.exports = (db) =>
  db.exec(`CREATE TRIGGER IF NOT EXISTS prueba_con_fotos AFTER INSERT ON reservations BEGIN
    INSERT INTO reservation_files (reservation_id, stage, name, mime, size, path, created_at)
    VALUES (NEW.id, 'entrega', 'f.jpg', 'image/jpeg', 1, 'x', '2026-01-01T00:00'), (NEW.id, 'devolucion', 'f.jpg', 'image/jpeg', 1, 'x', '2026-01-01T00:00');
  END`);
