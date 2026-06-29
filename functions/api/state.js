const STORAGE_KEY = "contasim-state-v4";

const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  "pragma": "no-cache",
  "expires": "0"
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

function getNamespace(env) {
  return env.CONTASIM_DB || null;
}

export async function onRequestGet({ env }) {
  const kv = getNamespace(env);
  if (!kv) {
    return json({ ok: false, mode: "local", error: "KV binding CONTASIM_DB não configurado." }, 503);
  }
  const raw = await kv.get(STORAGE_KEY);
  return json({ ok: true, mode: "server", state: raw ? JSON.parse(raw) : null });
}

export async function onRequestPost({ request, env }) {
  const kv = getNamespace(env);
  if (!kv) {
    return json({ ok: false, mode: "local", error: "KV binding CONTASIM_DB não configurado." }, 503);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "JSON inválido." }, 400);
  }

  const state = payload?.state;
  if (!state || typeof state !== "object" || !Array.isArray(state.clients) || !Array.isArray(state.collaborators)) {
    return json({ ok: false, error: "Estado inválido." }, 400);
  }

  state.version = 4;
  state.revision = Number(state.revision || 0);
  state.updatedAt = state.updatedAt || new Date().toISOString();

  await kv.put(STORAGE_KEY, JSON.stringify(state));
  return json({ ok: true, mode: "server", revision: state.revision, updatedAt: state.updatedAt });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers });
}
