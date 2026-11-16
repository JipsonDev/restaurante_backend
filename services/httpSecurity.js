// Ajustes HTTP de seguridad sin dependencias extra (equivalente minimo a helmet).

export function resolveCorsOrigins(env = process.env) {
  const configured = String(env.CORS_ORIGIN || '').split(',').map((origin) => origin.trim()).filter(Boolean);
  const production = env.NODE_ENV === 'production';
  if (!configured.length || configured.includes('*')) {
    if (production) {
      throw new Error('CORS_ORIGIN debe listar los dominios permitidos en produccion (no se acepta "*" ni vacio).');
    }
    return '*';
  }
  return configured;
}

export function trustProxySetting(env = process.env) {
  if (env.TRUST_PROXY !== undefined && env.TRUST_PROXY !== '') {
    if (env.TRUST_PROXY === 'true') return true;
    if (env.TRUST_PROXY === 'false') return false;
    const hops = Number(env.TRUST_PROXY);
    return Number.isInteger(hops) ? hops : env.TRUST_PROXY;
  }
  // En produccion (Render) hay exactamente un proxy delante.
  return env.NODE_ENV === 'production' ? 1 : false;
}

export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; frame-ancestors 'none'");
  next();
}
