/**
 * Durable, atomic writes to the workspace (RT-02).
 *
 * The workspace is a Windows bind mount through Docker Desktop's filesystem layer, and a plain
 * `writeFile` there is acknowledged before the bytes have reached the host. If the container dies
 * abnormally — which it did, when an adapter failure took the process down — recently written
 * files can be gone when it comes back. That is how a knowledge base created through the panel
 * disappeared without any `config.changed` event recording a deletion: nothing deleted it, the
 * write never survived.
 *
 * So every file that represents configuration the user created is written the careful way: into a
 * temporary file in the same directory, flushed with `fsync`, renamed over the target (atomic on
 * POSIX, so a reader never sees half a manifest), and the directory entry flushed too.
 */
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";

/** Flush a directory entry so a rename is not lost with the page cache. */
async function syncDir(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // Some filesystems refuse to open or sync a directory. The rename still happened.
  } finally {
    await handle?.close();
  }
}

export async function writeFileDurable(file: string, data: string): Promise<void> {
  const dir = path.dirname(file);
  // The temporary name stays in the same directory: a rename across filesystems is not atomic,
  // and on a bind mount `/tmp` is a different filesystem.
  const temp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);

  let handle;
  try {
    handle = await open(temp, "w");
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }

  try {
    await rename(temp, file);
  } catch (err) {
    await unlink(temp).catch(() => undefined);
    throw err;
  }
  await syncDir(dir);
}
