/**
 * GEEService.ts
 * Service layer for Google Earth Engine REST API via local backend proxy.
 * All requests route through EXPO_PUBLIC_SERVER_URL to avoid CORS and key exposure.
 */

import { buildHeaders } from './ClaudeServices';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BandIndex =
  | 'TRUE_COLOR'
  | 'FALSE_COLOR'
  | 'NDVI'
  | 'SWIR_MINERAL'
  | 'IRON_OXIDE'
  | 'CLAY_MINERALS'
  | 'FERROUS_IRON'
  // ASTER SWIR mineral indices (historical 2000-2008 imagery)
  | 'ASTER_ALUNITE'
  | 'ASTER_CALCITE'
  | 'ASTER_CHLORITE'
  // EMIT hyperspectral
  | 'EMIT_AL_CLAY'
  | 'EMIT_MG_CLAY'
  | 'EMIT_CARBONATE'
  | 'EMIT_FERRIC';

export type GEEDataset = 'SENTINEL2' | 'LANDSAT8' | 'LANDSAT9' | 'ASTER' | 'EMIT';

/** EMIT indices require dataset=EMIT */
export const EMIT_BAND_IDS: BandIndex[] = ['EMIT_AL_CLAY', 'EMIT_MG_CLAY', 'EMIT_CARBONATE', 'EMIT_FERRIC'];

/** Multispectral indices compatible with Sentinel-2, Landsat 8/9, and ASTER VNIR */
export const MULTISPECTRAL_BAND_IDS: BandIndex[] = ['TRUE_COLOR', 'FALSE_COLOR', 'NDVI', 'SWIR_MINERAL', 'IRON_OXIDE', 'CLAY_MINERALS', 'FERROUS_IRON'];

/** ASTER-specific SWIR mineral indices (require historical data 2000-2008) */
export const ASTER_EXTRA_BAND_IDS: BandIndex[] = ['ASTER_ALUNITE', 'ASTER_CALCITE', 'ASTER_CHLORITE'];

/**
 * Indices available for ASTER:
 *  - VNIR-only (recent imagery): TRUE_COLOR, FALSE_COLOR, NDVI, IRON_OXIDE
 *  - SWIR historical (2000-2008): ASTER_ALUNITE, ASTER_CALCITE, ASTER_CHLORITE
 * NOTE: CLAY_MINERALS, FERROUS_IRON, SWIR_MINERAL need SWIR which failed in 2008.
 */
export const ASTER_BAND_IDS: BandIndex[] = [
  'TRUE_COLOR', 'FALSE_COLOR', 'NDVI', 'IRON_OXIDE',
  'ASTER_ALUNITE', 'ASTER_CALCITE', 'ASTER_CHLORITE',
];

export interface BandConfig {
  id: BandIndex;
  label: string;
  shortLabel: string;
  description: string;
  mineralUse: string;
  icon: string; // MaterialCommunityIcons name
  gradientColors: string[];
  gradientLabels: string[];
}

export interface GEETileConfig {
  tileUrl: string;
  mapId: string;
  legend: { color: string; label: string }[];
  bandDescription: string;
  mineralApplication: string;
  acquisitionDate: string;
  cloudCover: number;
  /** Estimated date of next satellite pass (acquisitionDate + revisit period). Null for EMIT. */
  nextPassDate: string | null;
  expiresAt: number;
}

export interface GEEPixelValues {
  bandValues: Record<string, number>;
  computedIndex: number;
}

// ---------------------------------------------------------------------------
// Band configurations — descriptions in Spanish, focused on mineral prospecting
// ---------------------------------------------------------------------------

export const BAND_CONFIGS: Record<BandIndex, BandConfig> = {
  TRUE_COLOR: {
    id: 'TRUE_COLOR',
    label: 'Color Verdadero',
    shortLabel: 'RGB',
    description:
      'Composición RGB estándar. Para ASTER usa NIR-Rojo-Verde (sin banda azul) mostrando vegetación en rojo.',
    mineralUse:
      'Referencia visual de base. Útil para identificar afloramientos rocosos, vegetación escasa y zonas de alteración superficial visibles.',
    icon: 'eye-outline',
    gradientColors: ['#1A6B1A', '#7EC850', '#D4C27A', '#A0785A', '#6B3A2A'],
    gradientLabels: ['Vegetación densa', 'Vegetación dispersa', 'Suelo desnudo', 'Roca expuesta', 'Alteración visible'],
  },
  FALSE_COLOR: {
    id: 'FALSE_COLOR',
    label: 'Falso Color (IRC)',
    shortLabel: 'IRC',
    description:
      'Infrarrojo cercano (NIR) combinado con Rojo y Verde. Las áreas con vegetación sana aparecen en rojo intenso; los minerales y rocas en tonos azul-cian.',
    mineralUse:
      'Discriminación rápida entre cobertura vegetal y afloramientos rocosos. Zonas sin cobertura con tonos fríos sugieren litología desnuda prospectable.',
    icon: 'layers',
    gradientColors: ['#FF0000', '#FF8800', '#FFFF00', '#00CCFF', '#0000FF'],
    gradientLabels: ['Vegetación vigorosa', 'Vegetación escasa', 'Suelo húmedo', 'Roca sedimentaria', 'Roca ígnea/metamórfica'],
  },
  NDVI: {
    id: 'NDVI',
    label: 'NDVI — Índice Vegetal',
    shortLabel: 'NDVI',
    description:
      'Índice de Diferencia Normalizada de Vegetación (NIR-Rojo)/(NIR+Rojo). Valores altos = vegetación sana. Valores bajos o negativos = roca, suelo, agua.',
    mineralUse:
      'Zonas de NDVI anómalamente bajo en áreas donde debería haber vegetación pueden indicar suelos tóxicos por mineralización (halo geoquímico). Delimita afloramientos.',
    icon: 'leaf',
    gradientColors: ['#8B0000', '#FF4400', '#FFDD00', '#88DD00', '#006600'],
    gradientLabels: ['Sin vegetación (-1 a 0)', 'Muy escasa (0–0.1)', 'Moderada (0.1–0.3)', 'Densa (0.3–0.6)', 'Muy densa (0.6–1)'],
  },
  SWIR_MINERAL: {
    id: 'SWIR_MINERAL',
    label: 'SWIR Mineralización',
    shortLabel: 'SWIR',
    description:
      'Bandas del Infrarrojo de Onda Corta (SWIR1 + SWIR2). Penetra cobertura vegetal ligera y es sensible a minerales arcillosos, hidrotermales y sulfuros.',
    mineralUse:
      'Detección de zonas de alteración hidrotermal, arcillas propilíticas y serícitas. Fundamental en exploración de pórfidos de cobre, epitermal de oro y plata.',
    icon: 'terrain',
    gradientColors: ['#000033', '#003366', '#006699', '#00AACC', '#FFEEAA'],
    gradientLabels: ['Sin respuesta SWIR', 'Respuesta baja', 'Alteración moderada', 'Alteración intensa', 'Mineralización activa'],
  },
  IRON_OXIDE: {
    id: 'IRON_OXIDE',
    label: 'Óxidos de Hierro',
    shortLabel: 'Fe-Ox',
    description:
      'Cociente de bandas Rojo/Verde-Azul. Sensible a minerales de Fe: goethita, limonita, hematita y jarosita que tiñen la roca de pardo-rojizo.',
    mineralUse:
      'Mapeo de gossan (sombrero de hierro), halos de oxidación de sulfuros masivos, zonas de lixiviación. Guía directa a depósitos de oro, plata, cobre y polimetálicos.',
    icon: 'magnet',
    gradientColors: ['#1A1A1A', '#4A2000', '#993300', '#FF6600', '#FFD700'],
    gradientLabels: ['Sin óxidos', 'Trazas Fe', 'Limonita', 'Goethita/Hematita', 'Gossan intenso'],
  },
  CLAY_MINERALS: {
    id: 'CLAY_MINERALS',
    label: 'Minerales Arcillosos',
    shortLabel: 'Arcillas',
    description:
      'Cociente SWIR2/SWIR1 optimizado para respuesta de alunita, caolinita, illita y muscovita. Resalta zonas de alteración argílica y serícita.',
    mineralUse:
      'Identificación de halos de alteración argílica avanzada (ALS) y propilítica alrededor de centros hidrotermales. Clave en sistemas epitermales y pórfidos.',
    icon: 'layers',
    gradientColors: ['#1A0D00', '#4D3319', '#997755', '#CCBB88', '#FFEEDD'],
    gradientLabels: ['Sin arcillas', 'Arcillas traza', 'Arcillas moderadas', 'Arcillas abundantes', 'Alteración argílica intensa'],
  },
  FERROUS_IRON: {
    id: 'FERROUS_IRON',
    label: 'Hierro Ferroso (Fe²⁺)',
    shortLabel: 'Fe²⁺',
    description:
      'Cociente NIR/SWIR1. Sensible al hierro ferroso en silicatos máficos como olivino, piroxeno y anfíbol. Distingue ferroso de férrico.',
    mineralUse:
      'Mapeo de rocas máficas y ultramáficas (fuentes de Ni, Co, Cr, PGE). Delimita intrusivos básicos y zonas de serpentinización con potencial para minerales estratégicos.',
    icon: 'water',
    gradientColors: ['#000022', '#001144', '#003388', '#2266CC', '#88AAFF'],
    gradientLabels: ['Sin Fe²⁺', 'Fe²⁺ traza', 'Fe²⁺ moderado', 'Rocas máficas', 'Ultramáficas/Serpentinita'],
  },

  // ── ASTER SWIR mineral indices (histórico 2000-2008) ────────────────────────
  ASTER_ALUNITE: {
    id: 'ASTER_ALUNITE',
    label: 'ASTER — Alunita/Caolinita',
    shortLabel: 'Al-OH',
    description:
      'Profundidad de banda Al-OH a 2200 nm: 1 − B06/(B05+B07)/2. Detecta alunita, caolinita, moscovita y pirofilita. 30 m · ASTER SWIR · Datos históricos 2000-2008.',
    mineralUse:
      'Guía a epitermales de alta sulfidación (Au-Ag) y halos de alteración argílica avanzada (ALS) en pórfidos de Cu. Mayor resolución espacial que EMIT en zonas históricamente mapeadas.',
    icon: 'grain',
    gradientColors: ['#1A0A00', '#4D2500', '#996633', '#DDAA44', '#FFFFCC'],
    gradientLabels: ['Sin Al-OH', 'Trazas caolinita', 'Caolinita moderada', 'Caolinita/Alunita', 'Alt. argílica (ALS)'],
  },
  ASTER_CALCITE: {
    id: 'ASTER_CALCITE',
    label: 'ASTER — Carbonatos',
    shortLabel: 'CO₃',
    description:
      'Profundidad de banda CO₃ a 2350 nm: 1 − B08/(B06+B09)/2. Detecta calcita, dolomita y magnesita. 30 m · ASTER SWIR · Datos históricos 2000-2008.',
    mineralUse:
      'Clave para skarns (Fe, Cu, Au, W), carbonatitas (REE, Nb) y carbonatización hidrotermal en epitermales. Delimita aureolas metasomáticas calcáreas.',
    icon: 'layers-outline',
    gradientColors: ['#00001A', '#001144', '#003388', '#3366CC', '#AACCFF'],
    gradientLabels: ['Sin carbonatos', 'Trazas calcita', 'Carbonatos mod.', 'Carbonatización', 'Skarn/Carbonatita'],
  },
  ASTER_CHLORITE: {
    id: 'ASTER_CHLORITE',
    label: 'ASTER — Clorita/Serpentina',
    shortLabel: 'Mg-OH',
    description:
      'Profundidad de banda Mg-OH a 2300 nm: 1 − B08/(B07+B09)/2. Detecta clorita, serpentina y talco. 30 m · ASTER SWIR · Datos históricos 2000-2008.',
    mineralUse:
      'Indica alteración propilítica en pórfidos Cu-Mo y rocas ultramáficas con potencial de Ni, Co, Cr y PGE. Delimita zonas de serpentinización.',
    icon: 'water',
    gradientColors: ['#001A00', '#00331A', '#006633', '#00AA55', '#AAFFCC'],
    gradientLabels: ['Sin Mg-OH', 'Trazas clorita', 'Clorita moderada', 'Clorita/Serpentina', 'Alt. propilítica'],
  },

  // ── EMIT hyperspectral (NASA/ISS · 285 bandas · 60 m) ─────────────────────
  EMIT_AL_CLAY: {
    id: 'EMIT_AL_CLAY',
    label: 'EMIT — Arcillas Al-OH',
    shortLabel: 'Al-OH',
    description:
      'Profundidad de banda a 2200 nm. Detecta absorción de Al-OH en caolinita, alunita, moscovita y pirofilita con resolución espectral de 7 nm.',
    mineralUse:
      'Guía a epitermales de alta sulfidación (Au-Ag) y halos de alteración argílica avanzada (ALS) en pórfidos de Cu. 60 m · ISS · 2022–presente.',
    icon: 'grain',
    gradientColors: ['#1A0A00', '#4D2500', '#996633', '#DDAA44', '#FFFFCC'],
    gradientLabels: ['Sin Al-OH', 'Trazas caolinita', 'Caolinita moderada', 'Caolinita/Alunita', 'Alt. argílica (ALS)'],
  },
  EMIT_MG_CLAY: {
    id: 'EMIT_MG_CLAY',
    label: 'EMIT — Arcillas Mg-OH',
    shortLabel: 'Mg-OH',
    description:
      'Profundidad de banda a 2300 nm. Detecta absorción de Mg-OH en clorita, serpentina, talco y tremolita.',
    mineralUse:
      'Indica alteración propilítica en pórfidos Cu-Mo y rocas ultramáficas con potencial de Ni, Cr, Co y PGE. 60 m · ISS · 2022–presente.',
    icon: 'water',
    gradientColors: ['#001A00', '#00331A', '#006633', '#00AA55', '#AAFFCC'],
    gradientLabels: ['Sin Mg-OH', 'Trazas clorita', 'Clorita moderada', 'Clorita/Serpentina', 'Alt. propilítica'],
  },
  EMIT_CARBONATE: {
    id: 'EMIT_CARBONATE',
    label: 'EMIT — Carbonatos',
    shortLabel: 'CO₃',
    description:
      'Profundidad de banda a 2350 nm. Detecta la absorción CO₃²⁻ de calcita, dolomita y magnesita.',
    mineralUse:
      'Clave para skarns (Fe, Cu, Au, W), carbonatitas (REE, Nb) y carbonatización hidrotermal en epitermales. 60 m · ISS · 2022–presente.',
    icon: 'layers-outline',
    gradientColors: ['#00001A', '#001144', '#003388', '#3366CC', '#AACCFF'],
    gradientLabels: ['Sin carbonatos', 'Trazas calcita', 'Carbonatos mod.', 'Carbonatización', 'Skarn/Carbonatita'],
  },
  EMIT_FERRIC: {
    id: 'EMIT_FERRIC',
    label: 'EMIT — Fe³⁺ Hiperespectral',
    shortLabel: 'Fe³⁺',
    description:
      'Profundidad de banda a 870 nm (campo cristalino Fe³⁺). Mayor sensibilidad que Sentinel-2 para hematita, goethita y jarosita.',
    mineralUse:
      'Localiza gossanes y halos de oxidación sobre depósitos de sulfuros (Cu, Au, Ag, Zn) con precisión subpixel. 60 m · ISS · 2022–presente.',
    icon: 'fire',
    gradientColors: ['#1A0000', '#550000', '#AA2200', '#FF5500', '#FFCC00'],
    gradientLabels: ['Sin Fe³⁺', 'Fe³⁺ traza', 'Goethita/Limonita', 'Hematita abundante', 'Gossan intenso'],
  },
};

// ---------------------------------------------------------------------------
// Dataset metadata
// ---------------------------------------------------------------------------

export const DATASET_LABELS: Record<
  GEEDataset,
  { label: string; resolution: string; revisit: string }
> = {
  SENTINEL2: {
    label: 'Sentinel-2',
    resolution: '10 m',
    revisit: '5 días',
  },
  LANDSAT8: {
    label: 'Landsat 8',
    resolution: '30 m',
    revisit: '16 días',
  },
  LANDSAT9: {
    label: 'Landsat 9',
    resolution: '30 m',
    revisit: '16 días',
  },
  ASTER: {
    label: 'ASTER',
    resolution: '15-30 m',
    revisit: '16 días',
  },
  EMIT: {
    label: 'EMIT Hiperespectral',
    resolution: '60 m',
    revisit: 'ISS',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GEE_SERVER_FALLBACK = 'https://prospector-gee-server-production.up.railway.app';

function getServerUrl(): string {
  const url = process.env.EXPO_PUBLIC_SERVER_URL;
  if (!url || url === 'undefined') {
    console.warn(`[GEEService] EXPO_PUBLIC_SERVER_URL vacía, usando fallback: ${GEE_SERVER_FALLBACK}`);
    return GEE_SERVER_FALLBACK;
  }
  return url.replace(/\/$/, '');
}

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number = 30000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

export type EstadoConexion = 'conectado' | 'sin_autorizacion' | 'sin_conexion';

/**
 * Ping real al servidor. NO usa /health a propósito: /health está fuera del
 * control de acceso, así que responde 200 aunque el token sea inválido — diría
 * "conectado" mientras todo lo demás falla con 401.
 *
 * En su lugar pega a /api/gee/tiles sin parámetros: el servidor valida el token
 * antes que los parámetros, así que 400 significa "pasé la autenticación" sin
 * llegar a consultar Earth Engine. Es barato y sí distingue los tres estados.
 */
export async function verificarConexion(timeoutMs = 8000): Promise<EstadoConexion> {
  try {
    const response = await fetchWithTimeout(
      `${getServerUrl()}/api/gee/tiles`,
      { method: 'GET', headers: buildHeaders() },
      timeoutMs
    );
    if (response.status === 401 || response.status === 403) return 'sin_autorizacion';
    return 'conectado';
  } catch {
    return 'sin_conexion';
  }
}

function buildQueryString(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && String(v) !== 'undefined' && String(v) !== 'null')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

async function geeGet<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const base = getServerUrl();
  const qs = buildQueryString(params);
  const url = `${base}${path}?${qs}`;

  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: buildHeaders(),
    }, 60000);
  } catch (networkErr: any) {
    const reason = networkErr.name === 'AbortError' ? 'Timeout 30s' : networkErr.message;
    throw new Error(
      `[GEE GET] Fallo de red → ${url} | ${reason}`
    );
  }

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error || body?.message || JSON.stringify(body);
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new Error(
      `Error del servidor GEE [${response.status}]: ${detail || response.statusText}`
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error('Respuesta inválida del servidor GEE: no es JSON válido.');
  }
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

/**
 * Fetches a tile configuration from the backend proxy.
 * Omit dateStart/dateEnd to use auto-latest mode (most recent cloud-free image).
 */
export async function getGEETileConfig(
  lat: number,
  lng: number,
  index: BandIndex,
  dataset: GEEDataset,
  dateStart?: string,
  dateEnd?: string,
  maxCloud?: number
): Promise<GEETileConfig> {
  const data = await geeGet<GEETileConfig>('/api/gee/tiles', {
    lat,
    lng,
    index,
    dataset,
    ...(dateStart ? { dateStart } : {}),
    ...(dateEnd   ? { dateEnd   } : {}),
    ...(maxCloud != null ? { maxCloud } : {}),
  });

  if (!data.tileUrl) {
    throw new Error(
      'El servidor no retornó una URL de tiles válida. ' +
        'Verifica la configuración del backend GEE.'
    );
  }

  return data;
}

/**
 * Fetches pixel-level spectral values at the given coordinate.
 * Omit dateStart/dateEnd to use auto-latest mode.
 */
export async function getGEEPixelValues(
  lat: number,
  lng: number,
  index: BandIndex,
  dataset: GEEDataset,
  dateStart?: string,
  dateEnd?: string
): Promise<GEEPixelValues> {
  const data = await geeGet<GEEPixelValues>('/api/gee/pixels', {
    lat,
    lng,
    index,
    dataset,
    ...(dateStart ? { dateStart } : {}),
    ...(dateEnd   ? { dateEnd   } : {}),
  });

  if (data.computedIndex === undefined || data.computedIndex === null) {
    throw new Error('El servidor no retornó valores de píxel válidos para esta zona y fecha.');
  }

  return data;
}

// ---------------------------------------------------------------------------
// Biomass / AgroCrop analysis
// ---------------------------------------------------------------------------

export interface BiomassAnalysisResult {
  success: boolean;
  ndvi_mean: number;
  evi_mean: number;
  ndre_mean: number;
  lswi_mean: number;
  ndvi_stdDev: number;
  ndvi_p25: number;
  ndvi_p50: number;
  ndvi_p75: number;
  hectareas_cultivo_activo: number;
  hectareas_area_optima: number;
  porcentaje_area_optima: number;
  clasificacion_vigor: string;
  tonelaje_estimado: number;
  tonelaje_minimo: number;
  tonelaje_maximo: number;
  rendimiento_por_hectarea: number;
  factor_ndvi: number;
  factor_ndre: number;
  factor_etapa?: number;
  rendimiento_base?: number;
  tipo_cultivo?: string;
  tipo_cultivo_label?: string;
  mango?: {
    arboles_estimados: number;
    frutos_por_arbol: number;
    valor_cosecha_mxn: number;
  };
  fecha_imagen: string;
  imagenes_usadas: number;
  fecha_inicio: string;
  fecha_fin: string;
  fuentes_satelitales?: {
    sentinel2:  { fecha: string; imagenes: number };
    landsat89:  { fecha: string; imagenes: number };
    sentinel1:  { fecha: string; imagenes: number; tipo: string };
    modis:      { fecha: string; imagenes: number };
    smap:       { fecha: string; imagenes: number; humedad_suelo_pct: number };
  };
  indices_fusionados?: {
    ndvi_s2: number;
    ndvi_landsat: number;
    rvi_radar: number;
    modis_ndvi: number;
    soil_moisture_smap: number;
  };
  imagen_mas_reciente_global?: string;
  frescura_dias?: number;
  confianza_fusion?: string;
  confianza_temporal?: string;
  etapa_fenologica?: string;
  margen_incertidumbre?: string;
  metodo_composicion?: string;
  frescura?: {
    fecha_imagen: string;
    satelite_mas_reciente: string;
    dias_atras: number;
    calidad: string;
    num_imagenes_usadas: number;
    ventana_dias: number;
    por_satelite: {
      S2: { fecha: string; dias_atras: number | null; imagenes: number };
      L9: { fecha: string; dias_atras: number | null; imagenes: number };
      S1: { fecha: string; dias_atras: number | null; imagenes: number };
    };
  };
  proyeccion?: {
    ton_ha: number;
    tonelaje_proyectado: number;
    incremento_pct: number;
    rango_min: number;
    rango_max: number;
    confianza: string;
    fecha_cosecha: string;
    dias_a_cosecha: number;
  };
  clima_local?: {
    temp_max_c: number | null;
    precip_mm: number | null;
    fuente: string;
  };
}

/**
 * Sends a polygon to the backend for crop biomass analysis using Sentinel-2.
 * @param coordinates [[lng,lat], ...] polygon ring
 * @param fecha_inicio YYYY-MM-DD
 * @param fecha_fin YYYY-MM-DD
 */
export async function getBiomassAnalysis(
  coordinates: number[][],
  fecha_inicio: string,
  fecha_fin: string,
  tipo_cultivo: string = 'maiz_riego'
): Promise<BiomassAnalysisResult> {
  const base = getServerUrl();
  const url = `${base}/api/biomass-analysis`;

  console.log(`[GEEService] POST biomass-analysis → ${url} (${tipo_cultivo})`);
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ coordinates, fecha_inicio, fecha_fin, tipo_cultivo }),
    }, 90000);
  } catch (networkErr: any) {
    const reason = networkErr.name === 'AbortError' ? 'Timeout 90s' : networkErr.message;
    throw new Error(
      `[GEE POST] Fallo de red → ${url} | ${reason}`
    );
  }

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error || JSON.stringify(body);
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new Error(`[GEE POST ${response.status}] ${url} | ${detail || response.statusText}`);
  }

  return (await response.json()) as BiomassAnalysisResult;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Biomass extended (SAR + MODIS + SMAP — background)
// ---------------------------------------------------------------------------

export interface BiomassExtendedResult {
  success: boolean;
  sentinel1: { fecha: string; imagenes: number; tipo: string; rvi: number };
  modis:     { fecha: string; imagenes: number; ndvi: number };
  smap:      { fecha: string; imagenes: number; humedad_suelo_pct: number };
}

export async function getBiomassExtended(
  coordinates: number[][],
  fecha_inicio: string,
  fecha_fin: string
): Promise<BiomassExtendedResult> {
  const base = getServerUrl();
  const url = `${base}/api/biomass-analysis-extended`;

  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ coordinates, fecha_inicio, fecha_fin }),
    }, 180000);
  } catch (networkErr: any) {
    const reason = networkErr.name === 'AbortError' ? 'Timeout 180s' : networkErr.message;
    throw new Error(`[GEE extended] ${reason}`);
  }

  if (!response.ok) {
    let detail = '';
    try { const b = await response.json(); detail = b?.error || ''; } catch {}
    throw new Error(`[GEE extended ${response.status}] ${detail}`);
  }

  return (await response.json()) as BiomassExtendedResult;
}

// ---------------------------------------------------------------------------
// Biomass grid (heatmap)
// ---------------------------------------------------------------------------

export interface GridCell {
  lat: number;
  lng: number;
  ndvi: number;
  evi: number;
  ndre: number;
  hectareas: number;
  tonelaje_estimado: number;
  rendimiento_ton_ha: number;
  vigor: string;
  color_hex: string;
}

export interface BiomassGridResult {
  success: boolean;
  grid: GridCell[];
  total_celdas: number;
  celdas_con_cultivo: number;
  cell_size_km: number;
  cell_size_m?: number;
  ha_por_celda?: number;
  area_km2?: number;
  resumen: {
    tonelaje_total: number;
    hectareas_con_cultivo: number;
    rendimiento_promedio: number;
    fecha_inicio: string;
    fecha_fin: string;
    imagenes_usadas: number;
  };
}

/**
 * Fetches per-cell grid biomass data for heatmap overlay.
 */
export async function getBiomassGrid(
  coordinates: number[][],
  fecha_inicio: string,
  fecha_fin: string,
  cell_size_km?: number          // undefined → servidor calcula automático por área
): Promise<BiomassGridResult> {
  const base = getServerUrl();
  const url = `${base}/api/biomass-grid`;

  // Solo incluir cell_size_km si se pasa explícitamente
  // (JSON.stringify omite undefined — evita sobreescribir el cálculo automático)
  const reqBody: Record<string, unknown> = { coordinates, fecha_inicio, fecha_fin };
  if (cell_size_km !== undefined) reqBody.cell_size_km = cell_size_km;

  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(reqBody),
    }, 60000);
  } catch (networkErr: any) {
    const reason = networkErr.name === 'AbortError' ? 'Timeout 30s' : networkErr.message;
    throw new Error(
      `[GEE POST grid] Fallo de red → ${url} | ${reason}`
    );
  }

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error || JSON.stringify(body);
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new Error(`Error del servidor GEE [${response.status}]: ${detail || response.statusText}`);
  }

  return (await response.json()) as BiomassGridResult;
}

/**
 * Generates a circular polygon (approximation) around a center point.
 * @param lat Center latitude
 * @param lng Center longitude
 * @param radiusKm Radius in kilometers
 * @param points Number of polygon vertices (default 32)
 * @returns [[lng,lat], ...] ring suitable for GEE Polygon
 */
export function generateCirclePolygon(
  lat: number,
  lng: number,
  radiusKm: number,
  points: number = 32
): number[][] {
  const coords: number[][] = [];
  for (let i = 0; i < points; i++) {
    const angle = (2 * Math.PI * i) / points;
    const dLat = (radiusKm / 111.32) * Math.cos(angle);
    const dLng = (radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(angle);
    coords.push([lng + dLng, lat + dLat]);
  }
  coords.push(coords[0]); // close the ring
  console.log(`[generateCirclePolygon] Centro: lat ${lat} lng ${lng} | Radio: ${radiusKm} km | Vértices: ${points} | Primer punto: [${coords[0][0].toFixed(5)}, ${coords[0][1].toFixed(5)}] | Último: [${coords[coords.length - 2][0].toFixed(5)}, ${coords[coords.length - 2][1].toFixed(5)}]`);
  return coords;
}

/**
 * Returns a dynamic date range ending today.
 * Kept for backward compatibility with polygon analysis.
 */
export function getDefaultDateRange(daysBack = 90): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - daysBack);
  const fmt = (d: Date): string => d.toISOString().split('T')[0];
  return { start: fmt(start), end: fmt(end) };
}
