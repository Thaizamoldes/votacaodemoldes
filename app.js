// ═══════════════════════════════════════════════════════════════════════
// Votação de Moldes — Thaiza Gonçalves
// App completo em JS puro, integrado ao Supabase (Auth + Postgres + Storage)
// + checagem de assinatura ativa via webhook da Hotmart
// ═══════════════════════════════════════════════════════════════════════

const root = document.getElementById("root");
const toastEl = document.getElementById("toast");
const sb = window.supabaseClient;

// E-mail(s) que terão acesso de administradora (em minúsculas).
const ADMIN_EMAILS = ["thaizassinaturamoldes@gmail.com"];

let currentUser = null;     // { id, email, name, isAdmin, hasActiveSubscription }
let cfg = { round_name: "Votação de Moldes", submission_deadline: "", voting_deadline: "", max_photos_per_user: 5 };
let submissions = [];       // [{ id, user_id, user_name, user_email, submitted_at, photos:[{id, title, url}] }]
let votesMap = {};          // { photoId: Set(voterIds) }
let usersList = [];         // [{ id, name, email }]
let currentView = "upload";
let channels = [];

function showToast(msg, type = "ok") {
  toastEl.textContent = msg;
  toastEl.style.background = type === "ok" ? "var(--verde)" : "var(--alerta)";
  toastEl.style.display = "block";
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (toastEl.style.display = "none"), 3000);
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}
function isPast(iso) {
  if (!iso) return false;
  return new Date() > new Date(iso);
}
function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function esc(s) {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─────────────────────────────────────────────────────────────────────────
// LIGHTBOX (pop-up de foto ampliada)
// ─────────────────────────────────────────────────────────────────────────

function openLightbox(url, caption) {
  const overlay = document.createElement("div");
  overlay.className = "lightbox-overlay";
  overlay.innerHTML = `
    <button class="lightbox-close" aria-label="Fechar">✕</button>
    <img class="lightbox-img" src="${url}" alt="${esc(caption || "")}" />
    ${caption ? `<div class="lightbox-caption">${esc(caption)}</div>` : ""}
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  function close() {
    overlay.remove();
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector(".lightbox-close").onclick = close;
  document.addEventListener("keydown", onKey);
}

// ─────────────────────────────────────────────────────────────────────────
// SUPABASE: leitura/escrita
// ─────────────────────────────────────────────────────────────────────────

async function loadConfig() {
  const { data, error } = await sb.from("config").select("*").eq("id", 1).single();
  if (!error && data) cfg = data;
}

async function loadSubmissionsWithPhotos() {
  const { data: subs, error: e1 } = await sb.from("submissions").select("*").order("submitted_at", { ascending: false });
  if (e1) { console.error(e1); return; }
  const { data: photos, error: e2 } = await sb.from("photos").select("*");
  if (e2) { console.error(e2); return; }

  submissions = (subs || []).map((s) => ({
    ...s,
    photos: (photos || [])
      .filter((p) => p.submission_id === s.id)
      .map((p) => ({ ...p, url: getPhotoPublicUrl(p.storage_path) })),
  }));
}

function getPhotoPublicUrl(path) {
  const { data } = sb.storage.from("photos").getPublicUrl(path);
  return data.publicUrl;
}

async function loadVotes() {
  const { data, error } = await sb.from("votes").select("photo_id, voter_id");
  if (error) { console.error(error); return; }
  votesMap = {};
  (data || []).forEach((v) => {
    if (!votesMap[v.photo_id]) votesMap[v.photo_id] = new Set();
    votesMap[v.photo_id].add(v.voter_id);
  });
}

async function loadUsers() {
  const { data, error } = await sb.from("profiles").select("*").order("name");
  if (error) { console.error(error); return; }
  usersList = (data || []).filter((u) => !u.is_admin);
}

async function checkSubscription(email) {
  const { data, error } = await sb.rpc("has_active_subscription");
  if (error) { console.error(error); return false; }
  return !!data;
}

function subscribeRealtime(onChange) {
  const ch = sb
    .channel("votacao-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "submissions" }, async () => { await loadSubmissionsWithPhotos(); onChange(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "photos" }, async () => { await loadSubmissionsWithPhotos(); onChange(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "votes" }, async () => { await loadVotes(); onChange(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "config" }, async () => { await loadConfig(); onChange(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, async () => { await loadUsers(); onChange(); })
    .subscribe();
  channels.push(ch);
}

function unsubscribeAll() {
  channels.forEach((ch) => sb.removeChannel(ch));
  channels = [];
}

async function saveConfig(newCfg) {
  const { error } = await sb.from("config").update(newCfg).eq("id", 1);
  if (error) throw error;
  await loadConfig();
}

async function uploadPhotoFile(file, userId) {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${userId}/${uid()}.${ext}`;
  const { error } = await sb.storage.from("photos").upload(path, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: file.type || "image/jpeg",
  });
  if (error) throw error;
  return path;
}

async function deleteSubmissionAndPhotos(submission) {
  const paths = submission.photos.map((p) => p.storage_path);
  if (paths.length) await sb.storage.from("photos").remove(paths);
  const { error } = await sb.from("submissions").delete().eq("id", submission.id);
  if (error) throw error;
}

async function toggleVote(photoId, userId) {
  const already = votesMap[photoId] && votesMap[photoId].has(userId);
  if (already) {
    const { error } = await sb.from("votes").delete().eq("photo_id", photoId).eq("voter_id", userId);
    if (error) throw error;
  } else {
    const { error } = await sb.from("votes").insert({ photo_id: photoId, voter_id: userId });
    if (error) throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// AUTENTICAÇÃO
// ─────────────────────────────────────────────────────────────────────────

async function doRegister(name, email, password) {
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { name } },
  });
  if (error) throw error;
  if (data.user) {
    const isAdmin = ADMIN_EMAILS.includes(email.toLowerCase());
    await sb.from("profiles").upsert({
      id: data.user.id,
      name,
      email: email.toLowerCase(),
      is_admin: isAdmin,
    });
  }
}

async function doLogin(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

async function doLogout() {
  await sb.auth.signOut();
}

async function setupAuthListener() {
  const { data: { session } } = await sb.auth.getSession();
  await handleSession(session);

  sb.auth.onAuthStateChange(async (_event, session) => {
    await handleSession(session);
  });
}

async function handleSession(session) {
  unsubscribeAll();

  if (!session || !session.user) {
    currentUser = null;
    renderLogin();
    return;
  }

  const user = session.user;
  const email = (user.email || "").toLowerCase();
  const isAdmin = ADMIN_EMAILS.includes(email);

  let { data: profile } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (!profile) {
    const name = user.user_metadata?.name || email;
    await sb.from("profiles").upsert({ id: user.id, name, email, is_admin: isAdmin });
    profile = { id: user.id, name, email, is_admin: isAdmin };
  }

  const hasActiveSubscription = isAdmin ? true : await checkSubscription(email);

  currentUser = {
    id: user.id,
    email,
    name: profile.name || email,
    isAdmin,
    hasActiveSubscription,
  };
  currentView = isAdmin ? "admin" : "upload";

  await Promise.all([loadConfig(), loadSubmissionsWithPhotos(), loadVotes(), loadUsers()]);
  subscribeRealtime(() => { if (currentUser) renderApp(); });
  renderApp();
}

// ─────────────────────────────────────────────────────────────────────────
// RENDER: LOGIN
// ─────────────────────────────────────────────────────────────────────────

function renderLogin() {
  root.innerHTML = `
    <div class="container-sm" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;">
      <div style="text-align:center;margin-bottom:28px;">
        <div style="font-size:36px;margin-bottom:6px;">✂️</div>
        <div style="font-size:24px;font-weight:bold;color:var(--vinho);">Votação de Moldes</div>
        <div class="sans" style="font-size:13px;color:var(--texto-suave);margin-top:4px;">Thaiza Gonçalves • Assinatura de Moldes</div>
      </div>
      <div class="card" style="width:100%;">
        <div class="tabs">
          <button class="tab active" id="tab-login">Entrar</button>
          <button class="tab" id="tab-cadastro">Criar conta</button>
        </div>
        <div id="login-fields"></div>
        <div id="login-err" class="err-msg"></div>
        <button id="login-submit" style="width:100%;padding:12px;">Entrar</button>
        <p id="cadastro-note" class="sans hidden" style="font-size:12px;color:var(--texto-suave);text-align:center;margin-top:14px;">
          Sua conta será criada, mas só será possível enviar fotos e votar se sua assinatura do curso estiver ativa.
        </p>
      </div>
    </div>`;

  let mode = "login";

  function renderFields() {
    document.getElementById("login-fields").innerHTML = `
      ${mode === "cadastro" ? `
        <div style="margin-bottom:14px;">
          <label class="field-label">Seu nome</label>
          <input type="text" id="f-name" placeholder="Ex: Maria Silva" />
        </div>` : ""}
      <div style="margin-bottom:14px;">
        <label class="field-label">E-mail</label>
        <input type="email" id="f-email" placeholder="seu@email.com" />
      </div>
      <div style="margin-bottom:16px;">
        <label class="field-label">Senha</label>
        <input type="password" id="f-password" placeholder="••••••" />
      </div>`;
    document.getElementById("login-submit").textContent = mode === "login" ? "Entrar" : "Criar minha conta";
    document.getElementById("cadastro-note").classList.toggle("hidden", mode !== "cadastro");
  }
  renderFields();

  document.getElementById("tab-login").onclick = () => {
    mode = "login";
    document.getElementById("tab-login").classList.add("active");
    document.getElementById("tab-cadastro").classList.remove("active");
    document.getElementById("login-err").textContent = "";
    renderFields();
  };
  document.getElementById("tab-cadastro").onclick = () => {
    mode = "cadastro";
    document.getElementById("tab-cadastro").classList.add("active");
    document.getElementById("tab-login").classList.remove("active");
    document.getElementById("login-err").textContent = "";
    renderFields();
  };

  document.getElementById("login-submit").onclick = async () => {
    const errEl = document.getElementById("login-err");
    errEl.textContent = "";
    const submitBtn = document.getElementById("login-submit");
    const email = document.getElementById("f-email").value.trim();
    const password = document.getElementById("f-password").value;
    submitBtn.disabled = true;
    try {
      if (mode === "login") {
        if (!email || !password) { errEl.textContent = "Preencha e-mail e senha."; submitBtn.disabled = false; return; }
        await doLogin(email, password);
      } else {
        const name = document.getElementById("f-name").value.trim();
        if (!name) { errEl.textContent = "Informe seu nome."; submitBtn.disabled = false; return; }
        if (!email.includes("@")) { errEl.textContent = "E-mail inválido."; submitBtn.disabled = false; return; }
        if (password.length < 6) { errEl.textContent = "Senha mínima de 6 caracteres."; submitBtn.disabled = false; return; }
        await doRegister(name, email, password);
        showToast("Conta criada! Bem-vinda 🎉");
      }
    } catch (e) {
      errEl.textContent = traduzErroSupabase(e.message);
      submitBtn.disabled = false;
    }
  };
}

function traduzErroSupabase(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("already registered") || m.includes("already exists")) return "Este e-mail já está cadastrado.";
  if (m.includes("invalid login credentials")) return "E-mail ou senha incorretos.";
  if (m.includes("password should be")) return "Senha muito fraca (mínimo 6 caracteres).";
  if (m.includes("invalid email")) return "E-mail inválido.";
  if (m.includes("rate limit")) return "Muitas tentativas. Aguarde um momento.";
  return "Ocorreu um erro. Tente novamente.";
}

// ─────────────────────────────────────────────────────────────────────────
// RENDER: APP (header + view)
// ─────────────────────────────────────────────────────────────────────────

function renderApp() {
  const headerHtml = `
    <header>
      <div>
        <div class="logo">✂️ Votação de Moldes</div>
        <div class="logo-sub">Thaiza Gonçalves</div>
      </div>
      <nav>
        ${!currentUser.isAdmin ? `
          <button class="btn-outline" id="nav-upload">Enviar fotos</button>
          <button class="btn-outline" id="nav-vote">Votar</button>
        ` : `
          <button class="btn-outline" id="nav-admin">Painel Admin</button>
          <button class="btn-outline" id="nav-results">Resultados</button>
        `}
        <span class="sans" style="font-size:13px;color:rgba(255,255,255,.85);">Olá, ${esc(currentUser.name.split(" ")[0])}</span>
        <button class="btn-outline" id="nav-logout" style="font-size:12px;padding:6px 12px;">Sair</button>
      </nav>
    </header>
    <div id="view"></div>`;
  root.innerHTML = headerHtml;

  if (!currentUser.isAdmin) {
    document.getElementById("nav-upload").onclick = () => { currentView = "upload"; renderApp(); };
    document.getElementById("nav-vote").onclick = () => { currentView = "vote"; renderApp(); };
  } else {
    document.getElementById("nav-admin").onclick = () => { currentView = "admin"; renderApp(); };
    document.getElementById("nav-results").onclick = () => { currentView = "results"; renderApp(); };
  }
  document.getElementById("nav-logout").onclick = doLogout;

  const viewEl = document.getElementById("view");

  if (!currentUser.isAdmin && !currentUser.hasActiveSubscription) {
    renderSubscriptionBlocked(viewEl);
    return;
  }

  if (currentUser.isAdmin) {
    if (currentView === "results") renderResults(viewEl);
    else renderAdmin(viewEl);
  } else {
    if (currentView === "vote") renderVote(viewEl);
    else renderUpload(viewEl);
  }
}

function renderSubscriptionBlocked(el) {
  el.innerHTML = `
    <div class="container-sm" style="text-align:center;margin-top:20px;">
      <div class="card">
        <div style="font-size:44px;margin-bottom:14px;">🔒</div>
        <h3 style="color:var(--vinho);">Assinatura não identificada como ativa</h3>
        <p class="sans" style="color:var(--texto-suave);font-size:14px;">
          Não encontramos uma assinatura ativa da Assinatura de Moldes vinculada a este e-mail.
          Se você acredita que isso é um engano, entre em contato com a Thaiza pelo WhatsApp ou
          confira se está usando o mesmo e-mail cadastrado na Hotmart.
        </p>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────
// VIEW: UPLOAD
// ─────────────────────────────────────────────────────────────────────────

function renderUpload(el) {
  const existing = submissions.find((s) => s.user_id === currentUser.id);
  let stagedFiles = []; // [{ id, file, previewUrl, title }]
  let savedPhotos = existing ? [...existing.photos] : [];
  const deadline = cfg.submission_deadline;
  const past = isPast(deadline);
  const max = cfg.max_photos_per_user || 5;

  function totalCount() {
    return savedPhotos.length + stagedFiles.length;
  }

  function draw() {
    el.innerHTML = `
      <div class="container">
        <h2 style="color:var(--vinho);margin-bottom:4px;">Enviar fotos para votação</h2>
        <p class="sans" style="color:var(--texto-suave);margin-bottom:22px;font-size:14px;">${esc(cfg.round_name)} • Envio de até ${max} fotos</p>
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
            <span class="badge ${past ? "badge-warn" : "badge-ok"}">${past ? "Prazo encerrado" : "Envios abertos"}</span>
            <span class="sans" style="font-size:13px;color:var(--texto-suave);">Prazo: ${fmtDate(deadline)}</span>
          </div>
          ${past ? `<p class="sans" style="color:var(--alerta);font-size:14px;">O prazo de envio encerrou. Aguarde a fase de votação!</p>` : `
            <div style="margin-bottom:18px;">
              <label class="field-label">Suas fotos (${totalCount()}/${max})</label>
              <label class="upload-box" style="${totalCount() >= max ? "opacity:.5;cursor:not-allowed;" : ""}">
                <input type="file" accept="image/*" multiple id="file-input" style="display:none;" ${totalCount() >= max ? "disabled" : ""} />
                <div style="font-size:30px;margin-bottom:6px;">📷</div>
                <div class="sans" style="font-size:14px;color:var(--texto-suave);">
                  ${totalCount() >= max ? `Limite de ${max} fotos atingido` : "Clique para selecionar fotos (até 8MB cada)"}
                </div>
              </label>
            </div>
            <div class="grid-photos" id="photos-grid" style="margin-bottom:18px;"></div>
            <button id="save-btn" style="width:100%;">${existing ? "Atualizar minhas fotos" : "Enviar fotos para votação"}</button>
          `}
          ${existing ? `
            <div class="sans" style="margin-top:16px;padding:12px 15px;background:var(--creme-medio);border-radius:8px;font-size:13px;color:var(--texto-suave);">
              ✅ Você já enviou ${existing.photos.length} foto(s) em ${fmtDate(existing.submitted_at)}.
              ${!past ? " Você pode adicionar mais fotos até o prazo." : ""}
            </div>` : ""}
        </div>
      </div>`;

    if (!past) {
      drawPhotosGrid();
      document.getElementById("file-input").onchange = handleFiles;
      document.getElementById("save-btn").onclick = handleSave;
    }
  }

  function drawPhotosGrid() {
    const grid = document.getElementById("photos-grid");
    if (!grid) return;
    const items = [
      ...savedPhotos.map((p) => ({ ...p, kind: "saved" })),
      ...stagedFiles.map((p) => ({ ...p, kind: "staged" })),
    ];
    grid.innerHTML = items
      .map(
        (p, i) => `
      <div class="photo-card">
        <img src="${p.kind === "saved" ? p.url : p.previewUrl}" alt="" data-lightbox="${i}" />
        <div class="pad">
          <input type="text" class="title-input" data-kind="${p.kind}" data-i="${p.kind === "saved" ? savedPhotos.indexOf(p) : stagedFiles.indexOf(p)}" value="${esc(p.title)}" placeholder="Título do molde"
            style="font-size:13px;padding:7px 9px;margin-bottom:8px;" />
          <button class="btn-danger remove-photo" data-kind="${p.kind}" data-i="${p.kind === "saved" ? savedPhotos.indexOf(p) : stagedFiles.indexOf(p)}" style="width:100%;font-size:12px;">Remover</button>
        </div>
      </div>`
      )
      .join("");

    grid.querySelectorAll("img[data-lightbox]").forEach((img, idx) => {
      img.onclick = () => openLightbox(img.src, items[idx].title);
    });
    grid.querySelectorAll(".title-input").forEach((inp) => {
      inp.oninput = (e) => {
        const i = +e.target.dataset.i;
        if (e.target.dataset.kind === "saved") savedPhotos[i].title = e.target.value;
        else stagedFiles[i].title = e.target.value;
      };
    });
    grid.querySelectorAll(".remove-photo").forEach((btn) => {
      btn.onclick = async (e) => {
        const i = +e.target.dataset.i;
        if (e.target.dataset.kind === "saved") {
          const photo = savedPhotos[i];
          try {
            await sb.storage.from("photos").remove([photo.storage_path]);
            await sb.from("photos").delete().eq("id", photo.id);
            savedPhotos.splice(i, 1);
            showToast("Foto removida.");
          } catch (err) {
            console.error(err);
            showToast("Erro ao remover foto.", "err");
          }
        } else {
          stagedFiles.splice(i, 1);
        }
        draw();
      };
    });
  }

  async function handleFiles(e) {
    const files = Array.from(e.target.files);
    if (totalCount() + files.length > max) {
      showToast(`Você pode enviar no máximo ${max} fotos no total.`, "err");
      return;
    }
    for (const f of files) {
      if (!f.type.startsWith("image/")) { showToast("Apenas imagens são aceitas.", "err"); continue; }
      if (f.size > 8 * 1024 * 1024) { showToast(`${f.name} é maior que 8MB.`, "err"); continue; }
      stagedFiles.push({ id: uid(), file: f, previewUrl: URL.createObjectURL(f), title: f.name.replace(/\.[^.]+$/, "") });
    }
    draw();
  }

  async function handleSave() {
    if (stagedFiles.length === 0 && savedPhotos.length === 0) { showToast("Adicione pelo menos 1 foto.", "err"); return; }
    const saveBtn = document.getElementById("save-btn");
    saveBtn.disabled = true;
    saveBtn.textContent = "Enviando...";
    try {
      let submissionId = existing ? existing.id : null;
      if (!submissionId) {
        const { data, error } = await sb
          .from("submissions")
          .insert({ user_id: currentUser.id, user_name: currentUser.name, user_email: currentUser.email })
          .select()
          .single();
        if (error) throw error;
        submissionId = data.id;
      }

      // Atualiza títulos das fotos já salvas
      for (const p of savedPhotos) {
        await sb.from("photos").update({ title: p.title }).eq("id", p.id);
      }

      // Sobe as novas fotos
      for (const sf of stagedFiles) {
        const path = await uploadPhotoFile(sf.file, currentUser.id);
        await sb.from("photos").insert({ submission_id: submissionId, title: sf.title, storage_path: path });
      }

      showToast("Fotos enviadas com sucesso! ✅");
      await loadSubmissionsWithPhotos();
      currentView = "vote";
      renderApp();
    } catch (err) {
      console.error(err);
      showToast("Erro ao enviar fotos. Verifique sua conexão e tente novamente.", "err");
      saveBtn.disabled = false;
      saveBtn.textContent = existing ? "Atualizar minhas fotos" : "Enviar fotos para votação";
    }
  }

  draw();
}

// ─────────────────────────────────────────────────────────────────────────
// VIEW: VOTE
// ─────────────────────────────────────────────────────────────────────────

function renderVote(el) {
  const submissionDeadline = cfg.submission_deadline;
  const votingDeadline = cfg.voting_deadline;
  const submissionsOpen = !isPast(submissionDeadline);
  const votingClosed = isPast(votingDeadline);

  if (submissionsOpen) {
    el.innerHTML = `
      <div class="container-sm" style="text-align:center;margin-top:20px;">
        <div class="card">
          <div style="font-size:44px;margin-bottom:14px;">⏳</div>
          <h3 style="color:var(--vinho);">Aguardando encerramento dos envios</h3>
          <p class="sans" style="color:var(--texto-suave);">A votação começa após o prazo de envio de fotos.</p>
          <span class="badge badge-vinho">Prazo de envio: ${fmtDate(submissionDeadline)}</span>
        </div>
      </div>`;
    return;
  }
  if (!votingDeadline) {
    el.innerHTML = `
      <div class="container-sm" style="text-align:center;margin-top:20px;">
        <div class="card">
          <div style="font-size:44px;margin-bottom:14px;">⚙️</div>
          <h3 style="color:var(--vinho);">Votação ainda não configurada</h3>
          <p class="sans" style="color:var(--texto-suave);">A administradora ainda não definiu o prazo de votação.</p>
        </div>
      </div>`;
    return;
  }

  const allPhotos = submissions.flatMap((s) =>
    s.photos.map((p) => ({ ...p, userName: s.user_name, userId: s.user_id }))
  );

  function votesFor(photoId) {
    return votesMap[photoId] ? votesMap[photoId].size : 0;
  }
  function hasVoted(photoId) {
    return !!(votesMap[photoId] && votesMap[photoId].has(currentUser.id));
  }
  const myVotes = allPhotos.filter((p) => hasVoted(p.id)).length;

  el.innerHTML = `
    <div class="container">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:22px;flex-wrap:wrap;gap:10px;">
        <div>
          <h2 style="color:var(--vinho);margin-bottom:4px;">Vote nos seus moldes favoritos</h2>
          <p class="sans" style="color:var(--texto-suave);font-size:14px;">${esc(cfg.round_name)} • ${allPhotos.length} foto(s) na votação</p>
        </div>
        <div style="text-align:right;">
          <span class="badge ${votingClosed ? "badge-warn" : "badge-ok"}">${votingClosed ? "Votação encerrada" : "Votação aberta"}</span>
          <div class="sans" style="font-size:12px;color:var(--texto-suave);margin-top:6px;">Prazo: ${fmtDate(votingDeadline)}</div>
          ${!votingClosed ? `<div class="sans" style="font-size:12px;color:var(--texto-suave);">Seus votos: ${myVotes}</div>` : ""}
        </div>
      </div>
      ${allPhotos.length === 0 ? `<div class="card sans" style="text-align:center;color:var(--texto-suave);">Nenhuma foto foi enviada ainda.</div>` : ""}
      <div class="vote-grid">
        ${allPhotos
          .map((photo, idx) => {
            const voted = hasVoted(photo.id);
            const count = votesFor(photo.id);
            const isOwn = photo.userId === currentUser.id;
            return `
            <div class="card" style="padding:0;overflow:hidden;border:2px solid ${voted ? "var(--vinho)" : "transparent"};">
              <div class="vote-photo-wrap">
                <img src="${photo.url}" alt="${esc(photo.title)}" data-lightbox-vote="${idx}" />
                <div class="vote-count">❤️ ${count}</div>
                ${isOwn ? `<span class="badge badge-vinho own-badge" style="font-size:11px;">Minha foto</span>` : ""}
                <div class="zoom-hint">🔍 Ampliar</div>
              </div>
              <div class="vote-info">
                <div class="vote-title">${esc(photo.title) || "Sem título"}</div>
                <div class="vote-author">por ${esc(photo.userName)}</div>
                ${
                  !votingClosed
                    ? `<button class="vote-btn ${voted ? "voted" : "not-voted"}" data-photo="${photo.id}">${voted ? "✓ Votado" : "Votar"}</button>`
                    : `<div class="sans" style="text-align:center;font-size:13px;color:var(--texto-suave);font-weight:700;">${count} voto${count !== 1 ? "s" : ""}</div>`
                }
              </div>
            </div>`;
          })
          .join("")}
      </div>
    </div>`;

  el.querySelectorAll("img[data-lightbox-vote]").forEach((img, idx) => {
    img.onclick = () => openLightbox(img.src, allPhotos[idx].title + " — por " + allPhotos[idx].userName);
  });

  el.querySelectorAll(".vote-btn").forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await toggleVote(btn.dataset.photo, currentUser.id);
      } catch (e) {
        console.error(e);
        showToast("Erro ao registrar voto.", "err");
      }
      btn.disabled = false;
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// VIEW: RESULTS
// ─────────────────────────────────────────────────────────────────────────

function renderResults(el) {
  const allPhotos = submissions.flatMap((s) =>
    s.photos.map((p) => ({ ...p, userName: s.user_name }))
  );
  const ranked = allPhotos
    .map((p) => ({ ...p, votes: votesMap[p.id] ? votesMap[p.id].size : 0 }))
    .sort((a, b) => b.votes - a.votes);

  const totalVoters = new Set(Object.values(votesMap).flatMap((s) => [...s])).size;

  el.innerHTML = `
    <div class="container">
      <h2 style="color:var(--vinho);margin-bottom:4px;">Resultados da Votação</h2>
      <p class="sans" style="color:var(--texto-suave);margin-bottom:22px;font-size:14px;">${esc(cfg.round_name)} • ${ranked.length} fotos • ${totalVoters} votante(s)</p>
      ${ranked.length === 0 ? `<div class="card sans" style="text-align:center;color:var(--texto-suave);">Nenhuma foto na votação ainda.</div>` : ""}
      ${ranked
        .map(
          (photo, i) => `
        <div class="result-row" style="${i === 0 ? "border:2px solid var(--vinho);" : ""}">
          <div style="position:relative;flex-shrink:0;">
            <img src="${photo.url}" alt="${esc(photo.title)}" data-lightbox-result="${i}" />
            ${i === 0 ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(125,46,70,.55);pointer-events:none;"><div style="font-size:36px;">🏆</div></div>` : ""}
          </div>
          <div class="result-info">
            <div>
              <div style="font-size:20px;font-weight:bold;color:${i < 3 ? "var(--vinho)" : "var(--texto)"};">#${i + 1}</div>
              <div style="font-weight:bold;font-size:15px;margin-bottom:3px;">${esc(photo.title) || "Sem título"}</div>
              <div class="sans" style="font-size:13px;color:var(--texto-suave);">por ${esc(photo.userName)}</div>
            </div>
            <div style="text-align:center;">
              <div style="font-size:28px;font-weight:bold;color:var(--vinho);">${photo.votes}</div>
              <div class="sans" style="font-size:12px;color:var(--texto-suave);">voto${photo.votes !== 1 ? "s" : ""}</div>
            </div>
          </div>
        </div>`
        )
        .join("")}
    </div>`;

  el.querySelectorAll("img[data-lightbox-result]").forEach((img, idx) => {
    img.onclick = () => openLightbox(img.src, `#${idx + 1} — ${ranked[idx].title} (${ranked[idx].votes} votos)`);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// VIEW: ADMIN
// ─────────────────────────────────────────────────────────────────────────

function renderAdmin(el) {
  function toLocalInput(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fromLocalInput(val) {
    return val ? new Date(val).toISOString() : null;
  }

  const totalVotes = Object.values(votesMap).reduce((a, s) => a + s.size, 0);
  const totalPhotos = submissions.reduce((a, s) => a + s.photos.length, 0);

  el.innerHTML = `
    <div class="container">
      <h2 style="color:var(--vinho);margin-bottom:22px;">Painel Administrativo</h2>

      <div class="stat-grid">
        <div class="stat-box"><div class="stat-num">${usersList.length}</div><div class="stat-label">Alunas cadastradas</div></div>
        <div class="stat-box"><div class="stat-num">${totalPhotos}</div><div class="stat-label">Fotos enviadas</div></div>
        <div class="stat-box"><div class="stat-num">${totalVotes}</div><div class="stat-label">Votos computados</div></div>
      </div>

      <div class="card">
        <h3 style="color:var(--vinho);margin-top:0;margin-bottom:18px;">Configurações da rodada</h3>
        <div style="margin-bottom:14px;">
          <label class="field-label">Nome da rodada</label>
          <input type="text" id="cfg-name" value="${esc(cfg.round_name)}" />
        </div>
        <div class="config-grid">
          <div>
            <label class="field-label">Prazo de envio de fotos</label>
            <input type="datetime-local" id="cfg-sub" value="${toLocalInput(cfg.submission_deadline)}" />
          </div>
          <div>
            <label class="field-label">Prazo de votação</label>
            <input type="datetime-local" id="cfg-vote" value="${toLocalInput(cfg.voting_deadline)}" />
          </div>
        </div>
        <div style="margin-bottom:18px;">
          <label class="field-label">Máximo de fotos por aluna</label>
          <input type="number" id="cfg-max" min="1" max="10" value="${cfg.max_photos_per_user}" style="max-width:100px;" />
        </div>
        <button id="cfg-save">Salvar configurações</button>
      </div>

      <div class="card">
        <h3 style="color:var(--vinho);margin-top:0;margin-bottom:16px;">Alunas cadastradas (${usersList.length})</h3>
        ${usersList.length === 0 ? `<p class="sans" style="color:var(--texto-suave);font-size:14px;">Nenhuma aluna cadastrada ainda.</p>` : ""}
        ${usersList
          .map((u) => {
            const sub = submissions.find((s) => s.user_id === u.id);
            return `
            <div class="row-flex">
              <div>
                <div style="font-weight:bold;font-size:14px;">${esc(u.name)}</div>
                <div class="sans" style="font-size:12px;color:var(--texto-suave);">${esc(u.email)}</div>
              </div>
              <span class="badge ${sub ? "badge-ok" : "badge-muted"}">${sub ? `${sub.photos.length} foto(s)` : "Sem envio"}</span>
            </div>`;
          })
          .join("")}
        <p class="sans" style="font-size:12px;color:var(--texto-suave);margin-top:10px;">
          Alunas só conseguem enviar fotos ou votar se a assinatura estiver marcada como ativa, segundo o status sincronizado com a Hotmart.
        </p>
      </div>

      <div class="card">
        <h3 style="color:var(--vinho);margin-top:0;margin-bottom:16px;">Fotos enviadas (${totalPhotos})</h3>
        ${submissions.length === 0 ? `<p class="sans" style="color:var(--texto-suave);font-size:14px;">Nenhuma foto enviada ainda.</p>` : ""}
        ${submissions
          .map(
            (s) => `
          <div style="border-bottom:1px solid var(--creme-escuro);padding-bottom:16px;margin-bottom:16px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
              <div>
                <span style="font-weight:bold;">${esc(s.user_name)}</span>
                <span class="sans" style="font-size:12px;color:var(--texto-suave);margin-left:10px;">${fmtDate(s.submitted_at)}</span>
              </div>
              <button class="btn-danger remove-submission" data-id="${s.id}">Remover envio</button>
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              ${s.photos
                .map(
                  (p, pi) => `
                <div style="text-align:center;">
                  <img src="${p.url}" alt="${esc(p.title)}" data-lightbox-admin="${s.id}-${pi}" style="width:100px;height:80px;object-fit:cover;border-radius:6px;display:block;cursor:zoom-in;" />
                  <div class="sans" style="font-size:11px;color:var(--texto-suave);margin-top:4px;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.title)}</div>
                </div>`
                )
                .join("")}
            </div>
          </div>`
          )
          .join("")}
      </div>
    </div>`;

  document.getElementById("cfg-save").onclick = async () => {
    const newCfg = {
      round_name: document.getElementById("cfg-name").value,
      submission_deadline: fromLocalInput(document.getElementById("cfg-sub").value),
      voting_deadline: fromLocalInput(document.getElementById("cfg-vote").value),
      max_photos_per_user: Number(document.getElementById("cfg-max").value) || 5,
    };
    try {
      await saveConfig(newCfg);
      showToast("Configurações salvas!");
    } catch (err) {
      console.error(err);
      showToast("Erro ao salvar configurações.", "err");
    }
  };

  el.querySelectorAll("img[data-lightbox-admin]").forEach((img) => {
    img.onclick = () => openLightbox(img.src, img.alt);
  });

  el.querySelectorAll(".remove-submission").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("Remover este envio? As fotos e votos relacionados serão apagados permanentemente.")) return;
      const submission = submissions.find((s) => s.id === btn.dataset.id);
      try {
        await deleteSubmissionAndPhotos(submission);
        showToast("Envio removido.");
        await loadSubmissionsWithPhotos();
        renderApp();
      } catch (err) {
        console.error(err);
        showToast("Erro ao remover envio.", "err");
      }
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────

setupAuthListener();
