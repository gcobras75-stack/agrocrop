// app/core/AgroCropService.ts — Multi-polygon + OCR for AgroCrop

/** Validates a coordinate array before sending to the server. */
export function validarCoordenadasCliente(
  coords: Array<{ latitude: number; longitude: number }>
): boolean {
  if (!coords || coords.length < 3 || coords.length > 500) return false;
  return coords.every(
    c =>
      typeof c.latitude === 'number' &&
      typeof c.longitude === 'number' &&
      c.latitude >= -90 && c.latitude <= 90 &&
      c.longitude >= -180 && c.longitude <= 180 &&
      !isNaN(c.latitude) && !isNaN(c.longitude)
  );
}

export interface AgroCropPolygon {
  id: string;
  nombre: string;
  origen: 'manual' | 'coordenadas' | 'foto_titulo' | 'circulo';
  coords: { latitude: number; longitude: number }[];
  hectareas: number;
  color: string;
  datosOCR?: {
    propietario?: string;
    ejido?: string;
    municipio?: string;
    superficie_ha?: number;
    formato_origen?: string;
    confianza?: string;
  };
  resultado?: any; // BiomassAnalysisResult
}

const POLYGON_COLORS = ['#FFC107', '#00BCD4', '#E040FB', '#76FF03', '#FF5722', '#2196F3', '#FF9800', '#4CAF50'];

export function getPolygonColor(index: number): string {
  return POLYGON_COLORS[index % POLYGON_COLORS.length];
}

export function generatePolygonId(): string {
  return `poly_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
}

// ── OCR: Extract coordinates from parcel title photo ──────────────────

export async function extractCoordsFromPhoto(base64Image: string): Promise<{
  vertices: { vertice: number; lat: number; lng: number }[];
  datos?: { propietario?: string; ejido?: string; municipio?: string; superficie_ha?: number };
  formato_origen?: string;
  confianza?: string;
  error?: string;
}> {
  const serverUrl = process.env.EXPO_PUBLIC_SERVER_URL?.trim();
  if (!serverUrl) throw new Error('EXPO_PUBLIC_SERVER_URL no configurada');

  const response = await fetch(`${serverUrl}/api/ocr-titulo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imagenBase64: base64Image }),
  });

  if (!response.ok) {
    const err = await response.text();
    let msg = err;
    try { msg = JSON.parse(err).error || err; } catch {}
    throw new Error(`OCR servidor error: ${msg.substring(0, 100)}`);
  }

  const parsed = await response.json();
  if (parsed.error) throw new Error(parsed.error);

  return {
    vertices: parsed.vertices_detectados || [],
    datos: parsed.datos_adicionales,
    formato_origen: parsed.formato_origen,
    confianza: parsed.confianza,
  };
}

// ── Consolidated analysis summary ─────────────────────────────────────

export function calcConsolidatedSummary(polygons: AgroCropPolygon[]): {
  totalHectareas: number;
  totalTonelaje: number;
  promedioRendimiento: number;
  totalValorMXN: number;
} {
  const analyzed = polygons.filter(p => p.resultado);
  const totalHa = analyzed.reduce((s, p) => s + (p.resultado?.hectareas_cultivo_activo || 0), 0);
  const totalTon = analyzed.reduce((s, p) => s + (p.resultado?.tonelaje_estimado || 0), 0);
  const totalValor = analyzed.reduce((s, p) => s + (p.resultado?.mango?.valor_cosecha_mxn || 0), 0);
  return {
    totalHectareas: Math.round(totalHa * 100) / 100,
    totalTonelaje: Math.round(totalTon),
    promedioRendimiento: totalHa > 0 ? Math.round((totalTon / totalHa) * 100) / 100 : 0,
    totalValorMXN: totalValor,
  };
}
