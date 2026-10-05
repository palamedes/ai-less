const $ = (sel) => document.querySelector(sel);

const els = {
  status: $("#status"),
  banner: $("#banner"),
  input: $("#input"),
  dropzone: $("#dropzone"),
  wordCount: $("#wordCount"),
  clearBtn: $("#clearBtn"),
  intensity: $("#intensity"),
  target: $("#target"),
  targetOut: $("#targetOut"),
  passes: $("#passes"),
  keepFormatting: $("#keepFormatting"),
  judge: $("#judge"),
  voiceNotes: $("#voiceNotes"),
  voiceBox: $("#voiceBox"),
  analyzeBtn: $("#analyzeBtn"),
  humanizeBtn: $("#humanizeBtn"),
  report: $("#report"),
  toast: $("#toast"),
};

const state = {
  status: null,
  busy: null, // "analyze" | "humanize" | null
  controller: null,
};

// ---------- small helpers ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const countWords = (t) => t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
const pct = (x) => `${Math.round(x)}%`;

function scoreColor(score) {
  if (score < 20) return "var(--good)";
  if (score < 45) return "var(--ok)";
  if (score < 70) return "var(--warn)";
  return "var(--bad)";
}

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`ai-less:${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`ai-less:${key}`, JSON.stringify(value));
    } catch {}
  },
};

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 2200);
}

function gauge(score, { size = "", caption = "AI" } = {}) {
  const r = 50;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, score));
  return `<div class="gauge ${size}" style="--c:${scoreColor(v)}" role="img" aria-label="${Math.round(v)} percent AI">
    <svg viewBox="0 0 120 120"><circle class="track" cx="60" cy="60" r="${r}"/><circle class="arc" cx="60" cy="60" r="${r}" stroke-dasharray="${((c * v) / 100).toFixed(1)} ${c.toFixed(1)}"/></svg>
    <div class="center"><div class="num">${Math.round(v)}<span>%</span></div><div class="cap">${caption}</div></div></div>`;
}

// ---------- options ----------

function options() {
  return {
    intensity: els.intensity.querySelector('[aria-checked="true"]')?.dataset.v ?? "balanced",
    targetScore: Number(els.target.value),
    maxPasses: Number(els.passes.value),
    keepFormatting: els.keepFormatting.checked,
    judge: els.judge.checked,
    voiceNotes: els.voiceNotes.value,
  };
}

function setIntensity(v) {
  for (const b of els.intensity.querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.v === v));
}

function restore() {
  els.input.value = store.get("text", "");
  const o = store.get("options", {});
  setIntensity(o.intensity ?? "balanced");
  if (o.targetScore) els.target.value = o.targetScore;
  if (o.maxPasses) els.passes.value = o.maxPasses;
  if (typeof o.keepFormatting === "boolean") els.keepFormatting.checked = o.keepFormatting;
  if (typeof o.judge === "boolean") els.judge.checked = o.judge;
  if (o.voiceNotes) {
    els.voiceNotes.value = o.voiceNotes;
    els.voiceBox.open = true;
  }
  els.targetOut.textContent = `${els.target.value}%`;
  updateWordCount();
}

const saveOptions = () => store.set("options", options());

function updateWordCount() {
  const n = countWords(els.input.value);
  els.wordCount.textContent = `${n.toLocaleString()} word${n === 1 ? "" : "s"}`;
}

// ---------- status ----------

async function refreshStatus() {
  try {
    const res = await fetch("/api/status");
    state.status = await res.json();
  } catch {
    state.status = null;
  }
  renderStatus();
  const s = state.status;
  const settling = !s || !s.claude.checked || s.local.some((m) => m.status === "loading" || m.status === "idle");
  setTimeout(refreshStatus, settling ? 2500 : s.claude.ok ? 60000 : 8000);
}

function renderStatus() {
  const s = state.status;
  if (!s) {
    els.status.innerHTML = `<span class="pill bad">Server unreachable</span>`;
    return;
  }
  const pills = [];
  const via = s.claude.backend === "claude-code" ? "Claude Code, on your Claude plan" : "the Anthropic API, billed to API credits";
  pills.push(
    s.claude.ok
      ? `<span class="pill ok" title="Rewrites with ${esc(s.claude.model)} via ${via}">${esc(s.claude.label)}</span>`
      : `<span class="pill ${s.claude.checked ? "bad" : "wait"}" title="${esc(s.claude.error ?? "Checking…")}">${esc(s.claude.label)} ${s.claude.checked ? "offline" : "…"}</span>`,
  );
  for (const m of s.local) {
    const cls = { ready: "ok", loading: "wait", idle: "wait", error: "bad" }[m.status];
    const label = m.status === "ready" ? m.name : m.status === "error" ? `${m.name} failed` : `${m.name} loading`;
    pills.push(`<span class="pill ${cls}" title="${esc(m.error ?? "Local classifier, runs on this machine")}">${esc(label)}</span>`);
  }
  const ext = s.external.filter((d) => d.configured);
  if (ext.length) for (const d of ext) pills.push(`<span class="pill ok" title="Commercial detector (API key set)">${esc(d.name)}</span>`);
  else pills.push(`<span class="pill off" title="Add SAPLING_API_KEY, GPTZERO_API_KEY, WINSTON_API_KEY or ORIGINALITY_API_KEY to .env">No commercial detectors</span>`);
  els.status.innerHTML = pills.join("");

  if (s.claude.checked && !s.claude.ok) {
    els.banner.hidden = false;
    els.banner.innerHTML = `<strong>Rewriting needs Claude.</strong> ${esc(s.claude.error ?? "")
      .replace(/`([^`]+)`/g, "<code>$1</code>")} Scoring still works with the local detectors.`;
  } else {
    els.banner.hidden = true;
  }
  updateButtons();
}

function updateButtons() {
  const claudeOk = Boolean(state.status?.claude.ok);
  els.analyzeBtn.disabled = state.busy !== null;
  if (state.busy === "humanize") {
    els.humanizeBtn.disabled = false;
    els.humanizeBtn.textContent = "Stop";
    els.humanizeBtn.classList.add("stop");
  } else {
    els.humanizeBtn.disabled = state.busy !== null || !claudeOk;
    els.humanizeBtn.textContent = "De-AI it";
    els.humanizeBtn.classList.remove("stop");
    els.humanizeBtn.title = claudeOk ? "" : "Claude isn't connected. See the banner above.";
  }
}

// ---------- rendering: analysis ----------

function emptyView() {
  els.report.innerHTML = `<div class="empty">
    <h3>Drop in an article.</h3>
    <ol>
      <li><b>Analyze</b> scores how AI-generated it reads and highlights the sentences that give it away.</li>
      <li><b>De-AI it</b> has Claude rewrite it, re-scores each draft, and revises the passages that still flag until it hits your target.</li>
      <li>A final check compares the rewrite to your original so nothing gets added, dropped, or changed.</li>
    </ol>
    <p class="fine">Scores come from a local RoBERTa classifier trained on the RAID benchmark, a set of style heuristics, optionally Claude's own read, and any commercial detectors you add keys for. No detector is perfect, and they often disagree, so treat the number as an estimate.</p>
  </div>`;
}

function loadingView(msg) {
  els.report.innerHTML = `<div class="loading"><div class="spinner"></div>${esc(msg)}</div>`;
}

function errorView(msg) {
  els.report.innerHTML = `<div class="error-box"><strong>Something went wrong.</strong><br>${esc(msg)}</div>`;
}

function detectorRows(analysis) {
  return analysis.detectors
    .map((d) => {
      const kind = { local: "local", llm: "LLM", external: "commercial" }[d.kind];
      if (d.error)
        return `<div class="det"><div class="name">${esc(d.name)}<small>${kind}</small></div><div class="err">${esc(d.error)}</div></div>`;
      const v = d.score * 100;
      return `<div class="det" title="${esc(d.detail ?? "")}">
        <div class="name">${esc(d.name)}<small>${kind} · weight ${d.weight}</small></div>
        <div class="bar" style="--c:${scoreColor(v)};--w:${v.toFixed(1)}%"><i></i></div>
        <div class="pct">${pct(v)}</div>
        ${d.detail ? `<div class="det-detail">${esc(d.detail)}</div>` : ""}
      </div>`;
    })
    .join("");
}

function signalCards(analysis) {
  return analysis.signals
    .map(
      (s) => `<div class="sig" title="${esc(s.hint)}">
        <div class="top"><span>${esc(s.label)}</span><span style="color:${scoreColor(s.score * 100)}">${s.score >= 0.67 ? "AI-like" : s.score >= 0.34 ? "mixed" : "human-like"}</span></div>
        <div class="val">${esc(s.value)}</div>
        <div class="bar" style="--c:${scoreColor(s.score * 100)};--w:${(s.score * 100).toFixed(0)}%"><i></i></div>
      </div>`,
    )
    .join("");
}

function heat(score) {
  return Math.max(0, (score - 0.3) / 0.7) * 0.42;
}

const flagged = (s) => s.score !== null && (s.score >= 0.5 || (s.notes.length > 0 && s.score >= 0.35));

// The article with each sentence shaded by its AI score. Flagged sentences get a
// number, and each paragraph is followed by its notes: the score and the reasons.
function heatmap(text, sentences) {
  const root = document.createElement("div");
  root.className = "article heatmap";
  let pos = 0;
  let n = 0;
  let pending = []; // notes for the paragraph in progress
  let afterNotes = false;

  const gap = (to) => {
    let chunk = text.slice(pos, to);
    // A notes block already ends the line, so drop one newline to keep paragraph spacing even.
    if (afterNotes) chunk = chunk.replace(/^\n/, "");
    afterNotes = false;
    if (chunk) root.append(chunk);
  };

  sentences.forEach((s, i) => {
    if (s.start < pos) return;
    gap(s.start);
    const span = document.createElement("span");
    span.className = "sent";
    span.textContent = text.slice(s.start, s.end);
    if (s.score !== null) {
      span.style.setProperty("--heat", heat(s.score).toFixed(3));
      if (s.score >= 0.6) span.classList.add("hot");
    }
    root.append(span);
    if (flagged(s)) {
      n++;
      span.dataset.i = String(n);
      root.append(Object.assign(document.createElement("sup"), { className: "mk", textContent: String(n) }));
      pending.push({ n, s });
    }
    pos = s.end;

    const next = sentences[i + 1];
    if (pending.length && (!next || next.paragraph !== s.paragraph)) {
      const box = document.createElement("div");
      box.className = "hm-notes";
      box.innerHTML = pending
        .map(({ n, s }) => {
          const v = s.score * 100;
          const why = s.notes.length ? s.notes.map(esc).join(" · ") : "classifier only, no specific tell";
          return `<div class="hm-note" data-i="${n}"><span class="n">${n}</span><span class="p" style="--c:${scoreColor(v)}">${pct(v)}</span><span class="why">${why}</span></div>`;
        })
        .join("");
      root.append(box);
      pending = [];
      afterNotes = true;
    }
  });
  gap(text.length);

  // Hovering a note lights up its sentence, and the other way round.
  const link = (e, on) => {
    const i = e.target.closest?.("[data-i]")?.dataset.i;
    if (i) for (const el of root.querySelectorAll(`[data-i="${i}"]`)) el.classList.toggle("focus", on);
  };
  root.addEventListener("mouseover", (e) => link(e, true));
  root.addEventListener("mouseout", (e) => link(e, false));
  return root;
}

function scoreCard(analysis, extra = "") {
  const ok = analysis.detectors.filter((d) => !d.error).length;
  return `<div class="score-card">${gauge(analysis.overall)}
    <div class="score-text"><div class="verdict">${esc(analysis.verdict)}</div>
    <div class="sub">${analysis.words.toLocaleString()} words · ${ok} detector${ok === 1 ? "" : "s"}${extra}</div></div></div>`;
}

function analysisBlocks(text, analysis) {
  const frag = document.createDocumentFragment();
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div><div class="section-title">Detectors</div><div class="detectors">${detectorRows(analysis)}</div></div>
    ${analysis.tells.length ? `<div><div class="section-title">Stock phrases</div><div class="chips">${analysis.tells.map((t) => `<span class="chip">${esc(t.phrase)}${t.count > 1 ? `<b>×${t.count}</b>` : ""}</span>`).join("")}</div></div>` : ""}
    <div><div class="section-title">Sentence heatmap <span class="meta legend">human <span class="ramp"></span> AI</span></div><div class="hm-slot"></div></div>
    <div><div class="section-title">Style signals</div><div class="signals">${signalCards(analysis)}</div></div>`;
  wrap.querySelector(".hm-slot").replaceWith(heatmap(text, analysis.sentences));
  frag.append(...wrap.children);
  return frag;
}

function renderAnalysis(text, analysis) {
  els.report.innerHTML = scoreCard(analysis);
  els.report.append(analysisBlocks(text, analysis));
}

// ---------- analyze ----------

async function runAnalyze() {
  const text = els.input.value;
  if (!text.trim()) return toast("Paste an article first.");
  state.busy = "analyze";
  updateButtons();
  loadingView(options().judge && state.status?.claude.ok ? "Scoring… (Claude's read takes a few seconds)" : "Scoring…");
  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, judge: options().judge }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    renderAnalysis(text, data);
  } catch (err) {
    errorView(err.message);
  } finally {
    state.busy = null;
    updateButtons();
  }
}

// ---------- humanize ----------

async function* readSSE(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value.replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

function runView() {
  els.report.innerHTML = `
    <div class="run-head"></div>
    <div><div class="section-title">Progress</div><div class="steps"></div></div>
    <div class="live-wrap" hidden><div class="section-title"><span class="live-title">Draft</span><span class="meta live-meta"></span></div><div class="article live"></div></div>`;
  return {
    head: els.report.querySelector(".run-head"),
    steps: els.report.querySelector(".steps"),
    liveWrap: els.report.querySelector(".live-wrap"),
    liveTitle: els.report.querySelector(".live-title"),
    liveMeta: els.report.querySelector(".live-meta"),
    live: els.report.querySelector(".live"),
  };
}

function addStep(view, label) {
  view.steps.querySelector(".step.active")?.classList.replace("active", "done");
  const el = document.createElement("span");
  el.className = "step active";
  el.innerHTML = `<span class="label">${esc(label)}</span>`;
  view.steps.append(el);
  return el;
}

async function runHumanize() {
  if (state.busy === "humanize") {
    state.controller?.abort();
    return;
  }
  const original = els.input.value;
  if (!original.trim()) return toast("Paste an article first.");

  state.busy = "humanize";
  state.controller = new AbortController();
  updateButtons();
  const view = runView();
  const opts = options();
  let liveText = "";
  let caret = null;
  const stepFor = {};

  try {
    const res = await fetch("/api/humanize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: original, options: opts }),
      signal: state.controller.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? res.statusText);
    }

    for await (const { event, data } of readSSE(res.body)) {
      switch (event) {
        case "stage": {
          if (data.stage === "rewriting") {
            stepFor[data.pass] = addStep(view, data.pass === 1 ? "Pass 1: rewriting" : `Pass ${data.pass}: revising`);
            liveText = "";
            view.liveWrap.hidden = false;
            view.liveTitle.textContent = data.pass === 1 ? "Rewriting" : `Revision pass ${data.pass}`;
            view.liveMeta.textContent = "";
            view.live.textContent = "";
            caret = document.createElement("span");
            caret.className = "caret";
            view.live.append(caret);
          } else if (data.stage === "scoring") {
            stepFor[data.pass].querySelector(".label").textContent = `Pass ${data.pass}: scoring`;
            caret?.remove();
          } else {
            addStep(view, data.message);
          }
          break;
        }
        case "before":
          view.head.innerHTML = scoreCard(data.analysis, " · original");
          break;
        case "delta": {
          liveText += data.text;
          caret.before(data.text);
          view.liveMeta.textContent = `${countWords(liveText).toLocaleString()} words`;
          const box = view.live;
          if (box.scrollHeight - box.scrollTop - box.clientHeight < 80) box.scrollTop = box.scrollHeight;
          break;
        }
        case "draft": {
          const s = data.analysis.overall;
          const el = stepFor[data.pass];
          el.classList.replace("active", "done");
          if (data.best) {
            view.steps.querySelector(".step.best")?.classList.remove("best");
            el.classList.add("best");
          }
          el.innerHTML = `Pass ${data.pass} <span class="score" style="--c:${scoreColor(s)}">${pct(s)}</span>`;
          el.title = data.analysis.detectors.filter((d) => !d.error).map((d) => `${d.name}: ${pct(d.score * 100)}`).join(" · ");
          break;
        }
        case "done":
          renderResult(original, data);
          break;
        case "error":
          throw new Error(data.message);
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      view.steps.querySelector(".step.active")?.classList.replace("active", "done");
      toast("Stopped.");
    } else {
      els.report.insertAdjacentHTML("afterbegin", `<div class="error-box"><strong>Rewrite failed.</strong><br>${esc(err.message)}</div>`);
    }
  } finally {
    state.busy = null;
    state.controller = null;
    updateButtons();
  }
}

function fidelityBox(r) {
  if (r.fidelity === null) {
    return r.bestPass === 0
      ? ""
      : `<div class="fidelity warn"><div class="head">Meaning check didn't run</div><div class="note">${esc(r.fidelityError ?? "")} Compare the Changes tab by eye.</div></div>`;
  }
  const issues = r.fidelity.issues;
  if (!issues.length) {
    return `<div class="fidelity ok"><div class="head">Meaning check passed</div><div class="note">${esc(r.fidelity.summary)}</div></div>`;
  }
  return `<div class="fidelity warn"><div class="head">Meaning check: ${issues.length} thing${issues.length === 1 ? "" : "s"} to look at</div>
    <div class="note">${esc(r.fidelity.summary)}</div>
    <ul>${issues
      .map(
        (i) => `<li><span class="kind">${esc(i.kind)}</span>${esc(i.note)}<br>
          <span class="note">Original: <q>${esc(i.original)}</q>${i.edited ? `<br>Now: <q>${esc(i.edited)}</q>` : ""}</span></li>`,
      )
      .join("")}</ul></div>`;
}

function diffView(before, after) {
  const root = document.createElement("div");
  root.className = "article diff";
  if (!window.Diff) {
    root.textContent = "Diff library failed to load.";
    return root;
  }
  // A raw word diff of a heavy rewrite alternates single words and is unreadable.
  // Short unchanged runs sandwiched between edits get folded into the edit, so each
  // change reads as a whole deleted phrase followed by its replacement.
  let del = "";
  let ins = "";
  const flush = () => {
    if (del) root.append(Object.assign(document.createElement("del"), { textContent: del }));
    if (ins) root.append(Object.assign(document.createElement("ins"), { textContent: ins }));
    del = ins = "";
  };
  const parts = window.Diff.diffWordsWithSpace(before, after);
  parts.forEach((part, i) => {
    if (part.removed) del += part.value;
    else if (part.added) ins += part.value;
    else {
      const between = (del || ins) && i < parts.length - 1;
      const short = !part.value.includes("\n") && part.value.trim().split(/\s+/).length <= 3;
      if (between && short) {
        del += part.value;
        ins += part.value;
      } else {
        flush();
        root.append(part.value);
      }
    }
  });
  flush();
  return root;
}

function renderResult(original, r) {
  const { before, after } = r;
  const improved = r.bestPass > 0;
  const drop = before.overall - after.overall;
  els.report.innerHTML = `
    <div class="compare">
      <div>${gauge(before.overall, { size: "sm" })}<div class="label">Before</div></div>
      <div class="arrow">→</div>
      <div>${gauge(after.overall, { size: "sm" })}<div class="label">After</div></div>
      <div class="summary">
        <div class="verdict">${improved ? esc(after.verdict) : "Couldn't beat the original"}</div>
        <div class="sub">${improved ? `${drop >= 0 ? "Down" : "Up"} ${Math.abs(Math.round(drop))} points · best draft from pass ${r.bestPass}` : "Every draft scored worse than the original, so it's unchanged."}
          · ${r.usage.input.toLocaleString()} in / ${r.usage.output.toLocaleString()} out tokens</div>
      </div>
    </div>
    ${fidelityBox(r)}
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="text" aria-selected="true">Rewritten</button>
      <button role="tab" data-tab="diff" aria-selected="false">Changes</button>
      <button role="tab" data-tab="heat" aria-selected="false">Heatmap</button>
      <button role="tab" data-tab="detail" aria-selected="false">Detectors</button>
    </div>
    <div class="tab-body"></div>
    <div class="out-actions">
      <button class="primary" data-act="copy" type="button">Copy</button>
      <button class="secondary" data-act="download" type="button">Download .md</button>
      <button class="secondary" data-act="use" type="button" title="Put the rewrite in the editor so you can tweak it or run another round">Edit / run again</button>
    </div>`;

  const body = els.report.querySelector(".tab-body");
  const tabs = {
    text() {
      const el = document.createElement("div");
      el.className = "article";
      el.textContent = r.text;
      return el;
    },
    diff: () => diffView(original, r.text),
    heat: () => heatmap(r.text, after.sentences),
    detail() {
      const el = document.createElement("div");
      el.innerHTML = `<div class="section-title">After</div><div class="detectors">${detectorRows(after)}</div>
        <div class="section-title" style="margin-top:18px">Before</div><div class="detectors">${detectorRows(before)}</div>
        <div class="section-title" style="margin-top:18px">Style signals after</div><div class="signals">${signalCards(after)}</div>`;
      return el;
    },
  };
  const show = (name) => {
    for (const b of els.report.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
    body.replaceChildren(tabs[name]());
  };
  els.report.querySelector(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) show(b.dataset.tab);
  });
  els.report.querySelector(".out-actions").addEventListener("click", async (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (act === "copy") {
      await navigator.clipboard.writeText(r.text);
      toast("Copied.");
    } else if (act === "download") {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([r.text], { type: "text/markdown" }));
      a.download = "article.ai-less.md";
      a.click();
      URL.revokeObjectURL(a.href);
    } else if (act === "use") {
      els.input.value = r.text;
      store.set("text", r.text);
      updateWordCount();
      renderAnalysis(r.text, after);
      toast("Rewrite moved into the editor.");
    }
  });
  show("text");
}

// ---------- file drop ----------

async function loadFile(file) {
  if (/\.docx?$/i.test(file.name)) return toast("Word files aren't supported yet. Copy and paste the text instead.");
  let text = await file.text();
  if (/\.html?$/i.test(file.name) || /^\s*<(!doctype|html)/i.test(text)) {
    const doc = new DOMParser().parseFromString(text, "text/html");
    doc.querySelectorAll("script, style, nav, header, footer").forEach((n) => n.remove());
    const root = doc.querySelector("article, main") ?? doc.body;
    text = [...root.querySelectorAll("h1, h2, h3, h4, p, li, blockquote")]
      .map((n) => {
        const t = n.textContent.replace(/\s+/g, " ").trim();
        if (/^H\d$/.test(n.tagName)) return `${"#".repeat(Number(n.tagName[1]))} ${t}`;
        if (n.tagName === "LI") return `- ${t}`;
        return t;
      })
      .filter(Boolean)
      .join("\n\n") || root.textContent.trim();
  }
  els.input.value = text;
  store.set("text", text);
  updateWordCount();
  emptyView();
  toast(`Loaded ${file.name}`);
}

for (const type of ["dragenter", "dragover"]) {
  els.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    els.dropzone.classList.add("dragging");
  });
}
for (const type of ["dragleave", "drop"]) {
  els.dropzone.addEventListener(type, () => els.dropzone.classList.remove("dragging"));
}
els.dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

// ---------- wiring ----------

els.input.addEventListener("input", () => {
  updateWordCount();
  store.set("text", els.input.value);
});
els.clearBtn.addEventListener("click", () => {
  els.input.value = "";
  store.set("text", "");
  updateWordCount();
  emptyView();
  els.input.focus();
});
els.intensity.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-v]");
  if (!b) return;
  setIntensity(b.dataset.v);
  saveOptions();
});
els.target.addEventListener("input", () => {
  els.targetOut.textContent = `${els.target.value}%`;
  saveOptions();
});
for (const el of [els.passes, els.keepFormatting, els.judge, els.voiceNotes]) el.addEventListener("change", saveOptions);
els.analyzeBtn.addEventListener("click", runAnalyze);
els.humanizeBtn.addEventListener("click", runHumanize);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !state.busy) {
    e.preventDefault();
    runAnalyze();
  }
});

restore();
emptyView();
updateButtons();
refreshStatus();
