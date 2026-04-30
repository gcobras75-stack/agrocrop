'use strict';
/**
 * gee.js — AgroCrop v4.4
 * Google Earth Engine logic: autenticación, composición multi-satélite,
 * índices espectrales por cultivo y análisis de biomasa/rendimiento.
 *
 * Novedades v4.4:
 *   - Ventana dinámica S2: 30→60→90 días hasta ≥3 imágenes sin nubes
 *   - satelitesPorCultivo: config de satélites e índices por tipo de cultivo
 *   - Nuevos índices: NDWI (B8A/B11), SAVI, VHI (MODIS LST), RVI (SAR)
 *   - Promise.allSettled: Landsat + SAR + VHI en paralelo
 *   - Respuesta extendida: frescura, satelites_activos, indices_calculados
 */

const ee = require('@google/earthengine');

// ---------------------------------------------------------------------------
// Dataset config
// ---------------------------------------------------------------------------

const COLLECTION_IDS = {
  SENTINEL2: 'COPERNICUS/S2_SR_HARMONIZED',
  LANDSAT8:  'LANDSAT/LC08/C02/T1_L2',
  LANDSAT9:  'LANDSAT/LC09/C02/T1_L2',
  ASTER:     'ASTER/AST_L1T_003',
  EMIT:      'NASA/EMIT/L2A/RFL',
};

const CLOUD_PROP = {
  SENTINEL2: 'CLOUDY_PIXEL_PERCENTAGE',
  LANDSAT8:  'CLOUD_COVER',
  LANDSAT9:  'CLOUD_COVER',
  ASTER:     'CLOUDCOVER',
  EMIT:      null,
};

// Logical band names → actual GEE band names per dataset
const BANDS = {
  SENTINEL2: { blue: 'B2', green: 'B3', red: 'B4', nir: 'B8',    swir1: 'B11', swir2: 'B12' },
  LANDSAT8:  { blue: 'SR_B2', green: 'SR_B3', red: 'SR_B4', nir: 'SR_B5', swir1: 'SR_B6', swir2: 'SR_B7' },
  LANDSAT9:  { blue: 'SR_B2', green: 'SR_B3', red: 'SR_B4', nir: 'SR_B5', swir1: 'SR_B6', swir2: 'SR_B7' },
  // ASTER L1T · VNIR: B01 (0.52-0.60μm), B02 (0.63-0.69μm), B3N (0.76-0.86μm) · 15 m
  // ASTER SWIR: B04-B09 (1.60-2.43μm) · 30 m · NOTE: SWIR detector failed April 2008;
  //   for recent imagery only VNIR bands are valid.
  ASTER: {
    blue:     'B01',  // green 0.52-0.60μm (used as pseudo-blue — no blue band in ASTER)
    green:    'B01',  // green 0.52-0.60μm
    red:      'B02',  // red 0.63-0.69μm
    nir:      'B3N',  // NIR 0.76-0.86μm
    swir1:    'B04',  // 1.60-1.70μm ≈ Landsat SWIR1
    swir2:    'B06',  // 2.185-2.225μm — Al-OH absorption (used as SWIR2 for clay mapping)
    // Extra SWIR bands for ASTER mineral indices
    b05:      'B05',  // 2.145-2.185μm
    b07:      'B07',  // 2.235-2.285μm
    b08:      'B08',  // 2.295-2.365μm
    b09:      'B09',  // 2.360-2.430μm
  },
  // EMIT L2A: 285 bands from ~381 nm to ~2493 nm (spacing ≈7.44 nm/band)
  EMIT: {
    r660:  'reflectance_39',
    r770:  'reflectance_53',
    r870:  'reflectance_67',
    r1000: 'reflectance_84',
    r2100: 'reflectance_232',
    r2200: 'reflectance_246',
    r2250: 'reflectance_252',
    r2300: 'reflectance_259',
    r2350: 'reflectance_266',
    r2400: 'reflectance_273',
    r2450: 'reflectance_279',
  },
};

const SPATIAL_RESOLUTION = { SENTINEL2: 10, LANDSAT8: 30, LANDSAT9: 30, ASTER: 30, EMIT: 60 };

// Approximate satellite revisit period in days (used to estimate next pass date)
const REVISIT_DAYS = { SENTINEL2: 5, LANDSAT8: 16, LANDSAT9: 16, ASTER: 16, EMIT: null };

// ASTER SWIR bands failed April 2008 — indices using B04-B09 require historical imagery
const ASTER_SWIR_INDEXES = ['ASTER_ALUNITE', 'ASTER_CALCITE', 'ASTER_CHLORITE'];

// ---------------------------------------------------------------------------
// Static legend / description metadata (mirrors client BAND_CONFIGS)
// ---------------------------------------------------------------------------

const BAND_META = {
  TRUE_COLOR: {
    legend: [
      { color: '#1A6B1A', label: 'Vegetación densa' },
      { color: '#7EC850', label: 'Vegetación dispersa' },
      { color: '#D4C27A', label: 'Suelo desnudo' },
      { color: '#A0785A', label: 'Roca expuesta' },
      { color: '#6B3A2A', label: 'Alteración visible' },
    ],
    bandDescription: 'Composición RGB estándar (Rojo-Verde-Azul).',
    mineralApplication: 'Referencia visual de base. Identifica afloramientos y zonas de alteración superficial.',
  },
  FALSE_COLOR: {
    legend: [
      { color: '#FF0000', label: 'Vegetación vigorosa' },
      { color: '#FF8800', label: 'Vegetación escasa' },
      { color: '#FFFF00', label: 'Suelo húmedo' },
      { color: '#00CCFF', label: 'Roca sedimentaria' },
      { color: '#0000FF', label: 'Roca ígnea/metamórfica' },
    ],
    bandDescription: 'NIR + Rojo + Verde (Infrarrojo Color IRC).',
    mineralApplication: 'Discriminación rápida entre cobertura vegetal y afloramientos rocosos.',
  },
  NDVI: {
    legend: [
      { color: '#8B0000', label: 'Sin vegetación (-1 a 0)' },
      { color: '#FF4400', label: 'Muy escasa (0–0.1)' },
      { color: '#FFDD00', label: 'Moderada (0.1–0.3)' },
      { color: '#88DD00', label: 'Densa (0.3–0.6)' },
      { color: '#006600', label: 'Muy densa (0.6–1)' },
    ],
    bandDescription: 'Índice de Diferencia Normalizada de Vegetación (NIR−Rojo)/(NIR+Rojo).',
    mineralApplication: 'NDVI anómalamente bajo indica suelos tóxicos por mineralización (halo geoquímico).',
  },
  SWIR_MINERAL: {
    legend: [
      { color: '#000033', label: 'Sin respuesta SWIR' },
      { color: '#003366', label: 'Respuesta baja' },
      { color: '#006699', label: 'Alteración moderada' },
      { color: '#00AACC', label: 'Alteración intensa' },
      { color: '#FFEEAA', label: 'Mineralización activa' },
    ],
    bandDescription: 'Composición SWIR2 / SWIR1 / NIR.',
    mineralApplication: 'Detección de alteración hidrotermal, arcillas propilíticas y sulfuros.',
  },
  IRON_OXIDE: {
    legend: [
      { color: '#1A1A1A', label: 'Sin óxidos' },
      { color: '#4A2000', label: 'Trazas Fe' },
      { color: '#993300', label: 'Limonita' },
      { color: '#FF6600', label: 'Goethita/Hematita' },
      { color: '#FFD700', label: 'Gossan intenso' },
    ],
    bandDescription: 'Cociente Rojo / Verde-Azul.',
    mineralApplication: 'Mapeo de gossan, halos de oxidación de sulfuros. Guía a Au, Ag, Cu y polimetálicos.',
  },
  CLAY_MINERALS: {
    legend: [
      { color: '#1A0D00', label: 'Sin arcillas' },
      { color: '#4D3319', label: 'Arcillas traza' },
      { color: '#997755', label: 'Arcillas moderadas' },
      { color: '#CCBB88', label: 'Arcillas abundantes' },
      { color: '#FFEEDD', label: 'Alteración argílica intensa' },
    ],
    bandDescription: 'Cociente SWIR2 / SWIR1.',
    mineralApplication: 'Halos de alteración argílica avanzada (ALS) en sistemas epitermales y pórfidos.',
  },
  FERROUS_IRON: {
    legend: [
      { color: '#000022', label: 'Sin Fe²⁺' },
      { color: '#001144', label: 'Fe²⁺ traza' },
      { color: '#003388', label: 'Fe²⁺ moderado' },
      { color: '#2266CC', label: 'Rocas máficas' },
      { color: '#88AAFF', label: 'Ultramáficas/Serpentinita' },
    ],
    bandDescription: 'Cociente NIR / SWIR1.',
    mineralApplication: 'Mapeo de rocas máficas y ultramáficas (Ni, Co, Cr, PGE). Delimita serpentinización.',
  },

  // ── ASTER mineral indices (SWIR · histórico 2000-2008) ─────────────────────
  ASTER_ALUNITE: {
    legend: [
      { color: '#1A0A00', label: 'Sin Al-OH' },
      { color: '#4D2500', label: 'Trazas caolinita/alunita' },
      { color: '#996633', label: 'Caolinita moderada' },
      { color: '#DDAA44', label: 'Alunita/Caolinita abundante' },
      { color: '#FFFFCC', label: 'Alteración argílica avanzada' },
    ],
    bandDescription: 'Índice de profundidad de banda Al-OH: 1 − B06 / ((B05+B07)/2). Resolución 30 m · ASTER SWIR.',
    mineralApplication: 'Detecta alunita, caolinita y moscovita. Clave en epitermales de alta sulfidación (Au-Ag) y pórfidos de Cu. Datos históricos 2000-2008.',
  },
  ASTER_CALCITE: {
    legend: [
      { color: '#00001A', label: 'Sin carbonatos' },
      { color: '#001144', label: 'Trazas calcita/dolomita' },
      { color: '#003388', label: 'Carbonatos moderados' },
      { color: '#3366CC', label: 'Carbonatización intensa' },
      { color: '#AACCFF', label: 'Skarn / Carbonatita' },
    ],
    bandDescription: 'Índice de profundidad de banda CO₃: 1 − B08 / ((B06+B09)/2). Resolución 30 m · ASTER SWIR.',
    mineralApplication: 'Mapea calcita, dolomita y magnesita. Para skarns (Fe, Cu, Au, W), carbonatitas (REE, Nb) y carbonatización hidrotermal. Datos históricos 2000-2008.',
  },
  ASTER_CHLORITE: {
    legend: [
      { color: '#001A00', label: 'Sin Mg-OH' },
      { color: '#00331A', label: 'Trazas clorita/serpentina' },
      { color: '#006633', label: 'Clorita moderada' },
      { color: '#00AA55', label: 'Clorita/Serpentina abundante' },
      { color: '#AAFFCC', label: 'Alteración propilítica intensa' },
    ],
    bandDescription: 'Índice de profundidad de banda Mg-OH: 1 − B08 / ((B07+B09)/2). Resolución 30 m · ASTER SWIR.',
    mineralApplication: 'Detecta clorita, serpentina y talco. Indica alteración propilítica en pórfidos Cu-Mo y rocas ultramáficas (Ni, Co, Cr, PGE). Datos históricos 2000-2008.',
  },

  // ── EMIT hyperspectral indices ──────────────────────────────────────────────
  EMIT_AL_CLAY: {
    legend: [
      { color: '#1A0A00', label: 'Sin arcillas Al-OH' },
      { color: '#4D2500', label: 'Trazas caolinita/moscovita' },
      { color: '#996633', label: 'Caolinita moderada' },
      { color: '#DDAA44', label: 'Caolinita/Alunita abundante' },
      { color: '#FFFFCC', label: 'Alteración argílica avanzada (ALS)' },
    ],
    bandDescription: 'Profundidad de banda a 2200 nm (absorción Al-OH). Resolución 60 m · EMIT/ISS.',
    mineralApplication: 'Detecta caolinita, alunita y moscovita con precisión subpixel. Guía a epitermales de alta sulfidación (Au-Ag) y halos de alteración en pórfidos de Cu.',
  },
  EMIT_MG_CLAY: {
    legend: [
      { color: '#001A00', label: 'Sin minerales Mg-OH' },
      { color: '#00331A', label: 'Trazas clorita/serpentina' },
      { color: '#006633', label: 'Clorita moderada' },
      { color: '#00AA55', label: 'Clorita/Serpentina abundante' },
      { color: '#AAFFCC', label: 'Alteración propilítica intensa' },
    ],
    bandDescription: 'Profundidad de banda a 2300 nm (absorción Mg-OH). Resolución 60 m · EMIT/ISS.',
    mineralApplication: 'Detecta clorita, serpentina y talco. Indica alteración propilítica en pórfidos Cu-Mo y rocas ultramáficas portadoras de Ni, Cr, Co y PGE.',
  },
  EMIT_CARBONATE: {
    legend: [
      { color: '#00001A', label: 'Sin carbonatos' },
      { color: '#001144', label: 'Trazas calcita/dolomita' },
      { color: '#003388', label: 'Carbonatos moderados' },
      { color: '#3366CC', label: 'Carbonatización intensa' },
      { color: '#AACCFF', label: 'Skarn / Carbonatita' },
    ],
    bandDescription: 'Profundidad de banda a 2350 nm (absorción CO₃²⁻). Resolución 60 m · EMIT/ISS.',
    mineralApplication: 'Mapea calcita, dolomita y magnesita. Clave para skarns (Fe, Cu, Au, W), carbonatitas (REE, Nb) y zonas de carbonatización hidrotermal en sistemas epitermales.',
  },
  EMIT_FERRIC: {
    legend: [
      { color: '#1A0000', label: 'Sin Fe³⁺' },
      { color: '#550000', label: 'Fe³⁺ traza' },
      { color: '#AA2200', label: 'Goethita / Limonita' },
      { color: '#FF5500', label: 'Hematita abundante' },
      { color: '#FFCC00', label: 'Gossan / Alteración intensa' },
    ],
    bandDescription: 'Profundidad de banda a 870 nm (campo cristalino Fe³⁺). Resolución 60 m · EMIT/ISS.',
    mineralApplication: 'Detecta hematita, goethita y jarosita con mayor sensibilidad que Sentinel-2. Localiza gossanes y halos de oxidación sobre depósitos de sulfuros (Cu, Au, Ag, Zn).',
  },
};

// ---------------------------------------------------------------------------
// GEE initialization
// ---------------------------------------------------------------------------

let _initialized = false;

function initGEE() {
  return new Promise((resolve, reject) => {
    const raw = process.env.GEE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
      return reject(new Error('GEE_SERVICE_ACCOUNT_JSON environment variable is not set'));
    }

    let privateKey;
    try {
      privateKey = JSON.parse(raw);
    } catch {
      return reject(new Error('GEE_SERVICE_ACCOUNT_JSON is not valid JSON'));
    }

    ee.data.authenticateViaPrivateKey(
      privateKey,
      () => {
        ee.initialize(
          null,
          null,
          () => {
            _initialized = true;
            console.log('[GEE] Authenticated and initialized via service account:', privateKey.client_email);
            resolve();
          },
          (err) => reject(new Error(`GEE initialize failed: ${err}`))
        );
      },
      (err) => reject(new Error(`GEE authentication failed: ${err}`))
    );
  });
}

function assertInitialized() {
  if (!_initialized) throw new Error('GEE is not initialized. Wait for server startup to complete.');
}

// ---------------------------------------------------------------------------
// Promise wrappers for callback-based GEE API
// ---------------------------------------------------------------------------

function getMapIdAsync(eeImage, visParams) {
  return new Promise((resolve, reject) => {
    eeImage.getMapId(visParams, (mapId, error) => {
      if (error) reject(new Error(String(error)));
      else resolve(mapId);
    });
  });
}

function getInfoAsync(eeObject) {
  return new Promise((resolve, reject) => {
    eeObject.getInfo((info, error) => {
      if (error) reject(new Error(String(error)));
      else resolve(info);
    });
  });
}

// ---------------------------------------------------------------------------
// Image scaling: normalize to 0–1 reflectance
// ---------------------------------------------------------------------------

function scaleToReflectance(image, dataset) {
  if (dataset === 'SENTINEL2') {
    return image.divide(10000);
  }
  if (dataset === 'ASTER') {
    // ASTER L1T DN values are 0-255; divide by 255 for ratio-safe 0-1 normalization.
    // Not true surface reflectance, but accurate for all ratio/band-depth indices.
    return image.divide(255);
  }
  // Landsat C02 L2: scale = 0.0000275, offset = -0.2
  return image.multiply(0.0000275).add(-0.2);
}

// ---------------------------------------------------------------------------
// Core: build the index image + vis params
// ---------------------------------------------------------------------------

function buildIndexImage(scaledImage, dataset, index) {
  const b = BANDS[dataset];

  switch (index) {
    case 'TRUE_COLOR':
      if (dataset === 'ASTER') {
        // ASTER has no blue band — use standard NIR-Red-Green false color composite
        return {
          image: scaledImage.select([b.nir, b.red, b.green]),
          visParams: { bands: [b.nir, b.red, b.green], min: 0, max: 0.25, gamma: 1.4 },
          sampleBands: [b.nir, b.red, b.green],
        };
      }
      return {
        image: scaledImage.select([b.red, b.green, b.blue]),
        visParams: { bands: [b.red, b.green, b.blue], min: 0, max: 0.3, gamma: 1.4 },
        sampleBands: [b.red, b.green, b.blue],
      };

    case 'FALSE_COLOR':
      return {
        image: scaledImage.select([b.nir, b.red, b.green]),
        visParams: { bands: [b.nir, b.red, b.green], min: 0, max: 0.5 },
        sampleBands: [b.nir, b.red, b.green],
      };

    case 'NDVI': {
      const ndvi = scaledImage.normalizedDifference([b.nir, b.red]).rename('NDVI');
      return {
        image: ndvi,
        visParams: {
          min: -0.2,
          max: 0.8,
          palette: ['8B0000', 'FF4400', 'FFDD00', '88DD00', '006600'],
        },
        sampleBands: [b.nir, b.red],
        indexImage: ndvi,
      };
    }

    case 'SWIR_MINERAL':
      return {
        image: scaledImage.select([b.swir2, b.swir1, b.nir]),
        visParams: { bands: [b.swir2, b.swir1, b.nir], min: 0, max: 0.4 },
        sampleBands: [b.swir2, b.swir1, b.nir],
      };

    case 'IRON_OXIDE': {
      const ratio = scaledImage.select(b.red).divide(scaledImage.select(b.green)).rename('IRON_OXIDE');
      return {
        image: ratio,
        visParams: {
          min: 0.5,
          max: 3.0,
          palette: ['1A1A1A', '4A2000', '993300', 'FF6600', 'FFD700'],
        },
        sampleBands: [b.red, b.green],
        indexImage: ratio,
      };
    }

    case 'CLAY_MINERALS': {
      const ratio = scaledImage.select(b.swir2).divide(scaledImage.select(b.swir1)).rename('CLAY_MINERALS');
      return {
        image: ratio,
        visParams: {
          min: 0.5,
          max: 2.0,
          palette: ['1A0D00', '4D3319', '997755', 'CCBB88', 'FFEEDD'],
        },
        sampleBands: [b.swir2, b.swir1],
        indexImage: ratio,
      };
    }

    case 'FERROUS_IRON': {
      const ratio = scaledImage.select(b.nir).divide(scaledImage.select(b.swir1)).rename('FERROUS_IRON');
      return {
        image: ratio,
        visParams: {
          min: 0.5,
          max: 3.5,
          palette: ['000022', '001144', '003388', '2266CC', '88AAFF'],
        },
        sampleBands: [b.nir, b.swir1],
        indexImage: ratio,
      };
    }

    // ── ASTER SWIR mineral indices (require historical 2000-2008 data) ──────
    case 'ASTER_ALUNITE': {
      // Band-depth at 2200 nm: 1 − B06 / ((B05+B07)/2)
      const continuum = scaledImage.select(b.b05).add(scaledImage.select(b.b07)).divide(2);
      const bd = ee.Image(1).subtract(scaledImage.select(b.swir2).divide(continuum)).rename('ASTER_ALUNITE');
      return {
        image: bd,
        visParams: { min: -0.1, max: 0.3, palette: ['1A0A00', '4D2500', '996633', 'DDAA44', 'FFFFCC'] },
        sampleBands: [b.b05, b.swir2, b.b07],
        indexImage: bd,
      };
    }

    case 'ASTER_CALCITE': {
      // Band-depth at 2350 nm: 1 − B08 / ((B06+B09)/2)
      const continuum = scaledImage.select(b.swir2).add(scaledImage.select(b.b09)).divide(2);
      const bd = ee.Image(1).subtract(scaledImage.select(b.b08).divide(continuum)).rename('ASTER_CALCITE');
      return {
        image: bd,
        visParams: { min: -0.1, max: 0.3, palette: ['00001A', '001144', '003388', '3366CC', 'AACCFF'] },
        sampleBands: [b.swir2, b.b08, b.b09],
        indexImage: bd,
      };
    }

    case 'ASTER_CHLORITE': {
      // Band-depth at 2300 nm: 1 − B08 / ((B07+B09)/2)
      const continuum = scaledImage.select(b.b07).add(scaledImage.select(b.b09)).divide(2);
      const bd = ee.Image(1).subtract(scaledImage.select(b.b08).divide(continuum)).rename('ASTER_CHLORITE');
      return {
        image: bd,
        visParams: { min: -0.1, max: 0.25, palette: ['001A00', '00331A', '006633', '00AA55', 'AAFFCC'] },
        sampleBands: [b.b07, b.b08, b.b09],
        indexImage: bd,
      };
    }

    default:
      throw new Error(`Unknown band index: ${index}`);
  }
}

// ---------------------------------------------------------------------------
// Compute a scalar index from band values dict (for /pixels response)
// ---------------------------------------------------------------------------

function computeIndexFromValues(bandValues, dataset, index) {
  const b = BANDS[dataset];

  const get = (band) => {
    const val = bandValues[band];
    return val != null ? val : null;
  };

  switch (index) {
    case 'NDVI': {
      const nir = get(b.nir), red = get(b.red);
      if (nir == null || red == null) return null;
      return (nir - red) / (nir + red);
    }
    case 'IRON_OXIDE': {
      const red = get(b.red), green = get(b.green);
      if (red == null || green == null || green === 0) return null;
      return red / green;
    }
    case 'CLAY_MINERALS': {
      const swir2 = get(b.swir2), swir1 = get(b.swir1);
      if (swir2 == null || swir1 == null || swir1 === 0) return null;
      return swir2 / swir1;
    }
    case 'FERROUS_IRON': {
      const nir = get(b.nir), swir1 = get(b.swir1);
      if (nir == null || swir1 == null || swir1 === 0) return null;
      return nir / swir1;
    }
    case 'TRUE_COLOR':
    case 'FALSE_COLOR':
    case 'SWIR_MINERAL': {
      const vals = Object.values(bandValues).filter(v => v != null);
      return vals.length ? vals.reduce((a, c) => a + c, 0) / vals.length : null;
    }

    // ── ASTER SWIR mineral indices ─────────────────────────────────────────
    case 'ASTER_ALUNITE': {
      const b05 = get(b.b05), b06 = get(b.swir2), b07 = get(b.b07);
      if (b05 == null || b06 == null || b07 == null) return null;
      const continuum = (b05 + b07) / 2;
      return continuum > 0 ? 1 - b06 / continuum : null;
    }
    case 'ASTER_CALCITE': {
      const b06 = get(b.swir2), b08 = get(b.b08), b09 = get(b.b09);
      if (b06 == null || b08 == null || b09 == null) return null;
      const continuum = (b06 + b09) / 2;
      return continuum > 0 ? 1 - b08 / continuum : null;
    }
    case 'ASTER_CHLORITE': {
      const b07 = get(b.b07), b08 = get(b.b08), b09 = get(b.b09);
      if (b07 == null || b08 == null || b09 == null) return null;
      const continuum = (b07 + b09) / 2;
      return continuum > 0 ? 1 - b08 / continuum : null;
    }

    // ── EMIT band-depth indices ───────────────────────────────────────────────
    case 'EMIT_AL_CLAY': {
      const eb = BANDS.EMIT;
      const r2100 = get(eb.r2100), r2200 = get(eb.r2200), r2300 = get(eb.r2300);
      if (r2100 == null || r2200 == null || r2300 == null) return null;
      const continuum = (r2100 + r2300) / 2;
      return continuum > 0 ? 1 - r2200 / continuum : null;
    }
    case 'EMIT_MG_CLAY': {
      const eb = BANDS.EMIT;
      const r2250 = get(eb.r2250), r2300 = get(eb.r2300), r2400 = get(eb.r2400);
      if (r2250 == null || r2300 == null || r2400 == null) return null;
      const continuum = (r2250 + r2400) / 2;
      return continuum > 0 ? 1 - r2300 / continuum : null;
    }
    case 'EMIT_CARBONATE': {
      const eb = BANDS.EMIT;
      const r2250 = get(eb.r2250), r2350 = get(eb.r2350), r2450 = get(eb.r2450);
      if (r2250 == null || r2350 == null || r2450 == null) return null;
      const continuum = (r2250 + r2450) / 2;
      return continuum > 0 ? 1 - r2350 / continuum : null;
    }
    case 'EMIT_FERRIC': {
      const eb = BANDS.EMIT;
      const r770 = get(eb.r770), r870 = get(eb.r870), r1000 = get(eb.r1000);
      if (r770 == null || r870 == null || r1000 == null) return null;
      const continuum = (r770 + r1000) / 2;
      return continuum > 0 ? 1 - r870 / continuum : null;
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// EMIT: build composite from NASA/EMIT/L2A/RFL
// ---------------------------------------------------------------------------

function buildEmitComposite(lat, lng, dateStart, dateEnd) {
  const point  = ee.Geometry.Point([lng, lat]);
  const region = point.buffer(150000);

  const collection = ee.ImageCollection(COLLECTION_IDS.EMIT)
    .filterDate(dateStart, dateEnd)
    .filterBounds(region)
    .sort('system:time_start', false);

  return { scaled: collection.mosaic(), collection };
}

function buildEmitIndexImage(scaledImage, index) {
  const b = BANDS.EMIT;

  switch (index) {
    case 'EMIT_AL_CLAY': {
      const continuum = scaledImage.select(b.r2100).add(scaledImage.select(b.r2300)).divide(2);
      const bd = ee.Image(1).subtract(scaledImage.select(b.r2200).divide(continuum)).rename('EMIT_AL_CLAY');
      return {
        image: bd,
        visParams: { min: 0, max: 0.25, palette: ['1A0A00', '4D2500', '996633', 'DDAA44', 'FFFFCC'] },
        sampleBands: [b.r2100, b.r2200, b.r2300],
        indexImage: bd,
      };
    }
    case 'EMIT_MG_CLAY': {
      const continuum = scaledImage.select(b.r2250).add(scaledImage.select(b.r2400)).divide(2);
      const bd = ee.Image(1).subtract(scaledImage.select(b.r2300).divide(continuum)).rename('EMIT_MG_CLAY');
      return {
        image: bd,
        visParams: { min: 0, max: 0.20, palette: ['001A00', '00331A', '006633', '00AA55', 'AAFFCC'] },
        sampleBands: [b.r2250, b.r2300, b.r2400],
        indexImage: bd,
      };
    }
    case 'EMIT_CARBONATE': {
      const continuum = scaledImage.select(b.r2250).add(scaledImage.select(b.r2450)).divide(2);
      const bd = ee.Image(1).subtract(scaledImage.select(b.r2350).divide(continuum)).rename('EMIT_CARBONATE');
      return {
        image: bd,
        visParams: { min: 0, max: 0.20, palette: ['00001A', '001144', '003388', '3366CC', 'AACCFF'] },
        sampleBands: [b.r2250, b.r2350, b.r2450],
        indexImage: bd,
      };
    }
    case 'EMIT_FERRIC': {
      const continuum = scaledImage.select(b.r770).add(scaledImage.select(b.r1000)).divide(2);
      const bd = ee.Image(1).subtract(scaledImage.select(b.r870).divide(continuum)).rename('EMIT_FERRIC');
      return {
        image: bd,
        visParams: { min: 0, max: 0.15, palette: ['1A0000', '550000', 'AA2200', 'FF5500', 'FFCC00'] },
        sampleBands: [b.r770, b.r870, b.r1000],
        indexImage: bd,
      };
    }
    default:
      throw new Error(`Unknown EMIT index: ${index}`);
  }
}

// ---------------------------------------------------------------------------
// Shared: build filtered + scaled median composite (explicit date range mode)
// ---------------------------------------------------------------------------

function buildComposite(dataset, lat, lng, dateStart, dateEnd, maxCloud) {
  const collectionId = COLLECTION_IDS[dataset];
  const cloudProp    = CLOUD_PROP[dataset];
  const point        = ee.Geometry.Point([lng, lat]);
  const region       = point.buffer(50000);

  const collection = ee.ImageCollection(collectionId)
    .filterDate(dateStart, dateEnd)
    .filterBounds(region)
    .filter(ee.Filter.lte(cloudProp, maxCloud))
    .sort(cloudProp);

  const rawComposite = collection.median();
  return { scaled: scaleToReflectance(rawComposite, dataset), collection };
}

// ---------------------------------------------------------------------------
// Auto-latest: find the most recent cloud-free image for a dataset + location
// ---------------------------------------------------------------------------

/**
 * Searches for the most recent image meeting cloud criteria.
 * Progressively expands the search window (15 → 30 → 60 → 90 days) and
 * the cloud threshold (20 → 35 → 50 → 80%) until an image is found.
 *
 * For ASTER SWIR mineral indices (ASTER_ALUNITE, ASTER_CALCITE, ASTER_CHLORITE),
 * searches the historical archive (2000-2008) since the ASTER SWIR detector
 * failed in April 2008.
 *
 * Returns { image, acquisitionDate, cloudCover, dateStart, dateEnd, maxCloudUsed, isHistorical }
 * or { image: null } if nothing is found.
 */
async function findLatestCloudFreeImage(dataset, lat, lng, preferredMaxCloud, index) {
  const cloudProp = CLOUD_PROP[dataset];
  const point     = ee.Geometry.Point([lng, lat]);
  const region    = point.buffer(50000);

  const isAsterSwir = dataset === 'ASTER' && ASTER_SWIR_INDEXES.includes(index);

  let searchWindows;
  if (isAsterSwir) {
    // ASTER SWIR failed April 2008 — use the entire historical archive
    searchWindows = [{ start: '2000-01-01', end: '2008-04-01' }];
  } else {
    const now = new Date();
    const end = now.toISOString().split('T')[0];
    const makeStart = (days) => {
      const d = new Date(now.getTime() - days * 86400000);
      return d.toISOString().split('T')[0];
    };
    searchWindows = [
      { start: makeStart(15), end },
      { start: makeStart(30), end },
      { start: makeStart(60), end },
      { start: makeStart(90), end },
    ];
  }

  // Cloud thresholds to try (skipped for ASTER SWIR and EMIT)
  const cloudThresholds = isAsterSwir || !cloudProp
    ? [100]
    : (preferredMaxCloud <= 20 ? [20, 35, 50, 80] : [preferredMaxCloud, 50, 80]);

  for (const { start, end } of searchWindows) {
    for (const thresh of cloudThresholds) {
      const baseCol = ee.ImageCollection(COLLECTION_IDS[dataset])
        .filterDate(start, end)
        .filterBounds(region)
        .sort('system:time_start', false); // newest first

      const filtered = cloudProp && !isAsterSwir
        ? baseCol.filter(ee.Filter.lte(cloudProp, thresh))
        : baseCol;

      // Quick check: does this window+threshold have any images?
      let timestamps;
      try {
        timestamps = await getInfoAsync(filtered.limit(1).aggregate_array('system:time_start'));
      } catch {
        continue;
      }

      if (!timestamps || timestamps.length === 0) continue;

      // Get metadata of the most recent image
      const first = filtered.first();
      const metaKeys = cloudProp ? ['system:time_start', cloudProp] : ['system:time_start'];
      let meta;
      try {
        meta = await getInfoAsync(first.toDictionary(metaKeys));
      } catch {
        continue;
      }

      if (!meta || !meta['system:time_start']) continue;

      const acquisitionDate = new Date(meta['system:time_start']).toISOString().split('T')[0];
      const cloudCover = cloudProp ? Math.round((meta[cloudProp] || 0) * 10) / 10 : 0;

      return {
        image: first,
        acquisitionDate,
        cloudCover,
        dateStart: start,
        dateEnd: end,
        maxCloudUsed: thresh,
        isHistorical: isAsterSwir,
      };
    }
  }

  return { image: null, acquisitionDate: null, cloudCover: 0, dateStart: null, dateEnd: null, isHistorical: false };
}

// ---------------------------------------------------------------------------
// Next pass date estimation
// ---------------------------------------------------------------------------

/**
 * Estimates the next satellite pass date by adding the revisit period.
 * Returns null for EMIT (ISS orbit is not predictable).
 */
function computeNextPassDate(acquisitionDate, dataset) {
  const revisit = REVISIT_DAYS[dataset];
  if (!revisit || !acquisitionDate) return null;
  const d = new Date(acquisitionDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + revisit);
  return d.toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// Public: getTileConfig
// ---------------------------------------------------------------------------

/**
 * @param {object} params
 * @param {number} params.lat
 * @param {number} params.lng
 * @param {string} params.index       — BandIndex
 * @param {string} params.dataset     — GEEDataset
 * @param {string} [params.dateStart] — YYYY-MM-DD (omit for auto-latest)
 * @param {string} [params.dateEnd]   — YYYY-MM-DD (omit for auto-latest)
 * @param {number} [params.maxCloud]  — percent 0–100 (default 20)
 * @returns {Promise<GEETileConfig>}
 */
async function getTileConfig({ lat, lng, index, dataset, dateStart, dateEnd, maxCloud }) {
  assertInitialized();

  const isEmit      = dataset === 'EMIT';
  const autoLatest  = !dateStart || !dateEnd;
  const cloudLimit  = maxCloud != null ? maxCloud : 20;

  let scaledImage, acquisitionDate, cloudCover, usedDateStart, usedDateEnd;

  if (isEmit) {
    // EMIT always uses mosaic over a configurable window
    const emitStart = dateStart || (() => {
      const d = new Date(); d.setDate(d.getDate() - 180); return d.toISOString().split('T')[0];
    })();
    const emitEnd = dateEnd || new Date().toISOString().split('T')[0];
    const { scaled, collection } = buildEmitComposite(lat, lng, emitStart, emitEnd);
    scaledImage = scaled;
    usedDateStart = emitStart;
    usedDateEnd   = emitEnd;

    try {
      const firstInfo = await getInfoAsync(
        collection.first().toDictionary(['system:time_start'])
      );
      acquisitionDate = firstInfo?.['system:time_start']
        ? new Date(firstInfo['system:time_start']).toISOString().split('T')[0]
        : emitEnd;
    } catch {
      acquisitionDate = emitEnd;
    }
    cloudCover = 0;

  } else if (autoLatest) {
    // Auto-find the most recent cloud-free image
    const result = await findLatestCloudFreeImage(dataset, lat, lng, cloudLimit, index);
    if (!result.image) {
      throw new Error(
        `No se encontró ninguna imagen de ${dataset} con cobertura de nubes ≤ 80% ` +
        `en los últimos 90 días para la ubicación (${lat.toFixed(4)}, ${lng.toFixed(4)}). ` +
        'Verifica que la zona esté dentro de la cobertura del satélite.'
      );
    }
    scaledImage     = scaleToReflectance(result.image, dataset);
    acquisitionDate = result.acquisitionDate;
    cloudCover      = result.cloudCover;
    usedDateStart   = result.dateStart;
    usedDateEnd     = result.dateEnd;

  } else {
    // Explicit date range — use median composite (existing behavior)
    const { scaled, collection } = buildComposite(dataset, lat, lng, dateStart, dateEnd, cloudLimit);
    scaledImage   = scaled;
    usedDateStart = dateStart;
    usedDateEnd   = dateEnd;

    try {
      const firstInfo = await getInfoAsync(
        collection
          .sort('system:time_start', false)
          .first()
          .toDictionary(['system:time_start', CLOUD_PROP[dataset]])
      );
      if (firstInfo) {
        const ts = firstInfo['system:time_start'];
        if (ts) acquisitionDate = new Date(ts).toISOString().split('T')[0];
        const cc = firstInfo[CLOUD_PROP[dataset]];
        if (cc != null) cloudCover = Math.round(cc * 10) / 10;
      }
    } catch {
      acquisitionDate = dateEnd;
      cloudCover = 0;
    }
  }

  // Build the index image and get map tiles
  const { image, visParams } = isEmit
    ? buildEmitIndexImage(scaledImage, index)
    : buildIndexImage(scaledImage, dataset, index);

  const mapId = await getMapIdAsync(image, visParams);

  const isV1MapId = mapId.mapid.startsWith('projects/');
  const tileUrl = isV1MapId
    ? `https://earthengine.googleapis.com/v1/${mapId.mapid}/tiles/{z}/{x}/{y}`
    : `https://earthengine.googleapis.com/map/${mapId.mapid}/{z}/{x}/{y}?token=${mapId.token}`;

  const meta = BAND_META[index];

  return {
    tileUrl,
    mapId: mapId.mapid,
    legend: meta.legend,
    bandDescription: meta.bandDescription,
    mineralApplication: meta.mineralApplication,
    acquisitionDate: acquisitionDate || usedDateEnd,
    cloudCover: cloudCover || 0,
    nextPassDate: computeNextPassDate(acquisitionDate, dataset),
    expiresAt: Date.now() + 23 * 60 * 60 * 1000,
  };
}

// ---------------------------------------------------------------------------
// Public: getPixelValues
// ---------------------------------------------------------------------------

async function getPixelValues({ lat, lng, index, dataset, dateStart, dateEnd }) {
  assertInitialized();

  const isEmit    = dataset === 'EMIT';
  const cloudLimit = 50; // relaxed for pixel sampling

  let scaledImage;

  if (isEmit) {
    const emitStart = dateStart || (() => {
      const d = new Date(); d.setDate(d.getDate() - 180); return d.toISOString().split('T')[0];
    })();
    const emitEnd = dateEnd || new Date().toISOString().split('T')[0];
    const { scaled } = buildEmitComposite(lat, lng, emitStart, emitEnd);
    scaledImage = scaled;
  } else if (!dateStart || !dateEnd) {
    // Auto-latest for pixel sampling
    const result = await findLatestCloudFreeImage(dataset, lat, lng, cloudLimit, index);
    if (!result.image) {
      throw new Error(
        `No hay datos disponibles para ${dataset} en esta zona y rango de fechas.`
      );
    }
    scaledImage = scaleToReflectance(result.image, dataset);
  } else {
    const { scaled } = buildComposite(dataset, lat, lng, dateStart, dateEnd, cloudLimit);
    scaledImage = scaled;
  }

  const { sampleBands } = isEmit
    ? buildEmitIndexImage(scaledImage, index)
    : buildIndexImage(scaledImage, dataset, index);

  const point    = ee.Geometry.Point([lng, lat]);
  const scale    = SPATIAL_RESOLUTION[dataset];
  const allBands = BANDS[dataset];

  const allBandList  = Object.values(allBands);
  const sampledImage = scaledImage.select(allBandList);

  const reduced = sampledImage.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: point,
    scale,
    maxPixels: 1e6,
  });

  const rawValues = await getInfoAsync(reduced);

  const bandValues = {};
  for (const band of sampleBands) {
    if (rawValues && rawValues[band] != null) {
      bandValues[band] = Math.round(rawValues[band] * 10000) / 10000;
    }
  }

  const computedIndex = computeIndexFromValues(rawValues || {}, dataset, index);

  if (computedIndex == null) {
    throw new Error(
      `No hay datos de píxel válidos para esta zona (${lat.toFixed(4)}, ${lng.toFixed(4)}). ` +
      'Prueba ampliar el rango de fechas o reducir el filtro de nubes.'
    );
  }

  return {
    bandValues,
    computedIndex: Math.round(computedIndex * 10000) / 10000,
  };
}

// ---------------------------------------------------------------------------
// Public: getBiomassAnalysis — Agricultural crop indices over a polygon
// ---------------------------------------------------------------------------

/**
 * @param {object} params
 * @param {number[][]} params.coordinates — [[lng,lat], ...] polygon ring
 * @param {string}     params.fecha_inicio — YYYY-MM-DD
 * @param {string}     params.fecha_fin    — YYYY-MM-DD
 * @returns {Promise<object>} Crop biomass statistics + tonnage estimation
 */
async function getBiomassAnalysis({ coordinates, fecha_inicio, fecha_fin, tipo_cultivo = 'maiz_riego' }) {
  assertInitialized();

  const geometry = ee.Geometry.Polygon([coordinates]);

  // ── SENTINEL-2 — ventana dinámica 30→60→90 días ─────────────────────
  const now = new Date(fecha_fin);
  const makeS2Col = (days) => {
    const ws = new Date(now.getTime() - days * 86400000).toISOString().split('T')[0];
    const sd = ws > fecha_inicio ? ws : fecha_inicio;
    const col = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterDate(sd, fecha_fin)
      .filterBounds(geometry)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10))
      .map(function(img) {
        var scl = img.select('SCL');
        var mask = scl.neq(3).and(scl.neq(8)).and(scl.neq(9)).and(scl.neq(10)).and(scl.neq(11));
        return img.updateMask(mask).divide(10000)
          .copyProperties(img, ['system:time_start', 'CLOUDY_PIXEL_PERCENTAGE']);
      });
    return { col, startDate: sd };
  };

  let s2, s2WindowDays, s2StartDate;
  let s2Info = { count: 0, date: fecha_fin };
  for (const days of [30, 60, 90]) {
    const { col, startDate } = makeS2Col(days);
    try {
      const count = await getInfoAsync(col.size());
      s2Info.count = count || 0;
      if (count >= 3 || (count > 0 && days === 90)) {
        s2 = col;
        s2WindowDays = days;
        s2StartDate = startDate;
        const meta = await getInfoAsync(col.sort('system:time_start', false).first().toDictionary(['system:time_start']));
        if (meta?.['system:time_start']) s2Info.date = new Date(meta['system:time_start']).toISOString().split('T')[0];
        break;
      }
    } catch { /* try wider window */ }
  }
  console.log(`[biomass] S2: ${s2Info.count} imgs, latest: ${s2Info.date}, ventana: ${s2WindowDays}d (${s2StartDate}→${fecha_fin})`);

  if (!s2 || s2Info.count === 0) {
    throw new Error('No se encontraron imágenes Sentinel-2 sin nubes en los últimos 90 días. Intenta un área con menos nubosidad.');
  }

  // ── Build S2 composite from top 3 most recent cloud-free images ────────
  const s2Sorted = s2.sort('system:time_start', false);
  const s2Composite = s2Sorted.limit(5).qualityMosaic('B8'); // best NIR pixel from top 5
  const NDVI = s2Composite.normalizedDifference(['B8', 'B4']).rename('NDVI');
  const EVI = s2Composite.expression(
    '2.5 * ((NIR - RED) / (NIR + 6*RED - 7.5*BLUE + 1))',
    { NIR: s2Composite.select('B8'), RED: s2Composite.select('B4'), BLUE: s2Composite.select('B2') }
  ).rename('EVI');
  const NDRE = s2Composite.normalizedDifference(['B8', 'B5']).rename('NDRE');
  const LSWI = s2Composite.normalizedDifference(['B8', 'B11']).rename('LSWI');
  // NDWI — contenido hídrico del dosel vegetal (B8A/B11)
  const NDWI = s2Composite.normalizedDifference(['B8A', 'B11']).rename('NDWI');
  // SAVI — índice de vegetación ajustado al suelo (L=0.5)
  const SAVI = s2Composite.expression(
    '(1.5 * (NIR - RED)) / (NIR + RED + 0.5)',
    { NIR: s2Composite.select('B8'), RED: s2Composite.select('B4') }
  ).rename('SAVI');

  // ── Parallel satellite fetches: Landsat + SAR (Promise.allSettled) ─────
  const fetchLandsat = async () => {
    try {
      const l9 = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2')
        .filterDate(s2StartDate, fecha_fin).filterBounds(geometry)
        .filter(ee.Filter.lt('CLOUD_COVER', 15));
      const l8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
        .filterDate(s2StartDate, fecha_fin).filterBounds(geometry)
        .filter(ee.Filter.lt('CLOUD_COVER', 15));
      const landsat = l9.merge(l8).sort('system:time_start', false);
      const lsCount = await getInfoAsync(landsat.size());
      if (!lsCount) return { count: 0, date: 'N/A' };
      const lsMeta = await getInfoAsync(landsat.first().toDictionary(['system:time_start']));
      const lsDate = lsMeta?.['system:time_start'] ? new Date(lsMeta['system:time_start']).toISOString().split('T')[0] : 'N/A';
      console.log(`[biomass] Landsat 9/8: ${lsCount} imgs, latest: ${lsDate}`);
      return { count: lsCount, date: lsDate };
    } catch (e) { console.log('[biomass] Landsat failed:', e.message); return { count: 0, date: 'N/A' }; }
  };

  const fetchSAR = async () => {
    try {
      const s1 = ee.ImageCollection('COPERNICUS/S1_GRD')
        .filterDate(s2StartDate, fecha_fin).filterBounds(geometry)
        .filter(ee.Filter.eq('instrumentMode', 'IW'))
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
        .select(['VV', 'VH']);
      const s1Count = await getInfoAsync(s1.size());
      if (!s1Count) return { count: 0, date: 'N/A', rvi: 0 };
      const comp = s1.sort('system:time_start', false).limit(5).median().focal_median(30, 'circle', 'meters');
      const RVI_sar = comp.expression('4 * VH / (VV + VH)', {
        VV: comp.select('VV'), VH: comp.select('VH'),
      }).rename('RVI');
      const [rviResult, sarMeta] = await Promise.all([
        getInfoAsync(RVI_sar.reduceRegion({ reducer: ee.Reducer.mean(), geometry, scale: 100, bestEffort: true, maxPixels: 1e10 })),
        getInfoAsync(s1.sort('system:time_start', false).first().toDictionary(['system:time_start'])),
      ]);
      const sarDate = sarMeta?.['system:time_start'] ? new Date(sarMeta['system:time_start']).toISOString().split('T')[0] : 'N/A';
      const rvi = Math.round((rviResult?.RVI ?? 0) * 10000) / 10000;
      console.log(`[biomass] SAR S1: ${s1Count} imgs, RVI=${rvi}`);
      return { count: s1Count, date: sarDate, rvi };
    } catch (e) { console.log('[biomass] SAR failed:', e.message); return { count: 0, date: 'N/A', rvi: 0 }; }
  };

  const fetchVHI = async () => {
    try {
      const modisLST = ee.ImageCollection('MODIS/061/MOD11A2')
        .filterDate(s2StartDate, fecha_fin).filterBounds(geometry)
        .select('LST_Day_1km')
        .map(function(img) { return img.multiply(0.02).subtract(273.15); });
      const lstCount = await getInfoAsync(modisLST.size());
      if (!lstCount) return { lst_mean_c: null, vhi: null };
      const lstResult = await getInfoAsync(modisLST.mean().reduceRegion({
        reducer: ee.Reducer.mean(), geometry, scale: 1000, bestEffort: true, maxPixels: 1e10,
      }));
      const lst = lstResult?.LST_Day_1km != null ? Math.round(lstResult.LST_Day_1km * 10) / 10 : null;
      // Simplified VHI: temperature comfort index (optimal ~25°C, stress >35°C or <10°C)
      const vhi = lst != null ? Math.max(0, Math.min(1, 1 - Math.abs(lst - 25) / 25)) : null;
      console.log(`[biomass] MODIS LST: ${lst}°C, VHI=${vhi != null ? vhi.toFixed(2) : 'N/A'}`);
      return { lst_mean_c: lst, vhi: vhi != null ? Math.round(vhi * 100) / 100 : null };
    } catch (e) { console.log('[biomass] VHI failed:', e.message); return { lst_mean_c: null, vhi: null }; }
  };

  // Kick off parallel fetches immediately (results used later)
  const [landsatRes, sarRes, vhiRes] = await Promise.allSettled([fetchLandsat(), fetchSAR(), fetchVHI()]);
  const landsatInfo = landsatRes.status === 'fulfilled' ? landsatRes.value : { count: 0, date: 'N/A' };
  const sarInfo     = sarRes.status     === 'fulfilled' ? sarRes.value     : { count: 0, date: 'N/A', rvi: 0 };
  const vhiInfo     = vhiRes.status     === 'fulfilled' ? vhiRes.value     : { lst_mean_c: null, vhi: null };

  // ── Crop-specific thresholds ────────────────────────────────────────────
  const isMango = tipo_cultivo.startsWith('mango');
  const ndviCropThreshold = isMango ? 0.5 : 0.4;
  const ndviOptimalThreshold = isMango ? 0.65 : 0.7;
  const cropMask = NDVI.gt(ndviCropThreshold);
  const optimalMask = NDVI.gt(ndviOptimalThreshold);

  const stats = NDVI.addBands(EVI).addBands(NDRE).addBands(LSWI).addBands(NDWI).addBands(SAVI)
    .updateMask(cropMask)
    .reduceRegion({
      reducer: ee.Reducer.mean()
        .combine(ee.Reducer.stdDev(), '', true)
        .combine(ee.Reducer.percentile([25, 50, 75]), '', true),
      geometry, scale: 30, bestEffort: true, maxPixels: 1e13,
    });

  const totalHectareas = cropMask.multiply(ee.Image.pixelArea()).divide(10000)
    .reduceRegion({ reducer: ee.Reducer.sum(), geometry, scale: 30, bestEffort: true, maxPixels: 1e13 });

  const optimalHectareas = optimalMask.multiply(ee.Image.pixelArea()).divide(10000)
    .reduceRegion({ reducer: ee.Reducer.sum(), geometry, scale: 30, bestEffort: true, maxPixels: 1e13 });

  const [statsResult, hectareasResult, optimalResult] = await Promise.all([
    getInfoAsync(stats), getInfoAsync(totalHectareas), getInfoAsync(optimalHectareas),
  ]);

  const ndvi_mean = statsResult?.NDVI_mean ?? 0;
  const evi_mean  = statsResult?.EVI_mean  ?? 0;
  const ndre_mean = statsResult?.NDRE_mean ?? 0;
  const lswi_mean = statsResult?.LSWI_mean ?? 0;
  const ndwi_mean = statsResult?.NDWI_mean ?? 0;
  const savi_mean = statsResult?.SAVI_mean ?? 0;
  const ndvi_stdDev = statsResult?.NDVI_stdDev ?? 0;
  const ndvi_p25 = statsResult?.NDVI_p25 ?? 0;
  const ndvi_p50 = statsResult?.NDVI_p50 ?? 0;
  const ndvi_p75 = statsResult?.NDVI_p75 ?? 0;

  const extractHectares = (result) => {
    if (!result) return 0;
    for (const key of ['constant', 'NDVI', 'remapped']) {
      if (result[key] != null && typeof result[key] === 'number') return result[key];
    }
    const vals = Object.values(result).filter(v => typeof v === 'number');
    return vals.length > 0 ? vals[0] : 0;
  };

  const optHectVal = extractHectares(optimalResult);
  let hectareasVal = extractHectares(hectareasResult);
  if (hectareasVal === 0 && optHectVal > 0) {
    hectareasVal = Math.round(optHectVal / 0.6);
  }

  let clasificacion_vigor = 'Bajo';
  if (ndvi_mean > 0.7) clasificacion_vigor = 'Alto';
  else if (ndvi_mean > 0.5) clasificacion_vigor = 'Medio';

  // Progressive NDVI factor
  const factorNDVI = Math.min(1.0, Math.max(0.0, (ndvi_mean - 0.2) / 0.6));
  const factorNDRE = ndre_mean > 0.35 ? 1.0 : ndre_mean > 0.2 ? 0.8 : 0.6;
  const imgMonth = parseInt(s2Info.date.split('-')[1], 10) || 3;

  // Crop-specific yield, phenology and satellite/index preferences
  const SATELITES_POR_CULTIVO = {
    maiz_riego:    { rendimiento_base: 9.5,  label: 'Maíz Riego',         satelites: ['S2', 'S1', 'L8'], indices: ['NDVI', 'EVI', 'NDRE', 'SAVI', 'RVI'] },
    maiz_temporal: { rendimiento_base: 4.5,  label: 'Maíz Temporal',      satelites: ['S2', 'S1', 'L8'], indices: ['NDVI', 'EVI', 'SAVI', 'RVI'] },
    mango_ataulfo: { rendimiento_base: 12,   label: 'Mango Ataulfo',      satelites: ['S2', 'L8'],        indices: ['NDVI', 'EVI', 'NDRE', 'NDWI', 'LSWI'] },
    mango_kent:    { rendimiento_base: 14,   label: 'Mango Kent',         satelites: ['S2', 'L8'],        indices: ['NDVI', 'EVI', 'NDRE', 'NDWI', 'LSWI'] },
    mango_tommy:   { rendimiento_base: 16,   label: 'Mango Tommy Atkins', satelites: ['S2', 'L8'],        indices: ['NDVI', 'EVI', 'NDRE', 'NDWI', 'LSWI'] },
    tomate:        { rendimiento_base: 45,   label: 'Tomate',             satelites: ['S2', 'S1'],        indices: ['NDVI', 'EVI', 'NDWI', 'SAVI', 'RVI'] },
    chile:         { rendimiento_base: 18,   label: 'Chile',              satelites: ['S2', 'S1'],        indices: ['NDVI', 'EVI', 'NDWI', 'SAVI'] },
    aguacate:      { rendimiento_base: 8,    label: 'Aguacate',           satelites: ['S2', 'L8'],        indices: ['NDVI', 'NDRE', 'NDWI', 'LSWI'] },
    sorgo:         { rendimiento_base: 5.5,  label: 'Sorgo',              satelites: ['S2', 'S1', 'L8'], indices: ['NDVI', 'EVI', 'SAVI', 'RVI'] },
    limon:         { rendimiento_base: 12,   label: 'Limón',              satelites: ['S2', 'L8'],        indices: ['NDVI', 'NDRE', 'NDWI', 'LSWI'] },
  };
  const cropCfg = SATELITES_POR_CULTIVO[tipo_cultivo] || SATELITES_POR_CULTIVO.maiz_riego;

  let factorEtapa, etapaLabel, margen;
  if (isMango) {
    // Mango phenology (perennial)
    if (imgMonth >= 10 && imgMonth <= 11)      { factorEtapa = 0.7;  etapaLabel = 'Reposo vegetativo';     margen = 0.25; }
    else if (imgMonth === 12 || imgMonth === 1) { factorEtapa = 0.85; etapaLabel = 'Floracion';             margen = 0.20; }
    else if (imgMonth >= 2 && imgMonth <= 4)    { factorEtapa = 1.0;  etapaLabel = 'Cuaje/Desarrollo fruto'; margen = 0.10; }
    else if (imgMonth >= 5 && imgMonth <= 8)    { factorEtapa = 0.95; etapaLabel = 'Cosecha';               margen = 0.05; }
    else                                        { factorEtapa = 0.6;  etapaLabel = 'Post-cosecha';          margen = 0.30; }
    // Mango bonus: good flowering signal
    if ((imgMonth === 12 || imgMonth === 1) && ndvi_mean > 0.7) factorEtapa *= 1.05;
    // Mango penalty: water stress during fruit set
    if (imgMonth >= 2 && imgMonth <= 4 && lswi_mean < 0.05) factorEtapa *= 0.90;
  } else {
    // Maiz phenology (annual)
    if (imgMonth >= 10 && imgMonth <= 11)       { factorEtapa = 0.4;  etapaLabel = 'Siembra/temprano';      margen = 0.30; }
    else if (imgMonth === 12 || imgMonth === 1) { factorEtapa = 0.7;  etapaLabel = 'Desarrollo vegetativo'; margen = 0.25; }
    else if (imgMonth === 2 || imgMonth === 3)  { factorEtapa = 1.0;  etapaLabel = 'Floracion/Llenado';     margen = 0.10; }
    else                                        { factorEtapa = 0.95; etapaLabel = 'Madurez/Cosecha';       margen = 0.05; }
  }

  const rendimientoBase = cropCfg.rendimiento_base;
  const rendimientoEstimado = rendimientoBase * factorNDVI * factorNDRE * factorEtapa;
  const tonelajeEstimado = hectareasVal * rendimientoEstimado;
  const tonelajeMinimo = Math.round(tonelajeEstimado * (1 - margen));
  const tonelajeMaximo = Math.round(tonelajeEstimado * (1 + margen));
  const porcentajeOptima = hectareasVal > 0 ? Math.round((optHectVal / hectareasVal) * 100) : 0;

  // Mango-specific metrics
  const mangoMetrics = isMango ? {
    arboles_estimados: Math.round(hectareasVal * 100),
    frutos_por_arbol: Math.round((rendimientoEstimado * 1000) / (100 * 400)), // 400g avg fruit
    valor_cosecha_mxn: Math.round(tonelajeEstimado * (tipo_cultivo === 'mango_kent' ? 11200 : tipo_cultivo === 'mango_tommy' ? 7800 : 9500)),
    precio_ton_mxn: tipo_cultivo === 'mango_kent' ? 11200 : tipo_cultivo === 'mango_tommy' ? 7800 : 9500,
  } : null;

  // ── Harvest projection ──────────────────────────────────────────────────
  const factoresProyeccion = {
    maiz_riego:    { 'Siembra/temprano': 3.5, 'Desarrollo vegetativo': 1.8, 'Floracion/Llenado': 1.05, 'Madurez/Cosecha': 1.0 },
    maiz_temporal: { 'Siembra/temprano': 3.0, 'Desarrollo vegetativo': 1.6, 'Floracion/Llenado': 1.05, 'Madurez/Cosecha': 1.0 },
    mango_ataulfo: { 'Reposo vegetativo': 1.18, 'Floracion': 1.12, 'Cuaje/Desarrollo fruto': 1.0, 'Cosecha': 1.0, 'Post-cosecha': 1.0 },
    mango_kent:    { 'Reposo vegetativo': 1.18, 'Floracion': 1.12, 'Cuaje/Desarrollo fruto': 1.0, 'Cosecha': 1.0, 'Post-cosecha': 1.0 },
    mango_tommy:   { 'Reposo vegetativo': 1.18, 'Floracion': 1.12, 'Cuaje/Desarrollo fruto': 1.0, 'Cosecha': 1.0, 'Post-cosecha': 1.0 },
  };
  const mesesACosecha = {
    maiz_riego:    { 'Siembra/temprano': 5, 'Desarrollo vegetativo': 3, 'Floracion/Llenado': 1.5, 'Madurez/Cosecha': 0.5 },
    maiz_temporal: { 'Siembra/temprano': 5, 'Desarrollo vegetativo': 3, 'Floracion/Llenado': 1.5, 'Madurez/Cosecha': 0.5 },
    mango_ataulfo: { 'Reposo vegetativo': 6, 'Floracion': 4, 'Cuaje/Desarrollo fruto': 2, 'Cosecha': 0, 'Post-cosecha': 10 },
    mango_kent:    { 'Reposo vegetativo': 7, 'Floracion': 5, 'Cuaje/Desarrollo fruto': 3, 'Cosecha': 0, 'Post-cosecha': 11 },
    mango_tommy:   { 'Reposo vegetativo': 8, 'Floracion': 6, 'Cuaje/Desarrollo fruto': 3, 'Cosecha': 0, 'Post-cosecha': 11 },
  };
  const fp = (factoresProyeccion[tipo_cultivo] || {})[etapaLabel] || 1.0;
  const ajusteCondicion = (ndvi_mean > 0.7 && fp > 1.5) ? 1.10 : (ndvi_mean < 0.4 && fp < 1.2) ? 0.85 : 1.0;
  const rendProyectado = Math.round(rendimientoEstimado * fp * ajusteCondicion * 100) / 100;
  const tonProyectado = Math.round(hectareasVal * rendProyectado);
  const incertProyeccion = fp > 2 ? 0.30 : fp > 1.3 ? 0.20 : fp > 1.05 ? 0.10 : 0.05;
  const mesesRest = (mesesACosecha[tipo_cultivo] || {})[etapaLabel] || 0;
  const fechaCosechaEst = new Date(Date.now() + mesesRest * 30 * 86400000).toISOString().split('T')[0];
  const diasACosecha = Math.round(mesesRest * 30);

  const proyeccion = {
    ton_ha: rendProyectado,
    tonelaje_proyectado: tonProyectado,
    incremento_pct: Math.round(((rendProyectado / (rendimientoEstimado || 1)) - 1) * 1000) / 10,
    rango_min: Math.round(tonProyectado * (1 - incertProyeccion)),
    rango_max: Math.round(tonProyectado * (1 + incertProyeccion)),
    confianza: incertProyeccion <= 0.10 ? 'Alta' : incertProyeccion <= 0.20 ? 'Media' : 'Tentativa',
    fecha_cosecha: fechaCosechaEst,
    dias_a_cosecha: diasACosecha,
  };

  // ── ERA5 Climate Data ────────────────────────────────────────────────
  let climaLocal = { temp_max_c: null, precip_mm: null, fuente: 'ERA5' };
  try {
    const era5 = ee.ImageCollection('ECMWF/ERA5_LAND/MONTHLY_AGGR')
      .filterDate(ee.Date(fecha_fin).advance(-2, 'month'), fecha_fin)
      .filterBounds(geometry);
    const era5Count = await getInfoAsync(era5.size());
    if (era5Count > 0) {
      const [tempResult, precipResult] = await Promise.all([
        getInfoAsync(era5.select('temperature_2m_max').mean().subtract(273.15)
          .reduceRegion({ reducer: ee.Reducer.mean(), geometry, scale: 11132, bestEffort: true })),
        getInfoAsync(era5.select('total_precipitation_sum').sum().multiply(1000)
          .reduceRegion({ reducer: ee.Reducer.mean(), geometry, scale: 11132, bestEffort: true })),
      ]);
      climaLocal.temp_max_c = tempResult?.temperature_2m_max != null ? Math.round(tempResult.temperature_2m_max * 10) / 10 : null;
      climaLocal.precip_mm = precipResult?.total_precipitation_sum != null ? Math.round(precipResult.total_precipitation_sum * 10) / 10 : null;
    }
    console.log(`[biomass] ERA5: temp=${climaLocal.temp_max_c}C, precip=${climaLocal.precip_mm}mm`);
  } catch (e) { console.log('[biomass] ERA5 failed:', e.message); }

  // ── Frescura extendida ──────────────────────────────────────────────────
  const frescuraDias = Math.max(0, Math.round((Date.now() - new Date(s2Info.date).getTime()) / 86400000));
  const calidadFrescura = frescuraDias <= 7 ? 'Excelente' : frescuraDias <= 14 ? 'Buena' : frescuraDias <= 30 ? 'Aceptable' : 'Desactualizada';
  const coberturaEstimada = s2Info.count > 0
    ? Math.max(0, Math.min(100, Math.round(100 - (s2Info.count < 3 ? 20 : 0))))
    : 0;

  const frescura = {
    fecha_imagen: s2Info.date,
    dias_atras: frescuraDias,
    calidad: calidadFrescura,
    num_imagenes_usadas: s2Info.count,
    ventana_dias: s2WindowDays,
    cobertura_nubes_pct: coberturaEstimada,
  };

  // Satélites activos para este cultivo
  const satelitesActivos = cropCfg.satelites.map(sat => {
    if (sat === 'S2') return { id: 'S2', nombre: 'Sentinel-2', fecha: s2Info.date, imagenes: s2Info.count, estado: 'ok' };
    if (sat === 'L8') return { id: 'L8', nombre: 'Landsat 8/9', fecha: landsatInfo.date, imagenes: landsatInfo.count, estado: landsatInfo.count > 0 ? 'ok' : 'sin_datos' };
    if (sat === 'S1') return { id: 'S1', nombre: 'Sentinel-1 SAR', fecha: sarInfo.date, imagenes: sarInfo.count, estado: sarInfo.count > 0 ? 'ok' : 'sin_datos' };
    return { id: sat, estado: 'desconocido' };
  });

  // Índices calculados para este cultivo
  const indicesCalculados = cropCfg.indices.reduce((acc, idx) => {
    const vals = { NDVI: ndvi_mean, EVI: evi_mean, NDRE: ndre_mean, LSWI: lswi_mean, NDWI: ndwi_mean, SAVI: savi_mean, RVI: sarInfo.rvi };
    if (vals[idx] != null) acc[idx.toLowerCase()] = Math.round(vals[idx] * 10000) / 10000;
    return acc;
  }, {});

  return {
    ndvi_mean: Math.round(ndvi_mean * 10000) / 10000,
    evi_mean:  Math.round(evi_mean  * 10000) / 10000,
    ndre_mean: Math.round(ndre_mean * 10000) / 10000,
    lswi_mean: Math.round(lswi_mean * 10000) / 10000,
    ndwi_mean: Math.round(ndwi_mean * 10000) / 10000,
    savi_mean: Math.round(savi_mean * 10000) / 10000,
    rvi_sar:   sarInfo.rvi,
    ndvi_stdDev: Math.round(ndvi_stdDev * 10000) / 10000,
    ndvi_p25: Math.round(ndvi_p25 * 10000) / 10000,
    ndvi_p50: Math.round(ndvi_p50 * 10000) / 10000,
    ndvi_p75: Math.round(ndvi_p75 * 10000) / 10000,
    hectareas_cultivo_activo: Math.round(hectareasVal * 100) / 100,
    hectareas_area_optima: Math.round(optHectVal * 100) / 100,
    porcentaje_area_optima: porcentajeOptima,
    clasificacion_vigor,
    tonelaje_estimado: Math.round(tonelajeEstimado),
    tonelaje_minimo: tonelajeMinimo,
    tonelaje_maximo: tonelajeMaximo,
    rendimiento_por_hectarea: Math.round(rendimientoEstimado * 100) / 100,
    factor_ndvi: factorNDVI,
    factor_ndre: factorNDRE,
    factor_etapa: factorEtapa,
    rendimiento_base: rendimientoBase,
    tipo_cultivo,
    tipo_cultivo_label: cropCfg.label,
    ...(mangoMetrics ? { mango: mangoMetrics } : {}),
    proyeccion,
    fecha_inicio,
    fecha_fin,
    frescura,
    satelites_activos: satelitesActivos,
    indices_calculados: indicesCalculados,
    vhi: vhiInfo.vhi,
    lst_mean_c: vhiInfo.lst_mean_c,
    fuentes_satelitales: {
      sentinel2: { fecha: s2Info.date, imagenes: s2Info.count, ventana_dias: s2WindowDays },
      landsat89: { fecha: landsatInfo.date, imagenes: landsatInfo.count },
      sentinel1_sar: { fecha: sarInfo.date, imagenes: sarInfo.count, rvi: sarInfo.rvi },
    },
    clima_local: climaLocal,
    imagen_mas_reciente_global: s2Info.date,
    frescura_dias: frescuraDias,
    confianza_temporal: calidadFrescura,
    etapa_fenologica: etapaLabel,
    margen_incertidumbre: `±${Math.round(margen * 100)}%`,
    metodo_composicion: 'qualityMosaic top-5 NIR (imagen más reciente)',
    confianza_fusion: `Sentinel-2 — ${calidadFrescura}`,
  };
}

// ---------------------------------------------------------------------------
// Public: getBiomassExtended — SAR + MODIS + SMAP (slow, background)
// ---------------------------------------------------------------------------

async function getBiomassExtended({ coordinates, fecha_inicio, fecha_fin }) {
  assertInitialized();
  const geometry = ee.Geometry.Polygon([coordinates]);

  const safeLatest = async (col, timeProp = 'system:time_start') => {
    try {
      const count = await getInfoAsync(col.size());
      if (!count) return { count: 0, date: 'N/A' };
      const meta = await getInfoAsync(col.sort(timeProp, false).first().toDictionary([timeProp]));
      const ts = meta?.[timeProp];
      return { count, date: ts ? new Date(ts).toISOString().split('T')[0] : 'N/A' };
    } catch { return { count: 0, date: 'N/A' }; }
  };

  // Build collections
  const s1 = ee.ImageCollection('COPERNICUS/S1_GRD')
    .filterDate(fecha_inicio, fecha_fin).filterBounds(geometry)
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
    .select(['VV', 'VH']);

  const modis = ee.ImageCollection('MODIS/061/MOD13Q1')
    .filterDate(fecha_inicio, fecha_fin).filterBounds(geometry)
    .select('NDVI').map(function(img) { return img.multiply(0.0001); });

  const smap = ee.ImageCollection('NASA/SMAP/SPL4SMGP/008')
    .filterDate(fecha_inicio, fecha_fin).filterBounds(geometry)
    .select('sm_surface');

  // Get info + compute in parallel
  const [s1Info, modisInfo, smapInfo, rviVal, modisVal, smapVal] = await Promise.all([
    safeLatest(s1), safeLatest(modis), safeLatest(smap),
    // SAR RVI
    (async () => {
      try {
        const c = await getInfoAsync(s1.size());
        if (!c) return 0;
        const comp = s1.median().focal_median(30, 'circle', 'meters');
        const RVI = comp.expression('4 * VH / (VV + VH)', {
          VV: comp.select('VV'), VH: comp.select('VH')
        }).rename('RVI');
        const r = await getInfoAsync(RVI.reduceRegion({
          reducer: ee.Reducer.mean(), geometry, scale: 100, bestEffort: true, maxPixels: 1e10,
        }));
        console.log('[extended] S1 SAR OK');
        return Math.round((r?.RVI ?? 0) * 10000) / 10000;
      } catch (e) { console.log('[extended] S1 failed:', e.message); return 0; }
    })(),
    // MODIS
    (async () => {
      try {
        const c = await getInfoAsync(modis.size());
        if (!c) return 0;
        const r = await getInfoAsync(modis.mean().reduceRegion({
          reducer: ee.Reducer.mean(), geometry, scale: 250, bestEffort: true, maxPixels: 1e10,
        }));
        console.log('[extended] MODIS OK');
        return Math.round((r?.NDVI ?? 0) * 10000) / 10000;
      } catch (e) { console.log('[extended] MODIS failed:', e.message); return 0; }
    })(),
    // SMAP
    (async () => {
      try {
        const c = await getInfoAsync(smap.size());
        if (!c) return 0;
        const r = await getInfoAsync(smap.mean().reduceRegion({
          reducer: ee.Reducer.mean(), geometry, scale: 9000, bestEffort: true, maxPixels: 1e8,
        }));
        console.log('[extended] SMAP OK');
        return Math.round((r?.sm_surface ?? 0) * 10000) / 10000;
      } catch (e) { console.log('[extended] SMAP failed:', e.message); return 0; }
    })(),
  ]);

  return {
    sentinel1: { fecha: s1Info.date, imagenes: s1Info.count, tipo: 'SAR-VV+VH', rvi: rviVal },
    modis:     { fecha: modisInfo.date, imagenes: modisInfo.count, ndvi: modisVal },
    smap:      { fecha: smapInfo.date, imagenes: smapInfo.count, humedad_suelo_pct: Math.round(smapVal * 100 * 10) / 10 },
  };
}

// ---------------------------------------------------------------------------
// Public: getBiomassGrid — Per-cell grid analysis over a polygon
// ---------------------------------------------------------------------------

/**
 * Divides the polygon into a grid of ~1km x 1km cells, computes NDVI/EVI/NDRE
 * per cell using a single reduceRegions call, and returns tonnage per cell.
 *
 * @param {object} params
 * @param {number[][]} params.coordinates  — [[lng,lat], ...]
 * @param {string}     params.fecha_inicio — YYYY-MM-DD
 * @param {string}     params.fecha_fin    — YYYY-MM-DD
 * @param {number}     [params.cell_size_km=1] — cell side in km
 * @returns {Promise<object>}
 */
async function getBiomassGrid({ coordinates, fecha_inicio, fecha_fin, cell_size_km }) {
  assertInitialized();
  const geometry = ee.Geometry.Polygon([coordinates]);

  // Get actual area from GEE (accurate, not bounding box)
  const areaHa = await getInfoAsync(geometry.area().divide(10000));
  const lats = coordinates.map(c => c[1]);
  const lngs = coordinates.map(c => c[0]);

  // Cell size in meters based on area
  let cellMetros = cell_size_km ? cell_size_km * 1000 :
    areaHa < 10   ? 10  :
    areaHa < 50   ? 20  :
    areaHa < 200  ? 30  :
    areaHa < 1000 ? 50  :
    areaHa < 5000 ? 100 : 250;

  // Convert meters to degrees
  const avgLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const cellLat = cellMetros / 111320;
  const cellLng = cellMetros / (111320 * Math.cos(avgLat * Math.PI / 180));

  // Bounding box
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);

  // Generate grid points in JavaScript
  let gridPoints = [];
  for (let lat = minLat + cellLat / 2; lat < maxLat; lat += cellLat) {
    for (let lng = minLng + cellLng / 2; lng < maxLng; lng += cellLng) {
      gridPoints.push([lng, lat]);
    }
  }

  // Cap at 1500 points — increase cell size if needed
  if (gridPoints.length > 1500) {
    const ratio = Math.sqrt(gridPoints.length / 1500);
    cellMetros = Math.ceil(cellMetros * ratio / 10) * 10;
    const newCellLat = cellMetros / 111320;
    const newCellLng = cellMetros / (111320 * Math.cos(avgLat * Math.PI / 180));
    gridPoints = [];
    for (let lat = minLat + newCellLat / 2; lat < maxLat; lat += newCellLat) {
      for (let lng = minLng + newCellLng / 2; lng < maxLng; lng += newCellLng) {
        gridPoints.push([lng, lat]);
      }
    }
  }

  console.log(`[grid] Area: ${Math.round(areaHa)} ha, celda: ${cellMetros}m, puntos bbox: ${gridPoints.length}`);

  // Sentinel-2 composite
  const sentinel = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterDate(fecha_inicio, fecha_fin)
    .filterBounds(geometry)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20));

  const imageCount = await getInfoAsync(sentinel.size());
  if (!imageCount) throw new Error('No se encontraron imagenes Sentinel-2.');

  const scaled = sentinel.median().divide(10000);
  const NDVI = scaled.normalizedDifference(['B8', 'B4']).rename('NDVI');
  const EVI = scaled.expression(
    '2.5 * ((NIR - RED) / (NIR + 6*RED - 7.5*BLUE + 1))',
    { NIR: scaled.select('B8'), RED: scaled.select('B4'), BLUE: scaled.select('B2') }
  ).rename('EVI');
  const NDRE = scaled.normalizedDifference(['B8', 'B5']).rename('NDRE');
  const indexStack = NDVI.addBands(EVI).addBands(NDRE);

  // Create GEE point collection, filter inside polygon, sample values
  const pointCollection = ee.FeatureCollection(gridPoints.map(p => ee.Feature(ee.Geometry.Point(p))));
  const insidePoints = pointCollection.filterBounds(geometry);
  const sampled = indexStack.sampleRegions({
    collection: insidePoints,
    scale: Math.min(cellMetros, 10),
    geometries: true,
  });

  const features = await getInfoAsync(sampled);
  if (!features || !features.features) throw new Error('GEE no devolvio resultados.');

  console.log(`[grid] ${features.features.length} puntos dentro del poligono`);

  const rendimientoBase = 9.5;
  const haPorCelda = (cellMetros * cellMetros) / 10000;
  const gridCells = [];
  let totalTonelaje = 0;

  for (const f of features.features) {
    const props = f.properties || {};
    const ndvi = props.NDVI;
    if (ndvi == null || ndvi <= 0.35) continue;
    const coords = f.geometry?.coordinates;
    if (!coords) continue;

    const factorNDVI = Math.min(1.0, Math.max(0.3, (ndvi - 0.2) / 0.6));
    const ndre = props.NDRE;
    const factorNDRE = (ndre != null && ndre > 0.3) ? 1.0 : (ndre != null && ndre > 0.2) ? 0.9 : 0.75;
    const rendimiento = rendimientoBase * factorNDVI * factorNDRE;
    totalTonelaje += haPorCelda * rendimiento;

    const color = rendimiento > 10 ? '#1a5c1a' : rendimiento > 8 ? '#2e7d32' : rendimiento > 6 ? '#4caf50' : rendimiento > 4 ? '#cddc39' : rendimiento > 2 ? '#ff9800' : '#f44336';

    gridCells.push({
      lat: Math.round(coords[1] * 100000) / 100000,
      lng: Math.round(coords[0] * 100000) / 100000,
      ndvi: Math.round(ndvi * 1000) / 1000,
      evi: Math.round((props.EVI || 0) * 1000) / 1000,
      ndre: Math.round((ndre || 0) * 1000) / 1000,
      hectareas: haPorCelda,
      tonelaje_estimado: Math.round(haPorCelda * rendimiento * 100) / 100,
      rendimiento_ton_ha: Math.round(rendimiento * 100) / 100,
      vigor: ndvi > 0.7 ? 'Alto' : ndvi > 0.5 ? 'Medio' : 'Bajo',
      color_hex: color,
    });
  }

  console.log(`[grid] ${gridCells.length} celdas con cultivo de ${features.features.length} total`);

  return {
    grid: gridCells,
    total_celdas: features.features.length,
    celdas_con_cultivo: gridCells.length,
    cell_size_km: cellMetros / 1000,
    cell_size_m: cellMetros,
    ha_por_celda: Math.round(haPorCelda * 10000) / 10000,
    area_ha: Math.round(areaHa),
    area_km2: Math.round(areaHa / 100 * 10) / 10,
    resumen: {
      tonelaje_total: Math.round(totalTonelaje),
      hectareas_con_cultivo: Math.round(gridCells.length * haPorCelda * 100) / 100,
      rendimiento_promedio: gridCells.length > 0
        ? Math.round((totalTonelaje / (gridCells.length * haPorCelda)) * 100) / 100 : 0,
      fecha_inicio, fecha_fin, imagenes_usadas: imageCount,
    },
  };
}

module.exports = { initGEE, getTileConfig, getPixelValues, getBiomassAnalysis, getBiomassExtended, getBiomassGrid };
