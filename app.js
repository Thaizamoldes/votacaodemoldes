// ═══════════════════════════════════════════════════════════════════════
// Votação de Moldes — Thaiza Gonçalves
// App completo em JS puro, integrado ao Firebase (Auth + Firestore + Storage)
// ═══════════════════════════════════════════════════════════════════════

const root = document.getElementById("root");
const toastEl = document.getElementById("toast");

// E-mails que terão acesso de administradora.
// Adicione o(s) seu(s) e-mail(s) aqui (em minúsculas).
const ADMIN_EMAILS = ["thaizassinaturamoldes@gmail.com"];

let FB = null;
let currentUser = null;     // { uid, email, name, isAdmin }
let cfg = { roundName: "Votação de Moldes", submissionDeadline: "", votingDeadline: "", maxPhotosPerUser: 5 };
let submissions = [];       // [{ id, userEmail, userName, photos:[{id,url,title}], submittedAt }]
let votesMap = {};          // { photoId: { userEmail: true } }
let usersList = [];         // [{ uid, email, name }]
let currentView = "upload";
let unsubscribers = [];

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
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// FIREBASE: leitura/escrita
// ─────────────────────────────────────────────────────────────────────────

async function loadConfig() {
  const { doc, getDoc, db } = FB;
  const snap = await getDoc(doc(db, "config", "main"));
  if (snap.exists()) cfg = { ...cfg, ...snap.data() };
}

function listenConfig(onChange) {
  const { doc, onSnapshot, db } = FB;
  const unsub = onSnapshot(doc(db, "config", "main"), (snap) => {
    if (snap.exists()) cfg = { ...cfg, ...snap.data() };
    onChange();
  });
  unsubscribers.push(unsub);
}

function listenSubmissions(onChange) {
  const { collection, onSnapshot, db } = FB;
  const unsub = onSnapshot(collection(db, "submissions"), (snap) => {
    submissions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    onChange();
  });
  unsubscribers.push(unsub);
}

function listenVotes(onChange) {
  const { collection, onSnapshot, db } = FB;
  const unsub = onSnapshot(collection(db, "votes"), (snap) => {
    votesMap = {};
    snap.docs.forEach((d) => {
      votesMap[d.id] = d.data().voters || {};
    });
    onChange();
  });
  unsubscribers.push(unsub);
}

function listenUsers(onChange) {
  const { collection, onSnapshot, db } = FB;
  const unsub = onSnapshot(collection(db, "users"), (snap) => {
    usersList = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    onChange();
  });
  unsubscribers.push(unsub);
}

async function saveConfig(newCfg) {
  const { doc, setDoc, db } = FB;
  await setDoc(doc(db, "config", "main"), newCfg, { merge: true });
}

async function saveUserProfile(uidVal, data) {
  const { doc, setDoc, db } = FB;
  await setDoc(doc(db, "users", uidVal), data, { merge: true });
}

async function compressImage(dataUrl, maxWidth = 700, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      let q = quality;
      let result = canvas.toDataURL("image/jpeg", q);
      // Reduz qualidade até caber com folga no limite de 1MB do Firestore
      while (result.length > 700000 && q > 0.2) {
        q -= 0.1;
        result = canvas.toDataURL("image/jpeg", q);
      }
      resolve(result);
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function saveSubmission(submission) {
  const { doc, setDoc, db } = FB;
  await setDoc(doc(db, "submissions", submission.userEmail.replace(/[.#$/[\]]/g, "_")), submission);
}

async function deleteSubmissionDoc(docId) {
  const { doc, deleteDoc, db } = FB;
  await deleteDoc(doc(db, "submissions", docId));
}

async function toggleVoteDoc(photoId, userEmail) {
  const { doc, getDoc, setDoc, db } = FB;
  const ref2 = doc(db, "votes", photoId);
  const snap = await getDoc(ref2);
  const voters = snap.exists() ? snap.data().voters || {} : {};
  if (voters[userEmail]) {
    delete voters[userEmail];
  } else {
    voters[userEmail] = true;
  }
  await setDoc(ref2, { voters }, { merge: false });
}

async function deleteUserDoc(uidVal) {
  const { doc, deleteDoc, db } = FB;
  await deleteDoc(doc(db, "users", uidVal));
}

// ─────────────────────────────────────────────────────────────────────────
// AUTENTICAÇÃO
// ─────────────────────────────────────────────────────────────────────────

async function doRegister(name, email, password) {
  const { createUserWithEmailAndPassword, updateProfile, auth } = FB;
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(cred.user, { displayName: name });
  await saveUserProfile(cred.user.uid, { name, email: email.toLowerCase() });
}

async function doLogin(email, password) {
  const { signInWithEmailAndPassword, auth } = FB;
  await signInWithEmailAndPassword(auth, email, password);
}

async function doLogout() {
  const { signOut, auth } = FB;
  await signOut(auth);
}

function setupAuthListener() {
  const { onAuthStateChanged, auth } = FB;
  onAuthStateChanged(auth, async (user) => {
    unsubscribers.forEach((u) => u());
    unsubscribers = [];

    if (!user) {
      currentUser = null;
      renderLogin();
      return;
    }
    const isAdmin = ADMIN_EMAILS.includes((user.email || "").toLowerCase());
    currentUser = {
      uid: user.uid,
      email: (user.email || "").toLowerCase(),
      name: user.displayName || user.email,
      isAdmin,
    };
    currentView = isAdmin ? "admin" : "upload";

    await loadConfig();
    listenConfig(renderApp);
    listenSubmissions(renderApp);
    listenVotes(renderApp);
    listenUsers(renderApp);
    renderApp();
  });
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
          Ao se cadastrar, você concorda em participar da votação conforme as regras do site.
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
    const email = document.getElementById("f-email").value.trim();
    const password = document.getElementById("f-password").value;
    try {
      if (mode === "login") {
        if (!email || !password) { errEl.textContent = "Preencha e-mail e senha."; return; }
        await doLogin(email, password);
      } else {
        const name = document.getElementById("f-name").value.trim();
        if (!name) { errEl.textContent = "Informe seu nome."; return; }
        if (!email.includes("@")) { errEl.textContent = "E-mail inválido."; return; }
        if (password.length < 6) { errEl.textContent = "Senha mínima de 6 caracteres."; return; }
        await doRegister(name, email, password);
        showToast("Conta criada! Bem-vinda 🎉");
      }
    } catch (e) {
      errEl.textContent = traduzErroFirebase(e.code);
    }
  };
}

function traduzErroFirebase(code) {
  const map = {
    "auth/email-already-in-use": "Este e-mail já está cadastrado.",
    "auth/invalid-email": "E-mail inválido.",
    "auth/weak-password": "Senha muito fraca (mínimo 6 caracteres).",
    "auth/user-not-found": "E-mail ou senha incorretos.",
    "auth/wrong-password": "E-mail ou senha incorretos.",
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/too-many-requests": "Muitas tentativas. Aguarde um momento.",
  };
  return map[code] || "Ocorreu um erro. Tente novamente.";
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
  if (currentUser.isAdmin) {
    if (currentView === "results") renderResults(viewEl);
    else renderAdmin(viewEl);
  } else {
    if (currentView === "vote") renderVote(viewEl);
    else renderUpload(viewEl);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// VIEW: UPLOAD
// ─────────────────────────────────────────────────────────────────────────

function renderUpload(el) {
  const existing = submissions.find((s) => s.userEmail === currentUser.email);
  let photos = existing ? [...existing.photos] : [];
  const deadline = cfg.submissionDeadline;
  const past = isPast(deadline);
  const max = cfg.maxPhotosPerUser || 5;

  function draw() {
    el.innerHTML = `
      <div class="container">
        <h2 style="color:var(--vinho);margin-bottom:4px;">Enviar fotos para votação</h2>
        <p class="sans" style="color:var(--texto-suave);margin-bottom:22px;font-size:14px;">${esc(cfg.roundName)} • Envio de até ${max} fotos</p>
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
            <span class="badge ${past ? "badge-warn" : "badge-ok"}">${past ? "Prazo encerrado" : "Envios abertos"}</span>
            <span class="sans" style="font-size:13px;color:var(--texto-suave);">Prazo: ${fmtDate(deadline)}</span>
          </div>
          ${past ? `<p class="sans" style="color:var(--alerta);font-size:14px;">O prazo de envio encerrou. Aguarde a fase de votação!</p>` : `
            <div style="margin-bottom:18px;">
              <label class="field-label">Suas fotos (${photos.length}/${max})</label>
              <label class="upload-box" style="${photos.length >= max ? "opacity:.5;cursor:not-allowed;" : ""}">
                <input type="file" accept="image/*" multiple id="file-input" style="display:none;" ${photos.length >= max ? "disabled" : ""} />
                <div style="font-size:30px;margin-bottom:6px;">📷</div>
                <div class="sans" style="font-size:14px;color:var(--texto-suave);">
                  ${photos.length >= max ? `Limite de ${max} fotos atingido` : "Clique para selecionar fotos (até 5MB cada)"}
                </div>
              </label>
            </div>
            <div id="loading-msg" class="sans hidden" style="font-size:14px;color:var(--texto-suave);margin-bottom:12px;">Carregando fotos...</div>
            <div class="grid-photos" id="photos-grid" style="margin-bottom:18px;"></div>
            <button id="save-btn" style="width:100%;">${existing ? "Atualizar minhas fotos" : "Enviar fotos para votação"}</button>
          `}
          ${existing ? `
            <div class="sans" style="margin-top:16px;padding:12px 15px;background:var(--creme-medio);border-radius:8px;font-size:13px;color:var(--texto-suave);">
              ✅ Você já enviou ${existing.photos.length} foto(s) em ${fmtDate(existing.submittedAt)}.
              ${!past ? " Você pode atualizar suas fotos até o prazo." : ""}
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
    grid.innerHTML = photos
      .map(
        (p, i) => `
      <div class="photo-card">
        <img src="${p.dataUrl || p.url}" alt="" />
        <div class="pad">
          <input type="text" class="title-input" data-i="${i}" value="${esc(p.title)}" placeholder="Título do molde"
            style="font-size:13px;padding:7px 9px;margin-bottom:8px;" />
          <button class="btn-danger remove-photo" data-i="${i}" style="width:100%;font-size:12px;">Remover</button>
        </div>
      </div>`
      )
      .join("");

    grid.querySelectorAll(".title-input").forEach((inp) => {
      inp.oninput = (e) => {
        photos[+e.target.dataset.i].title = e.target.value;
      };
    });
    grid.querySelectorAll(".remove-photo").forEach((btn) => {
      btn.onclick = (e) => {
        photos.splice(+e.target.dataset.i, 1);
        draw();
      };
    });
  }

  async function handleFiles(e) {
    const files = Array.from(e.target.files);
    if (photos.length + files.length > max) {
      showToast(`Você pode enviar no máximo ${max} fotos no total.`, "err");
      return;
    }
    const loadingEl = document.getElementById("loading-msg");
    loadingEl.classList.remove("hidden");
    for (const f of files) {
      if (!f.type.startsWith("image/")) { showToast("Apenas imagens são aceitas.", "err"); continue; }
      if (f.size > 5 * 1024 * 1024) { showToast(`${f.name} é maior que 5MB.`, "err"); continue; }
      const dataUrl = await fileToBase64(f);
      photos.push({ id: uid(), dataUrl, title: f.name.replace(/\.[^.]+$/, "") });
    }
    loadingEl.classList.add("hidden");
    draw();
  }

  async function handleSave() {
    if (photos.length === 0) { showToast("Adicione pelo menos 1 foto.", "err"); return; }
    const saveBtn = document.getElementById("save-btn");
    saveBtn.disabled = true;
    saveBtn.textContent = "Enviando...";
    try {
      const finalPhotos = [];
      for (const p of photos) {
        if (p.dataUrl && p.dataUrl.length < 700000 && p.compressed) {
          // já comprimida nesta sessão
          finalPhotos.push({ id: p.id, dataUrl: p.dataUrl, title: p.title });
        } else {
          const compressed = await compressImage(p.dataUrl || p.url);
          finalPhotos.push({ id: p.id, dataUrl: compressed, title: p.title });
        }
      }
      await saveSubmission({
        userEmail: currentUser.email,
        userName: currentUser.name,
        photos: finalPhotos,
        submittedAt: new Date().toISOString(),
      });
      showToast("Fotos enviadas com sucesso! ✅");
      currentView = "vote";
      renderApp();
    } catch (err) {
      console.error(err);
      showToast("Erro ao enviar fotos. Tente novamente.", "err");
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
  const submissionDeadline = cfg.submissionDeadline;
  const votingDeadline = cfg.votingDeadline;
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
    s.photos.map((p) => ({ ...p, userName: s.userName, userEmail: s.userEmail }))
  );

  function votesFor(photoId) {
    return Object.keys(votesMap[photoId] || {}).length;
  }
  function hasVoted(photoId) {
    return !!(votesMap[photoId] && votesMap[photoId][currentUser.email]);
  }
  const myVotes = allPhotos.filter((p) => hasVoted(p.id)).length;

  el.innerHTML = `
    <div class="container">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:22px;flex-wrap:wrap;gap:10px;">
        <div>
          <h2 style="color:var(--vinho);margin-bottom:4px;">Vote nos seus moldes favoritos</h2>
          <p class="sans" style="color:var(--texto-suave);font-size:14px;">${esc(cfg.roundName)} • ${allPhotos.length} foto(s) na votação</p>
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
          .map((photo) => {
            const voted = hasVoted(photo.id);
            const count = votesFor(photo.id);
            const isOwn = photo.userEmail === currentUser.email;
            return `
            <div class="card" style="padding:0;overflow:hidden;border:2px solid ${voted ? "var(--vinho)" : "transparent"};">
              <div class="vote-photo-wrap">
                <img src="${photo.dataUrl || photo.url}" alt="${esc(photo.title)}" />
                ${isOwn ? `<span class="badge badge-vinho own-badge" style="font-size:11px;">Minha foto</span>` : ""}
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

  el.querySelectorAll(".vote-btn").forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await toggleVoteDoc(btn.dataset.photo, currentUser.email);
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
    s.photos.map((p) => ({ ...p, userName: s.userName, userEmail: s.userEmail }))
  );
  const ranked = allPhotos
    .map((p) => ({ ...p, votes: Object.keys(votesMap[p.id] || {}).length }))
    .sort((a, b) => b.votes - a.votes);

  const totalVoters = new Set(Object.values(votesMap).flatMap((v) => Object.keys(v))).size;

  el.innerHTML = `
    <div class="container">
      <h2 style="color:var(--vinho);margin-bottom:4px;">Resultados da Votação</h2>
      <p class="sans" style="color:var(--texto-suave);margin-bottom:22px;font-size:14px;">${esc(cfg.roundName)} • ${ranked.length} fotos • ${totalVoters} votante(s)</p>
      ${ranked.length === 0 ? `<div class="card sans" style="text-align:center;color:var(--texto-suave);">Nenhuma foto na votação ainda.</div>` : ""}
      ${ranked
        .map(
          (photo, i) => `
        <div class="result-row" style="${i === 0 ? "border:2px solid var(--vinho);" : ""}">
          <div style="position:relative;flex-shrink:0;">
            <img src="${photo.dataUrl || photo.url}" alt="${esc(photo.title)}" />
            ${i === 0 ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(125,46,70,.55);"><div style="font-size:36px;">🏆</div></div>` : ""}
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
    return val ? new Date(val).toISOString() : "";
  }

  const totalVotes = Object.values(votesMap).reduce((a, v) => a + Object.keys(v).length, 0);
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
          <input type="text" id="cfg-name" value="${esc(cfg.roundName)}" />
        </div>
        <div class="config-grid">
          <div>
            <label class="field-label">Prazo de envio de fotos</label>
            <input type="datetime-local" id="cfg-sub" value="${toLocalInput(cfg.submissionDeadline)}" />
          </div>
          <div>
            <label class="field-label">Prazo de votação</label>
            <input type="datetime-local" id="cfg-vote" value="${toLocalInput(cfg.votingDeadline)}" />
          </div>
        </div>
        <div style="margin-bottom:18px;">
          <label class="field-label">Máximo de fotos por aluna</label>
          <input type="number" id="cfg-max" min="1" max="10" value="${cfg.maxPhotosPerUser}" style="max-width:100px;" />
        </div>
        <button id="cfg-save">Salvar configurações</button>
      </div>

      <div class="card">
        <h3 style="color:var(--vinho);margin-top:0;margin-bottom:16px;">Alunas cadastradas (${usersList.length})</h3>
        ${usersList.length === 0 ? `<p class="sans" style="color:var(--texto-suave);font-size:14px;">Nenhuma aluna cadastrada ainda.</p>` : ""}
        ${usersList
          .map((u) => {
            const sub = submissions.find((s) => s.userEmail === u.email);
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
          Alunas se cadastram sozinhas pela tela de login. Para restringir o acesso só a quem comprou o curso, configure isso via Área de Membros da Hotmart.
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
                <span style="font-weight:bold;">${esc(s.userName)}</span>
                <span class="sans" style="font-size:12px;color:var(--texto-suave);margin-left:10px;">${fmtDate(s.submittedAt)}</span>
              </div>
              <button class="btn-danger remove-submission" data-id="${s.id}">Remover envio</button>
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              ${s.photos
                .map(
                  (p) => `
                <div style="text-align:center;">
                  <img src="${p.dataUrl || p.url}" alt="${esc(p.title)}" style="width:100px;height:80px;object-fit:cover;border-radius:6px;display:block;" />
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
      roundName: document.getElementById("cfg-name").value,
      submissionDeadline: fromLocalInput(document.getElementById("cfg-sub").value),
      votingDeadline: fromLocalInput(document.getElementById("cfg-vote").value),
      maxPhotosPerUser: Number(document.getElementById("cfg-max").value) || 5,
    };
    await saveConfig(newCfg);
    showToast("Configurações salvas!");
  };

  el.querySelectorAll(".remove-submission").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("Remover este envio? As fotos e votos relacionados não serão recuperados automaticamente.")) return;
      await deleteSubmissionDoc(btn.dataset.id);
      showToast("Envio removido.");
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────

window.addEventListener("firebase-ready", () => {
  FB = window.FB;
  setupAuthListener();
});
