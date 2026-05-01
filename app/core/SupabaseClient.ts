// app/core/SupabaseClient.ts
// AgroCrop v5.2 — Calibración local (Supabase pausado)
// Para activar la nube: SUPABASE_ENABLED = true

import AsyncStorage from '@react-native-async-storage/async-storage';
// import { createClient } from '@supabase/supabase-js';  // deshabilitado temporalmente

const SUPABASE_ENABLED = false; // ← cambiar a true cuando Supabase esté activo

// ─── Supabase (deshabilitado) ─────────────────────────────────────────────────
// const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
// const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
// let _client: ReturnType<typeof createClient> | null = null;
// function getClient() {
//   if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
//   if (!_client) _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
//   return _client;
// }

// No-op proxy — mantiene compatibilidad con imports de `supabase` en otros módulos
export const supabase = new Proxy({} as any, {
  get: () => () => Promise.resolve({ data: null, error: new Error('Supabase deshabilitado') }),
});

// ─── AsyncStorage key ─────────────────────────────────────────────────────────
const STORAGE_KEY = 'calibraciones_local';

// ─── Types ────────────────────────────────────────────────────────────────────
export interface CalibracionInput {
  parcela_id?: string;
  ndvi_promedio: number;
  evi_promedio?: number;
  ndre_promedio?: number;
  prediccion_ton_ha: number;
  prediccion_total_ton: number;
  fecha_imagen_satelital?: string;
  fecha_cosecha: string;          // YYYY-MM-DD
  cosecha_real_ton: number;
  rendimiento_real_ton_ha: number;
  precio_venta_mxn?: number;
  tipo_cultivo: string;
  variedad?: string;
  municipio?: string;
  sistema_riego?: string;
}

interface CalibracionStored extends CalibracionInput {
  id: string;
  factor_correccion: number;
  error_absoluto_ton: number;
  error_porcentual: number;
  creado_en: string;
}

export interface PrecisionStats {
  tipo_cultivo: string;
  total_cosechas: number;
  error_promedio_pct: number;
  mejor_prediccion_pct: number;
  peor_prediccion_pct: number;
}

// ─── Helpers AsyncStorage ─────────────────────────────────────────────────────
async function leerLocal(): Promise<CalibracionStored[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function escribirLocal(rows: CalibracionStored[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
}

// ─── Guardar calibración ──────────────────────────────────────────────────────
export async function guardarCalibracion(data: CalibracionInput): Promise<void> {
  const factor = data.prediccion_total_ton > 0
    ? +(data.cosecha_real_ton / data.prediccion_total_ton).toFixed(4)
    : 1;
  const errorAbs = Math.abs(data.cosecha_real_ton - data.prediccion_total_ton);
  const errorPct = data.prediccion_total_ton > 0
    ? +((data.cosecha_real_ton - data.prediccion_total_ton) / data.prediccion_total_ton * 100).toFixed(2)
    : 0;

  if (SUPABASE_ENABLED) {
    // TODO: restaurar lógica Supabase cuando SUPABASE_ENABLED = true
    throw new Error('Supabase no implementado aún en este bloque');
  }

  // Guardar en AsyncStorage local
  const rows = await leerLocal();
  const nueva: CalibracionStored = {
    ...data,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    factor_correccion: factor,
    error_absoluto_ton: +errorAbs.toFixed(2),
    error_porcentual: errorPct,
    creado_en: new Date().toISOString(),
  };
  rows.push(nueva);
  await escribirLocal(rows);
}

// ─── Factor de corrección local ───────────────────────────────────────────────
export async function getFactorCorreccion(
  tipoCultivo: string,
  ndviPromedio: number,
  municipio?: string | null
): Promise<{ factor: number; muestras: number }> {
  try {
    const rows = await leerLocal();

    const filtradas = rows.filter(r =>
      r.tipo_cultivo === tipoCultivo &&
      r.cosecha_real_ton > 0 &&
      r.factor_correccion >= 0.5 &&
      r.factor_correccion <= 2.0 &&
      Math.abs(r.ndvi_promedio - ndviPromedio) <= 0.1 &&
      (municipio ? r.municipio === municipio : true)
    );

    if (filtradas.length < 3) return { factor: 1.0, muestras: filtradas.length };

    const avg = filtradas.reduce((s, r) => s + r.factor_correccion, 0) / filtradas.length;
    return { factor: +avg.toFixed(4), muestras: filtradas.length };
  } catch {
    return { factor: 1.0, muestras: 0 };
  }
}

// ─── Estadísticas de precisión por cultivo ───────────────────────────────────
export async function getPrecisionStats(tipoCultivo: string): Promise<PrecisionStats | null> {
  try {
    const rows = await leerLocal();
    const filtradas = rows.filter(r => r.tipo_cultivo === tipoCultivo && r.cosecha_real_ton > 0);
    if (filtradas.length === 0) return null;

    const errores = filtradas.map(r => Math.abs(r.error_porcentual));
    return {
      tipo_cultivo: tipoCultivo,
      total_cosechas: filtradas.length,
      error_promedio_pct: +(errores.reduce((s, e) => s + e, 0) / errores.length).toFixed(1),
      mejor_prediccion_pct: +Math.min(...errores).toFixed(1),
      peor_prediccion_pct: +Math.max(...errores).toFixed(1),
    };
  } catch {
    return null;
  }
}

// ─── Dashboard admin ─────────────────────────────────────────────────────────
export async function getAdminStats(): Promise<{
  total: number;
  porCultivo: { tipo_cultivo: string; total_cosechas: number; error_promedio_pct: number }[];
  porMunicipio: { municipio: string; count: number }[];
} | null> {
  try {
    const rows = await leerLocal();
    if (rows.length === 0) return { total: 0, porCultivo: [], porMunicipio: [] };

    // Agrupar por cultivo
    const cultivoMap: Record<string, { errores: number[]; count: number }> = {};
    rows.forEach(r => {
      if (!cultivoMap[r.tipo_cultivo]) cultivoMap[r.tipo_cultivo] = { errores: [], count: 0 };
      cultivoMap[r.tipo_cultivo].errores.push(Math.abs(r.error_porcentual));
      cultivoMap[r.tipo_cultivo].count++;
    });
    const porCultivo = Object.entries(cultivoMap).map(([tipo_cultivo, v]) => ({
      tipo_cultivo,
      total_cosechas: v.count,
      error_promedio_pct: +(v.errores.reduce((s, e) => s + e, 0) / v.errores.length).toFixed(1),
    }));

    // Agrupar por municipio
    const muniMap: Record<string, number> = {};
    rows.forEach(r => { if (r.municipio) muniMap[r.municipio] = (muniMap[r.municipio] ?? 0) + 1; });
    const porMunicipio = Object.entries(muniMap)
      .map(([municipio, count]) => ({ municipio, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return { total: rows.length, porCultivo, porMunicipio };
  } catch {
    return null;
  }
}
