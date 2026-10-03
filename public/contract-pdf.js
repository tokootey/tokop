'use strict';

/*
 * Contrato de alquiler en PDF (A4), generado en el navegador con jsPDF + jsPDF-AutoTable.
 * Tiene los mismos datos que el contrato impreso: sirve antes de entregar el auto (pre-contrato)
 * y después, con los km, el combustible y los cargos reales.
 * Usa de app.js: state, money() y contractTermsList().
 */
function buildContractPdf(r) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const table = (opts) => (typeof window.autoTable === 'function' ? window.autoTable(doc, opts) : doc.autoTable(opts));
  const s = state.settings;
  const c = r.contract;
  const delivered = Boolean(c);
  const M = 12;
  const W = 210;
  const H = 297;
  const company = s.company_name || 'la Empresa';
  const ref = delivered ? `Contrato N° ${c.number}` : `Reserva ${r.code}`;

  // Texto plano para el PDF (las funciones de la pantalla devuelven HTML).
  const txt = (v) => (v === null || v === undefined ? '' : String(v));
  const d = (v) => (v ? `${String(v).slice(8, 10)}/${String(v).slice(5, 7)}/${String(v).slice(0, 4)}` : '');
  const dt = (v) => (v ? `${d(v)} ${String(v).slice(11, 16)}` : '');
  const km = (v) => (v === null || v === undefined || v === '' ? '' : `${Number(v).toLocaleString('es-AR')} km`);
  const fuel = (v) => (v === null || v === undefined || v === '' ? '___ /8' : `${v}/8`);
  const lastY = () => (doc.lastAutoTable ? doc.lastAutoTable.finalY : 0);

  const base = {
    theme: 'grid',
    styles: { fontSize: 8.5, cellPadding: 1.4, lineColor: [150, 150, 150], lineWidth: 0.2, textColor: [17, 17, 17], minCellHeight: 6 },
    margin: { left: M, right: M },
  };
  const kv = (y, rows) =>
    table({
      ...base,
      startY: y,
      body: rows,
      columnStyles: {
        0: { fontStyle: 'bold', fillColor: [240, 240, 240], cellWidth: 32 },
        2: { fontStyle: 'bold', fillColor: [240, 240, 240], cellWidth: 32 },
      },
    });
  const section = (title, y) => {
    doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(17);
    doc.text(title.toUpperCase(), M, y);
    doc.setDrawColor(17).setLineWidth(0.3).line(M, y + 1.2, W - M, y + 1.2);
    return y + 3;
  };
  const ensure = (y, need) => {
    if (y + need <= H - 16) return y;
    doc.addPage();
    return 16;
  };

  /* ---------- Hoja 1: datos ---------- */
  doc.setFont('helvetica', 'bold').setFontSize(15).text(company, M, 16);
  doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(60);
  doc.text([txt(s.company_address), [txt(s.company_phone), s.company_tax_id ? `CUIT ${s.company_tax_id}` : ''].filter(Boolean).join(' · ')].filter(Boolean), M, 21);
  doc.setTextColor(17).setFont('helvetica', 'bold').setFontSize(10);
  doc.text(delivered ? 'CONTRATO DE ALQUILER DE VEHÍCULO' : 'CONTRATO DE ALQUILER DE VEHÍCULO (PRE-CONTRATO)', W - M, 15, { align: 'right' });
  doc.setFont('helvetica', 'normal').setFontSize(8.5);
  doc.text(
    [delivered ? `N° ${c.number}` : 'Vehículo sin entregar todavía', `Reserva ${r.code} · Emitido ${new Date().toLocaleDateString('es-AR')}`],
    W - M,
    20,
    { align: 'right' },
  );
  doc.setLineWidth(0.6).line(M, 28, W - M, 28);

  let y = section('Cliente / conductor principal', 34);
  kv(y, [
    ['Nombre y apellido', txt(r.customer_name), 'Documento', r.customer_doc ? `${txt(r.customer_doc_type || 'DNI')} ${r.customer_doc}` : ''],
    ['Domicilio', txt(r.customer_address), 'Teléfono', txt(r.customer_phone)],
    ['Email', txt(r.customer_email), 'Fecha de nac.', d(r.customer_birth_date)],
    ['Licencia N°', txt(r.customer_license), 'Vence', d(r.customer_license_expiry)],
  ]);

  y = section('Conductor adicional', lastY() + 6);
  kv(y, [
    ['Nombre y apellido', '', 'Documento', ''],
    ['Licencia N°', '', 'Vence', ''],
  ]);

  y = section('Vehículo y período', lastY() + 6);
  kv(y, [
    ['Marca y modelo', r.vehicle_plate ? `${txt(r.vehicle_brand)} ${txt(r.vehicle_model)}` : '', 'Patente', txt(r.vehicle_plate)],
    ['Color / año', r.vehicle_plate ? [r.vehicle_color, r.vehicle_year].filter(Boolean).join(' · ') : '', 'Categoría', `${r.category_code} · ${r.category_name}`],
    ['Retiro', `${dt(r.pickup_at)} · ${txt(r.pickup_branch_name)}`, 'Devolución pactada', `${dt(r.return_at)} · ${txt(r.return_branch_name)}`],
    ['Días', txt(r.days), 'Vuelo / referencia', txt(r.flight)],
  ]);

  y = section('Entrega y devolución del vehículo', lastY() + 6);
  const back = c && c.in_at;
  table({
    ...base,
    startY: y,
    head: [['', 'Entrega', 'Devolución']],
    headStyles: { fillColor: [230, 230, 230], textColor: [17, 17, 17], fontStyle: 'bold' },
    body: [
      ['Fecha y hora', delivered ? dt(c.out_at) : '', back ? dt(c.in_at) : ''],
      ['Kilómetros', delivered ? km(c.out_km) : r.vehicle_km !== null && r.vehicle_km !== undefined ? `${km(r.vehicle_km)} (según flota, verificar)` : '', back ? km(c.in_km) : ''],
      ['Combustible', fuel(delivered ? c.out_fuel : r.vehicle_fuel), fuel(back ? c.in_fuel : null)],
    ],
    columnStyles: {
      0: { fontStyle: 'bold', fillColor: [240, 240, 240], cellWidth: 32 },
      1: { cellWidth: (W - 2 * M - 32) / 2 },
      2: { cellWidth: (W - 2 * M - 32) / 2 },
    },
  });

  // Diagrama del auto (visto desde arriba) para marcar daños, y observaciones.
  y = ensure(section('Estado del vehículo (marcar con X los daños)', lastY() + 6) + 2, 42);
  doc.setDrawColor(40).setLineWidth(0.5).roundedRect(M + 4, y + 4, 52, 26, 8, 8);
  doc.setLineWidth(0.25).setDrawColor(140);
  doc.roundedRect(M + 20, y + 8, 20, 18, 2, 2);
  doc.line(M + 17, y + 6, M + 15, y + 28).line(M + 43, y + 6, M + 45, y + 28);
  doc.setFillColor(40);
  for (const [wx, wy] of [[M + 9, y + 1.5], [M + 43, y + 1.5], [M + 9, y + 29.5], [M + 43, y + 29.5]]) doc.roundedRect(wx, wy, 8, 3, 1, 1, 'F');
  doc.setFont('helvetica', 'normal').setFontSize(6.5).setTextColor(90);
  doc.text('TRASERA', M + 1.5, y + 21, { angle: 90 });
  doc.text('FRENTE', M + 60, y + 11, { angle: -90 });
  doc.setTextColor(17);
  const nx = M + 70;
  const nw = W - M - nx;
  doc.setFontSize(7.5).setTextColor(80).text('Observaciones a la entrega:', nx, y + 1);
  doc.setDrawColor(150).rect(nx, y + 2, nw, 14);
  doc.text('Observaciones a la devolución:', nx, y + 19.5);
  doc.rect(nx, y + 20.5, nw, 14);
  doc.setTextColor(17).setFontSize(8);
  if (c && c.out_notes) doc.text(doc.splitTextToSize(c.out_notes, nw - 3).slice(0, 3), nx + 1.5, y + 5.5);
  if (c && c.in_notes) doc.text(doc.splitTextToSize(c.in_notes, nw - 3).slice(0, 3), nx + 1.5, y + 24);
  y += 38;

  // Precio y pagos, lado a lado.
  y = ensure(section('Precio, pagos y garantía', y + 2), 50);
  const q = r.pricing || {};
  const priceRows = [
    q.base !== undefined ? [`Alquiler ${r.days} día(s)${q.per_day ? ` × ${money(q.per_day)}` : ''}`, money(q.base)] : null,
    q.season_extra ? ['Recargo de temporada', money(q.season_extra)] : null,
    ...(q.extras || []).map((x) => [`${x.name}${x.quantity > 1 ? ` ×${x.quantity}` : ''}`, money(x.amount)]),
    q.one_way_fee ? ['Devolución en otro lugar', money(q.one_way_fee)] : null,
    q.discount ? [`Descuento ${q.discount_pct}%`, `- ${money(q.discount)}`] : null,
    q.tax_rate ? [`IVA ${q.tax_rate}%${q.tax_included ? ' (incluido)' : ''}`, money(q.tax)] : null,
    [{ content: 'Total del alquiler', styles: { fontStyle: 'bold' } }, { content: money(r.total), styles: { fontStyle: 'bold' } }],
    ...(c && c.charges ? c.charges.lines.map((l) => [l.concept, money(l.amount)]) : []),
    ...(c && c.final_total !== null && c.final_total !== undefined && c.final_total !== r.total
      ? [[{ content: 'Total final con cargos', styles: { fontStyle: 'bold' } }, { content: money(c.final_total), styles: { fontStyle: 'bold' } }]]
      : []),
  ].filter(Boolean);
  const half = (W - 2 * M - 6) / 2;
  table({ ...base, startY: y, body: priceRows, margin: { left: M, right: W - M - half }, columnStyles: { 1: { halign: 'right', cellWidth: 30 } } });
  const leftEnd = lastY();
  table({
    ...base,
    startY: y,
    margin: { left: M + half + 6, right: M },
    body: [
      ['Pagado', money(r.balance.paid)],
      ['Saldo pendiente', money(r.balance.pending)],
      ['Garantía requerida', money(r.deposit)],
      ['Garantía recibida', money(r.balance.deposit_held)],
      ['Adicionales', r.extras.map((x) => x.name).join(', ') || '-'],
    ],
    columnStyles: { 0: { fontStyle: 'bold', fillColor: [240, 240, 240] }, 1: { halign: 'right' } },
  });
  y = Math.max(leftEnd, lastY()) + 6;

  // Conformidad y firmas.
  y = ensure(y, 34);
  doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(17);
  doc.text(
    doc.splitTextToSize(
      'El Cliente declara haber leído y aceptado las condiciones generales que forman parte de este contrato y recibir el vehículo en el estado indicado.',
      W - 2 * M,
    ),
    M,
    y,
  );
  signatures(y + 22, ['Firma del cliente', 'Conductor adicional', `Por ${company}`]);

  /* ---------- Hoja 2: condiciones generales ---------- */
  doc.addPage();
  doc.setFont('helvetica', 'bold').setFontSize(9).text(company, M, 14);
  doc.setFont('helvetica', 'normal').text(`Condiciones generales · ${ref}`, W - M, 14, { align: 'right' });
  doc.setLineWidth(0.6).setDrawColor(17).line(M, 16.5, W - M, 16.5);
  doc.setFont('helvetica', 'bold').setFontSize(10).text('CONDICIONES GENERALES DEL ALQUILER', M, 23);

  const colW = (W - 2 * M - 8) / 2;
  const top = 28;
  const bottom = H - 40;
  let col = 0;
  let cy = top;
  const lh = 3.3;
  doc.setFontSize(7.8);
  for (const t of contractTermsList(r)) {
    doc.setFont('helvetica', 'bold');
    const titleLines = t.title ? doc.splitTextToSize(t.title, colW) : [];
    doc.setFont('helvetica', 'normal');
    const bodyLines = doc.splitTextToSize(t.body, colW);
    const need = (titleLines.length + bodyLines.length) * lh + 2;
    if (cy + need > bottom) {
      if (col === 0) {
        col = 1;
        cy = top;
      } else {
        doc.addPage();
        col = 0;
        cy = 16;
      }
    }
    const x = M + col * (colW + 8);
    if (titleLines.length) {
      doc.setFont('helvetica', 'bold').text(titleLines, x, cy);
      cy += titleLines.length * lh;
    }
    doc.setFont('helvetica', 'normal').text(bodyLines, x, cy);
    cy += bodyLines.length * lh + 2;
  }
  signatures(H - 26, ['Firma del cliente (conformidad)', `Por ${company}`]);

  /* ---------- Pie de página ---------- */
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal').setFontSize(7).setTextColor(110);
    doc.text(`${company} · ${ref} · Página ${i} de ${pages}`, W / 2, H - 7, { align: 'center' });
  }

  // Nombre de archivo sin acentos ni símbolos: algunos navegadores descartan los nombres con acentos.
  const safeName = `${delivered ? `Contrato ${c.number}` : `Pre-contrato ${r.code}`} - ${r.customer_name}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w .-]/g, '')
    .trim();
  return { doc, filename: `${safeName}.pdf` };

  function signatures(sy, labels) {
    const gap = 8;
    const w = (W - 2 * M - gap * (labels.length - 1)) / labels.length;
    doc.setDrawColor(17).setLineWidth(0.3).setTextColor(17);
    labels.forEach((label, i) => {
      const x = M + i * (w + gap);
      doc.line(x, sy, x + w, sy);
      doc.setFont('helvetica', 'normal').setFontSize(8).text(label, x + w / 2, sy + 4, { align: 'center' });
      doc.setFontSize(7).setTextColor(90).text(label.startsWith('Por ') ? ['Aclaración:'] : ['Aclaración:', 'DNI:'], x, sy + 9);
      doc.setTextColor(17);
    });
  }
}

/** Descarga un archivo generado en el navegador. */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
