# CI y despliegue de producción

Esta guía describe [bridge-ci-deploy.yml](.github/workflows/bridge-ci-deploy.yml) y los scripts [ci/](ci/). Para una instalación local usa [DOCKER.md](DOCKER.md). No mezcles rebuild local con una instalación gestionada por imagen aprobada.

## GitHub Actions

Los pull requests construyen la imagen de CI y ejecutan `ci/test.sh` mediante `bash ci/cloud-build.sh bridge test`. Un push a `main` repite la validación, publica la imagen en `ghcr.io/polfrns/bridge` y guarda un manifiesto con su digest. El job `production` despliega esa misma imagen, sin reconstruirla.

El despliegue requiere un runner self-hosted Linux con etiquetas `self-hosted`, `linux` y `bridge-prod`, y el environment de GitHub `production`. Configura la variable `BRIDGE_DEPLOY_DIR` en ese environment. La carpeta debe contener el `.env` privado y `compose.yaml`. El runner necesita Docker, Compose v2, Bash, Python 3, `flock` y permiso de lectura del paquete GHCR.

La imagen production hereda de la etapa `ci` del Dockerfile. Si falla una prueba, no se publica ni despliega. La suite y su alcance están en [TESTS.md](TESTS.md).

GitHub Actions publica usando su `GITHUB_TOKEN` con permiso `packages: write`. El runner de producción usa el token del job para descargar la imagen. El paquete GHCR debe permitir acceso al repositorio `Polfrns/bridge`.

La referencia de variables está en [ci/variables.example](ci/variables.example).

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
