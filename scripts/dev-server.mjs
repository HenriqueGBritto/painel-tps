/* Servidor local para testar o painel sem publicar: `npm run dev` e abrir http://localhost:8888.
   Serve public/ e responde /api/* com as mesmas funções do Netlify.
   A aba Atividades usa memória (os dados somem ao parar o servidor), a não ser que
   FIREBASE_SERVICE_ACCOUNT_JSON esteja definido no terminal: aí grava no Firestore de verdade.
   Login: sem a conta de serviço, usa as contas de teste de scripts/dev-users.json (só em memória). */
process.env.TZ = "America/Sao_Paulo";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const devUsers = JSON.parse(readFileSync(new URL("./dev-users.json", import.meta.url), "utf8")).users;
if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  process.env.TPS_ACTIVITIES_MEMORY = "1";
  process.env.TPS_AUTH_MEMORY = "1";
  process.env.TPS_AUTH_TEST_USERS = JSON.stringify(devUsers);
  process.env.TPS_ADMIN_EMAILS ||= "admin@painel.test";
}

const { default: api } = await import("../netlify/functions/api.mjs");
const { default: activities } = await import("../netlify/functions/atividades.mjs");
const { default: authApi } = await import("../netlify/functions/auth.mjs");
if (process.env.TPS_AUTH_MEMORY === "1") {
  const { activitiesStore } = await import("../netlify/lib/activities-store.mjs");
  const { USERS } = await import("../netlify/lib/auth.mjs");
  for (const { uid, email, name, permissions, mustChangePassword } of devUsers)
    await activitiesStore().set(USERS, uid, { email, name, permissions, mustChangePassword, disabled: false, createdAt: new Date().toISOString() });
}

const PORT = Number(process.env.PORT) || 8888;
const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png" };

async function toRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
}

async function send(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  try {
    if (path.startsWith("/api/atividades/")) return send(res, await activities(await toRequest(req), {}));
    if (path.startsWith("/api/auth/") || path === "/api/acessos" || path.startsWith("/api/acessos/")) return send(res, await authApi(await toRequest(req), {}));
    if (path.startsWith("/api/")) return send(res, await api(await toRequest(req), {}));
    const file = normalize(join(PUBLIC, path === "/" ? "index.html" : decodeURIComponent(path)));
    if (!file.startsWith(normalize(PUBLIC))) { res.writeHead(403).end(); return; }
    const content = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" }).end(content);
  } catch (error) {
    if (error.code === "ENOENT") { res.writeHead(404).end("Não encontrado"); return; }
    console.error(error);
    res.writeHead(500).end("Erro no servidor local");
  }
}).listen(PORT, () => {
  console.log(`Painel em http://localhost:${PORT}`);
  console.log(process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? "Atividades: gravando no Firestore." : "Atividades: dados em memória (somem ao parar o servidor).");
});
