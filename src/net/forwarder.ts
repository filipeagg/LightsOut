/**
 * Loopback forwarder for OAuth callbacks (SU-04, DESIGN §14.4).
 *
 * Engine CLIs bind their login listener to 127.0.0.1 inside the container. A published port
 * arrives on the container's external interface, so it never reaches that listener. This
 * forwarder listens on the container's own address and pipes each connection to the loopback
 * one, which makes `-p 127.0.0.1:1455:1455` work without host networking. Binding a specific
 * interface address instead of 0.0.0.0 avoids colliding with the CLI's own listener.
 */
import net from "node:net";
import { networkInterfaces } from "node:os";

export type Forwarder = {
  /** Addresses the forwarder is listening on. */
  addresses: string[];
  close: () => Promise<void>;
};

/** Non-loopback IPv4 addresses of this container. */
export function externalAddresses(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}

export async function startForwarder(
  port: number,
  onLog?: (line: string) => void,
): Promise<Forwarder> {
  const servers: net.Server[] = [];
  const addresses: string[] = [];

  for (const address of externalAddresses()) {
    const server = net.createServer((incoming) => {
      const upstream = net.connect({ host: "127.0.0.1", port });
      const drop = (err: NodeJS.ErrnoException) => {
        if (err.code !== "ECONNRESET" && err.code !== "EPIPE") {
          onLog?.(`forwarder error: ${err.message}`);
        }
        incoming.destroy();
        upstream.destroy();
      };
      incoming.on("error", drop);
      upstream.on("error", drop);
      incoming.pipe(upstream);
      upstream.pipe(incoming);
    });

    await new Promise<void>((resolve) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        onLog?.(`forwarder could not bind ${address}:${port}: ${err.message}`);
        resolve();
      });
      server.listen(port, address, () => {
        addresses.push(address);
        onLog?.(`forwarder listening on ${address}:${port} -> 127.0.0.1:${port}`);
        resolve();
      });
    });
    servers.push(server);
  }

  return {
    addresses,
    close: async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
            }),
        ),
      );
    },
  };
}
