// Interfaz del Analizador de Compensaciones (versión web).
import L from 'leaflet';
import { CRS_DEFS, ANALYSIS_CRS, ELLIPSOIDS } from './crs.js';
import { buildTables, ecosystemName, normalizeText, DEFAULT_TEMPLATE } from './tables.js';
import { readFactorsWorkbook, buildWorkbook, tableToSheetBytes, CRITERIA } from './excel.js';

export const APP_VERSION = '0.2.0-web';
const $ = (id) => document.getElementById(id);
const VECTOR_RE = /\.(shp|shx|dbf|prj|cpg|zip|gpkg|geojson|json)$/i;
const POLY_RE = /polygon|surface|desconocida/i;

// ------------------------------------------------------------------ worker
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let callSeq = 0;
const pending = new Map();
worker.onmessage = ({ data }) => {
  if (data.type === 'progress') { setStatus(data.msg); return; }
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  data.ok ? p.resolve(data.result) : p.reject(new Error(data.error));
};
worker.onerror = (e) => setStatus(`Error del proceso de cálculo: ${e.message}`, true);
const call = (type, payload = {}) => new Promise((resolve, reject) => {
  const id = ++callSeq;
  pending.set(id, { resolve, reject });
  worker.postMessage({ id, type, payload });
});

// ------------------------------------------------------------------- estado
const S = {
  interv: [], intervChecked: new Set(),
  cov: [], eco: [],
  factors: null, factorsName: '',
  result: null, tables: null, lastParams: null,
  edits: { fcOverride: {}, critOverride: {}, fcCob: {}, rowFcCob: {}, bioLabel: {}, ecoLabel: {} },
};

// --------------------------------------------------------------- utilidades
const parseNum = (s) => {
  if (s === null || s === undefined) return null;
  let t = String(s).trim().replace(/\s/g, '');
  if (t === '') return null;
  if (t.includes(',') && t.includes('.')) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else t = t.replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const fmtCache = new Map();
const fmt = (v, d) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  if (!fmtCache.has(d)) fmtCache.set(d, new Intl.NumberFormat('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d }));
  return fmtCache.get(d).format(v);
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dec = () => ({ ha: clampInt($('dec-ha').value, 0, 8, 4), m2: clampInt($('dec-m2').value, 0, 6, 2) });
const clampInt = (v, a, b, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d; };
const method = () => document.querySelector('input[name=method]:checked').value;

function setStatus(msg, error = false) {
  const el = $('status');
  el.textContent = msg || '';
  el.classList.toggle('error', !!error);
}

function download(bytes, name, type) {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

const fileEntries = (fileList) => [...fileList]
  .filter((f) => VECTOR_RE.test(f.name) && !f.name.startsWith('~$'))
  .map((f) => ({ path: f.webkitRelativePath || f.name, blob: f }));

async function registerGroup(group, fileList) {
  const files = fileEntries(fileList);
  if (!files.length) throw new Error('No se encontraron archivos vectoriales compatibles (.shp, .zip, .gpkg, .geojson).');
  setStatus(`Leyendo ${files.length} archivos…`);
  const res = await call('register', { files, group, replaceGroup: true, encoding: $('encoding').value });
  if (res.errors.length) console.warn(res.errors);
  setStatus(`${res.layers.length} capas encontradas${res.errors.length ? ` · ${res.errors.length} archivos no se pudieron leer (detalle en Diagnóstico)` : ''}.`);
  S.registerErrors = [...(S.registerErrors || []), ...res.errors];
  return res.layers;
}

const layerLabel = (l) => (l.kind === 'GeoPackage' ? `${l.name} — ${l.layer}` : l.name);

// -------------------------------------------------------- 1. intervenciones
async function loadInterventions(fileList) {
  try {
    S.interv = await registerGroup('interv', fileList);
    // Todas las capas poligonales válidas quedan marcadas: lo habitual es disolver el paquete completo.
    S.intervChecked = new Set(S.interv.filter((l) => POLY_RE.test(l.geometryType || '') && !l.crsError).map((l) => l.id));
    renderInterventionTree();
    const skipped = S.interv.length - S.intervChecked.size;
    setStatus(`${S.intervChecked.size} capas de intervención listas para disolver en una sola huella${skipped ? ` · ${skipped} omitidas (sin CRS o sin polígonos)` : ''}.`);
  } catch (e) { setStatus(e.message, true); }
}

function renderInterventionTree() {
  const el = $('interv-tree');
  if (!S.interv.length) { el.className = 'tree empty'; el.textContent = 'Sin capas cargadas.'; updateInterventionCount(); return; }
  el.className = 'tree';
  const root = { dirs: new Map(), layers: [] };
  for (const l of S.interv) {
    let node = root;
    for (const part of l.dir.split('/').filter((p) => p && p !== '.')) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), layers: [] });
      node = node.dirs.get(part);
    }
    node.layers.push(l);
  }
  const renderNode = (node) => {
    let html = '';
    for (const [name, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0], 'es'))) {
      html += `<details open><summary>${esc(name)}</summary>${renderNode(child)}</details>`;
    }
    for (const l of node.layers.sort((a, b) => layerLabel(a).localeCompare(layerLabel(b), 'es'))) {
      const poly = POLY_RE.test(l.geometryType || '');
      const ok = poly && !l.crsError;
      const tag = l.crsError ? `<span class="tag warn" title="${esc(l.crsError)}">sin CRS</span>` : !poly ? `<span class="tag warn">${esc(l.geometryType)}</span>` : `<span class="tag" title="${esc(l.crsLabel)}">${esc(l.crsCode)}</span>`;
      html += `<label class="${ok ? '' : 'disabled'}"><input type="checkbox" data-id="${l.id}" ${ok ? '' : 'disabled'} ${S.intervChecked.has(l.id) ? 'checked' : ''}><span>${esc(layerLabel(l))}</span>${tag}</label>`;
    }
    return html;
  };
  el.innerHTML = renderNode(root);
  updateInterventionCount();
}

function updateInterventionCount() {
  $('interv-count').textContent = S.interv.length ? `${S.intervChecked.size} de ${S.interv.length} marcadas` : '';
}

$('interv-tree').addEventListener('change', (e) => {
  const id = e.target?.dataset?.id;
  if (!id) return;
  e.target.checked ? S.intervChecked.add(id) : S.intervChecked.delete(id);
  updateInterventionCount();
});
$('interv-all').onclick = () => { S.interv.filter((l) => POLY_RE.test(l.geometryType || '') && !l.crsError).forEach((l) => S.intervChecked.add(l.id)); renderInterventionTree(); };
$('interv-none').onclick = () => { S.intervChecked.clear(); renderInterventionTree(); };
$('interv-dir').onchange = (e) => loadInterventions(e.target.files);
$('interv-files').onchange = (e) => loadInterventions(e.target.files);

// ---------------------------------------------------- 2 y 3. capas temáticas
function fillLayerSelect(sel, list, preferPrefix = null) {
  const sorted = [...list].filter((l) => POLY_RE.test(l.geometryType || '')).sort((a, b) => {
    if (preferPrefix) {
      const pa = normalizeText(a.layer).startsWith(preferPrefix) || normalizeText(a.name).startsWith(preferPrefix);
      const pb = normalizeText(b.layer).startsWith(preferPrefix) || normalizeText(b.name).startsWith(preferPrefix);
      if (pa !== pb) return pa ? -1 : 1;
    }
    return a.path.localeCompare(b.path, 'es');
  });
  sel.innerHTML = sorted.map((l) => `<option value="${l.id}">${esc(l.dir !== '.' ? l.dir + ' / ' : '')}${esc(layerLabel(l))}${l.crsError ? ' (sin CRS)' : ''}</option>`).join('');
  sel.disabled = !sorted.length;
  return sorted;
}

function fillFieldSelect(sel, layer, preferred = []) {
  const fields = (layer?.fields || []).map((f) => f.name).filter((n) => n !== 'fid');
  sel.innerHTML = fields.map((f) => `<option>${esc(f)}</option>`).join('');
  sel.disabled = !fields.length;
  for (const p of preferred) {
    const hit = fields.find((f) => normalizeText(f) === normalizeText(p));
    if (hit) { sel.value = hit; break; }
  }
}

async function showPreview(el, layerId, field) {
  el.innerHTML = '';
  if (!layerId || !field) return [];
  try {
    const s = await call('sample', { layerId, field });
    el.innerHTML = s.values.slice(0, 8).map((v) => `<span class="chip" title="${esc(v.value)} (${v.n})">${esc(v.value)}</span>`).join('')
      + (s.total > 8 ? `<span class="more">y ${s.total - 8} valores más</span>` : '');
    return s.values;
  } catch (e) { el.innerHTML = `<span class="more">${esc(e.message)}</span>`; return []; }
}

const covLayer = () => S.cov.find((l) => l.id === $('cov-layer').value);
const ecoLayer = () => S.eco.find((l) => l.id === $('eco-layer').value);

async function loadCoverage(fileList) {
  try {
    S.cov = await registerGroup('cov', fileList);
    fillLayerSelect($('cov-layer'), S.cov);
    onCoverageLayer();
    markReplaced('cov');
  } catch (e) { setStatus(e.message, true); }
}
function onCoverageLayer() {
  const l = covLayer();
  fillFieldSelect($('cov-field'), l, [...(l && l.id === S.included?.cov?.layerId ? [S.included.cov.campo] : []), 'cobertura', 'cob', 'nivel_3', 'leyenda', 'nombre', 'OBSERV']);
  if (l?.crsError) setStatus(`Coberturas: ${l.crsError}`, true);
  showPreview($('cov-preview'), l?.id, $('cov-field').value);
}
$('cov-files').onchange = (e) => loadCoverage(e.target.files);
$('cov-dir').onchange = (e) => loadCoverage(e.target.files);
$('cov-layer').onchange = onCoverageLayer;
$('cov-field').onchange = () => showPreview($('cov-preview'), covLayer()?.id, $('cov-field').value);

async function loadEcosystems(fileList) {
  try {
    S.eco = await registerGroup('eco', fileList);
    fillLayerSelect($('eco-layer'), S.eco, 'ecosistemas');
    onEcoLayer();
    markReplaced('eco');
  } catch (e) { setStatus(e.message, true); }
}
function onEcoLayer() {
  const l = ecoLayer();
  const inc = l && l.id === S.included?.eco?.layerId ? S.included.eco : null;
  fillFieldSelect($('eco-key'), l, [...(inc ? [inc.llave] : []), 'bioma_IAvH', 'bioma_iavh', 'BUB']);
  fillFieldSelect($('eco-group'), l, [...(inc ? [inc.grupo] : []), 'bioma_IAvH', 'gran_bioma', 'bioma_prel']);
  if (l?.crsError) setStatus(`Ecosistemas: ${l.crsError}`, true);
  refreshEcoPreviews();
}
async function refreshEcoPreviews() {
  const l = ecoLayer();
  const keyVals = await showPreview($('eco-key-preview'), l?.id, $('eco-key').value);
  await showPreview($('eco-group-preview'), l?.id, $('eco-group').value);
  S.sampleKey = keyVals[0]?.value || 'Peinobioma de la Orinoquía';
  updateTemplateExample();
}
function updateTemplateExample() {
  $('eco-template-example').textContent = ecosystemName($('eco-template').value, {
    cobertura: S.result?.parts?.[0]?.cov || 'Pastos limpios', bioma: S.sampleKey || 'Peinobioma de la Orinoquía', grupo: S.sampleKey || 'Peinobioma de la Orinoquía',
  });
}
$('eco-files').onchange = (e) => loadEcosystems(e.target.files);
$('eco-dir').onchange = (e) => loadEcosystems(e.target.files);
$('eco-layer').onchange = onEcoLayer;
$('eco-key').onchange = refreshEcoPreviews;
$('eco-group').onchange = refreshEcoPreviews;
$('eco-template').value = DEFAULT_TEMPLATE;
$('eco-template').oninput = () => { updateTemplateExample(); rebuild(); };

// ---------------------------------------------------------- 4. factores
async function useFactorsFile(file, included = false) {
  try {
    const r = readFactorsWorkbook(new Uint8Array(await file.arrayBuffer()));
    S.factors = r.factors;
    S.factorsInfo = r;
    S.factorsName = `${included ? S.manifest.factores.nombre + ' — ' : ''}${file.name} (hoja «${r.sheet}»)`;
    $('fc-status').textContent = `${r.factors.length} factores en la hoja «${r.sheet}»`
      + (r.hasCriteria ? ` con los criterios Crp, Cra, Crm y Ctt${r.mismatches.length ? `. Atención: ${r.mismatches.length} filas donde FC no es la suma: ${r.mismatches.slice(0, 3).join('; ')}` : '; en todas las filas FC = Crp + Cra + Crm + Ctt'}.` : ' (sin columnas de criterios: solo se usa FC).');
    $('fc-status').classList.toggle('error', !!r.mismatches.length);
    if (!included && S.manifest?.factores) {
      $('fc-included').hidden = false;
      $('fc-included').innerHTML = 'Usando un archivo propio.<button type="button">Volver a la tabla incluida</button>';
      $('fc-included').querySelector('button').onclick = loadIncludedFactors;
    }
    rebuild();
  } catch (err) {
    S.factors = null;
    $('fc-status').textContent = err.message;
    $('fc-status').classList.add('error');
  }
}
$('fc-file').onchange = (e) => { if (e.target.files[0]) useFactorsFile(e.target.files[0]); };

async function loadIncludedFactors() {
  const conf = S.manifest?.factores;
  if (!conf) return;
  const box = $('fc-included');
  box.hidden = false;
  try {
    const resp = await fetch(`data/${conf.archivo}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await useFactorsFile(new File([await resp.blob()], conf.archivo), true);
    box.textContent = `Usando la tabla incluida: ${conf.nombre}.`;
  } catch (e) {
    box.textContent = `No fue posible cargar la tabla incluida (${e.message}). Elija el Excel manualmente.`;
  }
}

// --------------------------------------------------------- 5. parámetros
$('crs').innerHTML = ANALYSIS_CRS.map((c) => `<option value="${c}">${esc(CRS_DEFS[c].label)} (${c})</option>`).join('');
$('ellipsoid').innerHTML = Object.entries(ELLIPSOIDS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
document.querySelectorAll('input[name=method]').forEach((r) => (r.onchange = rebuild));
$('dec-ha').onchange = rebuild;
$('dec-m2').onchange = rebuild;
const residueParams = () => ({ threshold: parseNum($('res-threshold').value) ?? 0, action: $('res-action').value });
async function onResidueChange() {
  if (!S.result) return;
  try {
    S.result.residues = await call('residues', residueParams());
    rebuild();
    drawResidues();
  } catch (e) { setStatus(e.message, true); }
}
$('res-threshold').onchange = onResidueChange;
$('res-action').onchange = onResidueChange;
for (const id of ['crs', 'ellipsoid']) $(id).onchange = () => { if (S.result) setStatus('Este cambio requiere volver a ejecutar el cruce.'); };

// ------------------------------------------------------------ 6. ejecutar
function buildParams() {
  const interventions = [...S.intervChecked];
  if (!interventions.length) throw new Error('Marque al menos una capa de intervención.');
  const cov = covLayer(); const eco = ecoLayer();
  if (!cov) throw new Error('Cargue y seleccione la capa de coberturas.');
  if (!$('cov-field').value) throw new Error('Seleccione el campo con el nombre de la cobertura.');
  if (!eco) throw new Error('Cargue y seleccione la capa de ecosistemas.');
  if (!$('eco-key').value || !$('eco-group').value) throw new Error('Seleccione el campo llave y el campo de agrupación de biomas.');
  return {
    interventions,
    eco: { id: eco.id, keyField: $('eco-key').value, groupField: $('eco-group').value },
    cov: { id: cov.id, field: $('cov-field').value },
    crs: $('crs').value,
    ellipsoid: $('ellipsoid').value,
    residue: residueParams(),
    unifySpelling: $('unify').checked,
  };
}

$('run').onclick = async () => {
  let params;
  try { params = buildParams(); } catch (e) { setStatus(e.message, true); return; }
  if (!S.factors) setStatus('Sin Excel de factores: las áreas se calculan, pero FC quedará vacío hasta que lo cargue.');
  $('run').disabled = true;
  try {
    const res = await call('run', params);
    S.result = res;
    S.lastParams = params;
    S.lastLayers = { cov: covLayer(), eco: ecoLayer(), interv: S.interv.filter((l) => S.intervChecked.has(l.id)) };
    setStatus(`Listo en ${res.seconds.toFixed(1)} s: ${res.parts.length} polígonos ecosistema–cobertura.`);
    ['dl-xlsx', 'dl-footprint', 'dl-units', 'dl-edits'].forEach((id) => ($(id).disabled = false));
    updateTemplateExample();
    rebuild();
    await drawMap();
    showTab(S.tables.missingKeys.length ? 'factors' : 'biomes');
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    $('run').disabled = false;
  }
};

// ------------------------------------------------------------- tablas
function tableConfig() {
  return { method: method(), factors: S.factors || [], ecoTemplate: $('eco-template').value || DEFAULT_TEMPLATE, ...S.edits };
}

function rebuild() {
  if (!S.result) return;
  S.tables = buildTables(S.result, tableConfig());
  $('legend-edit').hidden = false;
  $('method-label').textContent = method() === 'geod'
    ? `Áreas elipsoidales (${ELLIPSOIDS[S.lastParams.ellipsoid].label})`
    : `Áreas planimétricas en ${S.lastParams.crs}`;
  const n = S.tables.residues.length;
  $('res-badge').hidden = !n;
  $('res-badge').textContent = n;
  renderBiomes(); renderEcosystems(); renderCoverages(); renderFactors(); renderResidues(); renderDiag();
}

/**
 * columns: [{header, cls:'num'|'text', get(row), fmt?, edit?:{value(row), changed(row), commit(row, raw), reset?(row)}}]
 */
function renderTable(container, { title, formula, columns, rows, totals, exportName }) {
  if (!rows.length) { container.innerHTML = `<div class="empty-state">Sin filas. Ejecute el cruce para construir esta tabla.</div>`; return; }
  const head = `<tr>${columns.map((c) => `<th class="${c.cls || ''}">${esc(c.header)}</th>`).join('')}</tr>`;
  const body = rows.map((r, i) => `<tr>${columns.map((c, j) => {
    const cls = [c.cls || '', c.missing?.(r) ? 'missing' : ''].join(' ');
    if (c.edit && (!c.edit.when || c.edit.when(r))) {
      const changed = c.edit.changed(r);
      const val = c.edit.value(r);
      return `<td class="${cls}"><span class="cellwrap"><input class="cell${changed ? ' changed' : ''}" data-r="${i}" data-c="${j}" value="${esc(val)}" aria-label="${esc(c.header)}"${c.cls === 'text' ? ` size="${Math.min(60, Math.max(14, String(val).length + 2))}"` : ' inputmode="decimal" placeholder="sin FC"'}>${changed && c.edit.reset ? `<button class="reset" data-r="${i}" data-c="${j}" title="Restablecer valor calculado" aria-label="Restablecer">×</button>` : ''}</span></td>`;
    }
    const v = c.get(r);
    return `<td class="${cls}">${esc(c.fmt ? c.fmt(v, r) : v)}</td>`;
  }).join('')}</tr>`).join('');
  const foot = totals ? `<tr class="total">${columns.map((c, j) => `<td class="${c.cls || ''}">${j === 0 ? 'TOTAL' : c.total ? esc(c.fmt ? c.fmt(totals[c.total]) : totals[c.total]) : ''}</td>`).join('')}</tr>` : '';
  container.innerHTML = `<div class="table-head"><h3>${esc(title)}</h3><span class="formula">${formula || ''}</span><span class="spacer"></span><button type="button" class="dl-one">Exportar esta tabla</button></div>
    <div class="tbl-wrap"><table><thead>${head}</thead><tbody>${body}${foot}</tbody></table></div>`;
  container.querySelectorAll('input.cell').forEach((inp) => {
    inp.addEventListener('change', () => columns[+inp.dataset.c].edit.commit(rows[+inp.dataset.r], inp.value));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = columns[+inp.dataset.c].edit.value(rows[+inp.dataset.r]); inp.blur(); } });
  });
  container.querySelectorAll('button.reset').forEach((b) => (b.onclick = () => columns[+b.dataset.c].edit.reset(rows[+b.dataset.r])));
  container.querySelector('.dl-one').onclick = () => {
    const cols = columns.map((c) => ({ id: c.header, header: c.header, value: (r) => (c.raw ? c.raw(r) : c.get(r)) }));
    download(tableToSheetBytes(title, cols, rows), `${normalizeText(exportName || title).replace(/\s+/g, '_')}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  };
}

const numCol = (header, field, digits, extra = {}) => ({ header, cls: 'num', get: (r) => r[field], raw: (r) => r[field], fmt: (v) => fmt(v, digits()), ...extra, total: extra.total ? field : null });
const setEdit = (bucket, key, value) => { if (value === null || value === undefined || value === '') delete S.edits[bucket][key]; else S.edits[bucket][key] = value; rebuild(); };
const fcEdit = (keyOf) => ({
  value: (r) => (r.fc === null ? '' : fmt(r.fc, 6).replace(/0+$/, '').replace(/,$/, '')),
  changed: (r) => S.edits.fcOverride[keyOf(r)] !== undefined || S.edits.critOverride[keyOf(r)] !== undefined,
  commit: (r, raw) => { const n = parseNum(raw); setEdit('fcOverride', keyOf(r), n); },
  reset: (r) => { delete S.edits.critOverride[keyOf(r)]; setEdit('fcOverride', keyOf(r), null); },
});
const fcFmt = (v) => (v === null ? '' : fmt(v, 6).replace(/0+$/, '').replace(/,$/, ''));

function renderBiomes() {
  const t = S.tables; const d = dec();
  renderTable($('tab-biomes'), {
    title: 'Tabla por biomas', formula: 'Área a compensar (ha) = Área afectada (ha) × FC',
    rows: t.biomes, totals: t.totals.biomes, exportName: 'tabla_biomas',
    columns: [
      { header: 'Bioma', cls: 'text', get: (r) => r.label, raw: (r) => r.label, edit: {
        value: (r) => r.label, changed: (r) => S.edits.bioLabel[r.group] !== undefined,
        commit: (r, raw) => setEdit('bioLabel', r.group, raw.trim() && raw.trim() !== r.group ? raw.trim() : null),
        reset: (r) => setEdit('bioLabel', r.group, null) } },
      { header: `Valor de ${S.lastParams.eco.keyField}`, cls: 'text', get: (r) => r.keys.join('; ') },
      numCol('Áreas afectadas (m²)', 'm2', () => d.m2, { total: true }),
      numCol('Áreas afectadas (ha)', 'ha', () => d.ha, { total: true }),
      { header: 'FC', cls: 'num', get: (r) => r.fc, raw: (r) => r.fc, fmt: fcFmt, missing: (r) => r.fc === null, edit: { ...fcEdit((r) => r.fcKey), when: (r) => !!r.fcKey } },
      numCol('Áreas a compensar (ha)', 'comp', () => d.ha, { total: true }),
      numCol('Área sin FC (ha)', 'missingHa', () => d.ha),
      { header: 'Observación', cls: 'text', get: (r) => r.obs },
    ],
  });
}

function renderEcosystems() {
  const t = S.tables; const d = dec();
  renderTable($('tab-ecosystems'), {
    title: 'Tabla por ecosistemas', formula: `Ecosistema = ${esc($('eco-template').value || DEFAULT_TEMPLATE)} · Área a compensar = ha × FC`,
    rows: t.ecosystems, totals: t.totals.ecosystems, exportName: 'tabla_ecosistemas',
    columns: [
      { header: 'Bioma', cls: 'text', get: (r) => r.label },
      { header: 'Ecosistema', cls: 'text', get: (r) => r.name, raw: (r) => r.name, edit: {
        value: (r) => r.name, changed: (r) => S.edits.ecoLabel[r.auto] !== undefined,
        commit: (r, raw) => setEdit('ecoLabel', r.auto, raw.trim() && raw.trim() !== r.auto ? raw.trim() : null),
        reset: (r) => setEdit('ecoLabel', r.auto, null) } },
      numCol('Áreas afectadas (m²)', 'm2', () => d.m2, { total: true }),
      numCol('Áreas afectadas (ha)', 'ha', () => d.ha, { total: true }),
      { header: 'FC', cls: 'num', get: (r) => r.fc, raw: (r) => r.fc, fmt: fcFmt, missing: (r) => r.fc === null, edit: fcEdit((r) => r.key) },
      numCol('Áreas a compensar (ha)', 'comp', () => d.ha, { total: true }),
    ],
  });
}

function renderCoverages() {
  const t = S.tables; const d = dec();
  const box = $('tab-coverages');
  renderTable(box, {
    title: 'Tabla por coberturas', formula: 'Área a compensar (ha) = Área afectada (ha) × FC × FCcob',
    rows: t.coverages, totals: t.totals.coverages, exportName: 'tabla_coberturas',
    columns: [
      { header: 'Bioma', cls: 'text', get: (r) => r.label },
      { header: 'Ecosistema', cls: 'text', get: (r) => r.name },
      { header: 'Cobertura', cls: 'text', get: (r) => r.cov },
      numCol('Áreas afectadas (m²)', 'm2', () => d.m2, { total: true }),
      numCol('Áreas afectadas (ha)', 'ha', () => d.ha, { total: true }),
      { header: 'FC', cls: 'num', get: (r) => r.fc, raw: (r) => r.fc, fmt: fcFmt, missing: (r) => r.fc === null },
      { header: 'FCcob', cls: 'num', get: (r) => r.fcCob, raw: (r) => r.fcCob, edit: {
        value: (r) => fcFmt(r.fcCob), changed: (r) => r.fcCobOverridden,
        commit: (r, raw) => { const n = parseNum(raw); setEdit('rowFcCob', r.rowKey, n); },
        reset: (r) => setEdit('rowFcCob', r.rowKey, null) } },
      numCol('Áreas a compensar (ha)', 'comp', () => d.ha, { total: true }),
    ],
  });
  if (!t.coverages.length) return;
  const panel = document.createElement('div');
  panel.innerHTML = `<div class="table-head"><h3>FCcob por cobertura</h3><span class="formula">Se aplica a todas las filas de esa cobertura, salvo las que tengan un valor propio en la tabla.</span><span class="spacer"></span><button type="button" id="cob-all-one">Asignar 1 a todas</button></div>
    <div class="cob-panel">${t.coverageFactors.map((c, i) => `<label><span>${esc(c.cov)}</span><input class="cell${S.edits.fcCob[c.cov] !== undefined ? ' changed' : ''}" data-i="${i}" value="${esc(fcFmt(c.fcCob))}" inputmode="decimal"></label>`).join('')}</div>`;
  box.prepend(panel);
  panel.querySelectorAll('input.cell').forEach((inp) => inp.addEventListener('change', () => {
    const cov = t.coverageFactors[+inp.dataset.i].cov;
    const n = parseNum(inp.value);
    setEdit('fcCob', cov, n === 1 ? null : n);
  }));
  panel.querySelector('#cob-all-one').onclick = () => { S.edits.fcCob = {}; rebuild(); };
}

function renderFactors() {
  const t = S.tables;
  const critCols = CRITERIA.map((c) => ({
    header: c.label, cls: 'num', get: (r) => r.criteria?.[c.id] ?? null, raw: (r) => r.criteria?.[c.id] ?? null, fmt: fcFmt,
    edit: {
      when: (r) => !!r.criteria || !!S.factorsInfo?.hasCriteria,
      value: (r) => fcFmt(r.criteria?.[c.id] ?? null),
      changed: (r) => S.edits.critOverride[r.key]?.[c.id] !== undefined,
      commit: (r, raw) => {
        const n = parseNum(raw);
        const cur = { ...(S.edits.critOverride[r.key] || {}) };
        if (n === null) delete cur[c.id]; else cur[c.id] = n;
        if (Object.keys(cur).length) S.edits.critOverride[r.key] = cur; else delete S.edits.critOverride[r.key];
        delete S.edits.fcOverride[r.key]; // al editar un criterio, el FC vuelve a ser la suma
        rebuild();
      },
      reset: (r) => {
        const cur = { ...(S.edits.critOverride[r.key] || {}) };
        delete cur[c.id];
        if (Object.keys(cur).length) S.edits.critOverride[r.key] = cur; else delete S.edits.critOverride[r.key];
        rebuild();
      },
    },
  }));
  const hasCrit = t.fcTable.some((r) => r.criteria);
  renderTable($('tab-factors'), {
    title: 'Factores BUB → FC usados',
    formula: (hasCrit ? 'FC = Crp + Cra + Crm + Ctt (Resolución 256 de 2018). Edite un criterio y el FC se recalcula; o escriba el FC directamente. ' : '')
      + (S.factors ? `Fuente: ${esc(S.factorsName)}.` : 'Cargue el Excel de factores o escriba los FC aquí.'),
    rows: t.fcTable, exportName: 'factores_bub_fc',
    columns: [
      { header: `${S.lastParams.eco.keyField} (capa)`, cls: 'text', get: (r) => r.key },
      { header: 'BUB (Excel)', cls: 'text', get: (r) => r.bub ?? 'No encontrado', missing: (r) => !r.bub },
      ...(hasCrit || S.factorsInfo?.hasCriteria ? critCols : []),
      { header: 'FC usado', cls: 'num', get: (r) => r.fc, raw: (r) => r.fc, missing: (r) => r.fc === null, edit: {
        value: (r) => fcFmt(r.fc), changed: (r) => r.manual,
        commit: (r, raw) => setEdit('fcOverride', r.key, parseNum(raw)), reset: (r) => setEdit('fcOverride', r.key, null) } },
      { header: 'FC del Excel', cls: 'num', get: (r) => r.fcExcel, raw: (r) => r.fcExcel, fmt: fcFmt },
      { header: 'Origen del FC', cls: 'text', get: (r) => (r.manual ? 'Escrito a mano' : r.edited.length ? `Suma con ${r.edited.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(', ')} editado` : r.fc === null ? 'Sin FC' : 'Excel') },
    ],
  });
}

function renderResidues() {
  const t = S.tables; const box = $('tab-residues'); const rp = S.result.residues;
  const actionText = { reasignar: 'se suman al vecino con el que comparten más borde', descartar: 'se descartan', conservar: 'se conservan como unidades propias' }[rp.action];
  const summary = `${t.residues.length} polígonos menores a ${esc(fmt(rp.threshold, 4))} m² (${esc(fmt(t.residueArea.all, 6))} m² en total) ${actionText} (el umbral se evalúa con el área planimétrica).${t.residueArea.discarded ? ` Área descartada: ${esc(fmt(t.residueArea.discarded, 6))} m².` : ''} Pulse una fila para verla en el mapa.`;
  if (!t.residues.length) { box.innerHTML = `<div class="table-head"><h3>Residuos geométricos</h3><span class="formula">${summary}</span></div><div class="empty-state">No hay polígonos por debajo del umbral. Puede subir el umbral en el paso 5 para revisar piezas pequeñas.</div>`; return; }
  renderTable(box, {
    title: 'Residuos geométricos', rows: t.residues, exportName: 'residuos', formula: summary,
    columns: [
      { header: 'Bioma', cls: 'text', get: (r) => r.label },
      { header: 'Cobertura', cls: 'text', get: (r) => r.cov },
      { header: 'Área (m²)', cls: 'num', get: (r) => r.m2, raw: (r) => r.m2, fmt: (v) => fmt(v, 6) },
      { header: 'Tratamiento', cls: 'text', get: (r) => r.statusText },
      { header: 'Asignado a', cls: 'text', get: (r) => r.target },
      { header: 'Borde compartido (m)', cls: 'num', get: (r) => r.shared, raw: (r) => r.shared, fmt: (v) => (v ? fmt(v, 3) : '') },
    ],
  });
  box.querySelectorAll('tbody tr').forEach((tr, i) => {
    const r = t.residues[i];
    if (!r) return;
    tr.style.cursor = 'pointer';
    tr.title = 'Ver en el mapa';
    tr.onclick = () => zoomToPart(r.id);
  });
}

function renderDiag() {
  const r = S.result; const t = S.tables; const p = S.lastParams;
  const diff = r.footprint.geod - r.footprint.planar;
  const lines = [
    ['Capas de intervención', S.lastLayers.interv.map(layerLabel).join('; ')],
    ['Capa de coberturas', `${layerLabel(S.lastLayers.cov)} · campo ${p.cov.field}`],
    ['Capa de ecosistemas', `${layerLabel(S.lastLayers.eco)} · llave ${p.eco.keyField} · agrupación ${p.eco.groupField}`],
    ['CRS de análisis', `${CRS_DEFS[p.crs].label} (${p.crs})`],
    ['Huella — área planimétrica', `${fmt(r.footprint.planar, 2)} m² · ${fmt(r.footprint.planar / 1e4, 6)} ha`],
    ['Huella — área elipsoidal', `${fmt(r.footprint.geod, 2)} m² · ${fmt(r.footprint.geod / 1e4, 6)} ha (${ELLIPSOIDS[p.ellipsoid].label})`],
    ['Diferencia elipsoidal − planimétrica', `${fmt(diff, 2)} m² (${fmt((diff / r.footprint.planar) * 100, 4)} %)`],
    ['Cobertura de ecosistemas sobre la huella', `${fmt(r.coverage.ecoPct, 4)} %`],
    ['Cobertura ecosistema–cobertura sobre la huella', `${fmt(r.coverage.unitsPct, 4)} %`],
    ['Polígonos ecosistema–cobertura', `${r.parts.length}`],
    ['Residuos', `${t.residues.length} bajo ${fmt(r.residues.threshold, 4)} m²`],
    ['Construcción del ecosistema', esc($('eco-template').value || DEFAULT_TEMPLATE)],
  ];
  const warnings = [...r.warnings, ...(t.missingKeys.length ? [`${t.missingKeys.length} valores de ${p.eco.keyField} sin FC: ${t.missingKeys.join('; ')}`] : []), ...(S.registerErrors || [])];
  $('tab-diag').innerHTML = `<div class="diag"><h3>Resultados del análisis</h3><dl>${lines.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <h3>Advertencias</h3><ul>${(warnings.length ? warnings : ['Sin advertencias.']).map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`;
}

// ---------------------------------------------------------------- pestañas
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab').forEach((s) => (s.hidden = s.id !== `tab-${name}`));
  if (name === 'map') setTimeout(() => map.invalidateSize(), 50);
}
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// ------------------------------------------------------------------- mapa
const map = L.map('map', { preferCanvas: true }).setView([4.6, -73], 6);
const basemaps = {
  osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }),
  esri: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri World Imagery' }),
};
let currentBase = basemaps.osm.addTo(map);
$('basemap').onchange = (e) => { if (currentBase) map.removeLayer(currentBase); currentBase = basemaps[e.target.value] || null; if (currentBase) currentBase.addTo(map).bringToBack(); };
const overlay = { footprint: null, biomes: null, units: null, residues: null };
let mapCache = null;
let legend = null;
const PALETTE = ['#2a9d8f', '#e9c46a', '#8ab17d', '#577590', '#f4a261', '#90be6d', '#43aa8b', '#bc6c25', '#6d597a', '#b5838d', '#4d908e', '#f9844a'];

async function drawMap() {
  mapCache = await call('map');
  Object.values(overlay).forEach((l) => l && map.removeLayer(l));
  const covColor = new Map();
  [...new Set(mapCache.parts.map((f) => f.properties.cov))].forEach((c, i) => covColor.set(c, PALETTE[i % PALETTE.length]));
  overlay.biomes = L.geoJSON({ type: 'FeatureCollection', features: mapCache.eco }, {
    style: { color: '#7a4310', weight: 1.5, fill: false, dashArray: '4 3' },
    onEachFeature: (f, l) => l.bindPopup(`<b>Bioma</b><br>${esc(f.properties.group)}`),
  });
  overlay.units = L.geoJSON({ type: 'FeatureCollection', features: mapCache.parts }, {
    style: (f) => ({ color: '#0b4545', weight: 0.6, fillColor: covColor.get(f.properties.cov), fillOpacity: 0.55 }),
    onEachFeature: (f, l) => l.on('click', () => l.bindPopup(partPopup(f.properties.id)).openPopup()),
  });
  overlay.footprint = L.geoJSON(mapCache.footprint, { style: { color: '#b23a2a', weight: 2.6, fill: false }, interactive: false });
  drawResidues(false);
  if (legend) map.removeControl(legend);
  legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-legend');
    div.innerHTML = `<b>Coberturas</b>${[...covColor].map(([c, col]) => `<span><i style="background:${col}"></i>${esc(c)}</span>`).join('')}<span><i class="fp"></i>Huella</span><span><i class="bio"></i>Límite de bioma</span><span><i class="res"></i>Residuo</span>`;
    return div;
  };
  legend.addTo(map);
  applyLayerToggles();
  map.fitBounds(overlay.footprint.getBounds(), { padding: [20, 20] });
}

function partPopup(id) {
  const p = S.result.parts.find((x) => x.id === id);
  if (!p) return '';
  const res = S.result.residues.items.find((r) => r.id === id);
  const area = method() === 'geod' ? p.geod : p.planar;
  return `<b>${esc(p.cov)}</b><br>${esc(S.edits.bioLabel[p.group] ?? p.group)}<br>${esc(fmt(area, 2))} m² · ${esc(fmt(area / 1e4, 4))} ha${res ? `<br><i>Residuo: ${esc({ reasignar: 'sumado al vecino', descartar: 'descartado', conservar: 'conservado', 'conservar-sin-vecino': 'conservado (sin vecino)' }[res.status])}</i>` : ''}`;
}

function drawResidues(toggle = true) {
  if (!mapCache || !S.result) return;
  if (overlay.residues) map.removeLayer(overlay.residues);
  const ids = new Set(S.result.residues.items.map((r) => r.id));
  const group = L.layerGroup();
  for (const f of mapCache.parts.filter((x) => ids.has(x.properties.id))) {
    const g = L.geoJSON(f, { style: { color: '#c2185b', weight: 3, fillOpacity: 0.4 } });
    const c = g.getBounds().getCenter();
    group.addLayer(g);
    group.addLayer(L.circleMarker(c, { radius: 7, color: '#c2185b', weight: 2, fillOpacity: 0.15 }).on('click', () => L.popup().setLatLng(c).setContent(partPopup(f.properties.id)).openOn(map)));
  }
  overlay.residues = group;
  if (toggle) applyLayerToggles();
}

function applyLayerToggles() {
  const on = { biomes: $('lyr-biomes').checked, units: $('lyr-units').checked, footprint: $('lyr-footprint').checked, residues: $('lyr-residues').checked };
  for (const k of ['units', 'biomes', 'residues', 'footprint']) {
    const l = overlay[k];
    if (!l) continue;
    if (on[k] && !map.hasLayer(l)) l.addTo(map);
    if (!on[k] && map.hasLayer(l)) map.removeLayer(l);
  }
}
['lyr-footprint', 'lyr-biomes', 'lyr-units', 'lyr-residues'].forEach((id) => ($(id).onchange = applyLayerToggles));

function zoomToPart(id) {
  const f = mapCache?.parts.find((x) => x.properties.id === id);
  if (!f) return;
  showTab('map');
  const b = L.geoJSON(f).getBounds();
  setTimeout(() => { map.fitBounds(b, { maxZoom: 22 }); L.popup().setLatLng(b.getCenter()).setContent(partPopup(id)).openOn(map); }, 80);
}

// -------------------------------------------------------------- descargas
const stamp = () => new Date().toISOString().slice(0, 10);

$('dl-xlsx').onclick = () => {
  if (!S.tables) return;
  const p = S.lastParams; const r = S.result;
  const params = {
    'Aplicación': `Analizador de Compensaciones — Fundación Cunaguaro v${APP_VERSION}`,
    'Fecha': new Date().toLocaleString('es-CO'),
    'Intervenciones seleccionadas': S.lastLayers.interv.map(layerLabel).join('; '),
    'Capa de cobertura': layerLabel(S.lastLayers.cov),
    'Campo de cobertura': p.cov.field,
    'Capa de ecosistemas': layerLabel(S.lastLayers.eco),
    'Campo llave BUB/FC': p.eco.keyField,
    'Campo de agrupación de bioma': p.eco.groupField,
    'Construcción del ecosistema': $('eco-template').value || DEFAULT_TEMPLATE,
    'Unificación de variantes de escritura': p.unifySpelling ? 'Sí' : 'No',
    'Archivo de factores': S.factorsName || 'Sin archivo (FC escritos en la app)',
    'CRS de análisis': `${CRS_DEFS[p.crs].label} (${p.crs})`,
    'Método de área usado en las tablas': method() === 'geod' ? `Elipsoidal (equivale a $area en QGIS) — ${ELLIPSOIDS[p.ellipsoid].label}` : `Planimétrica en ${p.crs} (equivale a area($geometry) en QGIS)`,
    'Huella — área planimétrica (m²)': r.footprint.planar,
    'Huella — área elipsoidal (m²)': r.footprint.geod,
    'Huella — área planimétrica (ha)': r.footprint.planar / 1e4,
    'Huella — área elipsoidal (ha)': r.footprint.geod / 1e4,
    'Cobertura de ecosistemas sobre la huella (%)': r.coverage.ecoPct,
    'Cobertura ecosistema–cobertura sobre la huella (%)': r.coverage.unitsPct,
    'Umbral de residuos (m²)': r.residues.threshold,
    'Tratamiento de residuos': { reasignar: 'Sumar al vecino', descartar: 'Descartar', conservar: 'Conservar' }[r.residues.action],
    'Residuos encontrados': S.tables.residues.length,
    'FC escritos a mano en la app': Object.keys(S.edits.fcOverride).length,
    'BUB con criterios editados en la app': Object.keys(S.edits.critOverride).length,
    'FCcob por cobertura distintos de 1': Object.keys(S.edits.fcCob).length,
    'FCcob personalizados por fila': Object.keys(S.edits.rowFcCob).length,
  };
  const warnings = [...r.warnings, ...(S.tables.missingKeys.length ? [`Hay ${S.tables.missingKeys.length} valores de ${p.eco.keyField} sin FC asociado.`] : [])];
  download(buildWorkbook({ tables: S.tables, params, warnings }), `resultados_compensacion_${stamp()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
};

$('dl-footprint').onclick = async () => {
  const gj = await call('exportFootprint');
  download(JSON.stringify(gj), `huella_intervenciones_${stamp()}.geojson`, 'application/geo+json');
};

$('dl-units').onclick = async () => {
  const resMap = new Map(S.result.residues.items.map((r) => [r.id, r]));
  const byId = new Map(S.result.parts.map((p) => [p.id, p]));
  const attrs = {};
  for (const p of S.result.parts) {
    const r = resMap.get(p.id);
    const t = r && r.status === 'reasignar' && r.to !== null ? byId.get(r.to) : p;
    attrs[p.id] = {
      id: p.id, bioma: S.edits.bioLabel[t.group] ?? t.group, llave_fc: t.key, cobertura: t.cov,
      ecosistema: ecosystemName($('eco-template').value, { cobertura: t.cov, bioma: t.key, grupo: S.edits.bioLabel[t.group] ?? t.group }),
      area_plan_m2: p.planar, area_elip_m2: p.geod, residuo: r ? r.status : '',
    };
  }
  const gj = await call('exportUnits', attrs);
  download(JSON.stringify(gj), `unidades_ecosistema_cobertura_${stamp()}.geojson`, 'application/geo+json');
};

$('dl-edits').onclick = () => {
  const data = { app: 'analizador-compensaciones', version: APP_VERSION, saved: new Date().toISOString(), template: $('eco-template').value, method: method(), residue: residueParams(), edits: S.edits };
  download(JSON.stringify(data, null, 2), `ajustes_compensacion_${stamp()}.json`, 'application/json');
};

$('ul-edits').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    S.edits = { fcOverride: {}, critOverride: {}, fcCob: {}, rowFcCob: {}, bioLabel: {}, ecoLabel: {}, ...(data.edits || {}) };
    if (data.template) $('eco-template').value = data.template;
    if (data.method) document.querySelector(`input[name=method][value=${data.method}]`).checked = true;
    if (data.residue) { $('res-threshold').value = String(data.residue.threshold).replace('.', ','); $('res-action').value = data.residue.action; }
    setStatus('Ajustes cargados. Se aplican sobre el resultado actual o el próximo cruce.');
    if (S.result) await onResidueChange(); else rebuild();
  } catch (err) { setStatus(`No fue posible leer los ajustes: ${err.message}`, true); }
};

// ------------------------------------------------- capas incluidas en el sitio
async function loadIncluded(kind, quiet = false) {
  const conf = S.manifest?.[kind];
  if (!conf) return;
  const group = kind === 'coberturas' ? 'cov' : 'eco';
  const box = $(`${group}-included`);
  box.hidden = false;
  box.textContent = `Cargando la capa incluida: ${conf.nombre}…`;
  try {
    const resp = await fetch(`data/${conf.archivo}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const file = new File([await resp.blob()], conf.archivo);
    const layers = await registerGroup(group, [file]);
    const layer = layers.find((x) => POLY_RE.test(x.geometryType || ''));
    S.included = S.included || {};
    S.included[group] = { ...conf, layerId: layer?.id };
    if (group === 'cov') { S.cov = layers; fillLayerSelect($('cov-layer'), S.cov); if (layer) $('cov-layer').value = layer.id; onCoverageLayer(); }
    else { S.eco = layers; fillLayerSelect($('eco-layer'), S.eco, 'ecosistemas'); if (layer) $('eco-layer').value = layer.id; onEcoLayer(); }
    box.textContent = `Usando la capa incluida: ${conf.nombre}. Puede elegir otra arriba.`;
    if (!quiet) setStatus('Capa incluida restablecida.');
  } catch (e) {
    box.textContent = `No fue posible cargar la capa incluida (${e.message}). Elija el archivo manualmente.`;
  }
}

function markReplaced(group) {
  const box = $(`${group}-included`);
  if (!S.manifest) return;
  const kind = group === 'cov' ? 'coberturas' : 'ecosistemas';
  box.hidden = false;
  box.innerHTML = `Usando un archivo propio.<button type="button">Volver a la capa incluida</button>`;
  box.querySelector('button').onclick = () => loadIncluded(kind);
}

(async () => {
  try {
    const resp = await fetch('data/capas.json', { cache: 'no-cache' });
    if (!resp.ok) return;
    S.manifest = await resp.json();
    await loadIncluded('coberturas', true);
    await loadIncluded('ecosistemas', true);
    await loadIncludedFactors();
    setStatus(S.manifest.factores ? 'Coberturas, ecosistemas y factores incluidos listos. Cargue las intervenciones.' : 'Capas de coberturas y ecosistemas incluidas listas. Cargue las intervenciones y el Excel de factores.');
  } catch { /* sin capas incluidas */ }
})();

window.addEventListener('beforeunload', (e) => { if (S.result) { e.preventDefault(); e.returnValue = ''; } });
$('version').textContent = `v${APP_VERSION}`;
updateTemplateExample();
