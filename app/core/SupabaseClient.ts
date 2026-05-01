// app/core/SupabaseClient.ts
// AgroCrop v5.1 — Supabase client for regional calibration system
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

// Lazy-init so missing env vars don't crash the app at startup
let _client: ReturnType<typeof createClient> | null = null;

function getClient() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  if (!_client) _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _client;
}

export const supabase = new Proxy({} as ReturnType<typeof createClient>, {
  get: (_t, prop) => {
    const client = getClient();
    if (!client) {
      // Return a no-op so the app works without Supabase configured
      return () => Promise.resolve({ data: null, error: new Error('Supabase not configured') });
    }
    const val = (client as any)[prop];
    return typeof val === 'function' ? val.bind(client) : val;
  },
});

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

export interface PrecisionStats {
  tipo_cultivo: string;
  total_cosechas: number;
  error_promedio_pct: number;
  mejor_prediccion_pct: number;
  peor_prediccion_pct: number;
}

// ─── Guardar calibración ──────────────────────────────────────────────────────
export async function guardarCalibracion(data: CalibracionInput): Promise<void> {
  const client = getClient();
  if (!client) throw new Error('Supabase no configurado. Agrega EXPO_PUBLIC_SUPABASE_URL y EXPO_PUBLIC_SUPABASE_ANON_KEY al .env');

  const factor = data.prediccion_total_ton > 0
    ? +(data.cosecha_real_ton / data.prediccion_total_ton).toFixed(4)
    : 1;
  const errorAbs = Math.abs(data.cosecha_real_ton - data.prediccion_total_ton);
  const errorPct = data.prediccion_total_ton > 0
    ? +((data.cosecha_real_ton - data.prediccion_total_ton) / data.prediccion_total_ton * 100).toFixed(2)
    : 0;

  const { error } = await client.from('calibraciones').insert({
    ...data,
    factor_correccion: factor,
    error_absoluto_ton: +errorAbs.toFixed(2),
    error_porcentual: errorPct,
  } as any);

  if (error) throw new Error(error.message);
}

// ─── Factor de corrección regional ───────────────────────────────────────────
export async function getFactorCorreccion(
  tipoCultivo: string,
  ndviPromedio: number,
  municipio?: string | null
): Promise<{ factor: number; muestras: number }> {
  const client = getClient();
  if (!client) return { factor: 1.0, muestras: 0 };

  try {
    let query = client
      .from('calibraciones')
      .select('factor_correccion')
      .eq('tipo_cultivo', tipoCultivo)
      .gte('ndvi_promedio', ndviPromedio - 0.1)
      .lte('ndvi_promedio', ndviPromedio + 0.1)
      .gte('factor_correccion', 0.5)
      .lte('factor_correccion', 2.0)
      .gt('cosecha_real_ton', 0);

    if (municipio) query = (query as any).eq('municipio', municipio);

    const { data } = await query;
    if (!data || data.length < 3) return { factor: 1.0, muestras: data?.length ?? 0 };

    const avg = data.reduce((s: number, r: any) => s + Number(r.factor_correccion), 0) / data.length;
    return { factor: +avg.toFixed(4), muestras: data.length };
  } catch {
    return { factor: 1.0, muestras: 0 };
  }
}

// ─── Estadísticas de precisión por cultivo ───────────────────────────────────
export async function getPrecisionStats(tipoCultivo: string): Promise<PrecisionStats | null> {
  const client = getClient();
  if (!client) return null;
  try {
    const { data } = await client
      .from('precision_por_cultivo')
      .select('*')
      .eq('tipo_cultivo', tipoCultivo)
      .single();
    return data as PrecisionStats | null;
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
  const client = getClient();
  if (!client) return null;
  try {
    const [{ data: precision }, { data: municipios }] = await Promise.all([
      client.from('precision_por_cultivo').select('*'),
      client.from('calibraciones')
        .select('municipio')
        .not('municipio', 'is', null)
        .gt('cosecha_real_ton', 0),
    ]);

    const total = (precision as any[])?.reduce((s: number, r: any) => s + Number(r.total_cosechas), 0) ?? 0;

    const muniCount: Record<string, number> = {};
    (municipios as any[])?.forEach((r: any) => {
      if (r.municipio) muniCount[r.municipio] = (muniCount[r.municipio] ?? 0) + 1;
    });
    const porMunicipio = Object.entries(muniCount)
      .map(([municipio, count]) => ({ municipio, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return { total, porCultivo: (precision as any[]) ?? [], porMunicipio };
  } catch {
    return null;
  }
}
