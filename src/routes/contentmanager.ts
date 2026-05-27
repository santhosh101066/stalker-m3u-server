import { ServerRoute } from "@hapi/hapi";
import { authCheck } from "@/utils/jwt";
import { GenreOverride } from "@/models/GenreOverride";
import { ContentOverride } from "@/models/ContentOverride";
import { readGenres, readChannels } from "@/utils/storage";
import { xtreamCache } from "@/routes/xtream";
import { genreKey, contentKey } from "@/utils/overrides";
import { invalidateVodCache } from "@/utils/getM3uUrls";
import { GenreType } from "@/models/Genre";
import { generateStrmFiles } from "@/utils/strmGenerator";

function unauthorized(h: any) {
  return h.response({ error: "Unauthorized" }).code(401);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function getItemCount(type: GenreType, genreId: string): Promise<number> {
  if (String(genreId).startsWith("vcat_")) {
    return ContentOverride.count({ where: { item_type: type === "channel" ? "channel" : type, target_category_id: genreId } });
  }
  if (type === "channel") {
    const channels = await readChannels();
    return channels.filter((c) => c.tv_genre_id === genreId).length;
  }
  if (type === "movie") {
    const cached = await xtreamCache.get<any[]>(`vod_streams_${genreId}`);
    return cached?.length ?? 0;
  }
  if (type === "series") {
    const cached = await xtreamCache.get<any[]>(`series_list_${genreId}`);
    return cached?.length ?? 0;
  }
  return 0;
}

// ── Admin HTML ─────────────────────────────────────────────────────────────────

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Content Manager</title>
<style>
:root {
  --bg: #0d1117;
  --surface: #161b22;
  --surface2: #1c2128;
  --border: #30363d;
  --text: #e6edf3;
  --text-muted: #8b949e;
  --accent: #58a6ff;
  --accent-dim: #1f4068;
  --green: #3fb950;
  --red: #f85149;
  --yellow: #d29922;
  --radius: 6px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

/* Login */
#login-screen { display: flex; align-items: center; justify-content: center; height: 100vh; }
.login-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 40px; width: 340px; text-align: center; }
.login-card h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
.login-card p { color: var(--text-muted); font-size: 13px; margin-bottom: 28px; }
.login-card input { width: 100%; padding: 10px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 14px; outline: none; margin-bottom: 12px; }
.login-card input:focus { border-color: var(--accent); }
.login-card button { width: 100%; padding: 10px; background: var(--accent); color: #0d1117; border: none; border-radius: var(--radius); font-size: 14px; font-weight: 600; cursor: pointer; }
.login-card button:hover { opacity: 0.9; }
#login-error { color: var(--red); font-size: 13px; margin-top: 10px; min-height: 20px; }

/* App layout */
#app { display: flex; flex-direction: column; height: 100vh; }
header { display: flex; align-items: center; gap: 16px; padding: 12px 20px; background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0; }
header .logo { font-size: 15px; font-weight: 700; color: var(--text); margin-right: 8px; }
nav { display: flex; gap: 4px; flex: 1; }
nav button { padding: 6px 16px; background: transparent; border: 1px solid transparent; border-radius: var(--radius); color: var(--text-muted); font-size: 13px; cursor: pointer; transition: all 0.15s; }
nav button:hover { color: var(--text); background: var(--surface2); }
nav button.active { color: var(--text); background: var(--accent-dim); border-color: var(--accent); }
.sign-out { padding: 6px 14px; background: transparent; border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-muted); font-size: 13px; cursor: pointer; }
.sign-out:hover { color: var(--text); border-color: var(--text-muted); }

main { display: flex; flex: 1; overflow: hidden; }

/* Panels */
.panel { display: flex; flex-direction: column; overflow: hidden; }
#categories-panel { width: 340px; border-right: 1px solid var(--border); flex-shrink: 0; }
#items-panel { flex: 1; }

.panel-header { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; flex-shrink: 0; background: var(--surface); }
.panel-header h2 { font-size: 13px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.panel-header input[type=search] { padding: 5px 10px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 13px; outline: none; width: 140px; }
.panel-header input[type=search]:focus { border-color: var(--accent); }

.panel-body { flex: 1; overflow-y: auto; }
.panel-body::-webkit-scrollbar { width: 6px; }
.panel-body::-webkit-scrollbar-track { background: transparent; }
.panel-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

/* Rows */
.row { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.1s; min-height: 44px; }
.row:hover { background: var(--surface2); }
.row.selected { background: var(--accent-dim); }
.row.hidden-item { opacity: 0.45; }

.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot.visible { background: var(--green); }
.dot.hidden { background: var(--red); }

.row-name { flex: 1; min-width: 0; }
.row-name .primary { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row-name .secondary { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }

.row-count { font-size: 12px; color: var(--text-muted); flex-shrink: 0; min-width: 32px; text-align: right; }

.row-actions { display: flex; gap: 4px; flex-shrink: 0; opacity: 0; transition: opacity 0.15s; }
.row:hover .row-actions { opacity: 1; }
.row.editing .row-actions { opacity: 1; }

.btn-icon { width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; background: transparent; border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-muted); cursor: pointer; font-size: 12px; transition: all 0.15s; }
.btn-icon:hover { background: var(--surface); color: var(--text); border-color: var(--text-muted); }
.btn-icon.active { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.btn-icon.danger { color: var(--red); border-color: var(--red); }

/* Edit row */
.edit-row { display: none; padding: 6px 14px 10px 30px; border-bottom: 1px solid var(--border); background: var(--surface2); }
.edit-row.open { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.edit-row input[type=text] { flex: 1; min-width: 150px; padding: 5px 10px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 13px; outline: none; }
.edit-row input[type=text]:focus { border-color: var(--accent); }
.edit-row select { padding: 5px 10px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 13px; outline: none; cursor: pointer; }
.btn-save { padding: 5px 14px; background: var(--accent); color: #0d1117; border: none; border-radius: var(--radius); font-size: 13px; font-weight: 600; cursor: pointer; }
.btn-save:hover { opacity: 0.85; }
.btn-cancel { padding: 5px 14px; background: transparent; border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-muted); font-size: 13px; cursor: pointer; }
.btn-cancel:hover { color: var(--text); }
.btn-reset { padding: 5px 10px; background: transparent; border: 1px solid var(--border); border-radius: var(--radius); color: var(--yellow); font-size: 12px; cursor: pointer; }
.btn-reset:hover { border-color: var(--yellow); }

.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--text-muted); gap: 8px; }
.empty-state svg { opacity: 0.3; }
.empty-state p { font-size: 13px; }

.loading { display: flex; align-items: center; justify-content: center; height: 80px; color: var(--text-muted); font-size: 13px; gap: 8px; }

.btn-icon:disabled { opacity: 0.25; cursor: default; pointer-events: none; }

.add-cat-form { display: none; padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--surface2); gap: 8px; align-items: center; }
.add-cat-form.open { display: flex; }
.add-cat-form input { flex: 1; padding: 5px 10px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 13px; outline: none; }
.add-cat-form input:focus { border-color: var(--accent); }
.btn-add { padding: 5px 10px; background: transparent; border: 1px solid var(--green); border-radius: var(--radius); color: var(--green); font-size: 12px; font-weight: 600; cursor: pointer; flex-shrink: 0; }
.btn-add:hover { background: var(--green); color: #0d1117; }
.btn-reset-order { padding: 5px 10px; background: transparent; border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-muted); font-size: 12px; cursor: pointer; flex-shrink: 0; }
.btn-reset-order:hover { border-color: var(--yellow); color: var(--yellow); }

/* Drag and drop */
.drag-handle { display: flex; align-items: center; justify-content: center; width: 18px; flex-shrink: 0; color: var(--text-muted); opacity: 0; cursor: grab; transition: opacity 0.15s; user-select: none; font-size: 14px; }
.drag-handle:active { cursor: grabbing; }
.row:hover .drag-handle { opacity: 0.5; }
.row.dragging { opacity: 0.25; background: var(--surface2); }
.row.drop-above { box-shadow: 0 -2px 0 var(--accent); }
.row.drop-below { box-shadow: 0 2px 0 var(--accent); }

/* Item multi-select */
.row.item-sel { background: var(--accent-dim); }
.row.item-sel .drag-handle { opacity: 0.6; }
.row.item-sel:hover { filter: brightness(1.15); }
.item-sel-badge { font-size: 12px; color: var(--accent); font-weight: 500; white-space: nowrap; flex-shrink: 0; }
.btn-clear-sel { padding: 4px 8px; background: transparent; border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-muted); font-size: 12px; cursor: pointer; flex-shrink: 0; }
.btn-clear-sel:hover { border-color: var(--accent); color: var(--accent); }
</style>
</head>
<body>

<div id="login-screen">
  <div class="login-card">
    <h1>Content Manager</h1>
    <p>Sign in to manage your IPTV content</p>
    <form id="login-form">
      <input type="password" id="pw-input" placeholder="Admin password" autocomplete="current-password" />
      <button type="submit">Sign in</button>
    </form>
    <div id="login-error"></div>
  </div>
</div>

<div id="app" style="display:none">
  <header>
    <span class="logo">Content Manager</span>
    <nav>
      <button class="tab active" data-type="channel">Live</button>
      <button class="tab" data-type="movie">VOD</button>
      <button class="tab" data-type="series">Series</button>
    </nav>
    <button class="sign-out" id="sign-out-btn">Sign out</button>
  </header>
  <main>
    <div class="panel" id="categories-panel">
      <div class="panel-header">
        <h2>Categories</h2>
        <input type="search" id="cat-search" placeholder="Search&hellip;" />
        <button class="btn-reset-order" onclick="sortAlpha()" title="Sort categories A-Z">A-Z</button>
        <button class="btn-reset-order" id="reset-order-btn" onclick="resetOrder()" title="Restore original category order">↺ Order</button>
        <button class="btn-add" id="add-cat-btn" style="display:none" onclick="toggleAddCatForm()">+ Add</button>
      </div>
      <div class="add-cat-form" id="add-cat-form">
        <input type="text" id="add-cat-input" placeholder="Category name&hellip;" onkeydown="if(event.key==='Enter') submitAddCat(); if(event.key==='Escape') toggleAddCatForm()" />
        <button class="btn-save" onclick="submitAddCat()">Create</button>
        <button class="btn-cancel" onclick="toggleAddCatForm()">Cancel</button>
      </div>
      <div class="panel-body" id="categories-body">
        <div class="loading">Loading&hellip;</div>
      </div>
    </div>
    <div class="panel" id="items-panel">
      <div class="panel-header">
        <h2 id="items-title">Select a category</h2>
        <span class="item-sel-badge" id="items-sel-badge" style="display:none"></span>
        <button class="btn-clear-sel" id="items-clear-sel" style="display:none" onclick="clearItemSelection()">&#x2715; Clear</button>
        <input type="search" id="items-search" placeholder="Search&hellip;" />
      </div>
      <div class="panel-body" id="items-body">
        <div class="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6M9 12h6M9 15h4"/></svg>
          <p>Select a category to browse items</p>
        </div>
      </div>
    </div>
  </main>
</div>

<script>
const BASE = window.location.origin;
let token = sessionStorage.getItem("cm_token") || "";
let currentType = "channel";
let currentCategoryId = null;
let categories = [];
let items = [];
let allCategories = {};
let selectedItemIds = new Set();
let lastSelectedItemIdx = -1;

// ── Auth ──────────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { signOut(); throw new Error("Unauthorized"); }
  return res.json();
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = document.getElementById("pw-input").value;
  const err = document.getElementById("login-error");
  err.textContent = "";
  try {
    const res = await fetch(BASE + "/api/auth/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    const data = await res.json();
    if (!data.token) { err.textContent = data.error || "Invalid password"; return; }
    token = data.token;
    sessionStorage.setItem("cm_token", token);
    showApp();
  } catch { err.textContent = "Connection failed"; }
});

function signOut() {
  token = "";
  sessionStorage.removeItem("cm_token");
  document.getElementById("app").style.display = "none";
  document.getElementById("login-screen").style.display = "flex";
  document.getElementById("pw-input").value = "";
}
document.getElementById("sign-out-btn").addEventListener("click", signOut);

// ── Init ──────────────────────────────────────────────────────────────────────

async function showApp() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app").style.display = "flex";
  updateAddBtn();
  await loadCategories();
}

if (token) showApp().catch(() => signOut());

// ── Tabs ──────────────────────────────────────────────────────────────────────

function updateAddBtn() {
  const btn = document.getElementById("add-cat-btn");
  btn.style.display = (currentType === "movie" || currentType === "series") ? "" : "none";
  document.getElementById("add-cat-form").classList.remove("open");
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentType = btn.dataset.type;
    currentCategoryId = null;
    selectedItemIds.clear();
    lastSelectedItemIdx = -1;
    resetItemsPanel();
    updateAddBtn();
    await loadCategories();
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && selectedItemIds.size > 0) clearItemSelection();
});

// ── Search ────────────────────────────────────────────────────────────────────

document.getElementById("cat-search").addEventListener("input", (e) => renderCategories(e.target.value));
document.getElementById("items-search").addEventListener("input", (e) => renderItems(e.target.value));

// ── Categories ────────────────────────────────────────────────────────────────

async function loadCategories() {
  document.getElementById("categories-body").innerHTML = '<div class="loading">Loading&hellip;</div>';
  try {
    categories = await api("GET", "/api/admin/genres?type=" + currentType);
    allCategories[currentType] = categories;
    renderCategories();
  } catch {
    document.getElementById("categories-body").innerHTML = '<div class="loading">Failed to load</div>';
  }
}

function renderCategories(search = "") {
  const body = document.getElementById("categories-body");
  const term = search.toLowerCase();
  const filtered = term ? categories.filter((c) => (c.display_name || c.title).toLowerCase().includes(term) || c.title.toLowerCase().includes(term)) : categories;
  const isFiltering = !!term;

  if (filtered.length === 0) {
    body.innerHTML = '<div class="loading">No categories found</div>';
    return;
  }

  body.innerHTML = filtered.map((cat) => {
    const isSelected = cat.id === currentCategoryId;
    const isHidden = cat.hidden;
    const isVirtual = String(cat.id).startsWith("vcat_");
    const hasOverride = !isVirtual && (cat.hidden || cat.display_name);
    const displayName = cat.display_name || cat.title;
    const showOriginal = !isVirtual && cat.display_name && cat.display_name !== cat.title;
    const draggable = !isFiltering;
    return \`
      <div class="row\${isSelected ? " selected" : ""}\${isHidden ? " hidden-item" : ""}"
        data-id="\${cat.id}"
        \${draggable ? \`draggable="true" ondragstart="dragStart(event,'\${cat.id}')" ondragend="dragEnd(event)" ondragover="dragOver(event,'\${cat.id}')" ondragleave="dragLeave(event)" ondrop="dragDrop(event,'\${cat.id}')"\` : ""}
        onclick="selectCategory('\${cat.id}')">
        \${draggable ? \`<div class="drag-handle" onclick="event.stopPropagation()">&#8942;&#8942;</div>\` : \`<div style="width:18px;flex-shrink:0"></div>\`}
        <div class="dot \${isHidden ? "hidden" : "visible"}"></div>
        <div class="row-name">
          <div class="primary">\${esc(displayName)}\${isVirtual ? \` <span style="font-size:10px;color:var(--accent);opacity:0.7">custom</span>\` : ""}</div>
          \${showOriginal ? \`<div class="secondary">\${esc(cat.title)}</div>\` : ""}
        </div>
        <span class="row-count">\${cat.count ?? ""}</span>
        <div class="row-actions" draggable="false" onclick="event.stopPropagation()">
          \${!isVirtual ? \`<button class="btn-icon" title="\${isHidden ? "Show" : "Hide"}" onclick="toggleCatHidden('\${cat.id}', \${!isHidden})">\${isHidden ? "👁" : "🙈"}</button>\` : ""}
          <button class="btn-icon" title="Edit" onclick="openCatEdit('\${cat.id}')" id="cat-edit-btn-\${cat.id}">✏</button>
        </div>
      </div>
      <div class="edit-row" id="cat-edit-\${cat.id}">
        <input type="text" placeholder="\${isVirtual ? "Category name" : "Display name (leave blank to restore original)"}" value="\${esc(cat.display_name || cat.title || "")}" id="cat-name-input-\${cat.id}" onkeydown="if(event.key==='Enter') saveCatEdit('\${cat.id}')"/>
        <button class="btn-save" onclick="saveCatEdit('\${cat.id}')">Save</button>
        \${isVirtual ? \`<button class="btn-reset" style="color:var(--red);border-color:var(--red)" onclick="resetCat('\${cat.id}')" title="Delete this category">Delete</button>\` : hasOverride ? \`<button class="btn-reset" onclick="resetCat('\${cat.id}')" title="Restore original">Reset</button>\` : ""}
        <button class="btn-cancel" onclick="closeCatEdit('\${cat.id}')">Cancel</button>
      </div>
    \`;
  }).join("");
}

async function selectCategory(id) {
  currentCategoryId = id;
  selectedItemIds.clear();
  lastSelectedItemIdx = -1;
  renderCategories(document.getElementById("cat-search").value);
  await loadItems(id);
}

function openCatEdit(id) {
  document.querySelectorAll(".edit-row.open").forEach((el) => {
    if (el.id !== "cat-edit-" + id) el.classList.remove("open");
  });
  document.getElementById("cat-edit-" + id).classList.toggle("open");
  document.getElementById("cat-name-input-" + id)?.focus();
}
function closeCatEdit(id) { document.getElementById("cat-edit-" + id).classList.remove("open"); }

async function saveCatEdit(id) {
  const input = document.getElementById("cat-name-input-" + id);
  const val = input.value.trim();
  const cat = categories.find((c) => c.id === id);
  const isVirtual = String(id).startsWith("vcat_");
  if (isVirtual) {
    await api("PUT", \`/api/admin/genres/\${currentType}/\${id}\`, { display_name: null, hidden: false, virtual_title: val || cat?.title });
  } else {
    await api("PUT", \`/api/admin/genres/\${currentType}/\${id}\`, { display_name: val || null, hidden: cat?.hidden ?? false });
  }
  closeCatEdit(id);
  await loadCategories();
  if (currentCategoryId === id) await loadItems(id);
}

async function toggleCatHidden(id, hidden) {
  const cat = categories.find((c) => c.id === id);
  await api("PUT", \`/api/admin/genres/\${currentType}/\${id}\`, { display_name: cat?.display_name ?? null, hidden });
  await loadCategories();
}

async function resetCat(id) {
  const isVirtual = String(id).startsWith("vcat_");
  if (isVirtual) {
    const cat = categories.find((c) => c.id === id);
    const count = cat?.count ?? 0;
    const msg = count > 0
      ? \`Delete "\${cat?.title}"? \${count} item\${count === 1 ? "" : "s"} will be moved back to their original categories.\`
      : \`Delete "\${cat?.title}"?\`;
    if (!confirm(msg)) return;
  }
  await api("DELETE", \`/api/admin/genres/\${currentType}/\${id}\`);
  closeCatEdit(id);
  await loadCategories();
}

function toggleAddCatForm() {
  const form = document.getElementById("add-cat-form");
  const isOpen = form.classList.toggle("open");
  if (isOpen) {
    document.getElementById("add-cat-input").value = "";
    document.getElementById("add-cat-input").focus();
  }
}

async function submitAddCat() {
  const input = document.getElementById("add-cat-input");
  const title = input.value.trim();
  if (!title) return;
  await api("POST", \`/api/admin/genres/\${currentType}\`, { title });
  toggleAddCatForm();
  await loadCategories();
}

async function sortAlpha() {
  const sorted = [...categories].sort((a, b) =>
    (a.display_name || a.title).localeCompare(b.display_name || b.title)
  );
  categories = sorted;
  renderCategories();
  await api("PUT", \`/api/admin/genres/\${currentType}/reorder\`, {
    order: sorted.map((c, i) => ({ id: c.id, sort_order: i })),
  });
}

async function resetOrder() {
  if (!confirm("Reset category order to original portal order?")) return;
  await api("DELETE", \`/api/admin/genres/\${currentType}/order\`);
  await loadCategories();
}

async function moveCat(id, direction) {
  const idx = categories.findIndex((c) => c.id === id);
  if (idx === -1) return;
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= categories.length) return;
  const newOrder = [...categories];
  [newOrder[idx], newOrder[swapIdx]] = [newOrder[swapIdx], newOrder[idx]];
  categories = newOrder;
  renderCategories();
  await api("PUT", \`/api/admin/genres/\${currentType}/reorder\`, {
    order: newOrder.map((c, i) => ({ id: c.id, sort_order: i })),
  });
}

// ── Category Drag & Drop ──────────────────────────────────────────────────────

let dragId = null;

function dragStart(e, id) {
  dragId = id;
  e.dataTransfer.effectAllowed = "move";
  setTimeout(() => e.currentTarget.classList.add("dragging"), 0);
}
function dragEnd(e) {
  e.currentTarget.classList.remove("dragging");
  document.querySelectorAll("#categories-body .drop-above,.drop-below").forEach((el) => el.classList.remove("drop-above", "drop-below"));
}
function dragOver(e, id) {
  e.preventDefault();
  if (dragId === id) return;
  document.querySelectorAll("#categories-body .row").forEach((el) => el.classList.remove("drop-above", "drop-below"));
  const el = document.querySelector(\`#categories-body [data-id="\${id}"]\`);
  if (el) el.classList.add("drop-above");
}
function dragLeave(e) {
  e.currentTarget.classList.remove("drop-above", "drop-below");
}
function dragDrop(e, id) {
  e.preventDefault();
  if (!dragId || dragId === id) return;
  document.querySelectorAll("#categories-body .row").forEach((el) => el.classList.remove("drop-above", "drop-below"));
  const srcIdx = categories.findIndex((c) => String(c.id) === String(dragId));
  const destIdx = categories.findIndex((c) => String(c.id) === String(id));
  if (srcIdx === -1 || destIdx === -1) return;
  const newOrder = [...categories];
  const [moved] = newOrder.splice(srcIdx, 1);
  newOrder.splice(destIdx, 0, moved);
  categories = newOrder;
  dragId = null;
  renderCategories(document.getElementById("cat-search").value);
  api("PUT", \`/api/admin/genres/\${currentType}/reorder\`, {
    order: newOrder.map((c, i) => ({ id: c.id, sort_order: i })),
  });
}

// ── Item Drag & Drop ──────────────────────────────────────────────────────────

let dragItemId = null;

function dragItemStart(e, id) {
  dragItemId = id;
  e.dataTransfer.effectAllowed = "move";
  setTimeout(() => e.currentTarget.classList.add("dragging"), 0);
}
function dragItemEnd(e) {
  e.currentTarget.classList.remove("dragging");
  document.querySelectorAll("#items-body .row").forEach((el) => el.classList.remove("drop-above", "drop-below"));
}
function dragItemOver(e, id) {
  e.preventDefault();
  if (dragItemId === id) return;
  document.querySelectorAll("#items-body .row").forEach((el) => el.classList.remove("drop-above", "drop-below"));
  const el = document.querySelector(\`#items-body [data-id="\${id}"]\`);
  if (el) el.classList.add("drop-above");
}
function dragItemLeave(e) {
  e.currentTarget.classList.remove("drop-above", "drop-below");
}
function dragItemDrop(e, id) {
  e.preventDefault();
  if (!dragItemId) return;
  document.querySelectorAll("#items-body .row").forEach((el) => el.classList.remove("drop-above", "drop-below"));

  // If the dragged item is in the selection, move all selected; otherwise just the one
  const toMove = (selectedItemIds.size > 0 && selectedItemIds.has(String(dragItemId)))
    ? new Set(selectedItemIds)
    : new Set([String(dragItemId)]);

  if (toMove.has(String(id))) { dragItemId = null; return; }

  const movingItems = items.filter((i) => toMove.has(String(i.id)));
  const remaining = items.filter((i) => !toMove.has(String(i.id)));
  const insertAt = remaining.findIndex((i) => String(i.id) === String(id));
  if (insertAt === -1) { dragItemId = null; return; }

  const newOrder = [...remaining];
  newOrder.splice(insertAt, 0, ...movingItems);
  items = newOrder;
  dragItemId = null;
  selectedItemIds.clear();
  lastSelectedItemIdx = -1;
  renderItems(document.getElementById("items-search").value);
  api("PUT", \`/api/admin/items/\${currentType}/\${currentCategoryId}/reorder\`, {
    order: newOrder.map((item, i) => ({ id: item.id, sort_order: i })),
  });
}

function toggleItemSelect(e, id) {
  if (e.target.closest(".row-actions") || e.target.closest(".btn-icon") || e.target.closest(".drag-handle")) return;
  const idStr = String(id);
  if (e.shiftKey && lastSelectedItemIdx !== -1) {
    const curIdx = items.findIndex((i) => String(i.id) === idStr);
    const lo = Math.min(lastSelectedItemIdx, curIdx);
    const hi = Math.max(lastSelectedItemIdx, curIdx);
    for (let k = lo; k <= hi; k++) selectedItemIds.add(String(items[k].id));
    lastSelectedItemIdx = curIdx;
  } else {
    if (selectedItemIds.has(idStr)) {
      selectedItemIds.delete(idStr);
    } else {
      selectedItemIds.add(idStr);
      lastSelectedItemIdx = items.findIndex((i) => String(i.id) === idStr);
    }
  }
  renderItems(document.getElementById("items-search").value);
}

function clearItemSelection() {
  selectedItemIds.clear();
  lastSelectedItemIdx = -1;
  renderItems(document.getElementById("items-search").value);
}

function updateItemSelBadge() {
  const badge = document.getElementById("items-sel-badge");
  const btn = document.getElementById("items-clear-sel");
  const n = selectedItemIds.size;
  if (badge) { badge.textContent = n > 0 ? n + " selected" : ""; badge.style.display = n > 0 ? "" : "none"; }
  if (btn) btn.style.display = n > 0 ? "" : "none";
}

// ── Items ─────────────────────────────────────────────────────────────────────

function resetItemsPanel() {
  document.getElementById("items-title").textContent = "Select a category";
  document.getElementById("items-search").value = "";
  items = [];
  document.getElementById("items-body").innerHTML = \`
    <div class="empty-state">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6M9 12h6M9 15h4"/></svg>
      <p>Select a category to browse items</p>
    </div>\`;
}

async function loadItems(categoryId) {
  const cat = categories.find((c) => c.id === categoryId);
  document.getElementById("items-title").textContent = cat?.display_name || cat?.title || categoryId;
  document.getElementById("items-body").innerHTML = '<div class="loading">Loading&hellip;</div>';
  try {
    items = await api("GET", \`/api/admin/items?type=\${currentType}&category_id=\${categoryId}\`);
    renderItems();
  } catch {
    document.getElementById("items-body").innerHTML = '<div class="loading">Failed to load items</div>';
  }
}

function renderItems(search = "") {
  const body = document.getElementById("items-body");
  const term = search.toLowerCase();
  const filtered = term ? items.filter((i) => (i.display_name || i.name).toLowerCase().includes(term) || i.name.toLowerCase().includes(term)) : items;

  updateItemSelBadge();

  if (filtered.length === 0) {
    body.innerHTML = \`<div class="empty-state"><p>\${term ? "No matches" : "No items in this category"}</p></div>\`;
    return;
  }

  const cats = allCategories[currentType] || [];
  const isVodOrSeries = currentType === "movie" || currentType === "series";

  const isFiltering = !!term;
  body.innerHTML = filtered.map((item) => {
    const isHidden = item.hidden;
    const hasOverride = item.hidden || item.display_name || item.target_category_id;
    const displayName = item.display_name || item.name;
    const showOriginal = item.display_name && item.display_name !== item.name;
    const targetCat = item.target_category_id ? cats.find((c) => c.id === item.target_category_id) : null;
    const showMoved = item.target_category_id && item.target_category_id !== item.original_category_id;
    const draggable = !isFiltering;

    const catOptions = cats.map((c) =>
      \`<option value="\${esc(c.id)}" \${c.id === item.target_category_id ? "selected" : ""}>\${esc(c.display_name || c.title)}</option>\`
    ).join("");

    const isSel = selectedItemIds.has(String(item.id));
    return \`
      <div class="row\${isHidden ? " hidden-item" : ""}\${isSel ? " item-sel" : ""}"
        data-id="\${item.id}"
        \${draggable ? \`draggable="true" ondragstart="dragItemStart(event,'\${item.id}')" ondragend="dragItemEnd(event)" ondragover="dragItemOver(event,'\${item.id}')" ondragleave="dragItemLeave(event)" ondrop="dragItemDrop(event,'\${item.id}')"\` : ""}
        onclick="toggleItemSelect(event,'\${item.id}')">
        \${draggable ? \`<div class="drag-handle" onclick="event.stopPropagation()">&#8942;&#8942;</div>\` : \`<div style="width:18px;flex-shrink:0"></div>\`}
        <div class="dot \${isHidden ? "hidden" : "visible"}"></div>
        <div class="row-name">
          <div class="primary">\${esc(displayName)}</div>
          \${showOriginal ? \`<div class="secondary">\${esc(item.name)}</div>\` : ""}
          \${showMoved ? \`<div class="secondary">→ \${esc(targetCat?.display_name || targetCat?.title || item.target_category_id)}</div>\` : ""}
        </div>
        <div class="row-actions" draggable="false" onclick="event.stopPropagation()">
          <button class="btn-icon" title="\${isHidden ? "Show" : "Hide"}" onclick="toggleItemHidden('\${item.id}', \${!isHidden})">\${isHidden ? "👁" : "🙈"}</button>
          <button class="btn-icon" title="Edit" onclick="openItemEdit('\${item.id}')">✏</button>
        </div>
      </div>
      <div class="edit-row" id="item-edit-\${item.id}">
        <input type="text" placeholder="Display name (blank = original)" value="\${esc(item.display_name || "")}" id="item-name-input-\${item.id}" onkeydown="if(event.key==='Enter') saveItemEdit('\${item.id}')"/>
        \${isVodOrSeries ? \`<select id="item-cat-select-\${item.id}"><option value="">— Keep in current category —</option>\${catOptions}</select>\` : ""}
        <button class="btn-save" onclick="saveItemEdit('\${item.id}')">Save</button>
        \${hasOverride ? \`<button class="btn-reset" onclick="resetItem('\${item.id}')" title="Restore original">Reset</button>\` : ""}
        <button class="btn-cancel" onclick="closeItemEdit('\${item.id}')">Cancel</button>
      </div>
    \`;
  }).join("");
}

function openItemEdit(id) {
  document.querySelectorAll(".edit-row.open").forEach((el) => {
    if (el.id !== "item-edit-" + id) el.classList.remove("open");
  });
  document.getElementById("item-edit-" + id).classList.toggle("open");
  document.getElementById("item-name-input-" + id)?.focus();
}
function closeItemEdit(id) { document.getElementById("item-edit-" + id).classList.remove("open"); }

async function saveItemEdit(id) {
  const nameInput = document.getElementById("item-name-input-" + id);
  const catSelect = document.getElementById("item-cat-select-" + id);
  const display_name = nameInput?.value.trim() || null;
  const target_category_id = catSelect?.value || null;
  const item = items.find((i) => i.id === id);
  await api("PUT", \`/api/admin/items/\${currentType}/\${id}\`, {
    display_name,
    hidden: item?.hidden ?? false,
    target_category_id,
    original_category_id: item?.original_category_id ?? null,
  });
  closeItemEdit(id);
  await loadItems(currentCategoryId);
}

async function toggleItemHidden(id, hidden) {
  const item = items.find((i) => i.id === id);
  await api("PUT", \`/api/admin/items/\${currentType}/\${id}\`, {
    display_name: item?.display_name ?? null,
    hidden,
    target_category_id: item?.target_category_id ?? null,
    original_category_id: item?.original_category_id ?? null,
  });
  await loadItems(currentCategoryId);
}

async function resetItem(id) {
  await api("DELETE", \`/api/admin/items/\${currentType}/\${id}\`);
  closeItemEdit(id);
  await loadItems(currentCategoryId);
}

// ── Utility ───────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
</script>
</body>
</html>`;

// ── Admin API Routes ──────────────────────────────────────────────────────────

export const adminRoutes: ServerRoute[] = [

  {
    method: "GET",
    path: "/contentmanager",
    handler: (_request, h) =>
      h.response(ADMIN_HTML).type("text/html"),
  },

  // ── Genres ─────────────────────────────────────────────────────────────────

  {
    method: "GET",
    path: "/api/admin/genres",
    handler: async (request, h) => {
      if (!authCheck(request)) return unauthorized(h);
      const { type } = request.query as { type?: string };
      if (!type || !["channel", "movie", "series"].includes(type)) {
        return h.response({ error: "Invalid type" }).code(400);
      }
      const genreType = type as GenreType;
      const genres = await readGenres(genreType);
      const keys = genres.map((g) => genreKey(genreType, String(g.id)));
      const overrides = await GenreOverride.findAll({ where: { genre_key: keys }, raw: true });
      const ovMap = new Map(overrides.map((o) => [o.genre_key, o]));

      const result = await Promise.all(
        genres.map(async (g) => {
          const ov = ovMap.get(genreKey(genreType, String(g.id)));
          const count = await getItemCount(genreType, String(g.id));
          return {
            id: String(g.id),
            title: g.title,
            display_name: ov?.display_name ?? null,
            hidden: ov?.hidden ?? false,
            sort_order: (ov as any)?.sort_order ?? null,
            count,
          };
        }),
      );

      // Also include virtual categories for this type
      const prefix = `${genreType}_`;
      const virtualRows = await GenreOverride.findAll({ where: { virtual: true }, raw: true });
      const virtualResult = await Promise.all(
        virtualRows
          .filter((r) => r.genre_key.startsWith(prefix))
          .map(async (r) => {
            const id = r.genre_key.slice(prefix.length);
            const count = await getItemCount(genreType, id);
            return {
              id,
              title: r.virtual_title ?? id,
              display_name: null,
              hidden: false,
              sort_order: r.sort_order ?? null,
              count,
              virtual: true,
            };
          }),
      );

      const combined = [...result, ...virtualResult];
      combined.sort((a, b) => {
        if (a.sort_order == null && b.sort_order == null) return 0;
        if (a.sort_order == null) return 1;
        if (b.sort_order == null) return -1;
        return a.sort_order - b.sort_order;
      });
      return h.response(combined);
    },
  },

  {
    method: "POST",
    path: "/api/admin/genres/{type}",
    handler: async (request, h) => {
      if (!authCheck(request)) return unauthorized(h);
      const { type } = request.params as { type: string };
      if (!["movie", "series"].includes(type)) {
        return h.response({ error: "Virtual categories only supported for movie and series" }).code(400);
      }
      const { title } = request.payload as any;
      if (!title?.trim()) return h.response({ error: "Title required" }).code(400);
      const id = `vcat_${Date.now()}`;
      const key = genreKey(type as GenreType, id);
      await GenreOverride.create({ genre_key: key, display_name: null, hidden: false, sort_order: null, virtual: true, virtual_title: title.trim() });
      invalidateVodCache();
      return h.response({ id, key });
    },
  },

  {
    method: "PUT",
    path: "/api/admin/genres/{type}/reorder",
    handler: async (request, h) => {
      if (!authCheck(request)) return unauthorized(h);
      const { type } = request.params as { type: string };
      if (!["channel", "movie", "series"].includes(type)) {
        return h.response({ error: "Invalid type" }).code(400);
      }
      const { order } = request.payload as { order: Array<{ id: string; sort_order: number }> };
      for (const { id, sort_order } of order) {
        const key = genreKey(type as GenreType, id);
        const existing = await GenreOverride.findByPk(key);
        if (existing) {
          await existing.update({ sort_order });
        } else {
          await GenreOverride.create({ genre_key: key, display_name: null, hidden: false, sort_order });
        }
      }
      invalidateVodCache();
      return h.response({ success: true });
    },
  },

  {
    method: "PUT",
    path: "/api/admin/genres/{type}/{id}",
    handler: async (request, h) => {
      if (!authCheck(request)) return unauthorized(h);
      const { type, id } = request.params as { type: string; id: string };
      if (!["channel", "movie", "series"].includes(type)) {
        return h.response({ error: "Invalid type" }).code(400);
      }
      const { display_name, hidden, virtual_title } = request.payload as any;
      const key = genreKey(type as GenreType, id);
      const existing = await GenreOverride.findByPk(key);
      if (existing?.virtual) {
        await existing.update({ virtual_title: virtual_title ?? existing.virtual_title });
      } else if (existing) {
        await existing.update({ display_name: display_name ?? null, hidden: hidden ?? false });
      } else {
        await GenreOverride.create({ genre_key: key, display_name: display_name ?? null, hidden: hidden ?? false, sort_order: null, virtual: false, virtual_title: null });
      }
      invalidateVodCache();
      return h.response({ success: true });
    },
  },

  {
    method: "DELETE",
    path: "/api/admin/genres/{type}/order",
    handler: async (request, h) => {
      if (!authCheck(request)) return unauthorized(h);
      const { type } = request.params as { type: string };
      if (!["channel", "movie", "series"].includes(type)) {
        return h.response({ error: "Invalid type" }).code(400);
      }
      const prefix = `${type}_`;
      const rows = await GenreOverride.findAll({ raw: true });
      for (const row of rows.filter((r) => r.genre_key.startsWith(prefix))) {
        const instance = await GenreOverride.findByPk(row.genre_key);
        if (!instance) continue;
        if (instance.virtual) {
          // Keep the row (it defines the category) but clear its position
          await instance.update({ sort_order: null });
        } else if (!instance.hidden && !instance.display_name) {
          await instance.destroy();
        } else {
          await instance.update({ sort_order: null });
        }
      }
      invalidateVodCache();
      return h.response({ success: true });
    },
  },

  {
    method: "DELETE",
    path: "/api/admin/genres/{type}/{id}",
    handler: async (request, h) => {
      if (!authCheck(request)) return unauthorized(h);
      const { type, id } = request.params as { type: string; id: string };
      if (!["channel", "movie", "series"].includes(type)) {
        return h.response({ error: "Invalid type" }).code(400);
      }
      const row = await GenreOverride.findByPk(genreKey(type as GenreType, id));
      if (row?.virtual) {
        // Restore items that were moved into this virtual category
        const movedItems = await ContentOverride.findAll({ where: { item_type: type, target_category_id: id } });
        for (const item of movedItems) {
          if (!item.display_name && !item.hidden) {
            await item.destroy();
          } else {
            await item.update({ target_category_id: null, original_category_id: null });
          }
        }
      }
      await GenreOverride.destroy({ where: { genre_key: genreKey(type as GenreType, id) } });
      invalidateVodCache();
      return h.response({ success: true });
    },
  },

  // ── Items ───────────────────────────────────────────────────────────────────

  {
    method: "GET",
    path: "/api/admin/items",
    handler: async (request, h) => {
      if (!authCheck(request)) return unauthorized(h);
      const { type, category_id } = request.query as { type?: string; category_id?: string };
      if (!type || !["channel", "movie", "series"].includes(type)) {
        return h.response({ error: "Invalid type" }).code(400);
      }

      // Virtual categories have no portal cache — fetch from ContentOverride directly
      if (category_id?.startsWith("vcat_")) {
        const movedIn = await ContentOverride.findAll({
          where: { item_type: type, target_category_id: category_id },
          raw: true,
        });
        const result = await Promise.all(movedIn.map(async (ov) => {
          const id = ov.item_key.replace(`${type}_`, "");
          const cacheKey = type === "movie" ? `vod_streams_${ov.original_category_id}` : `series_list_${ov.original_category_id}`;
          const srcItems = await xtreamCache.get<any[]>(cacheKey) ?? [];
          const srcItem = type === "movie"
            ? srcItems.find((i: any) => String(i.stream_id) === id)
            : srcItems.find((i: any) => String(i.series_id) === id);
          return {
            id,
            name: ov.display_name ?? srcItem?.name ?? id,
            original_category_id: ov.original_category_id,
            display_name: ov.display_name ?? null,
            hidden: ov.hidden ?? false,
            target_category_id: category_id,
            sort_order: ov.sort_order ?? null,
          };
        }));
        result.sort((a: any, b: any) => {
          if (a.sort_order == null && b.sort_order == null) return 0;
          if (a.sort_order == null) return 1;
          if (b.sort_order == null) return -1;
          return a.sort_order - b.sort_order;
        });
        return h.response(result);
      }

      let rawItems: any[] = [];

      if (type === "channel") {
        const channels = await readChannels();
        rawItems = category_id
          ? channels.filter((c) => c.tv_genre_id === category_id)
          : channels;
        rawItems = rawItems.map((c) => ({ id: String(c.id), name: c.name, original_category_id: c.tv_genre_id }));
      } else if (type === "movie") {
        if (!category_id) return h.response({ error: "category_id required" }).code(400);
        const cached = await xtreamCache.get<any[]>(`vod_streams_${category_id}`);
        rawItems = (cached ?? []).map((m) => ({
          id: String(m.stream_id),
          name: m.name,
          original_category_id: m.category_id,
        }));
      } else if (type === "series") {
        if (!category_id) return h.response({ error: "category_id required" }).code(400);
        const cached = await xtreamCache.get<any[]>(`series_list_${category_id}`);
        rawItems = (cached ?? []).map((s) => ({
          id: String(s.series_id),
          name: s.name,
          original_category_id: s.category_id,
        }));
      }

      const keys = rawItems.map((i) => contentKey(type, i.id));
      const overrides = await ContentOverride.findAll({ where: { item_key: keys }, raw: true });
      const ovMap = new Map(overrides.map((o) => [o.item_key, o]));

      const result = rawItems.map((item) => {
        const ov = ovMap.get(contentKey(type, item.id));
        return {
          id: item.id,
          name: item.name,
          original_category_id: item.original_category_id,
          display_name: ov?.display_name ?? null,
          hidden: ov?.hidden ?? false,
          target_category_id: ov?.target_category_id ?? null,
          sort_order: (ov as any)?.sort_order ?? null,
        };
      });

      // For VOD/Series: also show items moved INTO this category from elsewhere
      if (category_id && (type === "movie" || type === "series")) {
        const existingIds = new Set(rawItems.map((i) => i.id));
        const movedIn = await ContentOverride.findAll({
          where: { item_type: type, target_category_id: category_id },
          raw: true,
        });
        for (const ov of movedIn) {
          const id = ov.item_key.replace(`${type}_`, "");
          if (existingIds.has(id)) continue;
          const cacheKey = type === "movie" ? `vod_streams_${ov.original_category_id}` : `series_list_${ov.original_category_id}`;
          const srcItems = await xtreamCache.get<any[]>(cacheKey) ?? [];
          const srcItem = type === "movie"
            ? srcItems.find((i: any) => String(i.stream_id) === id)
            : srcItems.find((i: any) => String(i.series_id) === id);
          result.push({
            id,
            name: ov.display_name ?? srcItem?.name ?? id,
            original_category_id: ov.original_category_id,
            display_name: ov.display_name ?? null,
            hidden: ov.hidden ?? false,
            target_category_id: ov.target_category_id,
            sort_order: (ov as any).sort_order ?? null,
          });
        }
      }

      result.sort((a: any, b: any) => {
        if (a.sort_order == null && b.sort_order == null) return 0;
        if (a.sort_order == null) return 1;
        if (b.sort_order == null) return -1;
        return a.sort_order - b.sort_order;
      });
      return h.response(result);
    },
  },

  {
    method: "PUT",
    path: "/api/admin/items/{type}/{category_id}/reorder",
    handler: async (request, h) => {
      if (!authCheck(request)) return unauthorized(h);
      const { type, category_id } = request.params as { type: string; category_id: string };
      if (!["channel", "movie", "series"].includes(type)) {
        return h.response({ error: "Invalid type" }).code(400);
      }
      const { order } = request.payload as { order: Array<{ id: string; sort_order: number }> };
      for (const { id, sort_order } of order) {
        const key = contentKey(type, id);
        const existing = await ContentOverride.findByPk(key);
        if (existing) {
          await existing.update({ sort_order });
        } else {
          try {
            await ContentOverride.create({
              item_key: key,
              item_type: type,
              display_name: null,
              hidden: false,
              sort_order,
              target_category_id: null,
              original_category_id: category_id,
            });
          } catch {
            // Row created between our find and create — just update sort_order
            await ContentOverride.update({ sort_order }, { where: { item_key: key } });
          }
        }
      }
      return h.response({ success: true });
    },
  },

  {
    method: "PUT",
    path: "/api/admin/items/{type}/{id}",
    handler: async (request, h) => {
      if (!authCheck(request)) return unauthorized(h);
      const { type, id } = request.params as { type: string; id: string };
      if (!["channel", "movie", "series"].includes(type)) {
        return h.response({ error: "Invalid type" }).code(400);
      }
      const { display_name, hidden, target_category_id, original_category_id } = request.payload as any;
      const key = contentKey(type, id);
      await ContentOverride.upsert({
        item_key: key,
        item_type: type,
        display_name: display_name ?? null,
        hidden: hidden ?? false,
        target_category_id: target_category_id ?? null,
        original_category_id: original_category_id ?? null,
      });
      invalidateVodCache();
      return h.response({ success: true });
    },
  },

  {
    method: "DELETE",
    path: "/api/admin/items/{type}/{id}",
    handler: async (request, h) => {
      if (!authCheck(request)) return unauthorized(h);
      const { type, id } = request.params as { type: string; id: string };
      if (!["channel", "movie", "series"].includes(type)) {
        return h.response({ error: "Invalid type" }).code(400);
      }
      await ContentOverride.destroy({ where: { item_key: contentKey(type, id) } });
      invalidateVodCache();
      return h.response({ success: true });
    },
  },

  {
    method: "POST",
    path: "/api/admin/strm/generate",
    handler: async (request, h) => {
      if (!authCheck(request)) return unauthorized(h);
      const moviesPath = process.env.STRM_MOVIES_PATH;
      const seriesPath = process.env.STRM_SERIES_PATH;
      if (!moviesPath && !seriesPath) {
        return h.response({ error: "STRM_MOVIES_PATH and STRM_SERIES_PATH are not configured" }).code(400);
      }
      // Run in background, respond immediately
      generateStrmFiles().catch((e) => console.error("[STRM] generate error:", e));
      return h.response({ success: true, message: "STRM generation started in background" });
    },
  },
];
