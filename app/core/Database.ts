import * as SQLite from 'expo-sqlite';

let dbCache: SQLite.SQLiteDatabase | null = null;

export const initDB = async () => {
  if (dbCache) return dbCache;
  dbCache = await SQLite.openDatabaseAsync('prospectorai_v2.db');
  
  await dbCache.execAsync(`
    CREATE TABLE IF NOT EXISTS proyectos (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      fecha_creacion TEXT NOT NULL,
      ultimo_acceso TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS muestras (
      id TEXT PRIMARY KEY,
      proyecto_id TEXT,
      lat REAL,
      lng REAL,
      altitud REAL,
      rumbo REAL,
      fecha_hora TEXT,
      tipo_captura TEXT,
      imagen_thumbnail TEXT,
      descripcion_texto TEXT,
      analisis_ia TEXT,
      mineral_detectado TEXT,
      score_ia INTEGER,
      sincronizado INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS poligonos_cache (
      id TEXT PRIMARY KEY,
      mineral TEXT,
      terrain TEXT,
      rock_type TEXT,
      coordenadas TEXT,
      fecha TEXT,
      analisis_resultado TEXT,
      estado TEXT DEFAULT 'OFFLINE'
    );
  `);

  const hasDefault = await dbCache.getFirstAsync('SELECT id FROM proyectos WHERE id = ?', ['default']);
  if (!hasDefault) {
    await dbCache.runAsync(
      'INSERT INTO proyectos (id, nombre, fecha_creacion, ultimo_acceso) VALUES (?, ?, ?, ?)',
      ['default', 'Predefinido', new Date().toISOString(), new Date().toISOString()]
    );
  }
  return dbCache;
};

export const saveMuestra = async (data: any) => {
  const db = await initDB();
  await db.runAsync(
    `INSERT INTO muestras (id, proyecto_id, lat, lng, altitud, rumbo, fecha_hora, tipo_captura, imagen_thumbnail, descripcion_texto, analisis_ia, mineral_detectado, score_ia, sincronizado) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id, 
      data.proyecto_id || 'default', 
      data.lat, 
      data.lng, 
      data.altitud || 0, 
      data.rumbo || 0,
      data.fecha_hora, 
      data.tipo_captura || 'normal', 
      data.imagen_thumbnail || '', 
      data.descripcion_texto || '',
      data.analisis_ia ? JSON.stringify(data.analisis_ia) : '{}', 
      data.mineral_detectado || '', 
      data.score_ia || 0, 
      0
    ]
  );
};

export const getMuestras = async (proyectoId?: string) => {
  const db = await initDB();
  if (proyectoId && proyectoId !== 'ALL') {
    return await db.getAllAsync('SELECT * FROM muestras WHERE proyecto_id = ? ORDER BY fecha_hora DESC', [proyectoId]);
  }
  return await db.getAllAsync('SELECT * FROM muestras ORDER BY fecha_hora DESC');
};

export const clearMuestras = async () => {
   const db = await initDB();
   await db.runAsync('DELETE FROM muestras');
};

export const savePoligonoCache = async (data: any) => {
  const db = await initDB();
  await db.runAsync(
    `INSERT OR REPLACE INTO poligonos_cache (id, mineral, terrain, rock_type, coordenadas, fecha, analisis_resultado, estado) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id, data.mineral, data.terrain, data.rock_type, 
      typeof data.coordenadas === 'string' ? data.coordenadas : JSON.stringify(data.coordenadas),
      new Date().toISOString(),
      typeof data.analisis_resultado === 'string' ? data.analisis_resultado : JSON.stringify(data.analisis_resultado),
      data.estado || 'OFFLINE'
    ]
  );
};

export const getPendingPolygons = async () => {
  const db = await initDB();
  return await db.getAllAsync('SELECT * FROM poligonos_cache WHERE estado = ?', ['OFFLINE']);
};

export default function DummyDatabaseRoute() { return null; }
