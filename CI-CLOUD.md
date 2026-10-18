# Configuración: Bitbucket Cloud → registro privado → VM rokoface

## 1. Aplicar el complemento en tus repositorios locales

Primero aplica la versión de observabilidad v0.7.1 de cada servicio. Después copia el contenido de `roko/` del complemento a la raíz del repo Roko y el de `bridge/` a la raíz del repo Bridge. Incluye los archivos de exclusión y `.gitattributes`.

Esto sustituye la automatización anterior: **no conserves su YAML antiguo**, que ejecutaba tests/build en la VM. Los dos repositorios siguen siendo independientes. Los directorios `tests/` del complemento son pruebas de la automatización y se ejecutan aparte, no se copian dentro de los servicios.

## 2. Registro de imágenes: opción Bitbucket Packages

Packages requiere actualmente un plan Standard o Premium mensual, un workspace de equipo vinculado a una organización de Atlassian. Si tu workspace lo tiene disponible:

1. En Bitbucket selecciona **Create → Package**.
2. Crea un paquete de contenedor llamado `roko`, vinculado al repo Roko, con acceso **Private**.
3. Crea otro llamado `bridge`, vinculado al repo Bridge, con acceso **Private**.
4. Usa sus referencias completas: `crg.apkg.io/TU_WORKSPACE/roko` y `crg.apkg.io/TU_WORKSPACE/bridge`. Sustituye `TU_WORKSPACE` por el slug real, en minúsculas.

En la nube, el script utiliza automáticamente `BITBUCKET_PACKAGES_USERNAME` y `BITBUCKET_PACKAGES_TOKEN`, las credenciales nativas que proporciona Pipelines para los paquetes del mismo repositorio. No las crees manualmente como variables.

Si Packages no está disponible, usa un registro privado existente accesible por HTTPS desde Atlassian y desde la VM. Ejemplos de formato: `ghcr.io/tuorganizacion/roko` o `docker.io/tuusuario/roko`. Debes crear los repositorios privados y configurar las credenciales de publicación indicadas en el apartado siguiente. Nunca uses imágenes públicas para código privado.

## 3. Variables y entornos de cada repositorio

Activa **Repository settings → Pipelines → Settings → Enable Pipelines**.

En **Repository variables**:

| Repo | Variable | Valor |
|---|---|---|
| Roko | `CI_IMAGE_REPOSITORY` | `crg.apkg.io/TU_WORKSPACE/roko` o referencia real de tu registro |
| Bridge | `CI_IMAGE_REPOSITORY` | `crg.apkg.io/TU_WORKSPACE/bridge` o referencia real de tu registro |

El valor debe contener hostname, namespace y nombre de imagen; sin `https://`, tag ni digest. Cada repo usa su propia variable.

En **Pipelines → Deployments**, configura dos entornos cuyos nombres coincidan exactamente:

- `image-publish`, de tipo **Staging**: tests/build en Atlassian y publicación posterior de la imagen aprobada.
- `production`, de tipo **Production**: descarga y despliegue en la VM, después del paso anterior.

En las variables del entorno `production` añade:

| Repo | Variable | Valor |
|---|---|---|
| Roko | `ROKO_DEPLOY_DIR` | `/home/rokoface/services/roko` |
| Bridge | `BRIDGE_DEPLOY_DIR` | `/home/rokoface/services/bridge` |

Si usas un registro externo o no dispones de autenticación nativa de Packages, añade **solo en las variables del entorno `image-publish`**:

- `CI_REGISTRY_PUSH_USER`: usuario autorizado para publicar.
- `CI_REGISTRY_PUSH_TOKEN`: token con permisos de publicación, marcado **Secured**.

No guardes estos permisos de escritura en `production`, ni como variables globales o de repositorio. Para Bitbucket Packages con autenticación nativa no necesitas estas dos variables.

Opcional: `CI_NODE_MAX_OLD_SPACE_SIZE=4096` para Roko, que ya es el valor predeterminado del script. Ambos YAML usan un step Cloud `2x` con 8 GB totales y asignan 6144 MB al servicio Docker. Estos pasos consumen los minutos de compilación de tu plan; 2x cuenta el doble de tiempo. Si falta cuota o memoria, el pipeline falla y no despliega. No hay una alternativa automática que traslade los tests al servidor.

Permite despliegue automático desde main en ambos entornos; restringe los cambios del pipeline y de main a personas de confianza. Si tu política exige PR, el merge a main activa el flujo.

## 4. Runner de la VM: exclusivamente para desplegar

El runner **Linux Shell** de workspace se conserva en la VM y debe aparecer Online, con etiquetas:

- `self.hosted`
- `linux.shell`
- `roko.bridge.prod`

Esa etiqueta personalizada debe señalar únicamente a esta VM, ya que los scripts trabajan con sus carpetas y Docker. Puedes mantener el servicio systemd descrito en los pasos anteriores. Necesita Git, Bash, Python 3.10+, flock, Docker Compose v2 y el Java requerido por la versión del runner. No necesita Node, npm ni LibreOffice en el host.

La etiqueta correcta es `roko.bridge.prod`, con puntos. La anterior `roko-bridge-prod` no cumple las reglas publicadas por Bitbucket para etiquetas personalizadas. Si creas un runner de workspace disponible también para Filestore, añade al runner de Filestore una etiqueta exclusiva, por ejemplo `leedeo.filestore.prod`, y exígela en los dos steps de su pipeline actual. Así no se programarán `/opt/test.sh` ni `/opt/deploy.sh` en la VM de Roko. No cambies sus rutas ni scripts. Si los runners están aislados por repositorio sin acceso compartido, no existe esa colisión.

El usuario es `rokoface`, con acceso a Docker sin sudo y escritura en las carpetas de despliegue. Mantén Roko y Bridge actuales arrancados para que el primer despliegue conserve el proyecto Compose y la imagen anterior.

Autentica Docker una vez como **rokoface**, sin sudo, con credenciales de **lectura** del registro privado. Para Bitbucket Packages crea un API token de Atlassian con scope `read:package:bitbucket`, para una cuenta con acceso a ambos paquetes:

```bash
docker login crg.apkg.io --username 'TU_CORREO_ATLASSIAN'
```

Pega el token en el prompt de contraseña. Para otro registro, cambia hostname y usuario. El runner usa el HOME `/home/rokoface`, donde Docker encuentra ese inicio de sesión. Rota el token antes de su caducidad.

No es necesario publicar puertos nuevos. La VM inicia las conexiones salientes del runner y las descargas del registro; Bitbucket Cloud no necesita una conexión SSH entrante a tu VM.

Copia los scripts nuevos al servidor para disponer de los comandos de gestión y rollback. Suponiendo que has subido el ZIP a `/home/rokoface`:

```bash
mkdir -p /home/rokoface/ci-cloud-setup
unzip /home/rokoface/roko-bridge-bitbucket-cloud-ci.zip -d /home/rokoface/ci-cloud-setup
cp -a /home/rokoface/ci-cloud-setup/roko/ci /home/rokoface/services/roko/
cp -a /home/rokoface/ci-cloud-setup/bridge/ci /home/rokoface/services/bridge/
```

No copies los archivos de ejemplo como `.env` del servidor. Comprueba la configuración existente sin imprimir secretos:

```bash
cd /home/rokoface/services/roko
test -r .env
docker compose -f docker-compose.yml -f docker-compose.override.yml config -q
docker compose -f docker-compose.yml -f docker-compose.override.yml ps

cd /home/rokoface/services/bridge
test -r .env
docker compose -f compose.yaml config -q
docker compose -f compose.yaml ps
```

## 5. Primer push y comprobación del bloqueo

Guarda los cambios del complemento en cada repo local. Puedes hacer primero un push a una rama para comprobar tests/build en la nube. Cuando llegue a main verás estos dos pasos secuenciales:

1. **Tests y build en la nube + publicar imagen aprobada**: usa `atlassian/default-image:5`, Docker y runtime Cloud v3; no tiene `runs-on: self.hosted`. La imagen production depende de la etapa Docker de tests.
2. **Desplegar imagen aprobada en la VM**: usa `runs-on: self.hosted`, consume el artifact de ese pipeline y descarga la imagen por digest; no tiene comandos build/test.

Comprueba en la interfaz que el primer paso corre en Cloud y el segundo en tu runner. Un fallo en el primero impide programar el segundo. Las ramas distintas de main tienen un único paso Cloud y no publican una imagen desplegable.

Para verificarlo con un fallo intencionado, usa una rama temporal y cambia temporalmente `ci/test.sh` para terminar con `exit 1`. Su pipeline debe fallar en Cloud. La estructura de main contiene exactamente ese mismo paso antes del despliegue; no usa `after-script`, ejecución paralela ni `on-fail: ignore` para desplegar. Revierte el cambio de prueba antes de integrarlo.

Las suites siguen siendo las específicas de la integración: Roko compila el frontend y ejecuta sus 36 pruebas de observabilidad, OTLP y tarjetas; Bridge ejecuta sus 128 pruebas Node y 9 Python de documentos. No equivale a toda la suite global de LibreChat ni a pruebas con inferencias reales en tus cuentas.

## 6. Datos, versiones y recuperación

El artifact solo contiene servicio, commit, número de build, digest e ID de imagen. Se rechazan artifacts locales antiguos, tags mutables, registros diferentes o imágenes de otro servicio/commit. Un pipeline más antiguo que el desplegado se omite.

La VM conserva `.env`, `runtime-config.yaml`, volúmenes, adjuntos y credenciales existentes. El código de aplicación procede de la imagen probada; no se hace git pull ni otro git push al checkout del servidor. Los Compose versionados se guardan en snapshots de `.ci-deploy/releases` y se ejecutan con el directorio del despliegue original para conservar las rutas relativas. Solo se actualiza `api` o `bridge`, sin recrear dependencias ni eliminar volúmenes.

Las nuevas variables de observabilidad y los nuevos archivos que se monten desde el host deben provisionarse previamente en el servidor; ese contenido privado no se incorpora a la imagen ni se escribe desde este complemento.

Después del primer despliegue CI:

```bash
cd /home/rokoface/services/roko
ROKO_DEPLOY_DIR="$PWD" bash ci/compose.sh roko ps
ROKO_DEPLOY_DIR="$PWD" bash ci/compose.sh roko logs --tail=50 api
ROKO_DEPLOY_DIR="$PWD" bash ci/deploy.sh roko rollback
```

```bash
cd /home/rokoface/services/bridge
BRIDGE_DEPLOY_DIR="$PWD" bash ci/compose.sh bridge ps
BRIDGE_DEPLOY_DIR="$PWD" bash ci/compose.sh bridge logs --tail=50 bridge
BRIDGE_DEPLOY_DIR="$PWD" bash ci/deploy.sh bridge rollback
```

Ejecuta la línea rollback solo cuando quieras restaurar la versión anterior. Una activación fallida intenta recuperarla automáticamente. Una descarga fallida no recrea el contenedor actual. Conserva las imágenes actuales y anteriores y `.ci-deploy/`; no hagas limpieza indiscriminada. La comprobación de salud y el rollback ocurren en producción después de pasar CI; no son sustitutos de los tests previos.

Filestore conserva su pipeline, runner y `/opt/test.sh` y `/opt/deploy.sh` actuales.

## Referencias oficiales

- Cloud y runners en distintos pasos: https://support.atlassian.com/bitbucket-cloud/docs/configure-your-runner-in-bitbucket-pipelines-yml/
- Docker y memoria: https://support.atlassian.com/bitbucket-cloud/docs/run-docker-commands-in-bitbucket-pipelines/
- Runtime v3: https://support.atlassian.com/bitbucket-cloud/docs/enable-and-use-runtime-v3/
- Tamaños y minutos: https://support.atlassian.com/bitbucket-cloud/docs/step-options/
- Packages y autenticación: https://support.atlassian.com/bitbucket-cloud/docs/set-up-and-use-packages/
- Registro de Bitbucket: https://support.atlassian.com/bitbucket-cloud/docs/working-with-the-container-registry/
- Identificación inmutable: https://docs.docker.com/reference/cli/docker/image/pull/
