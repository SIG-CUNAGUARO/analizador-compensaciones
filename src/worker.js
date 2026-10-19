// Web Worker: toda la geometría corre aquí para no congelar la interfaz.
import initSqlJs from 'sql.js';
import { initGeos } from './geo.js';
import { setSqlLoader } from './readers.js';
import * as E from './engine.js';

setSqlLoader(() => initSqlJs({ locateFile: () => new URL('./sql-wasm.wasm', self.location.href).href }));
const ready = initGeos();

self.onmessage = async ({ data }) => {
  const { id, type, payload } = data;
  const progress = (msg) => self.postMessage({ type: 'progress', msg });
  try {
    await ready;
    let result;
    switch (type) {
      case 'register':
        if (payload.replaceGroup) E.forgetGroup(payload.group);
        result = await E.registerFiles(payload.files, { encoding: payload.encoding, group: payload.group });
        break;
      case 'sample': result = await E.sampleField(payload.layerId, payload.field); break;
      case 'run': result = await E.runAnalysis(payload, progress); break;
      case 'residues': result = E.applyResidues(payload); break;
      case 'map': result = E.mapData(); break;
      case 'exportUnits': result = E.exportUnits(payload); break;
      case 'exportFootprint': result = E.exportFootprint(); break;
      default: throw new Error(`Mensaje desconocido: ${type}`);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};
