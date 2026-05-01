-- AgroCrop v5.1 — Sistema de calibración regional
-- Run this in: Supabase → SQL Editor

CREATE TABLE IF NOT EXISTS calibraciones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parcela_id TEXT,                    -- local SQLite UUID (no FK, app uses SQLite)
  usuario_id TEXT,

  -- Análisis satelital
  fecha_analisis TIMESTAMP DEFAULT NOW(),
  ndvi_promedio DECIMAL(6,4),
  evi_promedio DECIMAL(6,4),
  ndre_promedio DECIMAL(6,4),
  prediccion_ton_ha DECIMAL(8,2),
  prediccion_total_ton DECIMAL(10,2),
  fecha_imagen_satelital TEXT,

  -- Cosecha real (ingresada por el productor)
  fecha_cosecha DATE,
  cosecha_real_ton DECIMAL(10,2),
  rendimiento_real_ton_ha DECIMAL(8,2),
  precio_venta_mxn DECIMAL(10,2),

  -- Contexto
  tipo_cultivo TEXT,
  variedad TEXT,
  municipio TEXT,
  estado TEXT DEFAULT 'Sinaloa',
  sistema_riego TEXT,
  tipo_suelo TEXT,

  -- Métricas de error (calculadas automáticamente)
  error_absoluto_ton DECIMAL(10,2),
  error_porcentual DECIMAL(6,2),
  factor_correccion DECIMAL(6,4),

  -- Validación
  verificado BOOLEAN DEFAULT false,
  creado_en TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cal_tipo_cultivo ON calibraciones(tipo_cultivo);
CREATE INDEX IF NOT EXISTS idx_cal_municipio ON calibraciones(municipio);
CREATE INDEX IF NOT EXISTS idx_cal_ndvi ON calibraciones(ndvi_promedio);
CREATE INDEX IF NOT EXISTS idx_cal_factor ON calibraciones(factor_correccion);

-- Vista: factores de corrección por zona y cultivo
CREATE OR REPLACE VIEW factores_correccion_regional AS
SELECT
  tipo_cultivo,
  municipio,
  ROUND(AVG(ndvi_promedio)::numeric, 3)     AS ndvi_promedio,
  ROUND(AVG(factor_correccion)::numeric, 4) AS factor_promedio,
  ROUND(AVG(error_porcentual)::numeric, 2)  AS error_promedio_pct,
  COUNT(*)                                   AS total_muestras,
  ROUND(STDDEV(factor_correccion)::numeric, 4) AS variabilidad
FROM calibraciones
WHERE factor_correccion BETWEEN 0.5 AND 2.0
  AND cosecha_real_ton > 0
GROUP BY tipo_cultivo, municipio
HAVING COUNT(*) >= 3;

-- Vista: precisión global por cultivo
CREATE OR REPLACE VIEW precision_por_cultivo AS
SELECT
  tipo_cultivo,
  COUNT(*)                                         AS total_cosechas,
  ROUND(AVG(ABS(error_porcentual))::numeric, 1)   AS error_promedio_pct,
  ROUND(MIN(ABS(error_porcentual))::numeric, 1)   AS mejor_prediccion_pct,
  ROUND(MAX(ABS(error_porcentual))::numeric, 1)   AS peor_prediccion_pct
FROM calibraciones
WHERE cosecha_real_ton > 0
GROUP BY tipo_cultivo;

-- RLS: cualquiera puede insertar (app mobile anon), solo lectura pública
ALTER TABLE calibraciones ENABLE ROW LEVEL SECURITY;
CREATE POLICY "insert_anon" ON calibraciones FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "select_anon" ON calibraciones FOR SELECT TO anon USING (true);
