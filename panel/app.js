// Phase 1 placeholder: renders /health. Phase 7 turns this into the hash-routed
// panel with SSE patches (WP-01..08).
async function render() {
  const el = document.getElementById("health");
  try {
    const res = await fetch("/health");
    el.textContent = JSON.stringify(await res.json(), null, 2);
  } catch (err) {
    el.textContent = "unreachable: " + err.message;
  }
}
render();
setInterval(render, 5000);
