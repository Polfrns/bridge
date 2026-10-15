# Resultados ejecutados — v0.7.1

Entorno: Linux, Node v24.19.0, npm 11.9.0, Python 3.12.14, Docker Compose v2.40.3. Dependencias obtenidas de los manifests/lockfiles de los ZIP adjuntos; sin usar implementaciones de versiones anteriores.

## Pruebas ejecutadas sobre el código final

| Grupo | Resultado | Qué protege |
|---|---:|---|
| Bridge, suite Node completa con Python habilitado | **128/128**, sin omitidas | Codex/Claude, clasificación fiable, web, workspace, archivos, streaming Chat/Responses en tiempo real, V1 original y ampliado, cierre de estados, reintentos, aislamiento, sesiones, contexto firmado, exportación OTLP real privada y rechazo de marcadores de actividad forjados en razonamiento del modelo |
| Bridge, toolkit Python original | **9/9** | DOCX/PDF y Office reales, edición acumulativa, imágenes/HEIF, archivo de código sin ejecución automática, archivos comprimidos, aislamiento de lectores, conversión y medios |
| Roko, consumidores V1 y componentes React | **8/8** | Tarjetas originales, estados, duración, cancelación, reintentos y rechazo de nombres/rutas no autorizados |
| Roko, suites SDK de telemetría y contexto Bridge | **24/24** | Ciclo de vida OTEL, privacidad de URL, compatibilidad de identidad firmada y configuración existente |
| Roko, scripts de observabilidad | **4/4** | Sesiones por usuario/conversación/tenant, aislamiento de AsyncLocalStorage, destinos autorizados y exportación por el SDK real de agents con DOCX/PDF/código de control |
| Filestore, suite completa con SQLite | **240/240** | Contratos y registro de las 12 herramientas, lectura/escritura, permisos, usuarios, autenticación, KB, contexto y privacidad de exportación, excepciones y cancelaciones |
| Correlación entre los tres repositorios | **1/1** | Roko firma; Bridge verifica identidad/sesión; Python Filestore verifica la misma firma, conserva traceId/parentSpanId/sessionId y devuelve el resultado original, incluyendo tenant distinto |

**414 pruebas superadas. 0 fallidas u omitidas en estas ejecuciones finales.** Algunas primeras ejecuciones detectaron problemas de instalación/configuración y aserciones que se corrigieron antes de repetir las pruebas. Los resultados de arriba corresponden al código entregado.

## Comandos reproducibles

Desde Bridge, después de instalar las dependencias y disponer de las bibliotecas del toolkit:

```bash
npm ci
# Usa tu Python provisionado; en Docker será el del toolkit de la imagen.
FILE_TEST_PYTHON=/ruta/a/python node --test --test-concurrency=1 --test-timeout=30000 test/*.test.mjs
python -m unittest -v test/file_tools_test.py
```

FILE_TEST_PYTHON se especificó con el Python 3.12 del entorno, que tenía python-docx, PyMuPDF, openpyxl, python-pptx, Pillow, pillow-heif y py7zr. No se marca como validado un test omitido por faltar esa variable. La ejecución final tuvo todas las pruebas habilitadas. Se usa concurrencia 1 para evitar interferencia entre pruebas que lanzan y cancelan procesos del sandbox.

Desde Roko:

```bash
npm ci
npm run observability:patch
npm run frontend
node --test scripts/observability.test.cjs scripts/otel-export.test.cjs
cd client
npx jest --runInBand --coverage=false src/components/Chat/Messages/Content/__tests__/bridgeToolRecords.test.ts src/components/Chat/Messages/Content/__tests__/BridgeToolReasoning.test.tsx
# Desde packages/api:
npx jest --runInBand --coverage=false src/utils/rokoBridge.spec.ts src/telemetry/sdk.spec.ts
```

Desde Filestore (el settings de SQLite es exclusivamente para pruebas locales):

```bash
python -m pip install -r requirements-dev.txt
python -m pytest -q --ds=tests.settings_sqlite
```

Desde la raíz del paquete completo, con las dependencias de cada repo instaladas:

```bash
node --test verification/cross-service.test.cjs
```

Además se ejecutaron satisfactoriamente:

- `npm run frontend` de Roko (todos los paquetes y frontend), compilación del API y build final de client después de los cambios correspondientes.
- Instalación limpia de Roko desde el lockfile corregido; comprobación posterior con `npm ci --ignore-scripts --no-audit --no-fund --dry-run`.
- Prueba del API compilado confirmando que comparte el contexto AsyncLocalStorage con el SDK nativo.
- Instalación del parche agents desde archivos originales de @librechat/agents 3.2.35 y segunda aplicación idempotente.
- `docker compose config -q` usando el binario oficial Compose v2.40.3 para Bridge, Roko con override, Filestore producción y Filestore tests. En todos los casos la definición es válida; los servicios tienen image o build.
- Conservación byte a byte del archivo Bitbucket Pipelines del adjunto.
- Revisión de los ZIP para excluir .env, credenciales locales, bases de datos, uploads, logs, node_modules, .git, runtime-tools, entornos virtuales, binarios de ejecución y temporales. Los valores de claves en .env.example se dejan vacíos; el despliegue debe conservar su .env privado original.

## No ejecutado

- No se han usado tus cuentas reales Codex/Claude ni se han hecho inferencias de pago/suscripción.
- No se ha accedido a tus proyectos Langfuse ni se ha probado su interfaz Sessions en producción. Sí se capturaron exportaciones del SDK real en un receptor OTLP local y se verificaron atributos/jerarquía/sesiones/ausencia de datos sensibles.
- No se ejecutaron builds ni contenedores Docker: está disponible el cliente Compose para validación de configuración, sin daemon Docker.
- No se ejecutaron /opt/test.sh ni /opt/deploy.sh: son scripts de tu runner, no estaban adjuntos.
- La suite de Filestore usó SQLite, no PostgreSQL. El pipeline original conserva sus tests con PostgreSQL mediante docker-compose.test.yml.
- No se ejecutó toda la suite global de LibreChat ni E2E en navegador; se ejecutaron las suites relevantes y las compilaciones indicadas.

Las comprobaciones pendientes de tu entorno están en VERIFY-LANGFUSE.md y las limitaciones de instrumentación en LIMITATIONS.md.
