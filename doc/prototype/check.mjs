// Throwaway syntax check for the prototype's inline script.
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('./panel.html', import.meta.url), 'utf8');
const start = html.indexOf('<script>') + 8;
const end = html.lastIndexOf('<\/script>');
const js = html.slice(start, end);
writeFileSync(new URL('./check.js', import.meta.url), js);
try {
  new Function(js);
  console.log('SYNTAX_OK', js.split('\n').length, 'lines of script');
} catch (e) {
  console.log('SYNTAX_ERROR', e.message);
  process.exitCode = 1;
}
