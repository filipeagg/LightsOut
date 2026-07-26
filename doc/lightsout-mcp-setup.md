# Conectar LightsOut a Claude Desktop

Cinco minutos. Todo corre dentro de un contenedor; en tu máquina solo hace falta Docker Desktop.

## 1. Docker Desktop

Instálalo desde docker.com, o en Windows:

```powershell
winget install Docker.DockerDesktop
```

Ábrelo una vez y déjalo corriendo. En los siguientes arranques se abre solo.

## 2. Arrancar LightsOut

Doble clic en `1-Start-LightsOut.bat`, dentro de `scripts\windows\`. Busca Docker, lo arranca si
hace falta, levanta el contenedor con reinicio automático y abre el panel.

Comprueba que responde: **http://127.0.0.1:8484**

La carpeta de trabajo se crea en `Documents\LightsOut` dentro de tu usuario. Ahí van los
proyectos, los agentes, las plantillas y el conocimiento. Para ponerla en otro sitio, define
`LIGHTSOUT_WORKSPACE` antes de arrancar.

## 3. Conectar los motores (una vez por máquina)

Doble clic en `2-Connect-Claude.bat` y luego en `3-Connect-Codex.bat`. Cada uno imprime una URL:
ábrela, aprueba, y el script confirma el resultado leyendo `/health`.

Son logins interactivos y hay que lanzarlos desde tu propia terminal o con doble clic. Si tu
espacio de ChatGPT no permite códigos de dispositivo, usa la clave de API:

```powershell
.\Connect-Engine.ps1 -Engine codex -ApiKey
```

En `http://127.0.0.1:8484/#/health` los dos motores tienen que salir como conectados antes de
seguir.

## 4. Instalar la extensión en Claude Desktop

Instala el fichero `lightsout.mcpb` (está en `scripts\windows\`, y también en `dist\`):

- doble clic sobre él, o
- arrástralo encima de la ventana de Claude Desktop, o
- **Ajustes → Extensiones → Configuración avanzada → Instalar extensión…**

**Esta es la única forma que funciona** para llegar a un servidor MCP local:

- Un *custom connector* por URL **no** funciona. Claude alcanza los servidores MCP remotos desde
  la nube de Anthropic, y esa nube no tiene ruta hasta tu `127.0.0.1`.
- Editar `claude_desktop_config.json` **tampoco**. Las versiones recientes de Claude Desktop no
  lo leen. Existe un `4-Connect-ClaudeDesktop.bat` que lo parchea, pero es un resto de versiones
  antiguas; no lo uses.

## 5. Comprobar

Reinicia Claude Desktop del todo, incluido el icono de la bandeja del sistema, y pídele:

> usa la herramienta health de lightsout

Tiene que responder con la base de datos en verde, los dos motores autenticados y ningún run
activo. Es la misma foto que sale en `http://127.0.0.1:8484/health`.

Si contesta, ya está: crea el proyecto **LightsOut test** en Claude Desktop, pégale las
instrucciones de uso y empieza por el primer recorrido que describen.

## Cuando algo no va

- **La extensión no tiene aplicación asociada.** Windows no conoce `.mcpb` hasta que Claude
  Desktop registra el tipo. Instálala desde Ajustes → Extensiones → Configuración avanzada, y
  cambia el filtro del diálogo a "Todos los archivos" si no la ves.
- **Un `.ps1` se abre en el editor de texto.** Se lanzó desde `cmd`, donde los scripts de
  PowerShell no son ejecutables. Usa los `.bat` numerados: ellos se encargan de la política de
  ejecución.
- **`docker` dice que no hay demonio.** Docker Desktop está instalado pero no arrancado. Ábrelo
  una vez, o deja que `1-Start-LightsOut.bat` lo haga.
- **Claude Desktop no ve las herramientas nuevas.** La lista se guarda al conectar. Ciérralo del
  todo — incluida la bandeja — y vuelve a abrirlo.
- **Una página de login acaba en blanco.** El callback necesita el puerto 1455 publicado. Usa los
  scripts de conexión, que hacen el login dentro del contenedor con el reenviador puesto, en vez
  de llamar al CLI del motor a mano.
- **El panel no responde.** El contenedor está parado. `1-Start-LightsOut.bat` otra vez.

## Actualizar

```powershell
docker pull <imagen>
```

y vuelve a lanzar `1-Start-LightsOut.bat`. La configuración, las credenciales y la carpeta de
trabajo sobreviven: la biblioteca de agentes y plantillas que viene de serie se actualiza con la
imagen, y lo que tú hayas cambiado sigue por encima.
