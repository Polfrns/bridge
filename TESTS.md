# Pruebas y comprobaciones

## Suite reproducible

La referencia completa Linux es la etapa ci del Dockerfile, que ejecuta el workflow [bridge-ci-deploy.yml](.github/workflows/bridge-ci-deploy.yml):

```bash
docker build --target ci --tag bridge-ci-check:local .
```

Construye una imagen de prueba sin levantar servicios ni desplegarla. La imagen production hereda de ci, por lo que un test fallido también bloquea su construcción. El pipeline usa ese mismo recorrido de build.

En un entorno Linux ya provisionado:

```bash
npm ci
npm run setup:files
sh ci/test.sh
```

ci/test.sh desactiva tracing externo, ejecuta Node con concurrencia 1 y timeout de 120000 ms por prueba, y después unittest Python. Usa FILE_TEST_PYTHON si el Python provisionado no está en runtime-tools/bin/python.

Para una comprobación dirigida:

```bash
node --test test/langfuse-tools.test.mjs test/live-answer.test.mjs
```

npm test ejecuta solo las pruebas Node. No sustituye la suite Python ni garantiza que estén presentes las herramientas opcionales. Los tests de toolkit requieren Python provisionado; un caso omitido no equivale a una capacidad validada.

## Cobertura

| Área | Regresiones relevantes |
| --- | --- |
| HTTP, protocolo e identidad | Bearer/HMAC, aislamiento por propietario, JSON inválido, límites, Responses previo y reasoning replay tras función. |
| Opciones y proveedores | Presets medium/high, esfuerzos admitidos, precedencia, allowlists, capacidades y desactivación efectiva de búsqueda. |
| Texto en directo | Claude/Codex × Chat/Responses, fragmentos JSON/Unicode, instantáneas sin duplicados, orden de índices SSE y fallback sin parciales. |
| Barreras de entrega | Recepción del texto antes de terminar el proveedor; archivos y funciones retenidos hasta validar; reparación sin publicar éxito prematuro. |
| Fallos y cancelación | Timeout, desconexión, sustitución de texto y JSON final inválido sin final exitoso ni reparación de prosa ya emitida. |
| Actividad y trazas | Estados/IDs/intentos, un único terminal y cierre; contenido saneado antes de exportar; contexto remoto firmado, aislamiento y métricas. |
| Sandbox y runtime | Preparación/limpieza, credenciales mínimas, rutas, symlinks, cancelación y launchers simulados. |
| Toolkit | Documentos e imágenes reales, extracción, conversión, medios y validación con dependencias instaladas. |

live-answer.test.mjs incluye 33 casos. Sus barreras HTTP fallan si el texto se retiene hasta completar el proveedor. Las esperas de reparación decodifican registros V1 y comprueban workspace.validate/started/attempt=2; no dependen de traducciones ni búsquedas dentro del Base64.

langfuse-tools.test.mjs identifica la actualización terminal por metadata.state y exige una sola. Las actualizaciones de contenido saneado pueden precederla; no se presupone updates[0].metadata.

Los tests de privacidad de exportación no deben confundirse con la política del chat: los detalles públicos de herramientas pueden verse en la conversación autenticada mientras redacted los excluye de Langfuse.

## Último resultado registrado

Sobre el código actual (herramientas ampliadas y relay con varias llamadas) se ejecutó:

```bash
docker build --target ci --tag bridge-tools-ci .
```

Resultado: **215 pruebas Node y 11 pruebas Python aprobadas, sin omisiones**, incluido el recálculo de fórmulas con LibreOffice real. En la misma imagen, con las opciones de seguridad de compose, `check:workspace` verificó aislamiento, edición DOCX, gráfico pandas/matplotlib y disponibilidad de pandoc y dot en el sandbox; una prueba manual generó PDF con WeasyPrint y reportlab y los leyó con pdfplumber dentro del sandbox. La ejecución anterior (210 Node y 9 Python) incluía además 23 pruebas dirigidas de observabilidad que no se han repetido.

## Comprobaciones del host

| Comando | Qué comprueba |
| --- | --- |
| npm run check:workspace | Sandbox restringido de Claude; edición DOCX adicional si existe toolkit. Sin login ni inferencia. |
| npm run check:sandbox | Ejecución nativa determinista del sandbox Codex, sin llamar al modelo. La preparación usa el runtime OAuth de Codex. |
| docker compose exec bridge bridge health | Vida HTTP, versión y capacidades declaradas. |
| docker compose exec bridge bridge claude auth status | Estado del login Claude. |
| docker compose exec bridge bridge codex login status | Estado del login Codex. |

Ejecuta los checks en el host y con el usuario finales. Un launcher simulado en CI no prueba las restricciones reales del kernel.

En las comprobaciones Windows anteriores, check:sandbox pasó con unelevated y una prueba DOCX. check:workspace falló cerrado porque la restricción de lecturas exigía un backend elevado. La suite completa nativa también encontró supuestos POSIX y dependencias multimedia/Python ausentes; la suite Linux de la imagen sí pasó completa. No extrapoles ese resultado a todo host Windows.

## Pendiente de validación integral

Los adaptadores de inferencia de las pruebas usan SDK simulados; el SDK real de Langfuse se prueba con colectores locales. No se han validado aquí sesiones reales Claude/Codex, granularidad real de texto, selección backend confirmada por el proveedor, navegador Roko, MCP externo, Langfuse desplegado ni el runner/VM de producción.

La prueba integral debe recorrer desde Roko una respuesta textual, llamada de función con continuación, creación/edición de archivo y cancelación por proveedor. Verifica bytes descargables, parciales reales y sandbox del host. El script histórico scripts/Test-Bridge.ps1 envía solo Bearer y no firma identidad; no basta para probar el contrato de inferencia actual.

No se atribuyen a este repositorio los resultados históricos de suites de Roko o Filestore. La lista operativa de observabilidad está en [OBSERVABILITY.md](OBSERVABILITY.md).
