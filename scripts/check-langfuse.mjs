// Non-destructive check of Bridge -> Langfuse connectivity. No secrets logged.
const base = process.env.LANGFUSE_BASE_URL?.replace(/\/+$/, '');
const pub = process.env.LANGFUSE_PUBLIC_KEY;
const secret = process.env.LANGFUSE_SECRET_KEY;
if (!base || !pub || !secret) {
  console.error('Langfuse: incomplete LANGFUSE_BASE_URL/PUBLIC_KEY/SECRET_KEY');
  process.exitCode = 2;
} else {
  try {
    const url = new URL('/api/public/projects', base);
    const res = await fetch(url, {headers: {Authorization: 'Basic '+ Buffer.from(pub+':'+secret).toString('base64')},
      signal: AbortSignal.timeout(10000)});
    console.log('Langfuse HTTP:', res.status);
    if (!res.ok) process.exitCode = 1;
  } catch (error) {
    console.error('Langfuse connectivity failed:', error?.name || 'network_error');
    process.exitCode = 1;
  }
}
