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
  interviewBtn: $("#interviewBtn"),
  report: $("#report"),
  layout: $("main.layout"),
  editorBtn: $("#editorBtn"),
  editorView: $("#editorView"),
  edLabel: $("#edLabel"),
  edText: $("#edText"),
  edScore: $("#edScore"),
  tip: $("#tip"),
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
  els.interviewBtn.disabled = state.busy !== null || !claudeOk;
}

// ---------- rendering: analysis ----------

function emptyView() {
  els.report.innerHTML = `<div class="empty">
    <h3>Drop in an article.</h3>
    <ol>
      <li><b>Analyze</b> scores how AI-generated it reads and highlights the sentences that give it away.</li>
      <li><b>De-AI it</b> has Claude rewrite it, re-scores each draft, and revises the passages that still flag until it hits your target. It strips the obvious tells, but Pangram and GPTZero still catch AI wording however it's rewritten.</li>
      <li><b>Interview</b> walks you through the article section by section with questions, and you rewrite it in your own words. Your sentences are what read as human to the strongest detectors.</li>
      <li>A final check compares the rewrite to your original so nothing gets added, dropped, or changed.</li>
    </ol>
    <p class="fine">Scores come from local classifiers (Pangram's open EditLens model and a RAID-trained RoBERTa), style heuristics, optionally Claude's own read, and any commercial detectors you add keys for. No detector is perfect, and they often disagree, so treat the number as an estimate and check final drafts with the detector you care about.</p>
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
  return Math.max(0, (score - 0.3) / 0.7) * 0.5;
}

const flagged = (s) => s.score !== null && (s.score >= 0.5 || (s.notes.length > 0 && s.score >= 0.35));

// The article with each sentence shaded by its AI score. Flagged sentences get a small
// number; hovering it shows the score and the reasons and lights up the sentence.
function heatmap(text, sentences) {
  const root = document.createElement("div");
  root.className = "article heatmap";
  let pos = 0;
  let n = 0;
  for (const s of sentences) {
    if (s.start < pos) continue;
    if (s.start > pos) root.append(text.slice(pos, s.start));
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
      const mark = Object.assign(document.createElement("sup"), { className: "mk", textContent: String(n) });
      mark.dataset.i = String(n);
      mark.dataset.score = String(s.score);
      mark.dataset.notes = JSON.stringify(s.notes);
      root.append(mark);
    }
    pos = s.end;
  }
  root.append(text.slice(pos));
  return root;
}

// ---------- tooltip for heatmap markers ----------

function showTip(mark, on) {
  for (const el of document.querySelectorAll(`.heatmap [data-i="${mark.dataset.i}"]`)) el.classList.toggle("focus", on);
  if (!on) {
    els.tip.hidden = true;
    return;
  }
  const v = Number(mark.dataset.score) * 100;
  const notes = JSON.parse(mark.dataset.notes || "[]");
  els.tip.innerHTML = `<strong>${pct(v)} AI-like</strong><ul>${(notes.length ? notes : ["classifier only, no specific tell"]).map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`;
  els.tip.hidden = false;
  const r = mark.getBoundingClientRect();
  const t = els.tip.getBoundingClientRect();
  els.tip.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 8))}px`;
  els.tip.style.top = `${r.top - t.height - 8 < 8 ? r.bottom + 8 : r.top - t.height - 8}px`;
}
document.addEventListener("mouseover", (e) => {
  const mark = e.target.closest?.("sup.mk");
  if (mark) showTip(mark, true);
});
document.addEventListener("mouseout", (e) => {
  const mark = e.target.closest?.("sup.mk");
  if (mark) showTip(mark, false);
});
document.addEventListener("scroll", () => (els.tip.hidden = true), { passive: true });

function scoreCard(analysis, extra = "") {
  const ok = analysis.detectors.filter((d) => !d.error).length;
  return `<div class="score-card">${gauge(analysis.overall)}
    <div class="score-text"><div class="verdict">${esc(analysis.verdict)}</div>
    <div class="sub">${analysis.words.toLocaleString()} words · ${ok} detector${ok === 1 ? "" : "s"}${analysis.lead ? ` · strongest signal: ${esc(analysis.lead.name)} ${pct(analysis.lead.score)}` : ""}${extra}</div></div></div>`;
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
  state.analysis = { text, analysis };
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
    <div><div class="section-title">Progress <span class="meta steps-hint" hidden>click a version to read it</span></div><div class="steps"></div></div>
    <div class="live-wrap" hidden>
      <div class="section-title"><span class="live-title">Draft</span><button class="linkish back" type="button" hidden>Back to the draft being written</button><span class="meta live-meta"></span></div>
      <div class="article live"></div>
    </div>`;
  return {
    head: els.report.querySelector(".run-head"),
    steps: els.report.querySelector(".steps"),
    hint: els.report.querySelector(".steps-hint"),
    liveWrap: els.report.querySelector(".live-wrap"),
    liveTitle: els.report.querySelector(".live-title"),
    liveMeta: els.report.querySelector(".live-meta"),
    live: els.report.querySelector(".live"),
    back: els.report.querySelector(".back"),
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

const scoreChip = (label, overall) => `${esc(label)} <span class="score" style="--c:${scoreColor(overall)}">${pct(overall)}</span>`;

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
  const stepFor = {};
  const versions = []; // index = pass number; 0 is the original

  // The panel shows either the draft being written ("live") or a finished version the user clicked.
  let liveText = "";
  let livePass = null;
  let streaming = false;
  let viewing = null;
  const caret = Object.assign(document.createElement("span"), { className: "caret" });

  const markViewing = () => {
    for (const el of view.steps.querySelectorAll(".step[data-pass]")) el.classList.toggle("viewing", Number(el.dataset.pass) === viewing);
  };
  const showLive = () => {
    viewing = null;
    markViewing();
    view.back.hidden = true;
    view.liveTitle.textContent = livePass === 1 ? "Rewriting" : `Revision pass ${livePass}`;
    view.liveMeta.textContent = `${countWords(liveText).toLocaleString()} words`;
    view.live.replaceChildren(liveText, ...(streaming ? [caret] : []));
    view.live.scrollTop = view.live.scrollHeight;
  };
  const showVersion = (pass) => {
    const v = versions[pass];
    if (!v) return;
    viewing = pass;
    markViewing();
    view.liveWrap.hidden = false;
    view.back.hidden = !streaming;
    view.liveTitle.textContent = pass === 0 ? "Original" : `Pass ${pass} draft`;
    view.liveMeta.textContent = `${pct(v.analysis.overall)} AI · ${v.analysis.words.toLocaleString()} words`;
    view.live.replaceChildren(v.text);
    view.live.scrollTop = 0;
  };
  view.steps.addEventListener("click", (e) => {
    const chip = e.target.closest(".step[data-pass]");
    if (chip) showVersion(Number(chip.dataset.pass));
  });
  view.back.addEventListener("click", showLive);

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
          if (data.stage === "analyzing") {
            stepFor[0] = addStep(view, data.message);
          } else if (data.stage === "rewriting") {
            stepFor[data.pass] = addStep(view, data.pass === 1 ? "Pass 1: rewriting" : `Pass ${data.pass}: revising`);
            liveText = "";
            livePass = data.pass;
            streaming = true;
            view.liveWrap.hidden = false;
            // Keep a version the user is reading on screen; they can jump back to the live draft.
            if (viewing === null) showLive();
            else view.back.hidden = false;
          } else if (data.stage === "scoring") {
            stepFor[data.pass].querySelector(".label").textContent = `Pass ${data.pass}: scoring`;
            streaming = false;
            caret.remove();
            view.back.hidden = true;
          } else {
            addStep(view, data.message);
          }
          break;
        }
        case "before": {
          versions[0] = { pass: 0, text: original, analysis: data.analysis };
          view.head.innerHTML = scoreCard(data.analysis, " · original");
          const chip = stepFor[0];
          chip.classList.replace("active", "done");
          chip.dataset.pass = "0";
          chip.innerHTML = scoreChip("Original", data.analysis.overall);
          break;
        }
        case "delta": {
          liveText += data.text;
          if (viewing !== null) break;
          caret.before(data.text);
          view.liveMeta.textContent = `${countWords(liveText).toLocaleString()} words`;
          const box = view.live;
          if (box.scrollHeight - box.scrollTop - box.clientHeight < 80) box.scrollTop = box.scrollHeight;
          break;
        }
        case "draft": {
          versions[data.pass] = { pass: data.pass, text: data.text, analysis: data.analysis };
          const el = stepFor[data.pass];
          el.classList.replace("active", "done");
          el.dataset.pass = String(data.pass);
          if (data.best) {
            view.steps.querySelector(".step.best")?.classList.remove("best");
            el.classList.add("best");
          }
          el.innerHTML = scoreChip(`Pass ${data.pass}`, data.analysis.overall);
          el.title = data.analysis.detectors.filter((d) => !d.error).map((d) => `${d.name}: ${pct(d.score * 100)}`).join(" · ");
          view.hint.hidden = false;
          markViewing();
          break;
        }
        case "done":
          renderResult(original, data, versions);
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

// state: undefined (not run), "loading", { fidelity }, or { error }
function fidelityBox(state) {
  if (state === undefined) {
    return `<div class="fidelity"><div class="head">Meaning check hasn't run for this draft</div>
      <div class="note">The rewrite checks the best-scoring draft automatically. <button class="linkish" data-act="check" type="button">Check this one</button></div></div>`;
  }
  if (state === "loading") return `<div class="fidelity"><div class="head"><span class="spinner inline"></span> Checking that the meaning survived…</div></div>`;
  if (state.error) {
    return `<div class="fidelity warn"><div class="head">Meaning check didn't run</div><div class="note">${esc(state.error)} Compare the Changes tab by eye. <button class="linkish" data-act="check" type="button">Try again</button></div></div>`;
  }
  const { summary, issues } = state.fidelity;
  if (!issues.length) {
    return `<div class="fidelity ok"><div class="head">Meaning check passed</div><div class="note">${esc(summary)}</div></div>`;
  }
  return `<div class="fidelity warn"><div class="head">Meaning check: ${issues.length} thing${issues.length === 1 ? "" : "s"} to look at</div>
    <div class="note">${esc(summary)}</div>
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

const ICON_COPY = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>`;
const ICON_DONE = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The async clipboard API needs a secure context; fall back for plain-http LAN access.
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) toast("Couldn't copy. Select the text and press Ctrl+C.");
    return ok;
  }
}

// A clipboard icon that sticks to the top-right corner of a text panel while you scroll it.
function copyButton(getText) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-btn";
  btn.title = "Copy to clipboard";
  btn.setAttribute("aria-label", "Copy to clipboard");
  btn.innerHTML = ICON_COPY;
  let timer;
  btn.addEventListener("click", async () => {
    if (!(await copyText(getText()))) return;
    btn.innerHTML = ICON_DONE;
    btn.classList.add("done");
    btn.title = "Copied";
    clearTimeout(timer);
    timer = setTimeout(() => {
      btn.innerHTML = ICON_COPY;
      btn.classList.remove("done");
      btn.title = "Copy to clipboard";
    }, 1600);
  });
  return btn;
}

const ICON_EDIT = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;

function editButton(onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-btn edit-btn";
  btn.title = "Open in the editor";
  btn.setAttribute("aria-label", "Open in the editor");
  btn.innerHTML = ICON_EDIT;
  btn.addEventListener("click", onClick);
  return btn;
}

// ---------- spaces ----------
// Characters that render as a space, or as nothing at all, but aren't U+0020. Word processors
// and copy-paste leave some of them; some chat apps have been reported to leave them in output.
const ODD_SPACE = /[\t\r\v\f\u00a0\u00ad\u061c\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u2064\u2066-\u2069\u3000\ufeff\u{e0000}-\u{e007f}]/gu;
const ODD_NAMES = {
  "\t": ["TAB", "Tab"], "\r": ["CR", "Carriage return"], "\v": ["VT", "Vertical tab"], "\f": ["FF", "Form feed"],
  "\u00a0": ["NBSP", "No-break space"], "\u00ad": ["SHY", "Soft hyphen"], "\u061c": ["ALM", "Arabic letter mark"],
  "\u1680": ["OSM", "Ogham space mark"], "\u180e": ["MVS", "Mongolian vowel separator"],
  "\u2000": ["NQSP", "En quad"], "\u2001": ["MQSP", "Em quad"], "\u2002": ["ENSP", "En space"], "\u2003": ["EMSP", "Em space"],
  "\u2004": ["3/MSP", "Three-per-em space"], "\u2005": ["4/MSP", "Four-per-em space"], "\u2006": ["6/MSP", "Six-per-em space"],
  "\u2007": ["FSP", "Figure space"], "\u2008": ["PSP", "Punctuation space"], "\u2009": ["THSP", "Thin space"], "\u200a": ["HSP", "Hair space"],
  "\u200b": ["ZWSP", "Zero-width space"], "\u200c": ["ZWNJ", "Zero-width non-joiner"], "\u200d": ["ZWJ", "Zero-width joiner (also used inside some emoji)"],
  "\u200e": ["LRM", "Left-to-right mark"], "\u200f": ["RLM", "Right-to-left mark"],
  "\u2028": ["LSEP", "Line separator"], "\u2029": ["PSEP", "Paragraph separator"],
  "\u202a": ["LRE", "Left-to-right embedding"], "\u202b": ["RLE", "Right-to-left embedding"], "\u202c": ["PDF", "Pop directional formatting"],
  "\u202d": ["LRO", "Left-to-right override"], "\u202e": ["RLO", "Right-to-left override"], "\u202f": ["NNBSP", "Narrow no-break space"],
  "\u205f": ["MMSP", "Medium mathematical space"], "\u2060": ["WJ", "Word joiner"],
  "\u2066": ["LRI", "Left-to-right isolate"], "\u2067": ["RLI", "Right-to-left isolate"], "\u2068": ["FSI", "First strong isolate"], "\u2069": ["PDI", "Pop directional isolate"],
  "\u3000": ["IDSP", "Ideographic space"], "\ufeff": ["BOM", "Zero-width no-break space (byte order mark)"],
};

function oddSpace(ch) {
  const cp = ch.codePointAt(0);
  const code = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  const [label, name] = ODD_NAMES[ch] ?? (cp >= 0xe0000 ? ["TAG", "Invisible tag character"] : [code, "Invisible math operator"]);
  return { label, name, code };
}

// What to put in place of each one: a normal space for the ones with width, a line break for
// the line-like ones, nothing for the invisible ones.
function cleanSpaces(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(ODD_SPACE, (ch) =>
      /[\t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/.test(ch) ? " " : /[\v\f\u2028]/.test(ch) ? "\n" : ch === "\u2029" ? "\n\n" : "",
    );
}

function oddSpaceCounts(text) {
  const counts = new Map();
  for (const [ch] of text.matchAll(ODD_SPACE)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  return [...counts].map(([ch, count]) => ({ ...oddSpace(ch), count }));
}

function oddSpaceMark(ch) {
  const o = oddSpace(ch);
  const el = document.createElement("span");
  el.className = "ws-odd";
  el.dataset.label = o.label;
  el.title = `${o.name} (${o.code}), not a normal space`;
  return el;
}

// The text with every normal space in its own span, so .show-spaces can dot them, and every
// other space-like character flagged with a label.
function spacedText(text) {
  const frag = document.createDocumentFragment();
  const re = new RegExp(` |${ODD_SPACE.source}`, "gu");
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[0] === " ") frag.append(Object.assign(document.createElement("span"), { className: "sp", textContent: " " }));
    else {
      const mark = oddSpaceMark(m[0]);
      mark.textContent = m[0];
      frag.append(mark);
    }
    last = m.index + m[0].length;
  }
  frag.append(text.slice(last));
  return frag;
}

// One version's text with a "Show spaces" switch and a warning about anything that isn't a
// normal space. onEdit(text, note) opens it in the editor; the note says what changed.
function textPanel(text, onEdit) {
  const wrap = document.createElement("div");
  const odd = oddSpaceCounts(text);
  const total = odd.reduce((a, o) => a + o.count, 0);
  const shown = store.get("showSpaces", false);
  wrap.innerHTML = `<div class="text-tools">
      <label class="check"><input type="checkbox" class="show-spaces-box"${shown ? " checked" : ""}> Show spaces</label>
      ${
        total
          ? `<span class="ws-alert">${total} character${total === 1 ? " isn't a normal space" : "s aren't normal spaces"}: ${odd
              .map((o) => `<span class="ws-odd" data-label="${esc(o.label)}" title="${esc(`${o.name} (${o.code})`)}"></span>${esc(o.name.replace(/ \(.*/, "").toLowerCase())} ×${o.count}`)
              .join(", ")}</span> <button class="linkish" data-act="clean" type="button">Open a cleaned-up copy in the editor</button>`
          : `<span class="ws-ok">Only normal spaces and line breaks</span>`
      }
    </div>`;
  const article = document.createElement("div");
  article.className = "article";
  article.classList.toggle("show-spaces", shown);
  article.append(copyButton(() => text), editButton(() => onEdit(text)), spacedText(text));
  wrap.append(article);
  wrap.querySelector(".show-spaces-box").addEventListener("change", (e) => {
    article.classList.toggle("show-spaces", e.target.checked);
    store.set("showSpaces", e.target.checked);
  });
  wrap.querySelector('[data-act="clean"]')?.addEventListener("click", () => onEdit(cleanSpaces(text), "spaces cleaned up"));
  return wrap;
}

function renderResult(original, r, drafts = []) {
  const { before } = r;
  // Every version from the run; the best draft carries the final (full) analysis.
  const versions = [{ pass: 0, text: original, analysis: before }];
  for (const v of drafts.slice(1)) if (v) versions.push(v.pass === r.bestPass ? { ...v, analysis: r.after } : v);
  const byPass = new Map(versions.map((v) => [v.pass, v]));
  const fidelity = new Map(); // pass -> "loading" | { fidelity } | { error }
  if (r.bestPass > 0) fidelity.set(r.bestPass, r.fidelity ? { fidelity: r.fidelity } : { error: r.fidelityError ?? "It didn't run." });
  let selected = r.bestPass;
  let tab = "text";
  const sel = () => byPass.get(selected);

  els.report.innerHTML = `
    <div class="compare"></div>
    <div><div class="section-title">Versions <span class="meta">click to compare</span></div><div class="steps versions"></div></div>
    <div class="fidelity-slot"></div>
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
      <button class="secondary" data-act="edit" type="button" title="Keep working on this version in the Markdown editor">Edit</button>
      <button class="secondary" data-act="use" type="button" title="Put this version in the Article box to analyze it or run another round">Use as input</button>
    </div>`;

  const q = (selector) => els.report.querySelector(selector);
  const label = () => (selected === 0 ? "Original" : `Pass ${selected}`);
  const edit = (text, note) => openEditor(text, note ? `${label()}, ${note}` : label());
  q(".versions").innerHTML = versions
    .map(
      (v) => `<button type="button" class="step done clickable${v.pass === r.bestPass && v.pass > 0 ? " best" : ""}" data-pass="${v.pass}" title="${esc(
        v.analysis.detectors.filter((d) => !d.error).map((d) => `${d.name}: ${pct(d.score * 100)}`).join(" · "),
      )}">${scoreChip(v.pass === 0 ? "Original" : `Pass ${v.pass}`, v.analysis.overall)}${v.pass === r.bestPass && v.pass > 0 ? ' <span class="badge">best</span>' : ""}</button>`,
    )
    .join("");

  const tabs = {
    text: () => textPanel(sel().text, edit),
    diff() {
      if (selected === 0) return Object.assign(document.createElement("p"), { className: "note", textContent: "This is the original, so there are no changes to show." });
      return diffView(original, sel().text);
    },
    heat: () => heatmap(sel().text, sel().analysis.sentences),
    detail() {
      const el = document.createElement("div");
      el.innerHTML = `<div class="section-title">${selected === 0 ? "Original" : `Pass ${selected}`}</div><div class="detectors">${detectorRows(sel().analysis)}</div>
        ${selected === 0 ? "" : `<div class="section-title" style="margin-top:18px">Original</div><div class="detectors">${detectorRows(before)}</div>`}
        <div class="section-title" style="margin-top:18px">Style signals</div><div class="signals">${signalCards(sel().analysis)}</div>`;
      return el;
    },
  };

  const update = () => {
    const v = sel();
    const a = v.analysis;
    const drop = before.overall - a.overall;
    const note =
      selected === 0
        ? r.bestPass === 0
          ? "No draft scored better than the original. Click a pass above to read it anyway."
          : "The original, as you pasted it."
        : `${drop >= 0 ? "Down" : "Up"} ${Math.abs(Math.round(drop))} points from the original${selected === r.bestPass ? " · best score this run" : ""}`;
    q(".compare").innerHTML = `
      <div>${gauge(before.overall, { size: "sm" })}<div class="label">Original</div></div>
      <div class="arrow">→</div>
      <div>${gauge(a.overall, { size: "sm" })}<div class="label">${selected === 0 ? "Original" : `Pass ${selected}`}</div></div>
      <div class="summary">
        <div class="verdict">${esc(a.verdict)}</div>
        <div class="sub">${note}${a.lead ? ` · strongest signal: ${esc(a.lead.name)} ${pct(a.lead.score)}` : ""}
          <br>This run: ${r.usage.input.toLocaleString()} in / ${r.usage.output.toLocaleString()} out tokens</div>
      </div>`;
    for (const b of q(".versions").querySelectorAll("[data-pass]")) b.setAttribute("aria-pressed", String(Number(b.dataset.pass) === selected));
    q(".fidelity-slot").innerHTML = selected === 0 ? "" : fidelityBox(fidelity.get(selected));
    q('.tabs [data-tab="text"]').textContent = selected === 0 ? "Text" : "Rewritten";
    for (const b of q(".tabs").querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    q(".tab-body").replaceChildren(tabs[tab]());
  };

  const checkMeaning = async (pass) => {
    fidelity.set(pass, "loading");
    update();
    try {
      const res = await fetch("/api/fidelity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ original, rewrite: byPass.get(pass).text }),
      });
      const data = await res.json();
      fidelity.set(pass, res.ok ? { fidelity: data.fidelity } : { error: data.error ?? res.statusText });
    } catch (err) {
      fidelity.set(pass, { error: err.message });
    }
    if (selected === pass) update();
  };

  q(".versions").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pass]");
    if (!b) return;
    selected = Number(b.dataset.pass);
    update();
  });
  q(".fidelity-slot").addEventListener("click", (e) => {
    if (e.target.closest('[data-act="check"]')) checkMeaning(selected);
  });
  q(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    update();
  });
  q(".out-actions").addEventListener("click", async (e) => {
    const act = e.target.closest("button")?.dataset.act;
    const v = sel();
    if (act === "copy") {
      if (await copyText(v.text)) toast("Copied.");
    } else if (act === "download") {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([v.text], { type: "text/markdown" }));
      a.download = selected === 0 ? "article.md" : `article.ai-less.pass${selected}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    } else if (act === "edit") {
      edit(v.text);
    } else if (act === "use") {
      els.input.value = v.text;
      store.set("text", v.text);
      updateWordCount();
      renderAnalysis(v.text, v.analysis);
      toast(selected === 0 ? "Original is in the editor." : `Pass ${selected} moved into the editor.`);
    }
  });
  update();
}

// ---------- interview mode ----------
// The author rewrites the article in their own words, section by section. Their text replaces
// the AI text exactly as written; the tool never rewords it.

function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

// Share of the author's word triples that also appear in the AI draft: copying or lightly
// paraphrasing the draft brings its wording, and its detectability, straight back.
function draftOverlap(mine, draft) {
  const grams = (t) => {
    const w = t.toLowerCase().match(/[\p{L}\p{N}'’]+/gu) ?? [];
    const out = new Set();
    for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
    return out;
  };
  const a = grams(mine);
  const b = grams(draft);
  if (!a.size) return 0;
  let hits = 0;
  for (const g of a) if (b.has(g)) hits++;
  return hits / a.size;
}

// Average sentence score of a section, from an earlier analysis of the same article.
function sectionScore(original, sectionText) {
  if (state.analysis?.text !== original) return null;
  const start = original.indexOf(sectionText);
  if (start < 0) return null;
  const end = start + sectionText.length;
  const inside = state.analysis.analysis.sentences.filter((s) => s.start >= start && s.end <= end && s.score !== null);
  return inside.length ? (100 * inside.reduce((a, s) => a + s.score, 0)) / inside.length : null;
}

async function runInterview({ regenerate = false } = {}) {
  const original = els.input.value;
  if (!original.trim()) return toast("Paste an article first.");
  const key = `iv:${hashText(original)}`;
  const saved = store.get(key, null);
  if (saved?.plan && !regenerate) return renderInterview(original, saved.plan, key);

  state.busy = "interview";
  updateButtons();
  loadingView("Splitting it into sections and writing questions for you…");
  try {
    const res = await fetch("/api/interview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: original }),
    });
    const plan = await res.json();
    if (!res.ok) throw new Error(plan.error ?? res.statusText);
    store.set(key, { plan, answers: saved?.answers ?? {} });
    renderInterview(original, plan, key);
  } catch (err) {
    errorView(err.message);
  } finally {
    state.busy = null;
    updateButtons();
  }
}

function renderInterview(original, plan, key) {
  const answers = store.get(key, { plan, answers: {} }).answers ?? {};
  const save = () => store.set(key, { plan, answers });
  const sections = plan.sections;
  // Sections without their own heading continue the one before: "Opening, continued".
  const labels = new Map();
  let current = "Opening";
  for (const s of sections) {
    if (s.heading) current = s.heading.replace(/^#+\s*/, "");
    labels.set(s.id, s.heading || s.id === 1 ? current : `${current}, continued`);
  }
  const label = (s) => labels.get(s.id);

  const root = document.createElement("div");
  root.className = "iv";
  root.innerHTML = `
    <div class="iv-head">
      <h3>Make it yours</h3>
      <p class="note">Pangram and GPTZero detect AI wording itself, so the sections you write yourself are what read as human. For each section, cover the point in your own words. The questions are there to get you going; answer them, ignore them, or wander. Rough is fine, and anything you leave empty keeps the AI version.</p>
      <div class="iv-progress"><div class="bar" style="--c:var(--good)"><i></i></div><span class="meta iv-progress-text"></span></div>
      <div class="iv-tools"><button class="linkish" data-act="regen" type="button">New questions</button></div>
    </div>
    <div class="iv-sections">${sections
      .map((s) => {
        const ai = sectionScore(original, s.text);
        return `<section class="iv-card" data-id="${s.id}">
          <div class="iv-card-head"><span class="iv-num">${s.id}</span><span class="iv-label">${esc(label(s))}</span>${
            ai === null ? "" : `<span class="iv-ai" style="--c:${scoreColor(ai)}" title="How AI-like this section of the original scored">${pct(ai)} AI</span>`
          }</div>
          ${s.point ? `<p class="iv-point"><b>The point:</b> ${esc(s.point)}</p>` : ""}
          ${s.questions.length ? `<ul class="iv-q">${s.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}
          <textarea class="iv-text" rows="6" placeholder="Say it your way…"></textarea>
          <div class="iv-foot">
            <span class="iv-live meta"></span>
            <button class="linkish" data-act="fix" type="button" title="Fix spelling and punctuation only">Fix typos</button>
          </div>
          <details class="iv-draft"><summary>Show the AI draft of this section</summary><div class="article">${esc(s.text)}</div><p class="note">Reading it is fine. Copying or lightly rewording it brings the AI back.</p></details>
        </section>`;
      })
      .join("")}</div>
    <div class="iv-assemble">
      <button class="primary" data-act="assemble" type="button">Assemble the article</button>
      <span class="meta">Your sections go in exactly as written; the rest keeps the AI text.</span>
    </div>
    <div class="iv-result"></div>`;
  els.report.replaceChildren(root);

  const q = (sel) => root.querySelector(sel);
  const cards = new Map([...root.querySelectorAll(".iv-card")].map((el) => [Number(el.dataset.id), el]));
  const scoreTimers = new Map();

  const progress = () => {
    let mine = 0;
    let total = 0;
    let done = 0;
    for (const s of sections) {
      const text = (answers[s.id] ?? "").trim();
      if (text) {
        done++;
        mine += countWords(text);
        total += countWords(text);
      } else total += s.words;
    }
    const share = total ? (100 * mine) / total : 0;
    q(".iv-progress .bar i").style.setProperty("--w", `${share.toFixed(1)}%`);
    q(".iv-progress-text").textContent = `${done} of ${sections.length} sections in your words · about ${Math.round(share)}% of the article is yours`;
  };

  const live = (s) => {
    const card = cards.get(s.id);
    const text = (answers[s.id] ?? "").trim();
    const out = card.querySelector(".iv-live");
    card.classList.toggle("mine", Boolean(text));
    if (!text) {
      out.textContent = "";
      return;
    }
    const own = 100 * (1 - draftOverlap(text, s.text));
    const n = countWords(text);
    out.innerHTML = `${n} words · <span style="color:${own >= 85 ? "var(--good)" : own >= 65 ? "var(--warn)" : "var(--bad)"}" title="Share of your wording that isn't lifted from the AI draft">${Math.round(own)}% your own wording</span>${
      own < 65 ? " · close to the draft's wording, so detectors may still flag it" : ""
    }<span class="iv-local"></span>`;
    // A quick local AI check once there's enough to judge.
    clearTimeout(scoreTimers.get(s.id));
    if (n < 40) return;
    scoreTimers.set(
      s.id,
      setTimeout(async () => {
        try {
          const res = await fetch("/api/score", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
          const data = await res.json();
          if (!res.ok || (answers[s.id] ?? "").trim() !== text) return;
          const slot = card.querySelector(".iv-local");
          if (slot) slot.innerHTML = ` · <span style="color:${scoreColor(data.overall)}" title="Local detectors only (style tells and EditLens); Pangram is stricter">local check ${pct(data.overall)} AI</span>`;
        } catch {}
      }, 1200),
    );
  };

  for (const s of sections) {
    const card = cards.get(s.id);
    const ta = card.querySelector(".iv-text");
    ta.value = answers[s.id] ?? "";
    ta.addEventListener("input", () => {
      answers[s.id] = ta.value;
      save();
      live(s);
      progress();
    });
    card.querySelector('[data-act="fix"]').addEventListener("click", async (e) => {
      const text = ta.value.trim();
      if (!text) return toast("Write something first.");
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "Fixing…";
      try {
        const res = await fetch("/api/proofread", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? res.statusText);
        if (data.refused) toast("The fix tried to reword too much, so your version is kept.");
        else if (!data.changed && data.text === text) toast("No typos found.");
        else {
          ta.value = data.text;
          answers[s.id] = data.text;
          save();
          live(s);
          progress();
          toast(data.changed ? `Fixed ${data.changed} word${data.changed === 1 ? "" : "s"}.` : "Fixed capitalization and punctuation.");
        }
      } catch (err) {
        toast(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "Fix typos";
      }
    });
    live(s);
  }
  progress();

  const assemble = () => {
    const parts = plan.title ? [plan.title] : [];
    for (const s of sections) {
      if (s.heading) parts.push(s.heading);
      parts.push((answers[s.id] ?? "").trim() || s.text);
    }
    return parts.join("\n\n") + "\n";
  };

  root.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "regen") {
      if (confirm("Write new questions for this article? Your answers are kept.")) runInterview({ regenerate: true });
    } else if (act === "assemble") {
      const text = assemble();
      const mine = sections.filter((s) => (answers[s.id] ?? "").trim()).length;
      const slot = q(".iv-result");
      slot.innerHTML = `<div class="section-title">Your article <span class="meta">${mine} of ${sections.length} sections in your words</span></div>`;
      const article = document.createElement("div");
      article.className = "article";
      article.append(copyButton(() => text), text);
      slot.append(article);
      slot.insertAdjacentHTML(
        "beforeend",
        `<div class="out-actions" style="margin-top:12px">
          <button class="primary" data-act="iv-analyze" type="button">Analyze it</button>
          <button class="secondary" data-act="iv-download" type="button">Download .md</button>
          <button class="secondary" data-act="iv-edit" type="button" title="Keep working on it in the Markdown editor">Edit</button>
          <button class="secondary" data-act="iv-editor" type="button" title="Put this version in the Article box">Use as input</button>
        </div><div class="iv-analysis"></div>`,
      );
      slot.dataset.text = text;
      slot.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (act === "iv-analyze") {
      const text = q(".iv-result").dataset.text;
      const out = q(".iv-analysis");
      out.innerHTML = `<div class="loading"><div class="spinner"></div>Scoring…</div>`;
      try {
        const res = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, judge: options().judge }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? res.statusText);
        out.innerHTML = scoreCard(data);
        out.append(analysisBlocks(text, data));
      } catch (err) {
        out.innerHTML = `<div class="error-box"><strong>Scoring failed.</strong><br>${esc(err.message)}</div>`;
      }
    } else if (act === "iv-download") {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([q(".iv-result").dataset.text], { type: "text/markdown" }));
      a.download = "article.mine.md";
      a.click();
      URL.revokeObjectURL(a.href);
    } else if (act === "iv-edit") {
      openEditor(q(".iv-result").dataset.text, "Your interview draft");
    } else if (act === "iv-editor") {
      els.input.value = q(".iv-result").dataset.text;
      store.set("text", els.input.value);
      updateWordCount();
      toast("Your version is in the Article box. Your interview answers are saved with the original.");
    }
  });
}

// ---------- editor ----------
// A Markdown editor for finishing a draft by hand. It holds one document, saved in the browser
// as you type, so a reload doesn't lose it; the topbar's Editor button brings it back.

const editor = { mde: null, base: null, heat: [], scored: null, scrollY: 0 };

const icon = (paths) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const glyph = (text, style = "") => `<span class="tb-text" style="${style}">${text}</span>`;

function editorToolbar() {
  const E = window.EasyMDE;
  const b = (name, action, title, markup, extra = {}) => ({ name, action, title, icon: markup, ...extra });
  return [
    b("bold", E.toggleBold, "Bold", glyph("B", "font-weight:800")),
    b("italic", E.toggleItalic, "Italic", glyph("I", "font-style:italic;font-family:Georgia,serif")),
    b("strikethrough", E.toggleStrikethrough, "Strikethrough", glyph("S", "text-decoration:line-through")),
    "|",
    b("heading-1", E.toggleHeading1, "Heading 1", glyph("H1")),
    b("heading-2", E.toggleHeading2, "Heading 2", glyph("H2")),
    b("heading-3", E.toggleHeading3, "Heading 3", glyph("H3")),
    "|",
    b("quote", E.toggleBlockquote, "Quote", icon('<path d="M17 6H3"/><path d="M21 12H8"/><path d="M21 18H8"/><path d="M3 12v6"/>')),
    b("unordered-list", E.toggleUnorderedList, "Bulleted list", icon('<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>')),
    b("ordered-list", E.toggleOrderedList, "Numbered list", icon('<path d="M10 12h11"/><path d="M10 18h11"/><path d="M10 6h11"/><path d="M4 10h2"/><path d="M4 6h1v4"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>')),
    "|",
    b("link", E.drawLink, "Link", icon('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>')),
    b("image", E.drawImage, "Image", icon('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>')),
    b("table", E.drawTable, "Table", icon('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M12 3v18"/>')),
    b("horizontal-rule", E.drawHorizontalRule, "Divider line", icon('<path d="M5 12h14"/>')),
    b("code", E.toggleCodeBlock, "Code", icon('<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>')),
    b("clean-block", E.cleanBlock, "Clear formatting", icon('<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>')),
    "|",
    b("undo", E.undo, "Undo", icon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'), { noDisable: true }),
    b("redo", E.redo, "Redo", icon('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'), { noDisable: true }),
    "|",
    b("show-spaces", () => setEditorSpaces(!store.get("showSpaces", false)), "Show spaces", glyph("·␣")),
    b("clean-spaces", cleanEditorSpaces, "Replace characters that aren't normal spaces", glyph("␣✓")),
    "|",
    b("preview", E.togglePreview, "Preview", icon('<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'), { noDisable: true }),
    b("side-by-side", E.toggleSideBySide, "Side-by-side preview", icon('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/>'), { noDisable: true, noMobile: true }),
    b("fullscreen", E.toggleFullScreen, "Full screen", icon('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'), { noDisable: true, noMobile: true }),
    b("guide", "https://www.markdownguide.org/basic-syntax/", "Markdown guide", icon('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'), { noDisable: true }),
  ];
}

// The preview renders the article's Markdown, which can carry raw HTML.
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("script, style, iframe, object, embed, form, link, meta, base")) el.remove();
  for (const el of doc.body.querySelectorAll("*")) {
    for (const { name, value } of [...el.attributes]) {
      if (/^on/i.test(name) || (/^(href|src|action|formaction|xlink:href)$/i.test(name) && /^\s*javascript:/i.test(value))) el.removeAttribute(name);
    }
    if (el.tagName === "A") Object.assign(el, { target: "_blank", rel: "noopener noreferrer" });
  }
  return doc.body.innerHTML;
}

// Shows each normal space as a dot. flattenSpans is off so that runs of spaces get a dot each.
const SPACE_OVERLAY = {
  token(stream) {
    if (stream.eat(" ")) return "space";
    stream.eatWhile(/[^ ]/);
    return null;
  },
};

function setEditorSpaces(on) {
  store.set("showSpaces", on);
  const cm = editor.mde.codemirror;
  cm.removeOverlay(SPACE_OVERLAY);
  if (on) cm.addOverlay(SPACE_OVERLAY);
  // EasyMDE resets the "active" class on custom buttons whenever the cursor moves.
  editor.mde.toolbarElements["show-spaces"]?.setAttribute("aria-pressed", String(on));
}

function cleanEditorSpaces() {
  const cm = editor.mde.codemirror;
  const matches = [...cm.getValue().matchAll(ODD_SPACE)];
  if (!matches.length) return toast("Every space is already a normal space.");
  // Back to front, so earlier offsets stay valid; one undo step.
  cm.operation(() => {
    for (const m of matches.reverse()) {
      cm.replaceRange(cleanSpaces(m[0]), cm.posFromIndex(m.index), cm.posFromIndex(m.index + m[0].length), "+clean");
    }
  });
  toast(`Replaced ${matches.length} character${matches.length === 1 ? "" : "s"} with normal spaces or nothing.`);
}

function docTitle(text) {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

function updateEditorLabel() {
  const doc = store.get("editor", null);
  if (!doc) return;
  const title = docTitle(doc.text);
  els.edLabel.textContent = `${doc.label} · ${doc.text === doc.base ? "unchanged" : "edited, saved in this browser"}${title ? ` · ${title}` : ""}`;
}

function saveEditor() {
  const doc = store.get("editor", null);
  if (!editor.mde || !doc) return;
  doc.text = editor.mde.value();
  store.set("editor", doc);
  updateEditorLabel();
}

function clearHeat() {
  for (const m of editor.heat) m.clear();
  editor.heat = [];
}

// A score's highlights, drawn on the text. CodeMirror moves them with the text as you type, and
// a sentence's highlight goes away once you edit inside it, since its score no longer applies.
function paintHeat(analysis) {
  const cm = editor.mde.codemirror;
  clearHeat();
  for (const s of analysis.sentences) {
    if (s.score === null || s.kind === "heading" || heat(s.score) <= 0) continue;
    editor.heat.push(
      cm.markText(cm.posFromIndex(s.start), cm.posFromIndex(s.end), {
        className: s.score >= 0.6 ? "ed-heat hot" : "ed-heat",
        css: `--heat:${heat(s.score).toFixed(3)}`,
        title: `${pct(s.score * 100)} AI-like${s.notes.length ? `: ${s.notes.join("; ")}` : ""}`,
      }),
    );
  }
}

function clearHeatAt(change) {
  if (!editor.heat.length) return;
  const cm = editor.mde.codemirror;
  const a = cm.indexFromPos(change.from);
  const b = a + change.text.join("\n").length;
  editor.heat = editor.heat.filter((m) => {
    const r = m.find();
    if (!r) return false;
    const from = cm.indexFromPos(r.from);
    const to = cm.indexFromPos(r.to);
    if (a === b ? from <= a && a < to : from < b && to > a) {
      m.clear();
      return false;
    }
    return true;
  });
}

function staleNote() {
  const slot = els.edScore.querySelector(".ed-stale");
  if (slot) slot.textContent = editor.mde.value() === editor.scored ? "" : "You've edited since this score";
}

function createEditor() {
  const mde = new window.EasyMDE({
    element: els.edText,
    toolbar: editorToolbar(),
    toolbarButtonClassPrefix: "mde",
    autoDownloadFontAwesome: false,
    spellChecker: false,
    nativeSpellcheck: true,
    inputStyle: "contenteditable",
    sideBySideFullscreen: false,
    minHeight: "460px",
    status: ["words", "lines"],
    unorderedListStyle: "-",
    previewClass: ["editor-preview", "md-preview"],
    renderingConfig: { sanitizerFunction: sanitizeHtml },
    placeholder: "Write here…",
  });
  editor.mde = mde;
  const cm = mde.codemirror;
  cm.setOption("flattenSpans", false);
  // CodeMirror draws these as placeholders instead of the character: the same labels as the
  // Rewritten tab. Tabs it draws itself (styled in CSS).
  cm.setOption("specialChars", /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00a0\u00ad\u061c\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u2064\u2066-\u2069\u3000\ufeff\ufff9-\ufffc]/);
  cm.setOption("specialCharPlaceholder", oddSpaceMark);
  let saveTimer;
  cm.on("change", (_cm, change) => {
    clearHeatAt(change);
    staleNote();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveEditor, 300);
  });
  window.addEventListener("pagehide", saveEditor);
  setEditorSpaces(store.get("showSpaces", false));
}

function showEditor() {
  const doc = store.get("editor", null);
  if (!doc) return;
  if (!window.EasyMDE) return toast("The editor didn't load. Reload the page and try again.");
  editor.scrollY = window.scrollY;
  els.layout.hidden = true;
  els.editorView.hidden = false;
  els.editorBtn.hidden = true;
  if (!editor.mde) createEditor();
  const cm = editor.mde.codemirror;
  if (editor.base !== doc.base || editor.mde.value() !== doc.text) {
    // A different document: start fresh, without the last one's undo history or score.
    editor.mde.value(doc.text);
    cm.clearHistory();
    editor.base = doc.base;
    editor.scored = null;
    clearHeat();
    els.edScore.hidden = true;
    els.edScore.replaceChildren();
  }
  updateEditorLabel();
  window.scrollTo(0, 0);
  cm.refresh();
  cm.focus();
}

// Opening a text the editor already holds picks up where you left off. Opening a different one
// replaces it, after asking if that would throw away edits.
function openEditor(text, label) {
  const doc = store.get("editor", null);
  const replace = !doc || (doc.base !== text && doc.text !== text);
  if (replace && doc && doc.text !== doc.base) {
    const ok = confirm(`The editor has your edits to ${doc.label}.\n\nOK: replace them with ${label}.\nCancel: keep your edits and open them.`);
    if (!ok) return showEditor();
  }
  if (replace) store.set("editor", { text, base: text, label });
  showEditor();
}

function closeEditor() {
  saveEditor();
  if (editor.mde?.isFullscreenActive()) editor.mde.toggleFullScreen();
  els.editorView.hidden = true;
  els.layout.hidden = false;
  els.editorBtn.hidden = false;
  window.scrollTo(0, editor.scrollY);
}

async function scoreEditor() {
  const cm = editor.mde.codemirror;
  const text = cm.getValue();
  if (!text.trim()) return toast("Write something first.");
  const btn = els.editorView.querySelector('[data-act="score"]');
  const gen = cm.changeGeneration();
  btn.disabled = true;
  btn.textContent = "Scoring…";
  els.edScore.hidden = false;
  els.edScore.innerHTML = `<div class="loading"><div class="spinner"></div>${options().judge && state.status?.claude.ok ? "Scoring… (Claude's read takes a few seconds)" : "Scoring…"}</div>`;
  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, judge: options().judge }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    editor.scored = text;
    els.edScore.innerHTML = `<div class="section-title">Score <span class="meta ed-stale"></span></div>${scoreCard(data)}`;
    els.edScore.append(analysisBlocks(text, data));
    // The sentence offsets only line up with the text as it was sent.
    if (cm.isClean(gen)) paintHeat(data);
    else toast("You edited while it scored, so the highlights are off. Check again to see them.");
    staleNote();
  } catch (err) {
    els.edScore.innerHTML = `<div class="error-box"><strong>Scoring failed.</strong><br>${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Check score";
  }
}

els.editorView.querySelector(".ed-head").addEventListener("click", async (e) => {
  const act = e.target.closest("button[data-act]")?.dataset.act;
  if (!act || !editor.mde) return;
  const text = editor.mde.value();
  const doc = store.get("editor", null);
  if (act === "back") closeEditor();
  else if (act === "score") scoreEditor();
  else if (act === "copy") {
    if (await copyText(text)) toast("Copied.");
  } else if (act === "download") {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    a.download = "article.edited.md";
    a.click();
    URL.revokeObjectURL(a.href);
  } else if (act === "input") {
    els.input.value = text;
    store.set("text", text);
    updateWordCount();
    closeEditor();
    toast("It's in the Article box. Analyze it, interview it, or De-AI it from there.");
  } else if (act === "revert") {
    if (!doc || text === doc.base) return toast("There are no edits to revert.");
    if (confirm(`Throw away your edits and go back to ${doc.label} as it was?`)) editor.mde.value(doc.base);
  }
});
els.editorBtn.addEventListener("click", showEditor);

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
els.interviewBtn.addEventListener("click", () => runInterview());
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
  if (!els.editorView.hidden) {
    e.preventDefault();
    if (!els.editorView.querySelector('[data-act="score"]').disabled) scoreEditor();
  } else if (!state.busy) {
    e.preventDefault();
    runAnalyze();
  }
});

restore();
els.editorBtn.hidden = !store.get("editor", null);
emptyView();
updateButtons();
refreshStatus();
