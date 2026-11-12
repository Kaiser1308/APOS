/**
 * The whole UI as one page, served from memory so `tsc` alone builds it. All data from the controller is
 * placed with textContent (never innerHTML): outcomes, notes and logs are written by agents. Keep this
 * script free of backticks and dollar-brace sequences, because it lives inside a template literal.
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>APOS</title>
<style>
:root { --bg:#f6f7f9; --panel:#ffffff; --ink:#1c2230; --mute:#667085; --line:#e1e5ec; --accent:#2f5bd8; --ok:#1a7f4b; --warn:#b26a00; --bad:#c0392b; --chip:#eef1f6; }
@media (prefers-color-scheme: dark) { :root { --bg:#12151c; --panel:#1a1f2a; --ink:#e6e9f0; --mute:#97a0b3; --line:#2a3140; --accent:#7ea2ff; --ok:#4cc38a; --warn:#e0a03a; --bad:#ff7b6b; --chip:#242b39; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display:flex; flex-wrap:wrap; gap:8px 20px; align-items:center; padding:10px 16px; background:var(--panel); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:2; }
header h1 { font-size:16px; margin:0; }
header .meta { color:var(--mute); font-size:13px; }
#banner { display:none; padding:8px 16px; background:var(--bad); color:#fff; font-weight:600; }
main { display:grid; grid-template-columns:minmax(260px,340px) 1fr; gap:16px; padding:16px; align-items:start; }
@media (max-width: 800px) { main { grid-template-columns:1fr; } }
section { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-bottom:16px; }
h2 { font-size:13px; text-transform:uppercase; letter-spacing:.05em; color:var(--mute); margin:0 0 8px; }
h3 { font-size:14px; margin:14px 0 6px; }
.item { padding:8px 0; border-top:1px solid var(--line); cursor:pointer; }
.item:first-of-type { border-top:0; }
.item .k { font-weight:600; }
.item .d { color:var(--mute); font-size:13px; overflow-wrap:anywhere; }
.chip { display:inline-block; padding:1px 8px; border-radius:10px; background:var(--chip); font-size:12px; }
.chip.human,.chip.blocked,.chip.red,.chip.fail,.chip.stale { background:var(--bad); color:#fff; }
.chip.verified,.chip.green,.chip.pass,.chip.closed,.chip.done { background:var(--ok); color:#fff; }
.chip.executing,.chip.dispatching,.chip.resuming,.chip.controller { background:var(--accent); color:#fff; }
.chip.lead,.chip.unverifiable,.chip.manual-pending { background:var(--warn); color:#fff; }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:6px 8px; border-top:1px solid var(--line); vertical-align:top; }
th { color:var(--mute); font-weight:500; font-size:12px; }
tr.goal { cursor:pointer; }
tr.goal:hover { background:var(--chip); }
.mute { color:var(--mute); }
.err { color:var(--bad); font-weight:600; }
.steps { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0; }
.step { padding:2px 10px; border-radius:12px; border:1px solid var(--line); color:var(--mute); font-size:12px; }
.step.reached { background:var(--chip); color:var(--ink); }
.step.now { background:var(--accent); color:#fff; border-color:var(--accent); }
.tabs button { background:none; border:0; border-bottom:2px solid transparent; padding:6px 10px; color:var(--mute); cursor:pointer; font:inherit; }
.tabs button.on { color:var(--ink); border-color:var(--accent); }
a { color:var(--accent); }
pre { white-space:pre-wrap; overflow-wrap:anywhere; background:var(--chip); padding:8px; border-radius:6px; margin:4px 0; }
svg text { fill:var(--ink); font-size:12px; }
svg rect { stroke:var(--line); }
.back { cursor:pointer; color:var(--accent); display:inline-block; margin-bottom:8px; }
</style>
</head>
<body>
<header>
  <h1>APOS</h1>
  <span class="meta" id="read"></span>
  <span class="meta" id="last"></span>
  <span class="meta" id="tick"></span>
</header>
<div id="banner" role="alert"></div>
<main>
  <div><section><h2>Needs you</h2><div id="inbox"></div></section></div>
  <div id="view"></div>
</main>
<script>
(function () {
  var HOLDERS = [["human", "Human"], ["lead", "Lead"], ["controller", "Controller / agent"], ["done", "Done"]];
  var STEPS = ["draft", "approved", "selected", "planned", "ready", "executing", "verified", "closed"];
  var state = { snap: null, goal: null, tab: "overview", lastGood: null, failed: false, doneOpen: false, timeline: [], nextBefore: null };

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === "text") el.textContent = attrs[k]; else if (k === "class") el.className = attrs[k]; else if (k.slice(0, 2) === "on") el[k] = attrs[k]; else el.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return el;
  }
  function chip(label, cls) { return h("span", { class: "chip " + (cls || label), text: label }); }
  function age(iso) {
    if (!iso) return "-";
    var s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return s + "s ago"; if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago"; return Math.round(s / 86400) + "d ago";
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function num(n) { return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n); }
  function usageText(u) {
    if (!u) return "-";
    var t = num(u.inputTokens) + " in (" + num(u.cachedInputTokens) + " cached) / " + num(u.outputTokens) + " out";
    if (u.unknownDispatches) t += " + " + u.unknownDispatches + " unknown";
    return t;
  }
  function budget(g) {
    var a = g.appetite; if (!a) return "no appetite yet";
    return "owner attempts " + g.attempts + "/" + a.maxAttempts + ", " + g.elapsedMinutes + "/" + a.maxWallMinutes + " min, max $" + a.maxSpendUsd + " (spend not measured)";
  }
  function get(path) {
    return fetch(path, { cache: "no-store" }).then(function (r) {
      return r.text().then(function (body) { if (!r.ok) throw new Error(path + " -> " + r.status + " " + body.slice(0, 200)); return body; });
    });
  }
  function select(id) { state.goal = id; state.detail = null; state.detailError = null; state.tab = "overview"; state.timeline = []; state.nextBefore = null; location.hash = id || ""; render(); if (id) loadDetail(); }

  function renderHeader() {
    var s = state.snap;
    document.getElementById("read").textContent = s ? "read " + new Date(s.readAt).toLocaleTimeString() : "";
    document.getElementById("last").textContent = s ? "last event " + age(s.lastEventAt) : "";
    document.getElementById("tick").textContent = s ? (s.tickRunning ? "controller tick running" : "no tick running right now") : "";
    var b = document.getElementById("banner");
    if (state.failed) { b.style.display = "block"; b.textContent = "Cannot read the controller. Showing data from " + (state.lastGood ? new Date(state.lastGood).toLocaleTimeString() : "never") + "."; }
    else b.style.display = "none";
  }
  function renderInbox() {
    var box = document.getElementById("inbox"); clear(box);
    var items = state.snap ? state.snap.inbox : [];
    if (!items.length) { box.appendChild(h("div", { class: "mute", text: "Nothing is waiting for you." })); return; }
    items.forEach(function (it) {
      box.appendChild(h("div", { class: "item", onclick: function () { select(it.goalId); } }, [
        h("div", null, [h("span", { class: "k", text: it.goalId + " " }), chip(it.kind, it.kind === "needs-decision" ? "red" : "lead"), h("span", { class: "mute", text: "  " + age(it.at) })]),
        h("div", { class: "d", text: it.detail })
      ]));
    });
  }
  function goalTable(goals) {
    var t = h("table", null, [h("tr", null, ["Goal", "Outcome", "Status", "Mode", "Packages", "Budget", "Last event"].map(function (c) { return h("th", { text: c }); }))]);
    goals.forEach(function (g) {
      t.appendChild(h("tr", { class: "goal", onclick: function () { select(g.id); } }, [
        h("td", { text: g.id }),
        h("td", g.integrityError ? { class: "err", text: "log integrity: " + g.integrityError } : { text: g.outcome || "" }),
        h("td", null, [g.status ? chip(g.status) : null]),
        h("td", { text: g.mode || "-" }),
        h("td", { text: g.packages.total ? g.packages.verified + "/" + g.packages.total : "-" }),
        h("td", { class: "mute", text: budget(g) }),
        h("td", { class: "mute", text: age(g.lastEventAt) })
      ]));
    });
    return t;
  }
  function renderList(view) {
    var goals = state.snap ? state.snap.goals : [];
    HOLDERS.forEach(function (hd) {
      var group = goals.filter(function (g) { return (g.holder || "human") === hd[0]; });
      if (hd[0] === "human") group = group.concat(goals.filter(function (g) { return !g.holder; }));
      var sec = h("section", null, [h("h2", { text: hd[1] + " (" + group.length + ")" })]);
      if (hd[0] === "done" && !state.doneOpen) {
        if (group.length) sec.appendChild(h("a", { href: "#", text: "show", onclick: function (e) { e.preventDefault(); state.doneOpen = true; render(); } }));
      } else if (group.length) sec.appendChild(goalTable(group));
      else sec.appendChild(h("div", { class: "mute", text: "none" }));
      view.appendChild(sec);
    });
  }

  function dag(packages) {
    var byId = {}; packages.forEach(function (p) { byId[p.id] = p; });
    var depth = {};
    function d(p, seen) { if (depth[p.id] != null) return depth[p.id]; if (seen[p.id]) return 0; seen[p.id] = 1; var m = 0; p.dependencies.forEach(function (x) { if (byId[x]) m = Math.max(m, d(byId[x], seen) + 1); }); return (depth[p.id] = m); }
    packages.forEach(function (p) { d(p, {}); });
    var cols = {}, pos = {}, W = 130, H = 36, GX = 50, GY = 16, maxRows = 0, maxCol = 0;
    packages.forEach(function (p) { var c = depth[p.id]; cols[c] = cols[c] || []; pos[p.id] = { x: c * (W + GX) + 8, y: cols[c].length * (H + GY) + 8 }; cols[c].push(p); maxRows = Math.max(maxRows, cols[c].length); maxCol = Math.max(maxCol, c); });
    var NS = "http://www.w3.org/2000/svg";
    function s(tag, a) { var e = document.createElementNS(NS, tag); for (var k in a) e.setAttribute(k, a[k]); return e; }
    var svg = s("svg", { width: (maxCol + 1) * (W + GX) + 16, height: maxRows * (H + GY) + 16, role: "img", "aria-label": "work package dependency graph" });
    var defs = s("defs", {}); var mk = s("marker", { id: "arr", markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: "auto" });
    mk.appendChild(s("path", { d: "M0,0 L8,4 L0,8 z", fill: "#888" })); defs.appendChild(mk); svg.appendChild(defs);
    var COLOR = { verified: "#1a7f4b", executing: "#2f5bd8", dispatching: "#2f5bd8", resuming: "#2f5bd8", blocked: "#c0392b", stale: "#c0392b", specified: "#8a93a6" };
    packages.forEach(function (p) { p.dependencies.forEach(function (x) { if (!pos[x]) return; var a = pos[x], b = pos[p.id]; svg.appendChild(s("line", { x1: a.x + W, y1: a.y + H / 2, x2: b.x, y2: b.y + H / 2, stroke: "#888", "marker-end": "url(#arr)" })); }); });
    packages.forEach(function (p) {
      var q = pos[p.id]; var g = s("g", {});
      g.appendChild(s("rect", { x: q.x, y: q.y, width: W, height: H, rx: 6, fill: COLOR[p.status] || "#8a93a6", "fill-opacity": "0.25" }));
      var t1 = s("text", { x: q.x + 8, y: q.y + 15 }); t1.textContent = p.id; g.appendChild(t1);
      var t2 = s("text", { x: q.x + 8, y: q.y + 29 }); t2.textContent = p.status; g.appendChild(t2);
      svg.appendChild(g);
    });
    return svg;
  }

  function overview(g) {
    var box = h("div");
    var idx = STEPS.indexOf(g.status === "blocked" ? "executing" : g.status);
    var steps = h("div", { class: "steps" });
    STEPS.forEach(function (name, i) { steps.appendChild(h("span", { class: "step" + (i < idx ? " reached" : i === idx ? " now" : ""), text: name })); });
    box.appendChild(steps);
    if (g.status === "blocked") box.appendChild(h("div", { class: "err", text: "Blocked: " + JSON.stringify(g.blocker) }));
    if (g.status === "stopped") box.appendChild(h("div", { class: "mute", text: "Stopped by the Human." }));
    box.appendChild(h("h3", { text: "Budget" })); box.appendChild(h("div", { text: budget(g) }));
    box.appendChild(h("div", { class: "mute", text: "Tokens: " + usageText(g.usage) }));
    if (g.packageList.length) { box.appendChild(h("h3", { text: "Work packages" })); box.appendChild(dag(g.packageList));
      g.packageList.forEach(function (p) { box.appendChild(h("div", null, [h("b", { text: p.id + " " }), chip(p.status), h("span", { class: "mute", text: " " + p.owner + ", attempts " + p.attempts + (g.appetite ? "/" + g.appetite.maxAttempts : "") + " - " + p.outcome }), p.blocker ? h("div", { class: "err", text: p.blocker.kind + ": " + p.blocker.note }) : null])); }); }
    box.appendChild(h("h3", { text: "Findings" }));
    if (!g.findings.length) box.appendChild(h("div", { class: "mute", text: "none" }));
    g.findings.forEach(function (f) { box.appendChild(h("div", null, [chip(f.kind, "lead"), h("span", { text: " " + f.note }), h("span", { class: "mute", text: " (" + f.by + ")" })])); });
    box.appendChild(h("h3", { text: "Reviews" }));
    if (!g.reviews.length) box.appendChild(h("div", { class: "mute", text: "none" }));
    g.reviews.forEach(function (r) { box.appendChild(h("div", null, [chip(r.result, r.result === "pass" ? "pass" : "fail"), h("span", { text: " " + r.subject + (r.packageId ? " " + r.packageId : "") + " by " + r.reviewer + " on " + r.commitRef.slice(0, 10) + ": " + r.note })])); });
    box.appendChild(h("h3", { text: "Telemetry" }));
    if (!g.telemetry.length) box.appendChild(h("div", { class: "mute", text: "none" }));
    g.telemetry.forEach(function (t) { box.appendChild(h("div", { class: "mute", text: t.role + " " + t.dispatchId + " " + (t.model || "?") + ": " + (t.usage === "unknown" || !t.usage ? "usage unknown" : usageText({ inputTokens: t.usage.inputTokens, cachedInputTokens: t.usage.cachedInputTokens, outputTokens: t.usage.outputTokens, unknownDispatches: 0 })) + (t.wallMs ? ", " + Math.round(t.wallMs / 60000) + " min" : "") })); });
    return box;
  }
  function gates(g) {
    var box = h("div");
    if (!g.gates.length) return h("div", { class: "mute", text: "No gate has run yet." });
    g.gates.forEach(function (gate) {
      box.appendChild(h("h3", null, [h("span", { text: gate.scope + " " }), chip(gate.result), h("span", { class: "mute", text: " " + gate.commit.slice(0, 10) + " " + age(gate.at) })]));
      gate.checks.forEach(function (c) {
        var line = h("div", null, [chip(c.status), h("span", { text: " " + c.checkId + ": " + c.reason })]);
        c.logs.forEach(function (l) { line.appendChild(document.createTextNode(" ")); line.appendChild(h("a", { href: "/api/goals/" + encodeURIComponent(g.id) + "/gate-log/" + l.logSha256, target: "_blank", rel: "noopener", text: l.role + " log" + (l.exitCode === null ? "" : " (exit " + l.exitCode + ")") })); });
        box.appendChild(line);
        if (c.newFailures.length) box.appendChild(h("pre", { text: "new failures: " + c.newFailures.join(", ") }));
      });
    });
    return box;
  }
  function timeline(g) {
    var box = h("div");
    var events = state.timeline.length ? state.timeline : g.timeline.events;
    events.forEach(function (e) { box.appendChild(h("div", { class: "item" }, [h("span", { class: "k", text: e.type }), h("span", { class: "mute", text: "  " + new Date(e.at).toLocaleString() }), e.data ? h("div", { class: "d", text: e.data }) : null])); });
    var next = state.timeline.length ? state.nextBefore : g.timeline.nextBefore;
    if (next) box.appendChild(h("a", { href: "#", text: "older events", onclick: function (e) { e.preventDefault(); loadOlder(next); } }));
    return box;
  }
  function renderDetail(view) {
    view.appendChild(h("a", { class: "back", text: "< all Goals", onclick: function () { select(null); } }));
    var g = state.detail;
    if (!g || g.id !== state.goal) { view.appendChild(h("div", { class: state.detailError ? "err" : "mute", text: state.detailError || "loading..." })); return; }
    var sec = h("section", null, [h("h2", { text: g.id }), h("div", null, [chip(g.status), h("span", { text: "  " + g.outcome })])]);
    var tabs = h("div", { class: "tabs" }); ["overview", "gates", "timeline"].forEach(function (t) { tabs.appendChild(h("button", { class: t === state.tab ? "on" : "", text: t, onclick: function () { state.tab = t; render(); } })); });
    sec.appendChild(tabs);
    sec.appendChild(state.tab === "gates" ? gates(g) : state.tab === "timeline" ? timeline(g) : overview(g));
    view.appendChild(sec);
  }
  function render() {
    renderHeader(); renderInbox();
    var view = document.getElementById("view"); clear(view);
    if (state.goal) renderDetail(view); else renderList(view);
  }
  function loadDetail() {
    var id = state.goal; if (!id) return Promise.resolve();
    return get("/api/goals/" + encodeURIComponent(id)).then(function (b) { if (state.goal === id) { state.detail = JSON.parse(b); state.detailError = null; } }).catch(function (e) { if (state.goal === id) { state.detail = null; state.detailError = String(e.message); } }).then(render);
  }
  function loadOlder(before) {
    var id = state.goal;
    get("/api/goals/" + encodeURIComponent(id) + "?before=" + encodeURIComponent(before)).then(function (b) {
      var d = JSON.parse(b); state.timeline = (state.timeline.length ? state.timeline : state.detail.timeline.events).concat(d.timeline.events); state.nextBefore = d.timeline.nextBefore; render();
    }).catch(function (e) { state.detailError = String(e.message); render(); });
  }
  function poll() {
    if (document.hidden) return;
    get("/api/snapshot").then(function (b) { state.snap = JSON.parse(b); state.lastGood = state.snap.readAt; state.failed = false; })
      .catch(function () { state.failed = true; }).then(function () { render(); if (state.goal && !state.failed && state.tab !== "timeline") loadDetail(); });
  }
  window.addEventListener("hashchange", function () { var id = location.hash.slice(1); if (id !== (state.goal || "")) select(id || null); });
  document.addEventListener("visibilitychange", poll);
  state.goal = location.hash.slice(1) || null;
  poll(); setInterval(poll, 3000);
  if (state.goal) loadDetail();
})();
</script>
</body>
</html>
`;
