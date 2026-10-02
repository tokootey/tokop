/*
 * Conector para el formulario de cotización del sitio web.
 *
 * Se agrega UNA línea en la página del cotizador (antes de </body>):
 *   <script src="https://TU-SERVIDOR/webform.js" data-form="form"></script>
 *
 * Cuando el cliente envía el formulario, se manda una copia de los datos al sistema
 * (que la registra como reserva pendiente) y el formulario sigue funcionando como siempre.
 * data-form: selector CSS del formulario (por defecto "form").
 */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var endpoint = new URL('/api/public/webform', script.src).href;
  var selector = script.getAttribute('data-form') || 'form';

  function send(form) {
    try {
      var data = new URLSearchParams();
      new FormData(form).forEach(function (value, key) {
        if (typeof value === 'string') data.append(key, value);
      });
      data.append('_page', location.href);
      // Petición "simple" (sin preflight) y keepalive: llega aunque la página navegue.
      fetch(endpoint, { method: 'POST', body: data, mode: 'no-cors', keepalive: true });
    } catch (e) {
      /* nunca interrumpir el formulario del sitio */
    }
  }

  document.addEventListener(
    'submit',
    function (ev) {
      var form = ev.target;
      if (form && form.matches && form.matches(selector)) send(form);
    },
    true,
  );
})();
