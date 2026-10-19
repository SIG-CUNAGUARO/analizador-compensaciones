// Lectura del Excel de factores y exportación del libro de resultados (con fórmulas).
import * as XLSX from 'xlsx';
import { normalizeText } from './tables.js';

export const CRITERIA = [
  { id: 'crp', label: 'Crp', name: 'Representatividad en el SINAP', aliases: ['crp_valor', 'crp'] },
  { id: 'cra', label: 'Cra', name: 'Rareza', aliases: ['cra_valor', 'cra'] },
  { id: 'crm', label: 'Crm', name: 'Remanencia', aliases: ['crm_valor', 'crm'] },
  { id: 'ctt', label: 'Ctt', name: 'Tasa de transformación anual', aliases: ['ctt_valor', 'ctt'] },
];

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/**
 * Lee el Excel de factores. Reconoce BUB y FC y, si existen, los criterios
 * Crp, Cra, Crm y Ctt (FC = Crp + Cra + Crm + Ctt, Resolución 256 de 2018).
 */
export function readFactorsWorkbook(bytes) {
  const wb = XLSX.read(bytes, { type: 'array' });
  for (const sheet of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, defval: null });
    for (let h = 0; h < Math.min(rows.length, 15); h++) {
      const header = (rows[h] || []).map((c) => normalizeText(c));
      const iB = header.indexOf('bub');
      const iF = header.indexOf('fc');
      if (iB < 0 || iF < 0) continue;
      const iC = Object.fromEntries(CRITERIA.map((c) => [c.id, header.findIndex((x) => c.aliases.includes(x))]));
      const hasCriteria = CRITERIA.every((c) => iC[c.id] >= 0);
      const seen = new Map();
      const conflicts = [];
      const mismatches = [];
      for (const row of rows.slice(h + 1)) {
        const bub = row?.[iB] === null || row?.[iB] === undefined ? '' : String(row[iB]).trim();
        const fc = toNum(row?.[iF]);
        if (!bub || fc === null) continue;
        const k = normalizeText(bub);
        const rec = { bub, fc };
        if (hasCriteria) {
          rec.criteria = Object.fromEntries(CRITERIA.map((c) => [c.id, toNum(row[iC[c.id]])]));
          const vals = Object.values(rec.criteria);
          if (vals.every((v) => v !== null)) {
            const sum = vals.reduce((a, b) => a + b, 0);
            if (Math.abs(sum - fc) > 1e-9) mismatches.push(`${bub}: FC ${fc} ≠ suma ${sum}`);
          }
        }
        if (seen.has(k) && seen.get(k).fc !== fc) conflicts.push(bub);
        if (!seen.has(k)) seen.set(k, rec);
      }
      if (conflicts.length) throw new Error(`El Excel tiene más de un FC para el mismo BUB normalizado. Ejemplos: ${[...new Set(conflicts)].slice(0, 5).join(', ')}`);
      return { sheet, factors: [...seen.values()], hasCriteria, mismatches };
    }
  }
  throw new Error('Ninguna hoja del Excel contiene simultáneamente las columnas BUB y FC.');
}

const FMT = { m2: '#,##0.00', ha: '#,##0.0000', fc: '0.000000', pct: '0.000' };
const col = (i) => XLSX.utils.encode_col(i);

/** Crea una hoja a partir de definiciones de columna; cada columna puede tener fórmula. */
function sheetFrom(columns, rows, { totals = null } = {}) {
  const ws = {};
  columns.forEach((c, j) => { ws[XLSX.utils.encode_cell({ r: 0, c: j })] = { t: 's', v: c.header }; });
  const letters = Object.fromEntries(columns.map((c, j) => [c.id, col(j)]));
  rows.forEach((row, i) => {
    const r = i + 1;
    const excelRow = r + 1;
    columns.forEach((c, j) => {
      const ref = XLSX.utils.encode_cell({ r, c: j });
      const v = c.value(row);
      const f = c.formula ? c.formula(letters, excelRow, row) : null;
      if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) {
        ws[ref] = f ? { t: 's', v: '', f } : { t: 'z' };
      } else if (typeof v === 'number') {
        ws[ref] = { t: 'n', v, ...(c.z ? { z: c.z } : {}), ...(f ? { f } : {}) };
      } else {
        ws[ref] = { t: 's', v: String(v), ...(f ? { f } : {}) };
      }
    });
  });
  let last = rows.length;
  if (totals && rows.length) {
    last = rows.length + 1;
    const excelRow = last + 1;
    columns.forEach((c, j) => {
      const ref = XLSX.utils.encode_cell({ r: last, c: j });
      if (j === 0) ws[ref] = { t: 's', v: 'TOTAL' };
      else if (totals.includes(c.id)) {
        const L = letters[c.id];
        const v = rows.reduce((s, r) => s + (Number(c.value(r)) || 0), 0);
        ws[ref] = { t: 'n', v, f: `SUM(${L}2:${L}${excelRow - 1})`, z: c.z };
      }
    });
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(last, 1), c: columns.length - 1 } });
  ws['!cols'] = columns.map((c) => ({ wch: c.width || Math.min(60, Math.max(12, c.header.length + 2, ...rows.slice(0, 500).map((r) => String(c.value(r) ?? '').length + 2))) }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 1), c: columns.length - 1 } }) };
  return ws;
}

/**
 * model: { tables (buildTables), params:{...}, warnings:[], diagnostics:{...} }
 * Las columnas FC y FCcob consultan las hojas de factores con BUSCARV, de modo
 * que editar un factor en esas hojas recalcula todo el libro.
 */
export function buildWorkbook(model) {
  const { tables: t } = model;
  const wb = XLSX.utils.book_new();
  const nFc = t.fcTable.length;
  const nCob = t.coverageFactors.length;
  const fcLookup = (L, r) => `IFERROR(VLOOKUP(${L.key}${r},Factores_BUB_FC!$A$2:$G$${nFc + 1},7,FALSE),"")`;
  const cobLookup = (L, r) => `IFERROR(VLOOKUP(${L.cov}${r},Factores_cobertura!$A$2:$B$${nCob + 1},2,FALSE),1)`;
  const haF = (L, r) => `${L.m2}${r}/10000`;

  // Biomas
  XLSX.utils.book_append_sheet(wb, sheetFrom([
    { id: 'label', header: 'Bioma', value: (r) => r.label },
    { id: 'keys', header: 'bioma_IAvH', value: (r) => r.keys.join('; ') },
    { id: 'm2', header: 'Áreas afectadas (m²)', value: (r) => r.m2, z: FMT.m2 },
    { id: 'ha', header: 'Áreas afectadas (ha)', value: (r) => r.ha, z: FMT.ha, formula: haF },
    { id: 'fc', header: 'FC', value: (r) => r.fc, z: FMT.fc, formula: (L, r, row) => (row.fcKey ? `IFERROR(VLOOKUP(${L.keys}${r},Factores_BUB_FC!$A$2:$G$${nFc + 1},7,FALSE),"")` : null) },
    { id: 'comp', header: 'Áreas a compensar (ha)', value: (r) => r.comp, z: FMT.ha, formula: (L, r, row) => (row.missingHa > 1e-12 ? null : `IF(${L.fc}${r}="","",${L.ha}${r}*${L.fc}${r})`) },
    { id: 'miss', header: 'Área sin FC (ha)', value: (r) => r.missingHa, z: FMT.ha },
    { id: 'obs', header: 'Observación', value: (r) => r.obs },
  ], t.biomes, { totals: ['m2', 'ha', 'comp', 'miss'] }), 'Biomas');

  // Ecosistemas
  XLSX.utils.book_append_sheet(wb, sheetFrom([
    { id: 'label', header: 'Bioma', value: (r) => r.label },
    { id: 'name', header: 'Ecosistema', value: (r) => r.name },
    { id: 'key', header: 'Llave FC (bioma_IAvH)', value: (r) => r.key },
    { id: 'm2', header: 'Áreas afectadas (m²)', value: (r) => r.m2, z: FMT.m2 },
    { id: 'ha', header: 'Áreas afectadas (ha)', value: (r) => r.ha, z: FMT.ha, formula: haF },
    { id: 'fc', header: 'FC', value: (r) => r.fc, z: FMT.fc, formula: fcLookup },
    { id: 'comp', header: 'Áreas a compensar (ha)', value: (r) => r.comp, z: FMT.ha, formula: (L, r) => `IF(${L.fc}${r}="","",${L.ha}${r}*${L.fc}${r})` },
  ], t.ecosystems, { totals: ['m2', 'ha', 'comp'] }), 'Ecosistemas');

  // Coberturas
  XLSX.utils.book_append_sheet(wb, sheetFrom([
    { id: 'label', header: 'Bioma', value: (r) => r.label },
    { id: 'name', header: 'Ecosistema', value: (r) => r.name },
    { id: 'cov', header: 'Cobertura', value: (r) => r.cov },
    { id: 'key', header: 'Llave FC (bioma_IAvH)', value: (r) => r.key },
    { id: 'm2', header: 'Áreas afectadas (m²)', value: (r) => r.m2, z: FMT.m2 },
    { id: 'ha', header: 'Áreas afectadas (ha)', value: (r) => r.ha, z: FMT.ha, formula: haF },
    { id: 'fc', header: 'FC', value: (r) => r.fc, z: FMT.fc, formula: fcLookup },
    // Si la fila tiene un FCcob personalizado se escribe el valor; si no, se consulta la hoja.
    { id: 'fcCob', header: 'FCcob', value: (r) => r.fcCob, z: FMT.fc, formula: (L, r, row) => (row.fcCobOverridden ? null : cobLookup(L, r)) },
    { id: 'custom', header: 'FCcob personalizado en la fila', value: (r) => (r.fcCobOverridden ? 'Sí' : '') },
    { id: 'only', header: 'Solo FCcob (ha × FCcob)', value: (r) => (r.fcCobOnly ? 'Sí' : 'No'), formula: (L, r) => `IFERROR(VLOOKUP(${L.cov}${r},Factores_cobertura!$A$2:$C$${nCob + 1},3,FALSE),"No")` },
    { id: 'comp', header: 'Áreas a compensar (ha)', value: (r) => r.comp, z: FMT.ha, formula: (L, r) => `IF(${L.only}${r}="Sí",${L.ha}${r}*${L.fcCob}${r},IF(${L.fc}${r}="","",${L.ha}${r}*${L.fc}${r}*${L.fcCob}${r}))` },
  ], t.coverages, { totals: ['m2', 'ha', 'comp'] }), 'Coberturas');

  // Factores usados (editables en el libro): FC = Crp + Cra + Crm + Ctt
  XLSX.utils.book_append_sheet(wb, sheetFrom([
    { id: 'key', header: 'bioma_IAvH (capa)', value: (r) => r.key },
    { id: 'bub', header: 'BUB (Excel)', value: (r) => r.bub ?? 'NO ENCONTRADO' },
    ...CRITERIA.map((c) => ({ id: c.id, header: `${c.label} — ${c.name}`, value: (r) => r.criteria?.[c.id] ?? null, z: '0.00' })),
    { id: 'fc', header: 'FC usado (= Crp + Cra + Crm + Ctt)', value: (r) => r.fc, z: '0.00',
      formula: (L, r, row) => (row.manual || !row.criteria || CRITERIA.some((c) => row.criteria[c.id] === null) ? null : `SUM(${L.crp}${r}:${L.ctt}${r})`) },
    { id: 'fcx', header: 'FC del Excel original', value: (r) => r.fcExcel, z: '0.00' },
    { id: 'ov', header: 'Edición en la app', value: (r) => (r.manual ? 'FC escrito a mano' : r.edited.length ? `Criterios editados: ${r.edited.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(', ')}` : '') },
  ], t.fcTable), 'Factores_BUB_FC');

  XLSX.utils.book_append_sheet(wb, sheetFrom([
    { id: 'cov', header: 'Cobertura', value: (r) => r.cov },
    { id: 'fcCob', header: 'FCcob (edite aquí)', value: (r) => r.fcCob, z: FMT.fc },
    { id: 'only', header: 'Solo FCcob: Sí = ha × FCcob, ignora el FC (edite aquí)', value: (r) => (r.only ? 'Sí' : 'No') },
  ], t.coverageFactors), 'Factores_cobertura');

  XLSX.utils.book_append_sheet(wb, sheetFrom([
    { id: 'label', header: 'Bioma', value: (r) => r.label },
    { id: 'key', header: 'Llave FC', value: (r) => r.key },
    { id: 'cov', header: 'Cobertura', value: (r) => r.cov },
    { id: 'm2', header: 'Área (m²)', value: (r) => r.m2, z: '0.000000' },
    { id: 'planar', header: 'Área planimétrica (m²)', value: (r) => r.planar, z: '0.000000' },
    { id: 'geod', header: 'Área elipsoidal (m²)', value: (r) => r.geod, z: '0.000000' },
    { id: 'st', header: 'Tratamiento', value: (r) => r.statusText },
    { id: 'to', header: 'Asignado a', value: (r) => r.target },
    { id: 'sh', header: 'Borde compartido (m)', value: (r) => r.shared || null, z: '0.000' },
  ], t.residues.length ? t.residues : []), 'Residuos');

  const missing = t.fcTable.filter((f) => f.fc === null);
  XLSX.utils.book_append_sheet(wb, sheetFrom([
    { id: 'key', header: 'BUB no encontrado', value: (r) => r.key },
  ], missing), 'FC_no_encontrados');

  const params = Object.entries(model.params || {}).map(([k, v]) => ({ k, v }));
  XLSX.utils.book_append_sheet(wb, sheetFrom([
    { id: 'k', header: 'Parámetro', value: (r) => r.k, width: 46 },
    { id: 'v', header: 'Valor', value: (r) => (typeof r.v === 'number' ? r.v : String(r.v ?? '')), width: 70 },
  ], params), 'Parámetros');

  XLSX.utils.book_append_sheet(wb, sheetFrom([
    { id: 'w', header: 'Advertencias', value: (r) => r, width: 110 },
  ], model.warnings?.length ? model.warnings : ['Sin advertencias']), 'Advertencias');

  return XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true });
}

export function tableToSheetBytes(name, columns, rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetFrom(columns, rows), name.slice(0, 31));
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}
