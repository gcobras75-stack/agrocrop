// app/core/AgroCropService.ts — Multi-polygon + OCR for AgroCrop

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
  const apiKey = process.env.EXPO_PUBLIC_CLAUDE_API_KEY?.trim();
  if (!apiKey) throw new Error('EXPO_PUBLIC_CLAUDE_API_KEY no configurada');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64Image },
          },
          {
            type: 'text',
            text: `Extrae TODAS las coordenadas de los vertices del poligono que aparecen en este titulo parcelario mexicano (RAN, Procede, escritura agraria).

Formatos posibles:
- UTM: "X: 279589.73 m E, Y: 2699301.26 m N, Zona 13R"
- Decimal: "Lat: 24.3994, Lng: -107.1714"
- GMS: "24 23 58 N, 107 10 17 W"
- Tabla con columnas V1, V2, etc.

Si las coordenadas vienen en UTM, conviertelas a decimal WGS84 usando la zona indicada.

Devuelve SOLO JSON valido:
{
  "vertices_detectados": [
    {"vertice": 1, "lat": 24.3994, "lng": -107.1714}
  ],
  "formato_origen": "UTM_13R",
  "datos_adicionales": {
    "superficie_ha": 5.4,
    "propietario": "...",
    "ejido": "...",
    "municipio": "..."
  },
  "confianza": "alta",
  "notas": "..."
}

Si no hay coordenadas legibles devuelve:
{"error": "No se detectaron coordenadas", "razon": "..."}`
          }
        ]
      }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude Vision error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text || '';
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude no devolvio JSON valido');

  const parsed = JSON.parse(match[0]);
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
