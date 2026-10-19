// Construcción de tablas a partir del resultado geométrico y de los ajustes del usuario.
// Es una función pura: cada edición vuelve a calcular todo al instante.

export function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').replace(/\s+/g, ' ').trim();
}

export const DEFAULT_TEMPLATE = '{cobertura} del {bioma}';

export function ecosystemName(template, { cobertura, bioma, grupo }) {
  return (template || DEFAULT_TEMPLATE)
    .replaceAll('{cobertura}', cobertura)
    .replaceAll('{bioma}', bioma)
    .replaceAll('{grupo}', grupo)
    .replace(/\s+/g, ' ')
    .trim();
}

const SEP = '\u241f';
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * res: salida de runAnalysis (+ residues actualizados)
 * cfg: { method, factors:[{bub,fc}], fcOverride, fcCob, rowFcCob, bioLabel, ecoTemplate, ecoLabel }
 */
export function buildTables(res, cfg) {
  const method = cfg.method === 'geod' ? 'geod' : 'planar';
  const areaOf = (x) => (method === 'geod' ? x.geod : x.planar);
  const excel = new Map((cfg.factors || []).map((f) => [normalizeText(f.bub), f]));
  const fcOverride = cfg.fcOverride || {};
  const fcCob = cfg.fcCob || {};
  const fcCobOnly = cfg.fcCobOnly || {};
  const rowFcCob = cfg.rowFcCob || {};
  const bioLabel = cfg.bioLabel || {};
  const ecoLabel = cfg.ecoLabel || {};
  const label = (g) => bioLabel[g] ?? g;

  const critOverride = cfg.critOverride || {};
  const CRIT = ['crp', 'cra', 'crm', 'ctt'];
  /** FC usado: escrito a mano > suma de criterios (con ediciones) > FC del Excel. */
  const factorInfo = (key) => {
    const hit = excel.get(normalizeText(key));
    const over = critOverride[key] || {};
    const edited = CRIT.filter((c) => num(over[c]) !== null);
    let criteria = hit?.criteria ? { ...hit.criteria } : (edited.length ? Object.fromEntries(CRIT.map((c) => [c, null])) : null);
    if (criteria) for (const c of edited) criteria[c] = num(over[c]);
    const manual = num(fcOverride[key]) !== null;
    let fc;
    if (manual) fc = num(fcOverride[key]);
    else if (criteria && CRIT.every((c) => criteria[c] !== null) && (edited.length || hit?.criteria)) fc = CRIT.reduce((a, c) => a + criteria[c], 0);
    else fc = hit ? hit.fc : null;
    return { hit, criteria, edited, manual, fc };
  };
  const fcCache = new Map();
  const fcFor = (key) => { if (!fcCache.has(key)) fcCache.set(key, factorInfo(key)); return fcCache.get(key).fc; };

  // --------------------------------------------------------- factores BUB/FC
  const keys = new Set([...res.ecoPieces.map((e) => e.key), ...res.parts.map((p) => p.key)]);
  const fcTable = [...keys].sort((a, b) => normalizeText(a).localeCompare(normalizeText(b))).map((key) => {
    fcFor(key);
    const { hit, criteria, edited, manual, fc } = fcCache.get(key);
    return { key, bub: hit ? hit.bub : null, fcExcel: hit ? hit.fc : null, criteria, edited, manual, fc, overridden: manual || edited.length > 0 };
  });

  // ----------------------------------------------------------------- biomas
  const bmap = new Map();
  for (const e of res.ecoPieces) {
    if (!bmap.has(e.group)) bmap.set(e.group, { group: e.group, keys: new Set(), m2: 0, validHa: 0, missingHa: 0, comp: 0 });
    const r = bmap.get(e.group);
    const m2 = areaOf(e);
    const fc = fcFor(e.key);
    r.keys.add(e.key);
    r.m2 += m2;
    if (fc === null) r.missingHa += m2 / 1e4; else { r.validHa += m2 / 1e4; r.comp += (m2 / 1e4) * fc; }
  }
  const biomes = [...bmap.values()].map((r) => {
    const keysArr = [...r.keys];
    const missing = r.missingHa > 1e-12;
    return {
      rowKey: r.group, group: r.group, label: label(r.group), keys: keysArr,
      fcKey: keysArr.length === 1 ? keysArr[0] : null,
      m2: r.m2, ha: r.m2 / 1e4,
      fc: r.validHa > 0 ? r.comp / r.validHa : null,
      comp: missing ? null : r.comp,
      missingHa: r.missingHa,
      obs: missing ? 'Existe área sin FC asociado' : keysArr.length > 1 ? `FC ponderado de ${keysArr.length} valores de la llave` : '',
    };
  }).sort((a, b) => normalizeText(a.label).localeCompare(normalizeText(b.label)));

  // ------------------------------------------------- partes efectivas (residuos)
  const byId = new Map(res.parts.map((p) => [p.id, p]));
  const resMap = new Map((res.residues?.items || []).map((r) => [r.id, r]));
  const effective = [];
  for (const p of res.parts) {
    const r = resMap.get(p.id);
    if (r && r.status === 'descartar') continue;
    const target = r && r.status === 'reasignar' && r.to !== null ? byId.get(r.to) : p;
    effective.push({ id: p.id, key: target.key, group: target.group, cov: target.cov, planar: p.planar, geod: p.geod });
  }

  const nameOf = (x) => {
    const auto = ecosystemName(cfg.ecoTemplate, { cobertura: x.cov, bioma: x.key, grupo: label(x.group) });
    return { auto, name: ecoLabel[auto] ?? auto };
  };

  // ------------------------------------------------------------ ecosistemas
  const emap = new Map();
  for (const x of effective) {
    const { auto, name } = nameOf(x);
    const k = [x.group, auto, x.key].join(SEP);
    if (!emap.has(k)) emap.set(k, { rowKey: k, group: x.group, label: label(x.group), key: x.key, auto, name, m2: 0 });
    emap.get(k).m2 += areaOf(x);
  }
  const ecosystems = [...emap.values()].map((r) => {
    const fc = fcFor(r.key);
    const ha = r.m2 / 1e4;
    return { ...r, ha, fc, comp: fc === null ? null : ha * fc };
  }).sort((a, b) => normalizeText(a.label + SEP + a.name).localeCompare(normalizeText(b.label + SEP + b.name)));

  // ------------------------------------------------------------- coberturas
  const cmap = new Map();
  for (const x of effective) {
    const { auto, name } = nameOf(x);
    const k = [x.group, auto, x.cov, x.key].join(SEP);
    if (!cmap.has(k)) cmap.set(k, { rowKey: k, group: x.group, label: label(x.group), key: x.key, auto, name, cov: x.cov, m2: 0 });
    cmap.get(k).m2 += areaOf(x);
  }
  const coverages = [...cmap.values()].map((r) => {
    const fc = fcFor(r.key);
    const rowOver = num(rowFcCob[r.rowKey]);
    const fcCobValue = rowOver ?? num(fcCob[r.cov]) ?? 1;
    const ha = r.m2 / 1e4;
    const only = !!fcCobOnly[r.cov];
    // «Solo FCcob»: prioridad del FCcob sobre el FC del bioma → ha × FCcob.
    const comp = only ? ha * fcCobValue : fc === null ? null : ha * fc * fcCobValue;
    return { ...r, ha, fc, fcCob: fcCobValue, fcCobOverridden: rowOver !== null, fcCobOnly: only, comp };
  }).sort((a, b) => normalizeText([a.label, a.name, a.cov].join(SEP)).localeCompare(normalizeText([b.label, b.name, b.cov].join(SEP))));

  const coverageList = [...new Set(effective.map((p) => p.cov))].sort((a, b) => normalizeText(a).localeCompare(normalizeText(b)));
  const coverageFactors = coverageList.map((cov) => ({ cov, fcCob: num(fcCob[cov]) ?? 1, only: !!fcCobOnly[cov] }));

  // -------------------------------------------------------------- residuos
  const residues = (res.residues?.items || []).map((r) => {
    const t = r.to !== null ? byId.get(r.to) : null;
    return {
      ...r, label: label(r.group), m2: areaOf(r),
      target: t ? `${label(t.group)} · ${t.cov}` : '',
      statusText: { reasignar: 'Reasignado al vecino', descartar: 'Descartado', conservar: 'Conservado', 'conservar-sin-vecino': 'Conservado (sin vecino a ≤ 1 m)' }[r.status] || r.status,
    };
  });

  const sum = (rows, f) => rows.reduce((s, r) => s + (r[f] ?? 0), 0);
  const anyNull = (rows, f) => rows.some((r) => r[f] === null);
  const totals = {
    biomes: { m2: sum(biomes, 'm2'), ha: sum(biomes, 'ha'), comp: anyNull(biomes, 'comp') ? null : sum(biomes, 'comp') },
    ecosystems: { m2: sum(ecosystems, 'm2'), ha: sum(ecosystems, 'ha'), comp: anyNull(ecosystems, 'comp') ? null : sum(ecosystems, 'comp') },
    coverages: { m2: sum(coverages, 'm2'), ha: sum(coverages, 'ha'), comp: anyNull(coverages, 'comp') ? null : sum(coverages, 'comp') },
  };
  const residueArea = { all: sum(residues, 'm2'), discarded: residues.filter((r) => r.status === 'descartar').reduce((s, r) => s + r.m2, 0) };
  const missingKeys = fcTable.filter((f) => f.fc === null).map((f) => f.key);

  return { method, fcTable, biomes, ecosystems, coverages, coverageFactors, residues, totals, residueArea, missingKeys };
}
