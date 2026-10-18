// HTTP liveness only; login and the native sandbox have separate checks.
try {
  const port = Number(process.env.BRIDGE_PORT || 4000);
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
  const body = await response.json();
  if (!response.ok || body.status !== 'ok') throw new Error('Bridge health check failed.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
