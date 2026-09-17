# LightsOut en Windows — inicio rápido

Todo corre dentro de un único contenedor. Lo único que hace falta es Docker Desktop.

Repositorio: <https://github.com/filipeagg/LightsOut>

## 1. Instalar Docker Desktop

```powershell
winget install Docker.DockerDesktop
```

Ábrelo una vez y déjalo funcionando. En los siguientes reinicios arranca solo.

## 2. Arrancar LightsOut

```powershell
docker run -d --name lightsout --restart unless-stopped `
  -p 127.0.0.1:8484:8484 -p 127.0.0.1:1455:1455 -p 127.0.0.1:5170-5189:5170-5189 `
  -v lightsout-db:/data `
  -v "$env:USERPROFILE\Documents\LightsOut:/workspace" `
  -v lightsout-toolchains:/toolchains `
  -v claude-auth:/home/app/.claude -v codex-auth:/home/app/.codex `
  -e LO_WORKSPACE_MODE=host -e LO_WORKSPACE_HOST="$env:USERPROFILE\Documents\LightsOut" `
  ghcr.io/filipeagg/lightsout:latest
```

La imagen es pública y multiarquitectura: no hay que autenticarse contra el registro. Todos los
ajustes tienen un valor por defecto que funciona, así que no hay ningún fichero que editar.

El panel queda en <http://127.0.0.1:8484>.

## 3. Conectar los motores

Desde el asistente web: <http://127.0.0.1:8484/setup.html>

Pulsa **Connect** en cada motor. La página abre el login del CLI del propio motor, te muestra su
salida tal cual y te da el campo donde pegar lo que te pida; también acepta una API key si
prefieres esa vía. Claude hace el trabajo y Codex da la segunda opinión antes de abrir una duda,
así que conviene conectar los dos.

Las credenciales se quedan en los volúmenes `claude-auth` y `codex-auth` de esta máquina y
sobreviven a las actualizaciones.

## 4. Conectar Claude Desktop

Descarga la extensión:
<https://github.com/filipeagg/LightsOut/raw/main/scripts/windows/lightsout.mcpb>

Instálala arrastrándola sobre la ventana de Claude Desktop, o en Configuración → Extensiones →
Configuración avanzada → Instalar extensión… Solo pide un dato, el puerto, y 8484 es el valor por
defecto. Reinicia Claude Desktop después.

Es la única forma soportada de llegar a un servidor MCP local. Un conector remoto por URL no
funciona —Claude alcanza los MCP remotos desde la nube de Anthropic, que no tiene ruta hasta tu
`127.0.0.1`— y las versiones recientes ya no leen `claude_desktop_config.json`.

## 5. Comprobar

Pídele a Claude Desktop: *usa la tool health de lightsout*. Debería responder con la base de datos,
los dos motores autenticados y ninguna ejecución activa. Lo mismo se ve en
<http://127.0.0.1:8484/health>.

## Actualizar más adelante

```powershell
docker pull ghcr.io/filipeagg/lightsout:latest
docker rm -f lightsout
```

Y volver a lanzar el `docker run` del paso 2. Las migraciones se ejecutan al arrancar y todos los
volúmenes sobreviven, así que se conservan credenciales, base de datos y proyectos. Reinicia
Claude Desktop: la lista de tools la lee una sola vez, al conectarse.

## Conviene saber

- **Tu workspace es una carpeta de tu propia máquina**: `%USERPROFILE%\Documents\LightsOut`. Ahí
  viven los proyectos, los perfiles de agente, las plantillas y las bases de conocimiento, y los
  puedes abrir con tu editor de siempre. No edites a mano un proyecto mientras tenga una ejecución
  activa; el panel muestra cuáles están ocupados.
- **La extensión es solo un puente.** No declara ninguna tool propia —la lista se la sirve el
  contenedor cuando Claude Desktop se conecta—, así que no tiene por qué coincidir con la versión
  de la imagen.
- **Los proyectos no viajan con la imagen.** Para traerte uno de otra máquina: clona su
  repositorio y usa *Adopt existing* e *Import bundle* en el panel. El bundle nombra las
  credenciales que necesita pero nunca lleva sus valores, así que esos los pones tú.
