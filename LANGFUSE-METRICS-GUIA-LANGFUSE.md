# Langfuse: tokens, costes y operación sin evaluadores de IA

Preparado el 16 de octubre de 2026 para Bridge 0.7.3 y la actualización de
observabilidad de Roko 0.7.2. Filestore no requiere cambios para este parche.
No se añaden dependencias, llamadas a modelos, servicios ni tareas programadas.

## 1. Qué corrige el parche

El SDK serializa `usage_details` y `cost_details` como JSON. La política de
privacidad eliminaba esos atributos de texto. Ahora se conservan exclusivamente
claves conocidas de medición con valores numéricos finitos y no negativos.
Se siguen bloqueando Base64, credenciales y contenido sensible. No se modifica
lo que recibe el modelo ni lo que responde al usuario.

Roko recibe los mismos contadores al llamar al Bridge. Para los seis alias
conocidos (`gpt-codex`, `gpt-codex-fast`, `gpt-codex-deep`, `claude-max`,
`claude-max-fast`, `claude-max-deep`), su observación conserva el árbol y declara
consumo/coste cero con `metadata.usageAccounting=bridge_replica`. El consumo real
se registra en Bridge. El cero explícito impide que un tokenizer vuelva a estimar
consumo en esa réplica. Los modelos directos de Roko conservan sus mediciones.

Limitación: la deduplicación depende de esos alias exactos. Para alias nuevos o
si una capa exporta un modelo con otro nombre, hay que ampliar y probar la regla.
Mientras tanto, filtrar `model.codex` y `model.claude` en los paneles del Bridge
evita sumar sus réplicas. No se ocultan ni eliminan observaciones.

Este parche preserva los contadores ya disponibles; no incorpora un desglose
nuevo de caché/razonamiento al protocolo de respuesta. La normalización actual
puede perder ese desglose antes de la exportación. No configurar un widget como
si cero significara que el proveedor no usó caché o razonamiento.

## 2. Aplicar en tus repositorios locales de Windows

Extrae el ZIP fuera de los repositorios. Abre PowerShell en la carpeta extraída.
Sustituye las dos rutas por las de tus clones locales, NO las rutas de la VM:

```powershell
$bridge = 'C:\ruta\a\bridge'
$roko = 'C:\ruta\a\roko-librechat'
node .\apply.cjs --bridge $bridge --roko $roko
node .\apply.cjs --bridge $bridge --roko $roko --apply
```

La primera orden comprueba versiones sin escribir. La segunda aplica los nueve
archivos enumerados en FILES.json. Se aceptan cambios de finales de línea de
Windows; una diferencia de código bloquea la aplicación antes de escribir.
No sobrescribas el bloqueo copiando todo a mano: compara el archivo señalado.
Puedes aplicar cada repositorio por separado con solo `--bridge` o `--roko`.

En Bridge:

```powershell
Set-Location $bridge
node --test test/content-privacy.test.mjs test/metering-export.test.mjs
git diff --check
git add src/privacy.cjs test/content-privacy.test.mjs test/metering-export.test.mjs
git add SPEC.md TESTS.md
git diff --cached --stat
git commit -m "fix: preserve Langfuse usage and cost metrics"
git push origin main
```

En Roko:

```powershell
Set-Location $roko
node --test scripts/content-privacy.test.cjs
git diff --check
git add config/observability/privacy.cjs scripts/content-privacy.test.cjs
git add SPEC.md TESTS.md
git diff --cached --stat
git commit -m "fix: preserve metrics and avoid Bridge usage double counting"
git push origin main
```

Antes del commit revisa también `git diff --cached`: Git incluye todo lo que ya
estuviera preparado. Los comandos anteriores no añaden `.env` ni configuración
local. No uses `git add .`.

El pipeline existente debe pasar tests y construir/publicar en Bitbucket Cloud
antes del paso de despliegue del runner de cada repositorio. No hay que cambiar
los runners ni los scripts de Filestore. No ejecutes `ci/compose.sh` desde
`~/services/...`: esos archivos no están necesariamente en ese checkout de la VM.

## 3. Confirmar el despliegue en rokoface

Cuando ambos pipelines estén verdes, ejecuta en la VM:

```bash
docker inspect LibreChat ai-librechat-bridge-bridge-1 --format \
  '{{.Name}} commit={{index .Config.Labels "org.opencontainers.image.revision"}} image={{.Config.Image}}'
curl -fsS --max-time 10 http://127.0.0.1:4000/health
```

Los commits deben coincidir con los pushes respectivos. El parche no cambia
package.json: el número del health puede seguir siendo 0.7.3. La etiqueta de
commit es la comprobación de esta actualización.

No reconstruyas manualmente los contenedores en la VM. Se despliega la imagen
que ya pasó CI por su digest, manteniendo el Compose y las redes actuales.

## 4. Verificar tokens antes de configurar precios

Usa una interacción normal nueva de Roko. Esta comprobación utiliza el modelo
habitual del chat, sin evaluadores o llamadas de IA adicionales.

1. Abre el proyecto Roko en Langfuse y selecciona un intervalo reciente.
2. Deja inicialmente el filtro Environment en todos: antes se observaban valores
   diferentes en Roko y Bridge (`default` y `production`).
3. Abre la traza raíz `roko.interaction` y su generación `model.codex` o
   `model.claude` dentro de `bridge.request`.
4. Comprueba que la generación tiene Model y Usage con input/output numéricos.
   Puede haber varias generaciones reales por herramientas MCP o títulos.
5. La generación equivalente de Roko puede seguir mostrando cero: debe llevar
   `usageAccounting=bridge_replica`. Es la deduplicación, no un error.
6. Comprueba que la sesión se mantiene en el siguiente mensaje, con otra traza.
7. Comprueba que adjuntos/secretos siguen ocultos.

No se pueden reconstruir los contadores antiguos eliminados por el filtro a
partir de este cambio. Comprueba trazas posteriores al despliegue. Un SDK que no
entregue consumo tampoco puede medirse de forma exacta mediante este parche.

## 5. Configurar Models y tarifas

En Langfuse: Project Settings > Models > añadir modelo personalizado si el nombre
exportado no coincide con uno existente. Usa el campo Model de la generación,
no el nombre de la observación (`model.codex`).

Antes de poner precios, identifica el modelo real detrás de cada alias en la
configuración/resultado del proveedor. `gpt-codex` y `claude-max` no identifican
por sí solos un modelo o una tarifa. No supongas un modelo concreto.

Si cada alias corresponde a un único modelo verificado, patrones separados:

| Alias | Match pattern |
| --- | --- |
| gpt-codex | `^gpt-codex$` |
| gpt-codex-fast | `^gpt-codex-fast$` |
| gpt-codex-deep | `^gpt-codex-deep$` |
| claude-max | `^claude-max$` |
| claude-max-fast | `^claude-max-fast$` |
| claude-max-deep | `^claude-max-deep$` |

Añade precio de `input` y `output` con las tarifas vigentes del modelo verificado.
Respeta la unidad que indique el formulario. Si pide USD por token y la tarifa
es por millón, divide entre 1 000 000. No pongas también un precio a `total` si
ya cobras input/output: podrías sumar el mismo consumo otra vez.

Si el modelo real del alias cambia o no se puede identificar, deja su coste sin
configurar y conserva sus tokens. No uses precios inventados. La tarifa de
caché requiere conservar previamente su desglose real; este parche no lo añade.

En suscripciones, llama al panel «Coste equivalente estimado de API». No es una
factura de la suscripción, ni consumo marginal real. No marques como gratuito
un uso simplemente porque no haya precio configurado.

Las tarifas inferidas se aplican al ingerir nuevas generaciones. Una tarifa
nueva no repara por sí sola los datos antiguos. Confirma el cálculo con una
generación posterior: input × tarifa_input + output × tarifa_output.

## 6. Construir los dashboards

La posición y nombres de controles pueden variar según tu versión de Langfuse.
Ruta documentada: Dashboards > Widgets > New Widget. Configura Data Source,
Metric/Aggregation, Dimensions, Filters y Chart Type. Guarda cada widget.
Después: Dashboards > New Dashboard > añade los widgets guardados.

Crea «Roko — Operación». Intervalo inicial: últimas 24 h. Para comparar por hora,
usa dimensión temporal de una hora. Deja todos los entornos si no están alineados.

| Widget | Fuente/filtro | Medida y agrupación |
| --- | --- | --- |
| Interacciones | Observations, name=`roko.interaction` | count, por hora |
| Duración habitual | Observations, name=`roko.interaction` | latency p50, por hora |
| Duración lenta | Observations, name=`roko.interaction` | latency p95, por hora |
| Interacciones fallidas | Misma raíz; metadata.state=`failed` | count, por hora |
| Cancelaciones | Misma raíz; metadata.state=`cancelled` | count, por hora |
| Herramientas | Observaciones de herramientas reales; excluir generaciones y raíz | count por name |
| Herramientas lentas | Mismo conjunto | latency p95 por name |
| Herramientas fallidas | Herramientas y metadata.state=`failed` | count por name |
| Reintentos | Herramientas y metadata.attempt > 1, si existe | count por name |
| Archivos | name empieza por `file.generated.` | count por name |

Si la UI no ofrece un filtro de metadata o comparación numérica para un widget,
usa la tabla Observations con ese filtro, o exporta/query API. No sustituyas
attempt>1 por un contador inventado. Los eventos `missingStart=true` no tienen
una duración completa fiable: exclúyelos del análisis de latencia de herramientas
cuando ese filtro esté disponible. La duración de raíz mide la ejecución
instrumentada; no todo el recorrido de red/navegador.

Crea «Roko — Uso»:

| Widget | Fuente/filtro | Medida y agrupación |
| --- | --- | --- |
| Tokens Codex/Claude | Generations, name en `model.codex`,`model.claude` | suma input/output por model y hora |
| Coste equivalente | Mismas generaciones | suma cost por model y hora |
| Usuarios con mayor uso | Mismas generaciones | suma tokens/cost por userId |
| Sesiones con mayor uso | Mismas generaciones, o agregación de sesiones compatible | suma tokens/cost por sessionId |

No sumes una fila total junto con sus componentes de input/output. Para modelos
directos de Roko, crea otro widget con sus generaciones, excluyendo
`metadata.usageAccounting=bridge_replica` si la UI lo permite. Una tasa porcentual
requiere dividir fallos entre interacciones de la misma ventana; si el editor no
soporta esa expresión, muestra ambos contadores en lugar de una tasa falsa.

Filestore: crea «Filestore — Operación» en su proyecto si sigue separado. Incluye
volumen, latencia y errores por nombre real de herramienta MCP. No añadas precios
de modelos a llamadas de lectura/escritura: no son generaciones. Los dashboards
de un proyecto no combinan automáticamente el otro. Para árbol común deben
exportar al mismo proyecto, conservando la propagación autorizada existente.

## 7. Puntuaciones manuales sin IA

Project Settings > Scores / Evaluation > Create new score config:

| Nombre | Tipo | Valores |
| --- | --- | --- |
| respuesta_util | BOOLEAN | 0 / 1 |
| resultado_archivo | CATEGORICAL | correcto, incompleto, fallido, no_aplica |
| validacion_tecnica | BOOLEAN | 0 / 1 |

En una traza, usa Annotate o el panel Scores para puntuar. Una puntuación de
`validacion_tecnica` solo debe ponerse si existe una validación real. Estructura
válida no equivale a contenido semánticamente correcto.

En Annotation Queues crea «Incidencias Roko», selecciona las configuraciones y
asigna revisores. Desde Traces, filtra incidencias, selecciona filas y usa
Actions > Add to queue. También puedes añadir una traza desde Annotate.
La cola y la revisión son humanas; no activan evaluadores LLM.

Para un panel de calidad: Scores boolean > respuesta_util > average, y Scores
categóricos > resultado_archivo > count por valor. La media de booleanos expresa
la proporción positiva entre los casos revisados, NO entre todas las peticiones.

## 8. Validaciones deterministas automáticas: alcance exacto

El Bridge ya ejecuta validaciones de archivos y emite sus operaciones. Se pueden
analizar esos estados desde Observations sin añadir ningún proceso.

Crear una Score Config no convierte esos eventos en scores automáticamente.
Este parche NO añade un emisor automático de scores. Si se necesita, el punto
correcto es publicar el resultado existente después de la validación, asociado
a su traceId y observationId, con timeout y sin bloquear la respuesta; no repetir
la ejecución del archivo ni llamar a un modelo. La API/SDK de scores permite
esta integración, pero el contrato debe adaptarse a la versión instalada.

No actives LLM-as-a-Judge, evaluadores generativos, Assistant ni ejecuciones de
experimentos que consulten modelos para este montaje. Las herramientas y pruebas
de código locales, dashboards y revisión manual no añaden inferencias.

## 9. Alertas sin IA

Comprueba primero la versión en tu despliegue de Langfuse. Las alertas nativas
documentadas para self-hosted requieren v4+. No actualices toda la plataforma
solo para este parche de contadores. En una versión anterior conserva los
dashboards y usa el monitor existente si necesitas alertas.

Si tienes v4: Alerts > New Alert. Primeras reglas orientativas:

| Nombre | Filtro/medida | Condición inicial |
| --- | --- | --- |
| Respuestas lentas | Observations, name=roko.interaction; p95 latency | > 60 s en 15 min |
| Interacciones fallidas | Misma raíz, state=failed; count | >= 3 en 15 min |
| Fallos MCP | Herramientas MCP, state=failed; count | >= 3 en 15 min |

Son umbrales iniciales, no un SLA validado. Ajusta con uso real y volumen. No
interpretes pocos datos como degradación general. Configura NO_DATA como estado
sin datos si no esperas tráfico continuo; no alertes simplemente por inactividad.
Usa nombres de alerta escritos manualmente. Si deseas avisos, configura un
webhook/canal autorizado y vincúlalo a la alerta. No se ha creado ni enviado
ninguna notificación con este parche.

## 10. Privacidad y contenido para pruebas

Puedes mantener `OBSERVABILITY_CONTENT_MODE=redacted`: los contadores funcionan.
Si ya usas el modo de depuración existente, `debug` permite texto limitado y
saneado; no abre Base64, secretos o documentos completos de Filestore. No es un
modo de exportación sin restricciones. No cambies claves ni HMAC para este parche.

Si cambias variables en la VM, comprueba que estén en el entorno efectivo del
servicio y recrea usando las definiciones de la release activa; no basta editar
un `.env` del host. El despliegue de este parche no requiere cambios de variables.

## 11. Rollback

En cada clon local identifica el commit del hotfix y revierte SOLO ese commit:

```powershell
git log -3 --oneline
git revert <commit-del-hotfix>
git push origin main
```

Hazlo en Roko y Bridge según corresponda. La CI vuelve a probar y desplegar.
Se conservan datos, permisos, secretos y configuración de la VM. Las trazas ya
almacenadas no se borran al volver atrás. El rollback restaura el defecto de
contadores, por lo que no equivale a recuperar métricas históricas.

## 12. Fuentes oficiales consultadas

- https://langfuse.com/docs/observability/features/token-and-cost-tracking
- https://langfuse.com/docs/metrics/features/custom-dashboards
- https://langfuse.com/faq/all/manage-score-configs
- https://langfuse.com/docs/evaluation/evaluation-methods/annotation-queues
- https://langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk
- https://langfuse.com/docs/observability/features/alerts

La prueba final de la UI depende de tu versión y despliegue. No se ha accedido
a tu Langfuse, a tu VM ni a Bitbucket desde este entorno.
