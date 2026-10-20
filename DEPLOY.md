# CI y despliegue de producción

Esta guía describe [bitbucket-pipelines.yml](bitbucket-pipelines.yml) y los scripts [ci/](ci/). Para una instalación local usa [DOCKER.md](DOCKER.md). No mezcles comandos de rebuild local con una instalación gestionada por imagen aprobada.

## Pipeline actual

Las ramas distintas de main ejecutan tests/build en Bitbucket Cloud mediante bash ci/cloud-build.sh bridge test, sin publicar una imagen desplegable.

main ejecuta secuencialmente:

1. Tests/build en Cloud y publicación: deployment image-publish, runtime Cloud v3, step 2x y servicio Docker con 6144 MB. Ejecuta bash ci/cloud-build.sh bridge publish.
2. Despliegue: deployment production en runner Linux Shell con etiquetas self.hosted, linux.shell y roko.bridge.prod. Ejecuta bash /opt/deploy-and-clean.sh bash ci/deploy.sh bridge.

La imagen production hereda de la etapa ci del Dockerfile. Un fallo de las pruebas bloquea la publicación y el siguiente paso. No se ejecutan tests/build en la VM como alternativa automática. /opt/deploy-and-clean.sh es un wrapper externo del servidor y su implementación no forma parte de este repositorio.

La suite actual y su último resultado están en [TESTS.md](TESTS.md). No se certifican aquí ejecuciones de Bitbucket ni el estado de la VM.

## Variables de Bitbucket

| Ámbito | Variable | Uso |
| --- | --- | --- |
| Repository | CI_IMAGE_REPOSITORY | Referencia completa de imagen privada, sin esquema, tag ni digest; por ejemplo crg.apkg.io/tu-workspace/bridge. |
| Deployment production | BRIDGE_DEPLOY_DIR | Directorio real con el .env privado y el estado del despliegue; por ejemplo /home/rokoface/services/bridge. |
| Deployment image-publish | CI_REGISTRY_PUSH_USER / CI_REGISTRY_PUSH_TOKEN | Credenciales de publicación para un registro sin autenticación nativa; token Secured. |

Los nombres de deployment deben coincidir con el YAML. Cuando el registro es crg.apkg.io y Pipelines proporciona BITBUCKET_PACKAGES_USERNAME/TOKEN, el script usa esas credenciales nativas. Para otro registro utiliza las variables de publicación. Los requisitos comerciales y permisos del registro se consultan en el servicio elegido; no se presuponen en esta guía.

Las credenciales de publicación pertenecen al paso image-publish. La VM solo necesita lectura del registro. La referencia de variables está en [ci/variables.example](ci/variables.example).

## Preparar la VM

El runner debe disponer de Bash, Python 3.10+, Git, flock, Docker y Compose v2, acceso al daemon local y al registro. No necesita instalar los SDK o toolkit en el host: están en la imagen.

Configura una etiqueta roko.bridge.prod que seleccione únicamente la VM prevista. Autentica Docker en el HOME del usuario del runner con credenciales de lectura. Provisiona el wrapper /opt/deploy-and-clean.sh conforme a tu instalación.

Mantén el servicio anterior arrancado para el primer despliegue automático: el script necesita detectar su proyecto Compose y guardar una imagen de recuperación. Conserva el .env privado, los volúmenes logins/runtime y el nombre del proyecto. Comprueba la configuración sin imprimir sus secretos:

```bash
cd /home/rokoface/services/bridge
docker compose -f compose.yaml config -q
docker compose -f compose.yaml ps
```

Las variables nuevas y los recursos privados montados desde el host deben provisionarse antes del despliegue. No se copian desde .env.example ni se incluyen en la imagen.

## Garantías del despliegue

El artifact ci-result.json identifica servicio, commit, build, digest e ID de imagen. Los scripts validan el registro esperado y las etiquetas de revisión/servicio, descargan por digest para linux/amd64 y comprueban la configuración de imagen. Un pipeline ya desplegado o superado por otro más reciente se omite.

flock serializa activaciones. Las definiciones Compose se guardan en .ci-deploy/releases y se ejecutan con el directorio original y su .env; solo se recrea bridge, sin build ni dependencias. Se conservan volúmenes y logins.

Una descarga fallida no sustituye el contenedor. Si falla la activación o salud, el script intenta restaurar la imagen y definición previas. El healthcheck comprueba HTTP e identidad de imagen; no prueba login, inferencia ni restricciones del sandbox.

## Gestión después del primer despliegue CI

Los scripts pueden estar únicamente en el checkout del runner. Ejecuta desde un checkout que contenga ci/ y señala el directorio desplegado:

```bash
export BRIDGE_DEPLOY_DIR=/home/rokoface/services/bridge
bash ci/compose.sh bridge ps
bash ci/compose.sh bridge logs --tail=100 bridge
bash ci/compose.sh bridge exec bridge bridge health
```

ci/compose.sh usa el snapshot y la imagen fijados por el despliegue actual; requiere que exista .ci-deploy/current.

Para aplicar un cambio de .env conservando esa imagen:

```bash
bash ci/compose.sh bridge config -q
bash ci/compose.sh bridge up -d --no-deps --no-build --pull never --force-recreate bridge
```

No uses un simple restart para cargar variables nuevas. No reconstruyas manualmente en la VM una versión distinta de la aprobada.

## Verificación y recuperación

Tras desplegar, comprueba versión/capacidades, estado OAuth y los checks del sandbox para los proveedores activos. Recorre una petición desde Roko, incluyendo función externa y archivo si se usan: [OPERATIONS.md](OPERATIONS.md) y [OBSERVABILITY.md](OBSERVABILITY.md).

Para volver a la release anterior disponible:

```bash
export BRIDGE_DEPLOY_DIR=/home/rokoface/services/bridge
bash ci/deploy.sh bridge rollback
```

Ejecuta rollback solo cuando quieras restaurarla. Otra opción es revertir el commit y pasar de nuevo por main. Conserva .ci-deploy y las imágenes actual/anterior; no hagas una limpieza que las elimine.

No borres .env, logins, volúmenes ni bases de datos para revertir código u observabilidad. Roko y Filestore tienen pipelines y persistencia propios; estos scripts no despliegan sus cambios desde el repositorio Bridge.