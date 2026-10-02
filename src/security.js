'use strict';

const { HttpError } = require('./util');

/** Política de contenido de las pantallas: sólo código propio, sin incrustarse en otros sitios. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Encabezados de seguridad para todas las respuestas. */
function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), payment=(), usb=()');
  res.set('Content-Security-Policy', CSP);
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Los datos de clientes no deben quedar guardados en cachés del navegador ni de intermediarios.
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
}

/** Detrás de un proxy (Render, Nginx): si el pedido llegó por http, se redirige a https. */
function httpsRedirect(req, res, next) {
  if (process.env.TRUST_PROXY && req.get('x-forwarded-proto') === 'http') {
    return res.redirect(301, `https://${req.get('host')}${req.originalUrl || req.url}`);
  }
  next();
}

/**
 * Protección CSRF para la API interna: un pedido que modifica datos tiene que venir de la propia app.
 * Los navegadores siempre mandan Origin en esos pedidos; si viene de otro sitio, se rechaza.
 * (Además la cookie de sesión es SameSite=Strict.)
 */
function sameOrigin(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  const site = req.get('sec-fetch-site');
  const own = `${req.protocol}://${req.get('host')}`;
  if ((origin && origin !== own) || (site && !['same-origin', 'none'].includes(site))) {
    return next(new HttpError(403, 'Pedido rechazado: no viene de la aplicación'));
  }
  next();
}

module.exports = { CSP, securityHeaders, httpsRedirect, sameOrigin };
