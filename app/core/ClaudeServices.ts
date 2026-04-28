// app/core/ClaudeServices.ts
// GeologicalEngine removed — type kept for legacy function signature
type AnalysisPoint = { id: string; rank: number; base_score: number; indices: any; lat: number; lng: number };

// ─── MODELOS ───────────────────────────────────────────
const MODEL_FAST   = 'claude-haiku-4-5-20251001';   // Cámara y chat
const MODEL_SMART  = 'claude-sonnet-4-6';            // Análisis espectral

// ─── RETRY CON BACKOFF EXPONENCIAL ─────────────────────
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  let lastError: Error = new Error('Unknown error');
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429) {
        const waitMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      return response;
    } catch (e: any) {
      lastError = e;
      const waitMs = Math.pow(2, attempt) * 1000;
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw lastError;
}

// ─── HEADERS COMUNES ───────────────────────────────────
function getHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
}

// ─── VALIDAR API KEY ────────────────────────────────────
function getApiKey(): string {
  const key = process.env.EXPO_PUBLIC_CLAUDE_API_KEY?.trim();
  if (!key) throw new Error('Configura EXPO_PUBLIC_CLAUDE_API_KEY en tu .env');
  return key;
}

// ═══════════════════════════════════════════════════════
// 1. ANÁLISIS DE IMAGEN DE ROCA
// ═══════════════════════════════════════════════════════
export interface ClaudeAnalysis {
  mineral_detectado: string;
  probabilidad: number;
  indicadores: string[];
  alteracion: string;
  fluorescencia_uv: string;
  recomendacion: string;
  analisis_detallado: string;
}

export async function analyzeRockImageWithClaude(
  base64Image: string,
  captureType: string
): Promise<ClaudeAnalysis> {
  const API_KEY = getApiKey();

  let promptContext = "Muestra de campo estándar capturada con cámara normal de smartphone.";
  if (captureType === 'microscopio') {
    promptContext = "Imagen macro capturada con microscopio de alta magnificación. Busca cristales micrométricos, texturas finas y estructuras internas críticas.";
  } else if (captureType.startsWith('uv_')) {
    promptContext = `Imagen bajo iluminación UV tipo ${captureType}. Analiza patrones de fluorescencia espectral (Tungsteno, Fluorita, Scheelita, Calcita, Uranio secundario).`;
  }

  const payload = {
    model: MODEL_FAST,
    max_tokens: 1500,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: base64Image }
        },
        {
          type: "text",
          text: `Actúa como el mejor geólogo del mundo experto en alteraciones y metalogenia. Analiza visualmente esta muestra. ${promptContext}

Identifica el metal o mineral evaluando texturas, alteraciones y colores. Sé definitivo y preciso.

Devuelve EXCLUSIVAMENTE JSON válido (sin markdown):
{
  "mineral_detectado": "Ej. Cuarzo aurífero con arsenopirita",
  "probabilidad": 85,
  "indicadores": ["textura en peineta", "fuerte lixiviación"],
  "alteracion": "Ej. Argílica avanzada",
  "fluorescencia_uv": "N/A o describe color y mineral bajo UV",
  "analisis_detallado": "Explicación técnica de las paragénesis observadas.",
  "recomendacion": "Acción directa de campo. Ej: 🔴 Muestreo sistemático de canal."
}`
        }
      ]
    }]
  };

  const response = await fetchWithRetry(
    'https://api.anthropic.com/v1/messages',
    { method: 'POST', headers: getHeaders(API_KEY), body: JSON.stringify(payload) }
  );

  if (!response.ok) {
    const err = await response.text();
    let msg = err;
    try { msg = JSON.parse(err).error?.message || err; } catch {}
    throw new Error(`Anthropic (${response.status}): ${msg.substring(0, 100)}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text || '';
  const match = content.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (parseErr) {
      throw new Error('Error al parsear JSON de la IA. Respuesta: ' + content.substring(0, 120));
    }
  }

  throw new Error('La IA no devolvió un JSON válido. Respuesta recibida: ' + (content.substring(0, 120) || '(vacía)'));
}

// ═══════════════════════════════════════════════════════
// 2. ANÁLISIS ESPECTRAL POR LOTE (usa Sonnet - más inteligente)
// ═══════════════════════════════════════════════════════
export interface IndiceAnalizado {
  nombre: string;
  valor: number;
  nivel: 'ALTO' | 'MEDIO' | 'BAJO';
  interpretacion: string;
}

export interface SpectralAnalysisResult {
  id: string;
  score: number;
  indices_analizados: IndiceAnalizado[];
  analisis_integral: string;
  geologia_interpretada: string;
  recomendacion: string;
}

export async function analyzeSpectralCandidatesBatch(
  candidates: AnalysisPoint[],
  mineral: string,
  terrain: string,
  rockType: string
): Promise<SpectralAnalysisResult[]> {
  const API_KEY = getApiKey();

  const candidatesData = candidates.map(c => ({
    id: c.id, rank: c.rank, base_score: c.base_score, indices: c.indices
  }));

  const prompt = `Eres un Geólogo Principal experto en exploración de recursos minerales.
Analiza índices espectrales de ${candidates.length} puntos candidatos.
Mineral objetivo: ${mineral.toUpperCase()}
Contexto: Terreno "${terrain}", roca dominante "${rockType}".

Interpreta los valores como anomalías espectrales reales de satélites hiperespectrales.
Genera análisis PROFESIONAL y ESPECÍFICO basado en los valores numéricos.

Datos:
${JSON.stringify(candidatesData, null, 2)}

Devuelve EXCLUSIVAMENTE un arreglo JSON válido (sin markdown):
[
  {
    "id": "MISMO_ID_DEL_CANDIDATO",
    "score": 98,
    "indices_analizados": [
      {
        "nombre": "Gossan",
        "valor": 0.87,
        "nivel": "ALTO",
        "interpretacion": "Oxidación intensa, sombrero de hierro sobre veta"
      }
    ],
    "analisis_integral": "Explicación técnica con datos numéricos del porqué indica el mineral.",
    "geologia_interpretada": "Modelo geológico proyectado (ej. Zona epitermal con vetas de cuarzo).",
    "recomendacion": "ACCIÓN ESPECÍFICA. Ej: 🔴 MUESTREO URGENTE - Tomar muestra en afloramiento."
  }
]`;

  const payload = {
    model: MODEL_SMART,   // Sonnet para análisis complejo
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }]
  };

  const response = await fetchWithRetry(
    'https://api.anthropic.com/v1/messages',
    { method: 'POST', headers: getHeaders(API_KEY), body: JSON.stringify(payload) }
  );

  if (!response.ok) throw new Error('Fallo al conectar con Claude Sonnet.');

  const data = await response.json();
  const content = data.content?.[0]?.text || '';
  const match = content.match(/\[[\s\S]*\]/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return [];
}

// ═══════════════════════════════════════════════════════
// 3. CHAT GEÓLOGO (historial limitado a últimos 10)
// ═══════════════════════════════════════════════════════
export async function askClaudeGeologist(
  messagesHistory: { role: string; content: string }[]
): Promise<string> {
  const API_KEY = getApiKey();

  // FIX: Limitar a los últimos 10 mensajes para no explotar contexto ni costo
  const limitedHistory = messagesHistory.slice(-10);

  const payload = {
    model: MODEL_FAST,
    max_tokens: 1000,
    system: "Eres el asistente IA de ProspectorAI (Expo, React Native, TypeScript, SQLite). Ayuda al desarrollador con código, arquitectura, motor de prospección y geología. Eres Ing. de Software Elite y Geólogo.",
    messages: limitedHistory
  };

  const response = await fetchWithRetry(
    'https://api.anthropic.com/v1/messages',
    { method: 'POST', headers: getHeaders(API_KEY), body: JSON.stringify(payload) }
  );

  if (!response.ok) {
    const err = await response.text();
    let msg = err;
    try { msg = JSON.parse(err).error?.message || err; } catch {}
    throw new Error(`Anthropic: ${msg.substring(0, 100)}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || '';
}

// ═══════════════════════════════════════════════════════
// 4. ANÁLISIS AGRÍCOLA DE BIOMASA (AgroCrop)
// ═══════════════════════════════════════════════════════
export interface CropBiomassStats {
  ndvi_mean: number;
  evi_mean: number;
  ndre_mean: number;
  lswi_mean: number;
  hectareas_cultivo_activo: number;
  tonelaje_estimado: number;
  tonelaje_minimo: number;
  tonelaje_maximo: number;
  rendimiento_por_hectarea: number;
  porcentaje_area_optima: number;
  clasificacion_vigor: string;
}

export async function analyzeCropBiomassWithClaude(
  stats: CropBiomassStats,
  tipoCultivo: string
): Promise<string> {
  const API_KEY = getApiKey();

  const isMango = tipoCultivo.toLowerCase().includes('mango');
  const baseData = `Indices satelitales Sentinel-2 de ${stats.hectareas_cultivo_activo} hectareas, Sinaloa:
- NDVI: ${stats.ndvi_mean} (vigor)
- EVI: ${stats.evi_mean} (biomasa)
- NDRE: ${stats.ndre_mean} (nitrogeno)
- LSWI: ${stats.lswi_mean} (estres hidrico)
- Vigor: ${stats.clasificacion_vigor}
- Tonelaje estimado: ${stats.tonelaje_estimado} ton (${stats.tonelaje_minimo}-${stats.tonelaje_maximo})
- Rendimiento: ${stats.rendimiento_por_hectarea} ton/ha
- Area optima: ${stats.porcentaje_area_optima}%
- Cultivo: ${tipoCultivo}`;

  const prompt = isMango
    ? `Eres agronomo experto en produccion de mango en Escuinapa, Sinaloa (zona #1 productora de Ataulfo en Mexico).
Analiza estos datos de una huerta de ${tipoCultivo}:
${baseData}

Proporciona:
1. Estado sanitario del huerto (vigor follaje, densidad copa)
2. Estimacion de cosecha en toneladas (rango)
3. Si en floracion (Ene-Feb): pronostico de cuaje
4. Si en cuaje (Feb-Mar): riesgo de aborto floral
5. Si en desarrollo (Mar-May): tamano esperado de fruto
6. Recomendaciones especificas:
   - Riego (cantidad y frecuencia)
   - Fertilizacion foliar
   - Control de antracnosis (Colletotrichum)
   - Control de mosca de la fruta
7. Comparativo con promedio Escuinapa: Ataulfo 12, Kent 14, Tommy 16 ton/ha
8. Valor estimado de cosecha en MXN (Ataulfo $9,500, Kent $11,200, Tommy $7,800/ton)

Responde en espanol tecnico pero comprensible.`
    : `Eres un agronomo experto en cultivos de maiz del Valle de Culiacan, Sinaloa.
Analiza estos datos de ${tipoCultivo}:
${baseData}

Proporciona:
1. Diagnostico del estado actual del cultivo
2. Estimacion de produccion con rango min-max en toneladas
3. Factores de riesgo (estres hidrico, deficit nutricional)
4. Recomendaciones de manejo agronomico para esta zona
5. Comparacion con promedio historico del Valle de Culiacan

Responde en espanol tecnico pero comprensible.`;

  const payload = {
    model: MODEL_SMART,
    max_tokens: 2500,
    messages: [{ role: 'user', content: prompt }]
  };

  const response = await fetchWithRetry(
    'https://api.anthropic.com/v1/messages',
    { method: 'POST', headers: getHeaders(API_KEY), body: JSON.stringify(payload) }
  );

  if (!response.ok) {
    const err = await response.text();
    let msg = err;
    try { msg = JSON.parse(err).error?.message || err; } catch {}
    throw new Error(`Anthropic: ${msg.substring(0, 100)}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || 'No se obtuvo respuesta del análisis.';
}

export default function DummyClaudeRoute() { return null; }
