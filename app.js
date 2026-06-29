/* ContaSim — simulação bancária completa, sem integração real. */
const DB_KEY = "contasim_db_v4_realtime";
const SESSION_KEY = "contasim_session_v4_realtime";
const API_STATE_URL = "/api/state";
const SYNC_INTERVAL_MS = 1200;
const moneyFmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateFmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

const $ = (id) => document.getElementById(id);
const now = () => new Date().toISOString();
const uid = (prefix = "id") => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");
const brMoney = (n) => moneyFmt.format(Number(n || 0));
const brDate = (iso) => iso ? dateFmt.format(new Date(iso)) : "-";
const parseCurrency = (value) => Number(String(value || "0").replace(/\./g, "").replace(",", "."));
const maskText = (value = "") => String(value || "").length ? "••••••" : "-";
const sameText = (a = "", b = "") => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

let sync = { online: false, lastPull: 0, pulling: false, pushing: false, started: false };
let pushTimer = null;
let localChannel = null;
try { localChannel = new BroadcastChannel("contasim_realtime_v4"); } catch {}

function syncDBAndRefresh(message = "Atualizado em tempo real.") {
  saveDB();
  if (message) toast(message);
  render();
}

let db = loadDB();
let session = loadSession();
let screen = "client-login";
let clientSection = "inicio";
let staffSection = "painel";
let modal = null;
let lastGeneratedQr = "";

function seedDB() {
  const t = now();
  const client1 = {
    id: uid("cli"), name: "Cliente Demonstração 1", username: "cliente1", password: "123456",
    email: "cliente1@simulacao.local", phone: "(43) 90000-0001", document: "000.000.000-01",
    balance: 750.50, accountBlocked: false, balanceBlocked: false, createdAt: t,
    pixKeys: ["cliente1@simulacao.local", "43900000001", "aleatoria-cliente1"], blocks: [],
    transactions: [
      { id: uid("tx"), type: "entrada", title: "Saldo inicial simulado", amount: 750.50, date: t, status: "concluído", description: "Carga inicial da simulação" }
    ]
  };
  const client2 = {
    id: uid("cli"), name: "Cliente Demonstração 2", username: "cliente2", password: "123456",
    email: "cliente2@simulacao.local", phone: "(43) 90000-0002", document: "000.000.000-02",
    balance: 180.00, accountBlocked: false, balanceBlocked: false, createdAt: t,
    pixKeys: ["cliente2@simulacao.local", "43900000002", "aleatoria-cliente2"], blocks: [],
    transactions: [
      { id: uid("tx"), type: "entrada", title: "Saldo inicial simulado", amount: 180.00, date: t, status: "concluído", description: "Carga inicial da simulação" }
    ]
  };

  return {
    version: 4,
    revision: 1,
    createdAt: t,
    updatedAt: t,
    clients: [],
    collaborators: [
      { id: "owner-master", name: "Luis Fernando", username: "16581769", password: "0237162610", role: "owner", active: true, protected: true, createdAt: t }
    ],
    pendingDeposits: [],
    activity: [
      { id: uid("log"), date: t, actor: "Sistema", action: "Simulação iniciada com acesso owner principal protegido." }
    ]
  };
}

function loadDB() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) {
      const seeded = seedDB();
      localStorage.setItem(DB_KEY, JSON.stringify(seeded));
      return seeded;
    }
    const parsed = JSON.parse(raw);
    if (!parsed.version || parsed.version < 4) throw new Error("versão antiga");
    parsed.clients ||= [];
    parsed.collaborators ||= [];
    parsed.pendingDeposits ||= [];
    parsed.activity ||= [];
    parsed.revision ||= 1;
    parsed.updatedAt ||= parsed.createdAt || now();
    return parsed;
  } catch (err) {
    const seeded = seedDB();
    localStorage.setItem(DB_KEY, JSON.stringify(seeded));
    return seeded;
  }
}

function saveDB(options = {}) {
  const { push = true, silent = false } = options;
  db.version = 4;
  db.revision = Number(db.revision || 0) + 1;
  db.updatedAt = now();
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  if (!silent) localChannel?.postMessage({ type: "db-updated", revision: db.revision, at: db.updatedAt });
  if (push) queuePushRemote();
}

function saveRemoteStateLocalOnly(nextDb) {
  db = nextDb;
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  localChannel?.postMessage({ type: "db-pulled", revision: db.revision, at: db.updatedAt });
}

function queuePushRemote() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushRemote, 220);
}

async function pushRemote() {
  if (sync.pushing) return;
  sync.pushing = true;
  try {
    const res = await fetch(API_STATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ state: db })
    });
    if (!res.ok) throw new Error("API indisponível");
    sync.online = true;
  } catch {
    sync.online = false;
  } finally {
    sync.pushing = false;
  }
}

async function pullRemote(force = false) {
  if (sync.pulling) return false;
  sync.pulling = true;
  try {
    const res = await fetch(`${API_STATE_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error("API indisponível");
    const data = await res.json();
    sync.online = true;
    sync.lastPull = Date.now();
    if (!data.state) {
      await pushRemote();
      return false;
    }
    const remote = data.state;
    if (!remote.version || remote.version < 4) return false;
    const localRev = Number(db.revision || 0);
    const remoteRev = Number(remote.revision || 0);
    const remoteIsNewer = remoteRev > localRev || (remoteRev === localRev && String(remote.updatedAt || "") > String(db.updatedAt || ""));
    if (remoteIsNewer) {
      saveRemoteStateLocalOnly(remote);
      if (sync.started) render();
      return true;
    }
    if (localRev > remoteRev || String(db.updatedAt || "") > String(remote.updatedAt || "")) queuePushRemote();
    return false;
  } catch {
    sync.online = false;
    return false;
  } finally {
    sync.pulling = false;
  }
}

function syncBadge() {
  return sync.online
    ? `<span class="badge ok">tempo real servidor</span>`
    : `<span class="badge warning">modo local</span>`;
}

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; }
}
function saveSession() { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
function clearSession() { session = null; localStorage.removeItem(SESSION_KEY); }

function toast(message) {
  const box = $("toast");
  box.textContent = message;
  box.classList.add("show");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => box.classList.remove("show"), 3300);
}

function addLog(actor, action) {
  db.activity.unshift({ id: uid("log"), date: now(), actor, action });
  db.activity = db.activity.slice(0, 250);
  saveDB();
}

function getClient(id) { return db.clients.find(c => c.id === id); }
function getStaff(id) { return db.collaborators.find(c => c.id === id); }
function currentClient() { return session?.type === "client" ? getClient(session.id) : null; }
function currentStaff() { return session?.type === "staff" ? getStaff(session.id) : null; }

function roleName(role) {
  return ({ financeiro: "Financeiro", gerencial: "Gerencial", owner: "Owner" })[role] || role;
}

function perms(role) {
  return {
    financeiro: {
      viewClients: true, viewBalances: true, applyBlocks: true, removeBlocks: false,
      authorizeDeposits: false, manageCollaborators: false, seePasswords: false,
      alterBalance: false, addClient: false, removeClient: false, editClient: false,
      resetSimulation: false, audit: true
    },
    gerencial: {
      viewClients: true, viewBalances: true, applyBlocks: true, removeBlocks: true,
      authorizeDeposits: true, manageCollaborators: false, seePasswords: false,
      alterBalance: false, addClient: false, removeClient: false, editClient: false,
      resetSimulation: false, audit: true
    },
    owner: {
      viewClients: true, viewBalances: true, applyBlocks: true, removeBlocks: true,
      authorizeDeposits: true, manageCollaborators: true, seePasswords: true,
      alterBalance: true, addClient: true, removeClient: true, editClient: true,
      resetSimulation: true, audit: true
    }
  }[role] || {};
}

function render() {
  const app = $("app");
  if (session?.type === "client" && currentClient()) return renderClientApp(app);
  if (session?.type === "staff" && currentStaff()) return renderStaffApp(app);
  clearSession();
  if (screen === "staff-login") return renderStaffLogin(app);
  return renderAuth(app);
}

function baseHero() {
  return `
    <section class="hero-card">
      <div>
        <div class="brand"><div class="logo-mark">CS</div><span>ContaSim</span></div>
        <h1 class="hero-title">Conta bancária <span>simulada</span> completa.</h1>
        <p class="hero-subtitle">Área de cliente, cadastro, saldo, extrato, Pix por chave, Pix por QR/Copia e Cola, depósito pendente de autorização e painel colaborativo por cargos.</p>
        <div class="warning-line">Ambiente fictício. Não use dados reais. Não existe banco real, Pix real, API bancária real, boleto real ou movimentação financeira real.</div>
        <div class="actions-row" style="margin-top:14px">${syncBadge()}<span class="badge">rev. ${db.revision || 1}</span></div>
      </div>
      <div class="stat-row">
        <div class="stat-pill"><strong>${db.clients.length}</strong><small>clientes simulados</small></div>
        <div class="stat-pill"><strong>${db.pendingDeposits.filter(d => d.status === "pendente").length}</strong><small>depósitos pendentes</small></div>
        <div class="stat-pill"><strong>${db.collaborators.length}</strong><small>colaboradores</small></div>
      </div>
    </section>`;
}

function renderAuth(app) {
  app.innerHTML = `
    <main class="auth-page">
      <div class="auth-grid">
        ${baseHero()}
        <section class="auth-card">
          <div class="auth-tabs">
            <button class="tab-btn ${screen === "client-login" ? "active" : ""}" id="tabLogin">Entrar</button>
            <button class="tab-btn ${screen === "client-register" ? "active" : ""}" id="tabRegister">Criar conta</button>
          </div>
          <div id="authForm"></div>
          <div class="staff-line"><span id="staffAccess">acesso colaborativo</span></div>
        </section>
      </div>
    </main>`;

  $("tabLogin").onclick = () => { screen = "client-login"; render(); };
  $("tabRegister").onclick = () => { screen = "client-register"; render(); };
  $("staffAccess").onclick = () => { screen = "staff-login"; render(); };
  renderClientAuthForm();
}

function renderClientAuthForm() {
  const form = $("authForm");
  if (screen === "client-register") {
    form.innerHTML = `
      <h2 class="panel-title">Abrir conta simulada</h2>
      <p class="panel-subtitle">Crie uma conta fictícia para testar saldo, Pix e depósito com autorização.</p>
      <form id="registerForm" class="form-stack">
        <div><label>Nome completo fictício</label><input name="name" required /></div>
        <div class="two">
          <div><label>Usuário</label><input name="username" required minlength="3" autocomplete="username" /></div>
          <div><label>Telefone fictício</label><input name="phone" /></div>
        </div>
        <div><label>E-mail fictício</label><input name="email" type="email" /></div>
        <div class="two">
          <div><label>Senha</label><input name="password" required type="password" minlength="4" /></div>
          <div><label>Confirmar senha</label><input name="password2" required type="password" minlength="4" /></div>
        </div>
        <button class="btn" type="submit">Criar conta simulada</button>
      </form>`;
    $("registerForm").onsubmit = registerClient;
  } else {
    form.innerHTML = `
      <h2 class="panel-title">Login do cliente</h2>
      <p class="panel-subtitle">Entre com uma conta já cadastrada ou crie uma nova conta simulada.</p>
      <form id="loginForm" class="form-stack">
        <div><label>Usuário</label><input name="username" required autocomplete="username" /></div>
        <div><label>Senha</label><input name="password" required type="password" autocomplete="current-password" /></div>
        <button class="btn" type="submit">Entrar na conta</button>
      </form>`;
    $("loginForm").onsubmit = loginClient;
  }
}

async function registerClient(e) {
  e.preventDefault();
  await pullRemote(true);
  const data = Object.fromEntries(new FormData(e.target));
  const username = data.username.trim();
  if (data.password !== data.password2) return toast("As senhas não conferem.");
  if (db.clients.some(c => sameText(c.username, username))) return toast("Esse usuário de cliente já existe.");
  if (db.collaborators.some(c => sameText(c.username, username))) return toast("Esse usuário já está reservado na área colaborativa.");
  const id = uid("cli");
  const email = data.email?.trim() || `${username}@simulacao.local`;
  const phone = data.phone?.trim() || "";
  const client = {
    id, name: data.name.trim(), username, password: data.password,
    email, phone, document: "", balance: 0, accountBlocked: false, balanceBlocked: false,
    createdAt: now(), pixKeys: [email, `aleatoria-${username}-${Math.random().toString(36).slice(2, 7)}`], blocks: [],
    transactions: []
  };
  if (phone) client.pixKeys.push(phone.replace(/\D/g, ""));
  db.clients.push(client);
  addLog("Cliente", `Conta simulada criada para ${client.name}.`);
  session = { type: "client", id };
  saveSession();
  screen = "client-login";
  clientSection = "inicio";
  toast("Conta criada com sucesso.");
  render();
}

async function loginClient(e) {
  e.preventDefault();
  await pullRemote(true);
  const data = Object.fromEntries(new FormData(e.target));
  const client = db.clients.find(c => sameText(c.username, data.username) && c.password === data.password);
  if (!client) return toast("Usuário ou senha inválidos.");
  session = { type: "client", id: client.id };
  saveSession();
  clientSection = "inicio";
  render();
}

function renderStaffLogin(app) {
  app.innerHTML = `
    <main class="auth-page">
      <div class="auth-grid">
        ${baseHero()}
        <section class="auth-card">
          <button class="btn secondary small" id="backAuth" type="button">← Voltar ao login do cliente</button>
          <div style="height:18px"></div>
          <h2 class="panel-title">Acesso colaborativo</h2>
          <p class="panel-subtitle">Entre com um acesso colaborativo cadastrado.</p>
          <form id="staffLoginForm" class="form-stack">
            <div><label>Usuário colaborativo</label><input name="username" required autocomplete="username" /></div>
            <div><label>Senha</label><input name="password" required type="password" autocomplete="current-password" /></div>
            <button class="btn" type="submit">Entrar no painel</button>
          </form>
        </section>
      </div>
    </main>`;
  $("backAuth").onclick = () => { screen = "client-login"; render(); };
  $("staffLoginForm").onsubmit = loginStaff;
}

async function loginStaff(e) {
  e.preventDefault();
  await pullRemote(true);
  const data = Object.fromEntries(new FormData(e.target));
  const staff = db.collaborators.find(c => sameText(c.username, data.username) && c.password === data.password);
  if (!staff) return toast("Usuário ou senha inválidos.");
  if (!staff.active) return toast("Esse colaborador está bloqueado/inativo.");
  session = { type: "staff", id: staff.id };
  saveSession();
  staffSection = "painel";
  addLog(staff.name, `Entrou no painel colaborativo como ${roleName(staff.role)}.`);
  render();
}

function logout() {
  clearSession();
  screen = "client-login";
  render();
}

function renderTopbar(title, subtitle, badges = []) {
  return `
    <header class="topbar">
      <div class="brand"><div class="logo-mark">CS</div><div><div>${title}</div><small class="small-muted">${subtitle}</small></div></div>
      <div class="right">
        <span class="badge warning">100% simulação</span>
        ${syncBadge()}${badges.join("")}
        <button class="btn secondary small" id="logoutBtn">Sair</button>
      </div>
    </header>`;
}

function renderClientApp(app) {
  const c = currentClient();
  app.innerHTML = `
    <div class="app-shell">
      ${renderTopbar(`Olá, ${escapeHtml(c.name.split(" ")[0])}`, `Conta simulada`, [statusBadge(c), balanceBadge(c)])}
      <main class="main client-layout">
        <aside class="sidebar">
          ${clientNavBtn("inicio", "🏠", "Início")}
          ${clientNavBtn("pix", "⚡", "Pix simulado")}
          ${clientNavBtn("deposito", "⬇️", "Depósitos")}
          ${clientNavBtn("pagamentos", "🧾", "Pagamentos")}
          ${clientNavBtn("extrato", "📄", "Extrato")}
          ${clientNavBtn("perfil", "👤", "Perfil")}
        </aside>
        <section class="content" id="clientContent"></section>
      </main>
    </div>
    ${modal ? renderModal() : ""}`;
  $("logoutBtn").onclick = logout;
  document.querySelectorAll("[data-client-nav]").forEach(btn => btn.onclick = () => { clientSection = btn.dataset.clientNav; render(); });
  renderClientSection(c);
  attachModalHandlers();
}

function clientNavBtn(key, icon, label) {
  return `<button class="nav-btn ${clientSection === key ? "active" : ""}" data-client-nav="${key}">${icon} ${label}</button>`;
}
function statusBadge(c) {
  return c.accountBlocked ? `<span class="badge danger">Conta bloqueada</span>` : `<span class="badge ok">Conta ativa</span>`;
}
function balanceBadge(c) {
  return c.balanceBlocked ? `<span class="badge danger">Saldo bloqueado</span>` : `<span class="badge ok">Saldo livre</span>`;
}

function renderClientSection(c) {
  const box = $("clientContent");
  if (clientSection === "pix") return renderPix(c, box);
  if (clientSection === "deposito") return renderDeposits(c, box);
  if (clientSection === "pagamentos") return renderPayments(c, box);
  if (clientSection === "extrato") return renderStatement(c, box);
  if (clientSection === "perfil") return renderProfile(c, box);
  return renderClientHome(c, box);
}

function renderClientHome(c, box) {
  const pending = db.pendingDeposits.filter(d => d.clientId === c.id && d.status === "pendente").reduce((s, d) => s + d.amount, 0);
  box.innerHTML = `
    <section class="panel-card balance-card">
      <p class="panel-subtitle">Saldo disponível simulado</p>
      <h1 class="hero-title" style="margin:0;font-size:clamp(2.3rem,6vw,4rem)">${brMoney(c.balance)}</h1>
      <div class="actions-row" style="margin-top:18px">
        <button class="btn" data-client-nav="pix">Fazer Pix</button>
        <button class="btn secondary" data-client-nav="deposito">Solicitar depósito</button>
        <button class="btn secondary" data-client-nav="extrato">Ver extrato</button>
      </div>
    </section>
    <section class="grid-3">
      <div class="mini-card"><div class="label">Depósitos aguardando autorização</div><div class="value">${brMoney(pending)}</div></div>
      <div class="mini-card"><div class="label">Chaves Pix simuladas</div><div class="value">${c.pixKeys.length}</div></div>
      <div class="mini-card"><div class="label">Status</div><div class="value">${c.accountBlocked ? "Bloqueada" : "Ativa"}</div></div>
    </section>
    ${c.accountBlocked || c.balanceBlocked ? `<div class="notice danger"><strong>Atenção:</strong> sua ${c.accountBlocked ? "conta" : "movimentação de saldo"} está bloqueada nesta simulação. Algumas operações ficam impedidas.</div>` : `<div class="notice">Tudo pronto. Você pode testar Pix, QR Code, pagamento de boleto e depósitos pendentes de autorização.</div>`}
    <section class="panel-card">
      <h2 class="panel-title">Últimas movimentações</h2>
      ${transactionsTable(c.transactions.slice().reverse().slice(0, 6))}
    </section>`;
  document.querySelectorAll("[data-client-nav]").forEach(btn => btn.onclick = () => { clientSection = btn.dataset.clientNav; render(); });
}

function canMoveMoney(c) {
  if (c.accountBlocked) return "Conta bloqueada. Operação não permitida.";
  if (c.balanceBlocked) return "Saldo bloqueado. Operação não permitida.";
  return "";
}

function renderPix(c, box) {
  box.innerHTML = `
    <section class="panel-card">
      <h2 class="panel-title">Pix simulado</h2>
      <p class="panel-subtitle">Faça transferências fictícias entre clientes cadastrados. Não existe Pix real.</p>
      <div class="grid-2">
        <div class="mini-card">
          <h3>Minhas chaves</h3>
          <div class="block-list">${c.pixKeys.map(k => `<div class="code-box">${escapeHtml(k)}</div>`).join("")}</div>
          <div class="hr"></div>
          <form id="addPixKeyForm" class="form-stack">
            <div><label>Adicionar chave simulada</label><input name="key" placeholder="email, telefone ou chave aleatória" /></div>
            <button class="btn secondary" type="submit">Adicionar chave</button>
          </form>
        </div>
        <div class="mini-card">
          <h3>Enviar Pix por chave</h3>
          <form id="pixKeyForm" class="form-stack">
            <div><label>Chave Pix do destinatário</label><input name="key" required  /></div>
            <div><label>Valor</label><input name="amount" required type="number" step="0.01" min="0.01" placeholder="25,00" /></div>
            <div><label>Descrição</label><input name="description" placeholder="Ex: pagamento teste" /></div>
            <button class="btn" type="submit">Enviar Pix simulado</button>
          </form>
        </div>
      </div>
    </section>
    <section class="grid-2">
      <div class="panel-card">
        <h2 class="panel-title">Receber por QR Code</h2>
        <p class="panel-subtitle">Gere um QR visual e um código Pix Copia e Cola fictício.</p>
        <form id="qrReceiveForm" class="form-stack">
          <div><label>Valor para receber</label><input name="amount" type="number" step="0.01" min="0" placeholder="Opcional" /></div>
          <div><label>Descrição</label><input name="description" placeholder="Ex: pedido 001" /></div>
          <button class="btn secondary" type="submit">Gerar QR fictício</button>
        </form>
        <div id="qrGenerated" style="margin-top:16px"></div>
      </div>
      <div class="panel-card">
        <h2 class="panel-title">Pagar por QR/Copia e Cola</h2>
        <p class="panel-subtitle">Cole aqui o código gerado por outro cliente nesta simulação.</p>
        <form id="qrPayForm" class="form-stack">
          <div><label>Código QR/Pix Copia e Cola fictício</label><textarea name="payload" required placeholder="SIMPIX|to=...|amount=..."></textarea></div>
          <div><label>Valor, se o QR não tiver valor</label><input name="amount" type="number" step="0.01" min="0.01" /></div>
          <button class="btn" type="submit">Pagar QR simulado</button>
        </form>
      </div>
    </section>`;
  $("addPixKeyForm").onsubmit = addPixKey;
  $("pixKeyForm").onsubmit = sendPixByKey;
  $("qrReceiveForm").onsubmit = generateReceiveQr;
  $("qrPayForm").onsubmit = payByQr;
}

function addPixKey(e) {
  e.preventDefault();
  const c = currentClient();
  const key = new FormData(e.target).get("key").trim();
  if (!key) return toast("Digite uma chave.");
  const exists = db.clients.some(cli => cli.pixKeys.some(k => k.toLowerCase() === key.toLowerCase()));
  if (exists) return toast("Essa chave já está em uso na simulação.");
  c.pixKeys.push(key);
  addLog(c.name, `Adicionou uma chave Pix simulada: ${key}.`);
  toast("Chave Pix adicionada.");
  render();
}

function moveBalance({ fromId, toId, amount, title, description, channel }) {
  const from = getClient(fromId);
  const to = getClient(toId);
  if (!from || !to) return "Conta de origem ou destino não encontrada.";
  if (fromId === toId) return "Não é possível enviar Pix para a própria conta.";
  const blockMsg = canMoveMoney(from);
  if (blockMsg) return blockMsg;
  if (to.accountBlocked) return "A conta de destino está bloqueada.";
  if (amount <= 0) return "Valor inválido.";
  if (from.balance < amount) return "Saldo insuficiente.";
  from.balance = Number((from.balance - amount).toFixed(2));
  to.balance = Number((to.balance + amount).toFixed(2));
  const t = now();
  from.transactions.push({ id: uid("tx"), type: "saida", title, amount, date: t, status: "concluído", description: `${description || ""} Destino: ${to.name}. Canal: ${channel}.` });
  to.transactions.push({ id: uid("tx"), type: "entrada", title: `Pix recebido de ${from.name}`, amount, date: t, status: "concluído", description: `${description || ""} Origem: ${from.name}. Canal: ${channel}.` });
  addLog(from.name, `Enviou ${brMoney(amount)} para ${to.name} via ${channel}.`);
  return "";
}

function sendPixByKey(e) {
  e.preventDefault();
  const c = currentClient();
  const data = Object.fromEntries(new FormData(e.target));
  const key = data.key.trim().toLowerCase();
  const amount = Number(data.amount);
  const to = db.clients.find(cli => cli.pixKeys.some(k => k.toLowerCase() === key));
  if (!to) return toast("Chave Pix não encontrada nesta simulação.");
  const err = moveBalance({ fromId: c.id, toId: to.id, amount, title: `Pix enviado para ${to.name}`, description: data.description, channel: "chave" });
  if (err) return toast(err);
  toast("Pix simulado enviado.");
  render();
}

function makeQrPayload(clientId, amount, description) {
  const parts = ["SIMPIX", `to=${clientId}`, `amount=${Number(amount || 0).toFixed(2)}`, `desc=${encodeURIComponent(description || "")}`, `nonce=${Math.random().toString(36).slice(2, 11)}`];
  return parts.join("|");
}

function parseQrPayload(payload) {
  const raw = String(payload || "").trim();
  if (!raw.startsWith("SIMPIX|")) return null;
  const parts = raw.split("|").slice(1);
  const out = {};
  parts.forEach(p => {
    const [k, ...rest] = p.split("=");
    out[k] = rest.join("=");
  });
  return { to: out.to, amount: Number(out.amount || 0), desc: decodeURIComponent(out.desc || "") };
}

function generateReceiveQr(e) {
  e.preventDefault();
  const c = currentClient();
  const data = Object.fromEntries(new FormData(e.target));
  const amount = Number(data.amount || 0);
  const payload = makeQrPayload(c.id, amount, data.description);
  lastGeneratedQr = payload;
  const target = $("qrGenerated");
  target.innerHTML = `
    <div class="qr-wrap">
      <canvas id="qrCanvas" class="qr-canvas" width="176" height="176"></canvas>
      <div style="flex:1;min-width:220px">
        <div class="code-box" id="qrPayloadBox">${escapeHtml(payload)}</div>
        <div class="actions-row" style="margin-top:10px">
          <button class="btn small secondary" id="copyPayload" type="button">Copiar código</button>
        </div>
        <p class="small-muted">QR Code visual apenas para simulação. Para pagar, copie o código e cole em “Pagar por QR/Copia e Cola”.</p>
      </div>
    </div>`;
  drawFakeQr("qrCanvas", payload);
  $("copyPayload").onclick = () => {
    navigator.clipboard?.writeText(payload);
    toast("Código copiado.");
  };
}

function drawFakeQr(canvasId, payload) {
  const canvas = $(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  const cells = 22;
  const pad = 12;
  const cell = (size - pad * 2) / cells;
  let seed = 0;
  for (let i = 0; i < payload.length; i++) seed = (seed * 31 + payload.charCodeAt(i)) >>> 0;
  function rand() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
  ctx.fillStyle = "#07111f";
  function eye(x, y) {
    ctx.fillRect(pad + x * cell, pad + y * cell, cell * 6, cell * 6);
    ctx.fillStyle = "#fff"; ctx.fillRect(pad + (x + 1) * cell, pad + (y + 1) * cell, cell * 4, cell * 4);
    ctx.fillStyle = "#07111f"; ctx.fillRect(pad + (x + 2) * cell, pad + (y + 2) * cell, cell * 2, cell * 2);
  }
  eye(0, 0); eye(16, 0); eye(0, 16);
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const inEye = (x < 7 && y < 7) || (x > 14 && y < 7) || (x < 7 && y > 14);
      if (inEye) continue;
      if (rand() > 0.57) ctx.fillRect(pad + x * cell, pad + y * cell, Math.ceil(cell), Math.ceil(cell));
    }
  }
}

function payByQr(e) {
  e.preventDefault();
  const c = currentClient();
  const data = Object.fromEntries(new FormData(e.target));
  const parsed = parseQrPayload(data.payload);
  if (!parsed) return toast("Código QR inválido para esta simulação.");
  const to = getClient(parsed.to);
  if (!to) return toast("Conta de destino do QR não encontrada.");
  const amount = parsed.amount > 0 ? parsed.amount : Number(data.amount);
  const err = moveBalance({ fromId: c.id, toId: to.id, amount, title: `Pix QR para ${to.name}`, description: parsed.desc, channel: "QR/Copia e Cola" });
  if (err) return toast(err);
  toast("Pagamento por QR simulado concluído.");
  render();
}

function renderDeposits(c, box) {
  const deposits = db.pendingDeposits.filter(d => d.clientId === c.id).slice().reverse();
  box.innerHTML = `
    <section class="panel-card">
      <h2 class="panel-title">Solicitar depósito</h2>
      <p class="panel-subtitle">Todo depósito fica pendente e só entra no saldo após aprovação do cargo Gerencial ou Owner.</p>
      <form id="depositForm" class="form-stack">
        <div class="two">
          <div><label>Valor</label><input name="amount" required type="number" min="0.01" step="0.01" placeholder="100,00" /></div>
          <div><label>Origem simulada</label><select name="origin"><option>Pix externo fictício</option><option>Caixa fictício</option><option>Transferência fictícia</option></select></div>
        </div>
        <div><label>Observação</label><input name="note" placeholder="Ex: depósito para teste" /></div>
        <button class="btn" type="submit">Enviar para autorização</button>
      </form>
    </section>
    <section class="panel-card">
      <h2 class="panel-title">Meus pedidos de depósito</h2>
      ${deposits.length ? depositsTable(deposits, false) : `<div class="empty">Nenhum depósito solicitado ainda.</div>`}
    </section>`;
  $("depositForm").onsubmit = requestDeposit;
}

function requestDeposit(e) {
  e.preventDefault();
  const c = currentClient();
  if (c.accountBlocked) return toast("Conta bloqueada. Depósito não permitido.");
  const data = Object.fromEntries(new FormData(e.target));
  const amount = Number(data.amount);
  if (amount <= 0) return toast("Valor inválido.");
  const dep = { id: uid("dep"), clientId: c.id, amount, origin: data.origin, note: data.note || "", status: "pendente", requestedAt: now(), decidedAt: "", decidedBy: "" };
  db.pendingDeposits.push(dep);
  c.transactions.push({ id: uid("tx"), type: "pendente", title: "Depósito solicitado", amount, date: dep.requestedAt, status: "pendente", description: "Aguardando autorização gerencial." });
  addLog(c.name, `Solicitou depósito de ${brMoney(amount)}.`);
  toast("Depósito enviado para autorização.");
  render();
}

function renderPayments(c, box) {
  box.innerHTML = `
    <section class="panel-card">
      <h2 class="panel-title">Pagamentos simulados</h2>
      <p class="panel-subtitle">Pague boleto/conta fictícia. O valor sai do saldo simulado imediatamente.</p>
      <form id="billForm" class="form-stack">
        <div><label>Linha digitável fictícia</label><input name="code" required placeholder="00000.00000 00000.000000 00000.000000 0 00000000000000" /></div>
        <div class="two">
          <div><label>Valor</label><input name="amount" required type="number" min="0.01" step="0.01" /></div>
          <div><label>Favorecido</label><input name="payee" placeholder="Empresa fictícia" /></div>
        </div>
        <button class="btn" type="submit">Pagar boleto simulado</button>
      </form>
    </section>
    <section class="panel-card">
      <h2 class="panel-title">Saque simulado</h2>
      <p class="panel-subtitle">Teste uma retirada fictícia de saldo.</p>
      <form id="withdrawForm" class="form-stack">
        <div><label>Valor do saque</label><input name="amount" required type="number" min="0.01" step="0.01" /></div>
        <button class="btn secondary" type="submit">Realizar saque simulado</button>
      </form>
    </section>`;
  $("billForm").onsubmit = payBill;
  $("withdrawForm").onsubmit = withdrawMoney;
}

function payBill(e) {
  e.preventDefault();
  const c = currentClient();
  const blockMsg = canMoveMoney(c);
  if (blockMsg) return toast(blockMsg);
  const data = Object.fromEntries(new FormData(e.target));
  const amount = Number(data.amount);
  if (amount <= 0) return toast("Valor inválido.");
  if (c.balance < amount) return toast("Saldo insuficiente.");
  c.balance = Number((c.balance - amount).toFixed(2));
  c.transactions.push({ id: uid("tx"), type: "saida", title: `Boleto pago: ${data.payee || "favorecido fictício"}`, amount, date: now(), status: "concluído", description: `Linha digitável fictícia: ${data.code}` });
  addLog(c.name, `Pagou boleto simulado de ${brMoney(amount)}.`);
  toast("Pagamento simulado concluído.");
  saveDB();
  render();
}

function withdrawMoney(e) {
  e.preventDefault();
  const c = currentClient();
  const blockMsg = canMoveMoney(c);
  if (blockMsg) return toast(blockMsg);
  const amount = Number(new FormData(e.target).get("amount"));
  if (amount <= 0) return toast("Valor inválido.");
  if (c.balance < amount) return toast("Saldo insuficiente.");
  c.balance = Number((c.balance - amount).toFixed(2));
  c.transactions.push({ id: uid("tx"), type: "saida", title: "Saque simulado", amount, date: now(), status: "concluído", description: "Retirada fictícia realizada pelo cliente." });
  addLog(c.name, `Realizou saque simulado de ${brMoney(amount)}.`);
  toast("Saque simulado realizado.");
  saveDB();
  render();
}

function renderStatement(c, box) {
  box.innerHTML = `
    <section class="panel-card">
      <h2 class="panel-title">Extrato</h2>
      <p class="panel-subtitle">Histórico de movimentações fictícias da conta.</p>
      ${transactionsTable(c.transactions.slice().reverse())}
    </section>`;
}

function transactionsTable(transactions) {
  if (!transactions.length) return `<div class="empty">Nenhuma movimentação.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Operação</th><th>Tipo</th><th>Valor</th><th>Status</th><th>Descrição</th></tr></thead><tbody>
    ${transactions.map(t => `<tr>
      <td>${brDate(t.date)}</td><td>${escapeHtml(t.title)}</td><td>${escapeHtml(t.type)}</td><td>${brMoney(t.amount)}</td><td>${escapeHtml(t.status)}</td><td>${escapeHtml(t.description || "")}</td>
    </tr>`).join("")}
  </tbody></table></div>`;
}

function renderProfile(c, box) {
  box.innerHTML = `
    <section class="panel-card">
      <h2 class="panel-title">Meu perfil</h2>
      <p class="panel-subtitle">Dados fictícios da conta. Alterações ficam salvas apenas neste navegador.</p>
      <form id="profileForm" class="form-stack">
        <div><label>Nome</label><input name="name" value="${escapeHtml(c.name)}" /></div>
        <div class="two">
          <div><label>E-mail</label><input name="email" value="${escapeHtml(c.email || "")}" /></div>
          <div><label>Telefone</label><input name="phone" value="${escapeHtml(c.phone || "")}" /></div>
        </div>
        <button class="btn secondary" type="submit">Salvar perfil</button>
      </form>
    </section>
    <section class="panel-card">
      <h2 class="panel-title">Segurança simulada</h2>
      <form id="changeClientPass" class="form-stack">
        <div class="two">
          <div><label>Senha atual</label><input name="current" type="password" required /></div>
          <div><label>Nova senha</label><input name="newPass" type="password" required minlength="4" /></div>
        </div>
        <button class="btn secondary" type="submit">Alterar senha</button>
      </form>
      <div class="hr"></div>
      <div class="block-list">
        <div class="block-item"><strong>Bloqueio de conta:</strong> ${c.accountBlocked ? "ativo" : "não ativo"}</div>
        <div class="block-item"><strong>Bloqueio de saldo:</strong> ${c.balanceBlocked ? "ativo" : "não ativo"}</div>
      </div>
    </section>`;
  $("profileForm").onsubmit = updateClientProfile;
  $("changeClientPass").onsubmit = changeClientPassword;
}

function updateClientProfile(e) {
  e.preventDefault();
  const c = currentClient();
  const data = Object.fromEntries(new FormData(e.target));
  c.name = data.name.trim() || c.name;
  c.email = data.email.trim();
  c.phone = data.phone.trim();
  addLog(c.name, "Atualizou o perfil simulado.");
  toast("Perfil atualizado.");
  saveDB();
  render();
}

function changeClientPassword(e) {
  e.preventDefault();
  const c = currentClient();
  const data = Object.fromEntries(new FormData(e.target));
  if (data.current !== c.password) return toast("Senha atual incorreta.");
  c.password = data.newPass;
  addLog(c.name, "Alterou a senha da conta simulada.");
  toast("Senha alterada.");
  saveDB();
  render();
}

function renderStaffApp(app) {
  const staff = currentStaff();
  const p = perms(staff.role);
  const badge = `<span class="badge role">${roleName(staff.role)}</span>`;
  app.innerHTML = `
    <div class="app-shell">
      ${renderTopbar(`Painel colaborativo`, `${escapeHtml(staff.name)} • ${roleName(staff.role)}`, [badge])}
      <main class="main staff-layout">
        <aside class="sidebar">
          ${staffNavBtn("painel", "📊", "Painel")}
          ${p.viewClients ? staffNavBtn("clientes", "👥", "Clientes") : ""}
          ${p.authorizeDeposits ? staffNavBtn("depositos", "✅", "Autorizar depósitos") : ""}
          ${(p.applyBlocks || p.removeBlocks) ? staffNavBtn("bloqueios", "🔒", "Bloqueios") : ""}
          ${p.manageCollaborators ? staffNavBtn("colaboradores", "🧑‍💼", "Colaboradores") : ""}
          ${p.alterBalance ? staffNavBtn("saldos", "💰", "Alterar saldos") : ""}
          ${p.audit ? staffNavBtn("auditoria", "📝", "Auditoria") : ""}
          ${p.resetSimulation ? staffNavBtn("config", "⚙️", "Configuração") : ""}
        </aside>
        <section class="content staff-panel" id="staffContent"></section>
      </main>
    </div>
    ${modal ? renderModal() : ""}`;
  $("logoutBtn").onclick = logout;
  document.querySelectorAll("[data-staff-nav]").forEach(btn => btn.onclick = () => { staffSection = btn.dataset.staffNav; render(); });
  renderStaffSection(staff, p);
  attachModalHandlers();
}

function staffNavBtn(key, icon, label) {
  return `<button class="nav-btn ${staffSection === key ? "active" : ""}" data-staff-nav="${key}">${icon} ${label}</button>`;
}

function renderStaffSection(staff, p) {
  const box = $("staffContent");
  if (staffSection === "clientes" && p.viewClients) return renderStaffClients(staff, p, box);
  if (staffSection === "depositos" && p.authorizeDeposits) return renderStaffDeposits(staff, p, box);
  if (staffSection === "bloqueios" && (p.applyBlocks || p.removeBlocks)) return renderStaffBlocks(staff, p, box);
  if (staffSection === "colaboradores" && p.manageCollaborators) return renderCollaborators(staff, p, box);
  if (staffSection === "saldos" && p.alterBalance) return renderBalances(staff, p, box);
  if (staffSection === "auditoria" && p.audit) return renderAudit(staff, p, box);
  if (staffSection === "config" && p.resetSimulation) return renderConfig(staff, p, box);
  return renderStaffHome(staff, p, box);
}

function renderStaffHome(staff, p, box) {
  const totalBalance = db.clients.reduce((s, c) => s + c.balance, 0);
  const blockedAccounts = db.clients.filter(c => c.accountBlocked).length;
  const blockedBalances = db.clients.filter(c => c.balanceBlocked).length;
  const pending = db.pendingDeposits.filter(d => d.status === "pendente").length;
  box.innerHTML = `
    <section class="grid-3">
      <div class="mini-card"><div class="label">Clientes cadastrados</div><div class="value">${db.clients.length}</div></div>
      <div class="mini-card"><div class="label">Saldo total simulado</div><div class="value">${brMoney(totalBalance)}</div></div>
      <div class="mini-card"><div class="label">Depósitos pendentes</div><div class="value">${pending}</div></div>
    </section>
    <section class="panel-card">
      <h2 class="panel-title">Permissões do cargo ${roleName(staff.role)}</h2>
      <p class="panel-subtitle">O painel bloqueia ações conforme o cargo logado.</p>
      <div class="permission-grid">
        ${permLine("Ver clientes e saldo", p.viewClients)}
        ${permLine("Aplicar bloqueios", p.applyBlocks)}
        ${permLine("Remover bloqueios", p.removeBlocks)}
        ${permLine("Autorizar depósitos", p.authorizeDeposits)}
        ${permLine("Criar/remover colaboradores", p.manageCollaborators)}
        ${permLine("Ver/alterar senhas", p.seePasswords)}
        ${permLine("Alterar saldo", p.alterBalance)}
        ${permLine("Resetar simulação", p.resetSimulation)}
      </div>
    </section>
    <section class="grid-2">
      <div class="mini-card"><div class="label">Contas bloqueadas</div><div class="value">${blockedAccounts}</div></div>
      <div class="mini-card"><div class="label">Saldos bloqueados</div><div class="value">${blockedBalances}</div></div>
    </section>`;
}

function permLine(label, ok) {
  return `<div class="permission-item"><strong>${ok ? "✅ Permitido" : "⛔ Sem permissão"}</strong>${label}</div>`;
}

function renderStaffClients(staff, p, box) {
  box.innerHTML = `
    <section class="panel-card">
      <div class="actions-row" style="justify-content:space-between;align-items:center">
        <div><h2 class="panel-title">Clientes cadastrados</h2><p class="panel-subtitle">Consulta de contas e saldo conforme o cargo.</p></div>
        ${p.addClient ? `<button class="btn small" id="openAddClient">Adicionar cliente</button>` : ""}
      </div>
      <div class="form-stack" style="margin-bottom:14px"><input id="clientSearch" placeholder="Buscar por nome, telefone ou chave Pix" /></div>
      <div id="clientsTable"></div>
    </section>`;
  if (p.addClient) $("openAddClient").onclick = () => openAddClientModal();
  const input = $("clientSearch");
  input.oninput = () => renderClientsTable(p, input.value);
  renderClientsTable(p, "");
}

function renderClientsTable(p, query) {
  const q = String(query || "").toLowerCase();
  const list = db.clients.filter(c => [c.name, c.username, c.email, c.phone, ...c.pixKeys].join(" ").toLowerCase().includes(q));
  const target = $("clientsTable");
  if (!list.length) { target.innerHTML = `<div class="empty">Nenhum cliente encontrado.</div>`; return; }
  target.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Cliente</th><th>Acesso</th><th>Saldo</th><th>Status</th><th>Chaves Pix</th><th>Ações</th></tr></thead><tbody>
    ${list.map(c => `<tr>
      <td><strong>${escapeHtml(c.name)}</strong><br><span class="small-muted">Criado em ${brDate(c.createdAt)}</span></td>
      <td><span class="small-muted">Usuário e senha ocultos</span>${p.seePasswords ? `<br><button class="btn secondary small" data-reveal-client="${c.id}">Ver acesso</button>` : ""}</td>
      <td>${brMoney(c.balance)}</td>
      <td>${c.accountBlocked ? `<span class="badge danger">conta bloqueada</span>` : `<span class="badge ok">conta ativa</span>`}<br>${c.balanceBlocked ? `<span class="badge danger">saldo bloqueado</span>` : `<span class="badge ok">saldo livre</span>`}</td>
      <td>${c.pixKeys.map(k => `<div class="small-muted">${escapeHtml(k)}</div>`).join("")}</td>
      <td><div class="row-actions">
        ${p.applyBlocks ? `<button class="btn warning small" data-block-account="${c.id}" ${c.accountBlocked ? "disabled" : ""}>Bloquear conta</button><button class="btn warning small" data-block-balance="${c.id}" ${c.balanceBlocked ? "disabled" : ""}>Bloquear saldo</button>` : ""}
        ${p.removeBlocks ? `<button class="btn secondary small" data-unblock-account="${c.id}" ${!c.accountBlocked ? "disabled" : ""}>Desbloq. conta</button><button class="btn secondary small" data-unblock-balance="${c.id}" ${!c.balanceBlocked ? "disabled" : ""}>Desbloq. saldo</button>` : ""}
        ${p.editClient ? `<button class="btn secondary small" data-edit-client="${c.id}">Editar</button>` : ""}
        ${p.removeClient ? `<button class="btn danger small" data-remove-client="${c.id}">Remover</button>` : ""}
      </div></td>
    </tr>`).join("")}
  </tbody></table></div>`;
  attachClientActionButtons(p);
}

function attachClientActionButtons(p) {
  document.querySelectorAll("[data-block-account]").forEach(b => b.onclick = () => applyBlock(b.dataset.blockAccount, "account"));
  document.querySelectorAll("[data-block-balance]").forEach(b => b.onclick = () => applyBlock(b.dataset.blockBalance, "balance"));
  document.querySelectorAll("[data-unblock-account]").forEach(b => b.onclick = () => removeBlock(b.dataset.unblockAccount, "account"));
  document.querySelectorAll("[data-unblock-balance]").forEach(b => b.onclick = () => removeBlock(b.dataset.unblockBalance, "balance"));
  document.querySelectorAll("[data-edit-client]").forEach(b => b.onclick = () => openEditClientModal(b.dataset.editClient));
  document.querySelectorAll("[data-remove-client]").forEach(b => b.onclick = () => removeClient(b.dataset.removeClient));
  document.querySelectorAll("[data-reveal-client]").forEach(b => b.onclick = () => revealClientAccess(b.dataset.revealClient));
}

function applyBlock(clientId, kind) {
  const staff = currentStaff();
  const p = perms(staff.role);
  if (!p.applyBlocks) return toast("Seu cargo não pode aplicar bloqueios.");
  const c = getClient(clientId);
  if (!c) return;
  const label = kind === "account" ? "conta" : "saldo";
  const reason = prompt(`Motivo do bloqueio de ${label}:`) || "Bloqueio aplicado pela equipe.";
  if (kind === "account") c.accountBlocked = true;
  if (kind === "balance") c.balanceBlocked = true;
  c.blocks.unshift({ id: uid("blk"), kind, action: "aplicado", reason, by: staff.name, byRole: staff.role, date: now() });
  addLog(staff.name, `Aplicou bloqueio de ${label} em ${c.name}. Motivo: ${reason}`);
  syncDBAndRefresh(`Bloqueio de ${label} aplicado em tempo real.`);
}

function removeBlock(clientId, kind) {
  const staff = currentStaff();
  const p = perms(staff.role);
  if (!p.removeBlocks) return toast("Seu cargo não pode retirar bloqueios.");
  const c = getClient(clientId);
  if (!c) return;
  const label = kind === "account" ? "conta" : "saldo";
  const reason = prompt(`Motivo da retirada do bloqueio de ${label}:`) || "Bloqueio retirado pela equipe autorizada.";
  if (kind === "account") c.accountBlocked = false;
  if (kind === "balance") c.balanceBlocked = false;
  c.blocks.unshift({ id: uid("blk"), kind, action: "retirado", reason, by: staff.name, byRole: staff.role, date: now() });
  addLog(staff.name, `Retirou bloqueio de ${label} de ${c.name}. Motivo: ${reason}`);
  syncDBAndRefresh(`Bloqueio de ${label} retirado em tempo real.`);
}

function renderStaffDeposits(staff, p, box) {
  const pending = db.pendingDeposits.filter(d => d.status === "pendente");
  const all = db.pendingDeposits.slice().reverse();
  box.innerHTML = `
    <section class="panel-card">
      <h2 class="panel-title">Autorizar depósitos</h2>
      <p class="panel-subtitle">Depósitos solicitados pelo cliente só entram no saldo depois de autorização.</p>
      ${pending.length ? depositsTable(pending, true) : `<div class="empty">Nenhum depósito pendente.</div>`}
    </section>
    <section class="panel-card">
      <h2 class="panel-title">Histórico de depósitos</h2>
      ${all.length ? depositsTable(all, false, true) : `<div class="empty">Nenhum depósito registrado.</div>`}
    </section>`;
  document.querySelectorAll("[data-approve-dep]").forEach(b => b.onclick = () => decideDeposit(b.dataset.approveDep, "aprovado"));
  document.querySelectorAll("[data-reject-dep]").forEach(b => b.onclick = () => decideDeposit(b.dataset.rejectDep, "rejeitado"));
}

function depositsTable(deposits, withActions, compact = false) {
  return `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Cliente</th><th>Valor</th><th>Origem</th><th>Status</th>${withActions ? "<th>Ações</th>" : ""}</tr></thead><tbody>
    ${deposits.map(d => { const c = getClient(d.clientId) || {}; return `<tr>
      <td>${brDate(d.requestedAt)}</td><td>${escapeHtml(c.name || "Cliente removido")}<br><span class="small-muted">${escapeHtml(c.username || "")}</span></td><td>${brMoney(d.amount)}</td><td>${escapeHtml(d.origin)}<br><span class="small-muted">${escapeHtml(d.note || "")}</span></td><td><span class="badge ${d.status === "aprovado" ? "ok" : d.status === "rejeitado" ? "danger" : "warning"}">${escapeHtml(d.status)}</span>${d.decidedBy ? `<br><span class="small-muted">por ${escapeHtml(d.decidedBy)} em ${brDate(d.decidedAt)}</span>` : ""}</td>
      ${withActions ? `<td><div class="row-actions"><button class="btn ok small" data-approve-dep="${d.id}">Autorizar</button><button class="btn danger small" data-reject-dep="${d.id}">Rejeitar</button></div></td>` : ""}
    </tr>`; }).join("")}
  </tbody></table></div>`;
}

function decideDeposit(depId, status) {
  const staff = currentStaff();
  const p = perms(staff.role);
  if (!p.authorizeDeposits) return toast("Seu cargo não pode autorizar depósitos.");
  const dep = db.pendingDeposits.find(d => d.id === depId);
  if (!dep || dep.status !== "pendente") return toast("Depósito não está pendente.");
  const c = getClient(dep.clientId);
  if (!c) return toast("Cliente não encontrado.");
  dep.status = status;
  dep.decidedAt = now();
  dep.decidedBy = staff.name;
  if (status === "aprovado") {
    c.balance = Number((c.balance + dep.amount).toFixed(2));
    c.transactions.push({ id: uid("tx"), type: "entrada", title: "Depósito autorizado", amount: dep.amount, date: dep.decidedAt, status: "concluído", description: `Autorizado por ${staff.name}.` });
    addLog(staff.name, `Autorizou depósito de ${brMoney(dep.amount)} para ${c.name}.`);
    toast("Depósito autorizado e saldo atualizado.");
  } else {
    c.transactions.push({ id: uid("tx"), type: "rejeitado", title: "Depósito rejeitado", amount: dep.amount, date: dep.decidedAt, status: "rejeitado", description: `Rejeitado por ${staff.name}.` });
    addLog(staff.name, `Rejeitou depósito de ${brMoney(dep.amount)} para ${c.name}.`);
    toast("Depósito rejeitado.");
  }
  saveDB(); render();
}

function renderStaffBlocks(staff, p, box) {
  const blocked = db.clients.filter(c => c.accountBlocked || c.balanceBlocked);
  box.innerHTML = `
    <section class="panel-card">
      <h2 class="panel-title">Bloqueios</h2>
      <p class="panel-subtitle">Financeiro pode aplicar bloqueios. Gerencial e Owner podem retirar bloqueios.</p>
      ${blocked.length ? `<div class="table-wrap"><table><thead><tr><th>Cliente</th><th>Bloqueios ativos</th><th>Histórico</th><th>Ações</th></tr></thead><tbody>
      ${blocked.map(c => `<tr><td><strong>${escapeHtml(c.name)}</strong><br><span class="small-muted">${escapeHtml(c.username)}</span></td><td>${c.accountBlocked ? `<span class="badge danger">conta</span>` : ""} ${c.balanceBlocked ? `<span class="badge danger">saldo</span>` : ""}</td><td>${c.blocks.slice(0,4).map(b => `<div class="small-muted">${brDate(b.date)} • ${b.action} ${b.kind === "account" ? "conta" : "saldo"} • ${escapeHtml(b.by)}: ${escapeHtml(b.reason)}</div>`).join("")}</td><td><div class="row-actions">${p.removeBlocks ? `<button class="btn secondary small" data-unblock-account="${c.id}" ${!c.accountBlocked ? "disabled" : ""}>Desbloq. conta</button><button class="btn secondary small" data-unblock-balance="${c.id}" ${!c.balanceBlocked ? "disabled" : ""}>Desbloq. saldo</button>` : `<span class="small-muted">sem permissão para desbloquear</span>`}</div></td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">Nenhum bloqueio ativo.</div>`}
    </section>`;
  document.querySelectorAll("[data-unblock-account]").forEach(b => b.onclick = () => removeBlock(b.dataset.unblockAccount, "account"));
  document.querySelectorAll("[data-unblock-balance]").forEach(b => b.onclick = () => removeBlock(b.dataset.unblockBalance, "balance"));
}

function renderCollaborators(staff, p, box) {
  box.innerHTML = `
    <section class="panel-card">
      <div class="actions-row" style="justify-content:space-between;align-items:center">
        <div><h2 class="panel-title">Colaboradores</h2><p class="panel-subtitle">Somente Owner pode adicionar, remover, alterar senha, cargo e status.</p></div>
        <button class="btn small" id="openAddStaff">Adicionar colaborador</button>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Nome</th><th>Acesso</th><th>Cargo</th><th>Status</th><th>Ações</th></tr></thead><tbody>
        ${db.collaborators.map(col => `<tr>
          <td>${escapeHtml(col.name)} ${col.protected ? `<br><span class="badge warning">owner principal</span>` : ""}</td>
          <td><span class="small-muted">Usuário e senha ocultos</span><br><button class="btn secondary small" data-reveal-staff="${col.id}">Ver acesso</button></td>
          <td>${roleName(col.role)}</td>
          <td>${col.active ? `<span class="badge ok">ativo</span>` : `<span class="badge danger">inativo</span>`}</td>
          <td><div class="row-actions"><button class="btn secondary small" data-edit-staff="${col.id}">Editar</button>${!col.protected ? `<button class="btn danger small" data-remove-staff="${col.id}">Remover</button>` : ""}</div></td>
        </tr>`).join("")}
      </tbody></table></div>
    </section>`;
  $("openAddStaff").onclick = openAddStaffModal;
  document.querySelectorAll("[data-edit-staff]").forEach(b => b.onclick = () => openEditStaffModal(b.dataset.editStaff));
  document.querySelectorAll("[data-remove-staff]").forEach(b => b.onclick = () => removeStaff(b.dataset.removeStaff));
  document.querySelectorAll("[data-reveal-staff]").forEach(b => b.onclick = () => revealStaffAccess(b.dataset.revealStaff));
}

function renderBalances(staff, p, box) {
  box.innerHTML = `
    <section class="panel-card">
      <h2 class="panel-title">Alterar saldo</h2>
      <p class="panel-subtitle">Somente Owner pode corrigir saldo manualmente.</p>
      <form id="balanceForm" class="form-stack">
        <div><label>Cliente</label><select name="clientId">${db.clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)} — ${escapeHtml(c.username)} — ${brMoney(c.balance)}</option>`).join("")}</select></div>
        <div class="two"><div><label>Novo saldo</label><input name="balance" type="number" step="0.01" required /></div><div><label>Motivo</label><input name="reason" required placeholder="Ex: ajuste manual owner" /></div></div>
        <button class="btn" type="submit">Alterar saldo</button>
      </form>
    </section>`;
  $("balanceForm").onsubmit = alterBalance;
}

function alterBalance(e) {
  e.preventDefault();
  const staff = currentStaff();
  if (!perms(staff.role).alterBalance) return toast("Sem permissão.");
  const data = Object.fromEntries(new FormData(e.target));
  const c = getClient(data.clientId);
  if (!c) return toast("Cliente não encontrado.");
  const old = c.balance;
  const next = Number(data.balance);
  c.balance = Number(next.toFixed(2));
  c.transactions.push({ id: uid("tx"), type: "ajuste", title: "Ajuste manual de saldo", amount: c.balance - old, date: now(), status: "concluído", description: `Owner: ${staff.name}. Motivo: ${data.reason}. Saldo anterior: ${brMoney(old)}.` });
  addLog(staff.name, `Alterou saldo de ${c.name} de ${brMoney(old)} para ${brMoney(c.balance)}. Motivo: ${data.reason}`);
  syncDBAndRefresh("Saldo alterado em tempo real.");
}

function renderAudit(staff, p, box) {
  box.innerHTML = `
    <section class="panel-card">
      <h2 class="panel-title">Auditoria da simulação</h2>
      <p class="panel-subtitle">Registro das últimas ações feitas no app.</p>
      ${db.activity.length ? `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Ator</th><th>Ação</th></tr></thead><tbody>${db.activity.slice(0,100).map(l => `<tr><td>${brDate(l.date)}</td><td>${escapeHtml(l.actor)}</td><td>${escapeHtml(l.action)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Sem registros.</div>`}
    </section>`;
}

function renderConfig(staff, p, box) {
  const exportData = JSON.stringify(db, null, 2);
  box.innerHTML = `
    <section class="panel-card">
      <h2 class="panel-title">Configuração Owner</h2>
      <p class="panel-subtitle">Ferramentas extras da simulação local.</p>
      <div class="actions-row">
        <button class="btn secondary" id="exportBtn">Copiar backup JSON</button>
        <button class="btn danger" id="resetBtn">Resetar simulação</button>
      </div>
      <div class="hr"></div>
      <label>Backup atual</label>
      <textarea readonly style="min-height:260px">${escapeHtml(exportData)}</textarea>
    </section>`;
  $("exportBtn").onclick = () => { navigator.clipboard?.writeText(exportData); toast("Backup copiado."); };
  $("resetBtn").onclick = () => {
    if (!confirm("Resetar toda a simulação e voltar para o padrão?")) return;
    db = seedDB(); saveDB(); clearSession(); screen = "staff-login"; toast("Simulação resetada."); render();
  };
}

function revealClientAccess(id) {
  const staff = currentStaff();
  if (!staff || !perms(staff.role).seePasswords) return toast("Sem permissão para ver acessos.");
  const c = getClient(id);
  if (!c) return toast("Cliente não encontrado.");
  modal = { title: "Acesso do cliente", body: `
    <div class="notice warning">Esses dados são apenas desta simulação. Não use dados reais.</div>
    <div class="block-list">
      <div class="block-item"><strong>Usuário:</strong> <span class="code-box">${escapeHtml(c.username)}</span></div>
      <div class="block-item"><strong>Senha:</strong> <span class="code-box">${escapeHtml(c.password)}</span></div>
    </div>` };
  render();
}

function revealStaffAccess(id) {
  const owner = currentStaff();
  if (!owner || !perms(owner.role).seePasswords) return toast("Sem permissão para ver acessos.");
  const col = getStaff(id);
  if (!col) return toast("Colaborador não encontrado.");
  modal = { title: "Acesso do colaborador", body: `
    <div class="notice warning">Esses dados ficam ocultos na listagem e aparecem só para Owner.</div>
    <div class="block-list">
      <div class="block-item"><strong>Usuário:</strong> <span class="code-box">${escapeHtml(col.username)}</span></div>
      <div class="block-item"><strong>Senha:</strong> <span class="code-box">${escapeHtml(col.password)}</span></div>
    </div>` };
  render();
}

function openAddClientModal() {
  modal = { title: "Adicionar cliente", body: `
    <form id="modalAddClient" class="form-stack">
      <div><label>Nome</label><input name="name" required /></div>
      <div class="two"><div><label>Usuário</label><input name="username" required /></div><div><label>Senha</label><input name="password" required /></div></div>
      <div class="two"><div><label>E-mail</label><input name="email" /></div><div><label>Telefone</label><input name="phone" /></div></div>
      <div><label>Saldo inicial</label><input name="balance" type="number" step="0.01" value="0" /></div>
      <button class="btn" type="submit">Criar cliente</button>
    </form>` };
  render();
  $("modalAddClient").onsubmit = addClientByOwner;
}

async function addClientByOwner(e) {
  e.preventDefault();
  await pullRemote(true);
  const staff = currentStaff();
  if (!perms(staff.role).addClient) return toast("Sem permissão.");
  const data = Object.fromEntries(new FormData(e.target));
  const username = data.username.trim();
  if (db.clients.some(c => sameText(c.username, username))) return toast("Usuário de cliente já existe.");
  if (db.collaborators.some(c => sameText(c.username, username))) return toast("Esse usuário já está reservado na área colaborativa.");
  const email = (data.email || `${username}@simulacao.local`).trim();
  const c = { id: uid("cli"), name: data.name.trim(), username, password: data.password, email, phone: data.phone || "", document: "", balance: Number(data.balance || 0), accountBlocked: false, balanceBlocked: false, createdAt: now(), pixKeys: [email, `aleatoria-${username}-${Math.random().toString(36).slice(2, 7)}`], blocks: [], transactions: [] };
  c.transactions.push({ id: uid("tx"), type: "entrada", title: "Saldo inicial definido pelo owner", amount: c.balance, date: now(), status: "concluído", description: `Criado por ${staff.name}.` });
  db.clients.push(c);
  addLog(staff.name, `Criou cliente ${c.name}.`);
  modal = null;
  syncDBAndRefresh("Cliente criado e lista atualizada.");
}

function openEditClientModal(id) {
  const c = getClient(id);
  if (!c) return;
  modal = { title: `Editar cliente`, body: `
    <form id="modalEditClient" class="form-stack">
      <input name="id" type="hidden" value="${c.id}" />
      <div><label>Nome</label><input name="name" value="${escapeHtml(c.name)}" required /></div>
      <div class="two"><div><label>Usuário</label><input name="username" value="${escapeHtml(c.username)}" required /></div><div><label>Senha</label><input name="password" value="${escapeHtml(c.password)}" required /></div></div>
      <div class="two"><div><label>E-mail</label><input name="email" value="${escapeHtml(c.email || "")}" /></div><div><label>Telefone</label><input name="phone" value="${escapeHtml(c.phone || "")}" /></div></div>
      <button class="btn" type="submit">Salvar alterações</button>
    </form>` };
  render();
  $("modalEditClient").onsubmit = editClientByOwner;
}

async function editClientByOwner(e) {
  e.preventDefault();
  await pullRemote(true);
  const staff = currentStaff();
  if (!perms(staff.role).editClient) return toast("Sem permissão.");
  const data = Object.fromEntries(new FormData(e.target));
  const c = getClient(data.id);
  if (!c) return;
  const username = data.username.trim();
  if (db.clients.some(other => other.id !== c.id && sameText(other.username, username))) return toast("Usuário já existe.");
  if (db.collaborators.some(other => sameText(other.username, username))) return toast("Esse usuário já está reservado na área colaborativa.");
  c.name = data.name.trim(); c.username = username; c.password = data.password; c.email = data.email.trim(); c.phone = data.phone.trim();
  addLog(staff.name, `Editou dados/senha do cliente ${c.name}.`);
  modal = null;
  syncDBAndRefresh("Cliente atualizado em tempo real.");
}

function removeClient(id) {
  const staff = currentStaff();
  if (!perms(staff.role).removeClient) return toast("Sem permissão.");
  const c = getClient(id);
  if (!c) return;
  if (!confirm(`Remover cliente ${c.name}? Isso é apenas na simulação local.`)) return;
  db.clients = db.clients.filter(x => x.id !== id);
  db.pendingDeposits = db.pendingDeposits.filter(d => d.clientId !== id);
  addLog(staff.name, `Removeu cliente ${c.name}.`);
  syncDBAndRefresh("Cliente removido e lista atualizada.");
}

function openAddStaffModal() {
  modal = { title: "Adicionar colaborador", body: `
    <form id="modalAddStaff" class="form-stack">
      <div><label>Nome</label><input name="name" required /></div>
      <div class="two"><div><label>Usuário</label><input name="username" required /></div><div><label>Senha</label><input name="password" required /></div></div>
      <div><label>Cargo</label><select name="role"><option value="financeiro">Financeiro</option><option value="gerencial">Gerencial</option><option value="owner">Owner</option></select></div>
      <button class="btn" type="submit">Criar colaborador</button>
    </form>` };
  render();
  $("modalAddStaff").onsubmit = addStaff;
}

async function addStaff(e) {
  e.preventDefault();
  await pullRemote(true);
  const staff = currentStaff();
  if (!perms(staff.role).manageCollaborators) return toast("Sem permissão.");
  const data = Object.fromEntries(new FormData(e.target));
  const username = data.username.trim();
  if (db.collaborators.some(c => sameText(c.username, username))) return toast("Usuário colaborativo já existe.");
  if (db.clients.some(c => sameText(c.username, username))) return toast("Esse usuário já está reservado por um cliente.");
  db.collaborators.push({ id: uid("col"), name: data.name.trim(), username, password: data.password, role: data.role, active: true, protected: false, createdAt: now() });
  addLog(staff.name, `Criou colaborador ${data.name.trim()} com cargo ${roleName(data.role)}.`);
  modal = null;
  syncDBAndRefresh("Colaborador criado e lista atualizada.");
}

function openEditStaffModal(id) {
  const col = getStaff(id);
  if (!col) return;
  modal = { title: "Editar colaborador", body: `
    <form id="modalEditStaff" class="form-stack">
      <input name="id" type="hidden" value="${col.id}" />
      <div><label>Nome</label><input name="name" value="${escapeHtml(col.name)}" required /></div>
      <div class="two"><div><label>Usuário</label><input name="username" value="${escapeHtml(col.username)}" ${col.protected ? "readonly" : ""} required /></div><div><label>Senha</label><input name="password" value="${escapeHtml(col.password)}" required /></div></div>
      <div class="two"><div><label>Cargo</label><select name="role" ${col.protected ? "disabled" : ""}><option value="financeiro" ${col.role === "financeiro" ? "selected" : ""}>Financeiro</option><option value="gerencial" ${col.role === "gerencial" ? "selected" : ""}>Gerencial</option><option value="owner" ${col.role === "owner" ? "selected" : ""}>Owner</option></select></div><div><label>Status</label><select name="active" ${col.protected ? "disabled" : ""}><option value="true" ${col.active ? "selected" : ""}>Ativo</option><option value="false" ${!col.active ? "selected" : ""}>Inativo</option></select></div></div>
      <button class="btn" type="submit">Salvar colaborador</button>
    </form>` };
  render();
  $("modalEditStaff").onsubmit = editStaff;
}

async function editStaff(e) {
  e.preventDefault();
  await pullRemote(true);
  const owner = currentStaff();
  if (!perms(owner.role).manageCollaborators) return toast("Sem permissão.");
  const data = Object.fromEntries(new FormData(e.target));
  const col = getStaff(data.id);
  if (!col) return;
  const username = data.username.trim();
  if (db.collaborators.some(other => other.id !== col.id && sameText(other.username, username))) return toast("Usuário já existe.");
  if (db.clients.some(c => sameText(c.username, username))) return toast("Esse usuário já está reservado por um cliente.");
  col.name = data.name.trim();
  if (!col.protected) col.username = username;
  col.password = data.password;
  if (!col.protected) {
    col.role = data.role;
    col.active = data.active === "true";
  }
  addLog(owner.name, `Editou colaborador ${col.name}.`);
  modal = null;
  syncDBAndRefresh("Colaborador atualizado em tempo real.");
}

function removeStaff(id) {
  const owner = currentStaff();
  if (!perms(owner.role).manageCollaborators) return toast("Sem permissão.");
  const col = getStaff(id);
  if (!col || col.protected) return toast("Não é possível remover o owner principal.");
  if (!confirm(`Remover colaborador ${col.name}?`)) return;
  db.collaborators = db.collaborators.filter(c => c.id !== id);
  addLog(owner.name, `Removeu colaborador ${col.name}.`);
  syncDBAndRefresh("Colaborador removido e lista atualizada.");
}

function renderModal() {
  return `<div class="modal-backdrop" id="modalBackdrop"><div class="modal"><div class="modal-head"><h3>${escapeHtml(modal.title)}</h3><button class="btn secondary small" id="closeModal">Fechar</button></div>${modal.body}</div></div>`;
}

function attachModalHandlers() {
  const close = $("closeModal");
  if (close) close.onclick = () => { modal = null; render(); };
  const bg = $("modalBackdrop");
  if (bg) bg.onclick = (e) => { if (e.target === bg) { modal = null; render(); } };
}

window.addEventListener("storage", (event) => {
  if (event.key !== DB_KEY) return;
  db = loadDB();
  render();
});

localChannel && (localChannel.onmessage = (event) => {
  if (!event.data || !event.data.type) return;
  const fresh = loadDB();
  if ((fresh.revision || 0) !== (db.revision || 0) || fresh.updatedAt !== db.updatedAt) {
    db = fresh;
    render();
  }
});

async function initApp() {
  sync.started = true;
  render();
  await pullRemote(true);
  render();
  setInterval(async () => {
    const changed = await pullRemote(false);
    if (!changed && sync.started) {
      const badgeEls = document.querySelectorAll('.topbar .badge, .hero-card .badge');
      // Mantém o indicador atualizado sem forçar recarregamento visual pesado.
    }
  }, SYNC_INTERVAL_MS);
}

initApp();
