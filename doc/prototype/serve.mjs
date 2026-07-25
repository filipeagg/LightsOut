// Throwaway static server, only so the prototype can be screenshotted in a browser.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const file = new URL('./panel.html', import.meta.url);
createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(readFileSync(file));
}).listen(8899, '127.0.0.1', () => console.log('serving on http://127.0.0.1:8899'));
