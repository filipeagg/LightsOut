# toolchain.d — system packages a project asked for (ST-08)

One `<project-id>.txt` per project, written by LightsOut when the user approves a `toolchain`
doubt. Never edited by an agent: an agent cannot reach outside its own project directory, which is
the whole reason this file exists instead of an install.

Format: one apt package name per line. Blank lines and `#` comments are ignored. The image build
installs the union of every file here.

Applying an approved request is one command, run by the user in this folder:

    docker compose up -d --build

LightsOut does not run it. A container that can rebuild its own image can replace itself with a
different one, and every other boundary in the design would be decoration.
