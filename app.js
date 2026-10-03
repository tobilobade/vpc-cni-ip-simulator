/* UI: story cards, animated subnet maps, plain-language results, and the settings panel. */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const { clock, hover } = KCharts;
  const { CAT, INSTANCES, maxPodsFor, ipString } = KCni;

  const STORY_LOOK = {
    'warm-eni': { emoji: '🟨', short: 'Servers hoard spare addresses until none are left.' },
    'max-pods': { emoji: '📦', short: 'Small servers can only fit a few pods, unless you use blocks of 16.' },
    'fragmented': { emoji: '🧩', short: 'Lots of free addresses, but no 16 in a row.' },
    'burst': { emoji: '🚀', short: 'Sudden rush of pods: are there enough spares ready?' },
    'bigger-subnet': { emoji: '📏', short: 'A small street vs a big street of addresses.' },
  };
  const SHAPES = {
    steady: { label: 'Always the same', defaults: { replicas: 20 }, params: [['replicas', 'pods']] },
    daily: { label: 'Busy by day', defaults: { min: 10, max: 100, peakHour: 6 }, params: [['min', 'min'], ['max', 'max'], ['peakHour', 'busiest at h']] },
    spiky: { label: 'Sudden rushes', defaults: { base: 10, peak: 100, everyMin: 30, forMin: 10 }, params: [['base', 'normal'], ['peak', 'rush'], ['everyMin', 'every min'], ['forMin', 'lasting min']] },
    step: { label: 'Jump at a time', defaults: { from: 20, to: 120, atHour: 1 }, params: [['from', 'from'], ['to', 'to'], ['atHour', 'at h']] },
  };
  const LOG_KINDS = [['all', 'All'], ['error', 'Errors'], ['waiting', 'Waiting pods'], ['eni', 'Network cards'], ['node', 'Servers']];
  const SNAPSHOT_EVERY = 600;
  const SAMPLE_EVERY = 60;

  let state;
  let results = null;
  let frame = 0;
  let playing = null;
  let logKind = 'all';
  let colors = null;

  // --- state ------------------------------------------------------------------

  function fromPreset(id) {
    const p = KCniPresets.find((x) => x.id === id) || KCniPresets[0];
    return { presetId: p.id, scenario: clone(p.scenario), a: clone(p.a), b: clone(p.b) };
  }
  function loadHash() {
    if (location.hash.length < 2) return null;
    try { return JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(1))))); } catch (e) { return null; }
  }
  function saveHash() { history.replaceState(null, '', '#' + btoa(unescape(encodeURIComponent(JSON.stringify(state))))); }
  function setPath(obj, path, v) { const k = path.split('.'); let o = obj; for (let i = 0; i < k.length - 1; i++) o = o[k[i]]; o[k[k.length - 1]] = v; }
  function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }

  // --- describing configs in plain words ----------------------------------------

  function spareText(c) {
    if (c.mode === 'prefix') {
      return (c.warmIpTarget || c.minIpTarget) ? `blocks of 16, ${c.warmIpTarget} spare address${c.warmIpTarget === 1 ? '' : 'es'}` : `blocks of 16, ${c.warmPrefixTarget} spare block`;
    }
    if (c.warmIpTarget || c.minIpTarget) {
      return `${c.warmIpTarget} spare address${c.warmIpTarget === 1 ? '' : 'es'}` + (c.minIpTarget ? `, at least ${c.minIpTarget}` : '');
    }
    return `a spare network card (default)`;
  }
  function describe(c) { return `/${c.subnetPrefix} subnet (${Math.pow(2, 32 - c.subnetPrefix).toLocaleString()} addresses) · ${c.instanceType} · ${spareText(c)}`; }
  // Name each side after what actually differs between A and B.
  function title(side) {
    const c = state[side], other = state[side === 'a' ? 'b' : 'a'];
    const diff = Object.keys(c).filter((k) => k !== 'side' && JSON.stringify(c[k]) !== JSON.stringify(other[k]));
    if (diff.length === 1 && diff[0] === 'subnetPrefix') return `/${c.subnetPrefix} subnet: ${Math.pow(2, 32 - c.subnetPrefix).toLocaleString()} addresses`;
    if (diff.length === 1 && diff[0] === 'instanceType') return `${c.instanceType} servers`;
    if (c.mode === 'prefix') return 'Blocks of 16 (prefix delegation)';
    if (c.warmIpTarget || c.minIpTarget) return `Only ${c.warmIpTarget} spare address${c.warmIpTarget === 1 ? '' : 'es'} per server`;
    return 'Default: a whole spare network card';
  }

  // --- rendering: picker + settings ---------------------------------------------

  function renderStories() {
    $('#stories').innerHTML = KCniPresets.map((p) => {
      const look = STORY_LOOK[p.id] || { emoji: '✨', short: '' };
      return `<button type="button" class="story-card" data-story="${p.id}" aria-pressed="${p.id === state.presetId}">
        <span class="emoji">${look.emoji}</span><b>${esc(p.name)}</b><small>${esc(look.short)}</small></button>`;
    }).join('');
    const p = KCniPresets.find((x) => x.id === state.presetId);
    $('#story-text').textContent = p ? p.description : 'Your own setup.';
  }

  const help = (id, label) => `<button type="button" class="help" data-term="${id}" aria-label="Explain ${label || id}">?</button>`;
  const num = (path, cls) => `<input type="number" min="0" class="${cls || 'narrow'}" data-path="${path}" data-type="number" value="${esc(getPath(state, path))}">`;

  function renderConfig(side) {
    const c = state[side];
    const opt = (v, cur, label) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${label}</option>`;
    const subnetOpts = [];
    for (let p = 18; p <= 28; p++) subnetOpts.push(opt(p, c.subnetPrefix, `/${p} · ${Math.pow(2, 32 - p).toLocaleString()} addresses`));
    const typeOpts = INSTANCES.map((t) => opt(t.name, c.instanceType, `${t.name} · up to ${maxPodsFor(t, c.mode)} pods`)).join('');
    const ipTargets = c.warmIpTarget > 0 || c.minIpTarget > 0;
    const env = [`ENABLE_PREFIX_DELEGATION=${c.mode === 'prefix'}`];
    if (ipTargets) { env.push(`WARM_IP_TARGET=${c.warmIpTarget}`); if (c.minIpTarget) env.push(`MINIMUM_IP_TARGET=${c.minIpTarget}`); }
    else if (c.mode === 'prefix') env.push(`WARM_PREFIX_TARGET=${c.warmPrefixTarget}`);
    else env.push(`WARM_ENI_TARGET=${c.warmEniTarget}`);
    $('#config-' + side).innerHTML = `
      <h3><span class="tag ${side}">${side.toUpperCase()}</span> Settings</h3>
      <div class="fields">
        <label class="field"><span>Subnet size ${help('subnet', 'subnet')}</span>
          <select data-path="${side}.subnetPrefix" data-type="number">${subnetOpts.join('')}</select></label>
        <label class="field"><span>Server type ${help('eni', 'server type')}</span>
          <select data-path="${side}.instanceType">${typeOpts}</select></label>
        <label class="field"><span>How addresses are given ${help('prefix', 'prefix delegation')}</span>
          <select data-path="${side}.mode" data-rerender="1">
            ${opt('secondary', c.mode, 'One at a time (secondary IPs)')}${opt('prefix', c.mode, 'Blocks of 16 (prefix delegation)')}
          </select></label>
        <label class="field"><span>Minimum servers ${help('node', 'servers')}</span>${num(side + '.minNodes')}</label>
        <label class="field"><span>WARM_IP_TARGET ${help('warmIp', 'WARM_IP_TARGET')}</span>${num(side + '.warmIpTarget')}<span class="hint">0 = not set</span></label>
        <label class="field"><span>MINIMUM_IP_TARGET ${help('minIp', 'MINIMUM_IP_TARGET')}</span>${num(side + '.minIpTarget')}<span class="hint">0 = not set</span></label>
        ${c.mode === 'prefix'
          ? `<label class="field"><span>WARM_PREFIX_TARGET ${help('warmPrefix', 'WARM_PREFIX_TARGET')}</span>${num(side + '.warmPrefixTarget')}<span class="hint">${ipTargets ? 'ignored while an IP target is set' : 'spare blocks of 16'}</span></label>`
          : `<label class="field"><span>WARM_ENI_TARGET ${help('warmEni', 'WARM_ENI_TARGET')}</span>${num(side + '.warmEniTarget')}<span class="hint">${ipTargets ? 'ignored while an IP target is set' : 'spare network cards'}</span></label>`}
      </div>
      <pre class="env">kubectl set env daemonset aws-node -n kube-system \\\n  ${env.join(' ')}</pre>`;
  }

  function renderWorkloads() {
    const rows = state.scenario.workloads.map((w, i) => {
      const p = `scenario.workloads.${i}`, shape = SHAPES[w.shape.type];
      return `<tr>
        <td><input type="text" data-path="${p}.name" value="${esc(w.name)}" style="width:100px"></td>
        <td>${num(p + '.cpu')}</td><td>${num(p + '.mem')}</td>
        <td><select data-action="shape-type" data-i="${i}">${Object.keys(SHAPES).map((k) => `<option value="${k}"${k === w.shape.type ? ' selected' : ''}>${SHAPES[k].label}</option>`).join('')}</select>
          <span class="shape-params">${shape.params.map(([k, l]) => `${l} ${num(p + '.shape.' + k)}`).join(' ')}</span></td>
        <td><select data-path="${p}.onlyIn" data-type="opt">
          <option value=""${!w.onlyIn ? ' selected' : ''}>A and B</option><option value="a"${w.onlyIn === 'a' ? ' selected' : ''}>A only</option><option value="b"${w.onlyIn === 'b' ? ' selected' : ''}>B only</option></select></td>
        <td><button type="button" class="link" data-action="remove-workload" data-i="${i}">remove</button></td></tr>`;
    }).join('');
    $('#workloads').innerHTML = `<tr><th>App</th><th>CPU (m)</th><th>Memory (Mi)</th><th>Number of pods over the day ${help('pod', 'pods')}</th><th>Runs in</th><th></th></tr>${rows}`;
  }

  function bindStatic() {
    document.querySelectorAll('#settings > .row [data-path]').forEach((el) => { el.value = getPath(state, el.dataset.path); });
  }

  function renderInputs() {
    renderStories();
    renderConfig('a');
    renderConfig('b');
    renderWorkloads();
    bindStatic();
  }

  // `commit` is true for change events (select picked, number box left): only then is the
  // settings card redrawn, so typing never loses focus.
  function onInput(e, commit) {
    const el = e.target, path = el.dataset.path;
    if (!path) return;
    let v;
    if (el.dataset.type === 'number') {
      if (el.value === '' || isNaN(Number(el.value)) || Number(el.value) < 0) { el.classList.add('invalid'); return; }
      el.classList.remove('invalid');
      v = Number(el.value);
    } else if (el.dataset.type === 'opt') v = el.value || null;
    else v = el.value;
    if (getPath(state, path) === v && !commit) return;
    setPath(state, path, v);
    if (commit && (path[0] === 'a' || path[0] === 'b')) renderConfig(path[0]);
    scheduleRun();
  }

  function onAction(el) {
    const i = Number(el.dataset.i), wls = state.scenario.workloads;
    if (el.dataset.action === 'shape-type') wls[i].shape = Object.assign({ type: el.value }, SHAPES[el.value].defaults);
    else if (el.dataset.action === 'remove-workload') wls.splice(i, 1);
    else return;
    renderWorkloads();
    scheduleRun();
  }

  // --- simulation ---------------------------------------------------------------

  let workers = null, runId = 0, busy = false, runTimer = null;
  function scheduleRun() { clearTimeout(runTimer); runTimer = setTimeout(run, 300); }
  function getWorkers() {
    if (workers === null) { try { workers = [new Worker('worker.js'), new Worker('worker.js')]; } catch (e) { workers = false; } }
    return workers;
  }
  function setBusy(on) { busy = on; $('#busy').style.display = on ? 'block' : 'none'; }
  function showError(msg) { const el = $('#error'); el.hidden = !msg; el.textContent = msg ? '⚠️ ' + msg : ''; }

  function runInline() {
    try {
      finish(KCni.simulate(Object.assign({ side: 'a' }, state.a), state.scenario), KCni.simulate(Object.assign({ side: 'b' }, state.b), state.scenario));
    } catch (e) { setBusy(false); showError(e.message); }
  }

  function run() {
    if (document.querySelector('input.invalid')) return showError('Please fix the highlighted boxes.');
    if (busy && workers) { workers.forEach((w) => w.terminate()); workers = null; }
    const ws = getWorkers(), id = ++runId;
    setBusy(true);
    if (!ws) return setTimeout(runInline, 20);
    const out = {};
    let done = 0, error = null;
    ['a', 'b'].forEach((side, i) => {
      ws[i].onmessage = (e) => {
        if (e.data.id !== id) return;
        if (e.data.error) error = e.data.error; else out[side] = e.data.result;
        if (++done < 2) return;
        if (error) { setBusy(false); showError(error); } else finish(out.a, out.b);
      };
      ws[i].onerror = (e) => { e.preventDefault(); ws.forEach((w) => w.terminate()); workers = false; runInline(); };
      ws[i].postMessage({ id, cfg: Object.assign({ side }, state[side]), scenario: state.scenario });
    });
  }

  function finish(a, b) {
    setBusy(false);
    showError(null);
    results = { a, b };
    stop();
    frames = Math.min(a.snapshots.length, b.snapshots.length);
    $('#scrub').max = frames - 1;
    renderSides();
    renderStory();
    renderCharts();
    renderLogs();
    setFrame(busiestFrame());
    saveHash();
  }

  // --- the animated maps --------------------------------------------------------

  let frames = 0;

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    colors = [];
    colors[CAT.FREE] = v('--c-free'); colors[CAT.RESERVED] = v('--c-reserved'); colors[CAT.OTHER] = v('--c-other');
    colors[CAT.SYSTEM] = v('--c-server'); colors[CAT.POD] = v('--c-pod'); colors[CAT.IDLE] = v('--c-spare');
  }

  const CAT_TEXT = ['free', 'kept by AWS', 'used by something else', "a server's own address", 'used by a pod', 'spare, kept for later'];

  function renderLegend() {
    $('#map-legend').innerHTML = [
      ['pod', 'Used by a pod', 'ip'], ['spare', 'Spare, kept for later', 'spare'], ['server', "Server's own address", 'eni'],
      ['other', 'Used by other things', 'other'], ['reserved', 'Kept by AWS', 'reserved'], ['free', 'Free', 'subnet'],
    ].map(([cls, label, term]) => `<span><i class="sq ${cls}"></i>${label} ${help(term, label)}</span>`).join('');
  }

  function renderSides() {
    for (const side of ['a', 'b']) {
      $('#side-' + side).innerHTML = `
        <div class="side-head"><h3><span class="tag ${side}">${side.toUpperCase()}</span> ${esc(title(side))}</h3>
          <span class="what">${esc(describe(state[side]))}</span></div>
        <div class="status" id="status-${side}"></div>
        <div class="map-wrap"><canvas id="map-${side}" role="img" aria-label="Map of every address in the subnet for ${side.toUpperCase()}"></canvas></div>
        <div class="meter" id="meter-${side}"></div>
        <div class="stats" id="stats-${side}"></div>`;
      const canvas = $('#map-' + side);
      canvas.addEventListener('mousemove', (e) => mapTip(e, side));
      canvas.addEventListener('mouseleave', () => { $('#map-tip').style.display = 'none'; });
    }
  }

  function layout(size) {
    const cols = size <= 256 ? 16 : size <= 1024 ? 32 : size <= 4096 ? 64 : 128;
    return { cols, rows: Math.ceil(size / cols) };
  }

  function drawMap(side) {
    const r = results[side], snap = r.snapshots[Math.min(frame, r.snapshots.length - 1)];
    const canvas = $('#map-' + side);
    if (!canvas || !snap) return;
    const { cols, rows } = layout(snap.cells.length);
    const width = canvas.parentElement.clientWidth - 16;
    const cell = width / cols;
    const height = Math.min(cell * rows, 520);
    const ch = height / rows;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const gap = cell >= 8 ? 2 : cell >= 4 ? 1 : 0;
    for (let i = 0; i < snap.cells.length; i++) {
      ctx.fillStyle = colors[snap.cells[i]];
      const x = (i % cols) * cell, y = Math.floor(i / cols) * ch;
      ctx.fillRect(x, y, Math.max(0.5, cell - gap), Math.max(0.5, ch - gap));
    }
    canvas.dataset.cols = cols;
    canvas.dataset.rows = rows;
  }

  function mapTip(e, side) {
    if (!results) return;
    const canvas = e.currentTarget, rect = canvas.getBoundingClientRect();
    const cols = Number(canvas.dataset.cols), rows = Number(canvas.dataset.rows);
    const col = Math.floor(((e.clientX - rect.left) / rect.width) * cols), row = Math.floor(((e.clientY - rect.top) / rect.height) * rows);
    const snap = results[side].snapshots[Math.min(frame, results[side].snapshots.length - 1)];
    const i = row * cols + col;
    const tip = $('#map-tip');
    if (i < 0 || i >= snap.cells.length) { tip.style.display = 'none'; return; }
    tip.innerHTML = `<b>${ipString(i)}</b>: ${CAT_TEXT[snap.cells[i]]}`;
    tip.style.display = 'block';
    tip.style.left = e.clientX + 14 + 'px';
    tip.style.top = e.clientY + 14 + 'px';
  }

  function sampleAt(r, t) { return r.samples[Math.min(r.samples.length - 1, Math.round(t / SAMPLE_EVERY))]; }

  function drawStats(side) {
    const r = results[side], t = frame * SNAPSHOT_EVERY, s = sampleAt(r, t);
    const waiting = s.waiting + s.pending;
    let status;
    if (s.waiting > 0) status = `😟 ${s.waiting} pod${s.waiting === 1 ? ' is' : 's are'} waiting for an address`;
    else if (s.pending > 0) status = `😟 ${s.pending} pod${s.pending === 1 ? ' is' : 's are'} waiting for a server`;
    else if (s.free === 0) status = '😬 The subnet is full!';
    else status = '😀 Every pod has an address';
    if (s.waiting > 0 && s.pending > 0) status += ` (+${s.pending} waiting for a server)`;
    $('#status-' + side).textContent = status;
    const size = r.subnet.size, reserved = size - r.subnet.usable;
    const other = s.used - s.podIps - s.idle - s.system;
    const seg = (n, v) => `<i style="width:${(100 * n) / size}%;background:var(${v})" title="${n}"></i>`;
    $('#meter-' + side).innerHTML = seg(s.podIps, '--c-pod') + seg(s.idle, '--c-spare') + seg(s.system, '--c-server') + seg(other, '--c-other') + seg(reserved, '--c-reserved');
    const tile = (v, label, color, term) => `<div class="stat"><div class="v">${v.toLocaleString()}</div><div class="l">${color ? `<i style="background:var(${color})"></i>` : ''}${label} ${help(term, label)}</div></div>`;
    $('#stats-' + side).innerHTML =
      tile(s.podIps, 'pods with an address', '--c-pod', 'ip') + tile(s.idle, 'spare addresses', '--c-spare', 'spare') +
      tile(s.free, 'free addresses', '--c-free', 'subnet') + tile(waiting, 'pods waiting', null, 'waiting');
  }

  function setFrame(i, fromHover) {
    if (!results) return;
    frame = Math.max(0, Math.min(frames - 1, i));
    $('#scrub').value = frame;
    $('#clock').textContent = clock(frame * SNAPSHOT_EVERY);
    for (const side of ['a', 'b']) { drawMap(side); drawStats(side); }
    if (!fromHover) { syncing = true; hover.set(frame * SNAPSHOT_EVERY, true); syncing = false; }
  }

  function busiestFrame() {
    let best = 0, bestV = -1;
    const n = Math.min(results.a.samples.length, results.b.samples.length);
    for (let i = 0; i < n; i += SNAPSHOT_EVERY / SAMPLE_EVERY) {
      const v = results.a.samples[i].used + results.b.samples[i].used;
      if (v > bestV) { bestV = v; best = i / (SNAPSHOT_EVERY / SAMPLE_EVERY); }
    }
    return best;
  }

  function play() {
    if (playing) return stop();
    if (frame >= frames - 1) setFrame(0);
    $('#play').textContent = '❚❚';
    $('#play').setAttribute('aria-label', 'Pause');
    playing = setInterval(() => { if (frame >= frames - 1) stop(); else setFrame(frame + 1); }, 140);
  }
  function stop() {
    clearInterval(playing);
    playing = null;
    $('#play').textContent = '▶';
    $('#play').setAttribute('aria-label', 'Play');
  }

  // --- plain-language story -----------------------------------------------------

  const int = (x) => Math.round(x).toLocaleString();
  function dur(min) {
    if (min < 60) return `${int(min)} minute${Math.round(min) === 1 ? '' : 's'}`;
    const h = min / 60;
    return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : int(h)} hour${h === 1 ? '' : 's'}`;
  }
  const waitMinutes = (r) => r.summary.waitingPodMinutes + r.summary.pendingPodMinutes;

  function storyFor(r) {
    const S = r.summary, items = [];
    const full = r.samples.find((x) => x.free === 0);
    if (full) items.push(`😬 At <b>${clock(full.t)}</b> the subnet ran out of addresses. It was full for ${dur(S.subnetFullMinutes)} in total.`);
    else items.push(`✅ The subnet never filled up. At the busiest moment, ${Math.round(S.peakUsedPct * 100)}% of the addresses were taken.`);
    if (S.launchBlockedMinutes > 0) items.push(`🚫 New servers couldn't start for ${dur(S.launchBlockedMinutes)}, because a server needs an address for itself.`);
    if (S.prefixBlockedMinutes > 0) items.push(`🧩 For ${dur(S.prefixBlockedMinutes)} there was no free block of 16 addresses in a row, even with free addresses around.`);
    const peak = Math.max(...r.samples.filter((x) => x.t >= 300).map((x) => x.waiting + x.pending));
    if (waitMinutes(r) > 30) items.push(`⏳ Up to <b>${int(peak)} pods</b> were waiting at the same time (${int(waitMinutes(r))} pod-minutes of waiting).`);
    else items.push('🎉 Pods (almost) never had to wait.');
    items.push(`🟨 On average <b>${int(S.avgIdle)}</b> addresses sat around as spares: held by servers, but not used by any pod.`);
    items.push(`🖥️ Up to ${S.peakNodes} servers (${r.type.name}, up to ${S.maxPods} pods each), costing about $${S.totalCost.toFixed(2)}.`);
    return items;
  }

  function renderStory() {
    const { a, b } = results;
    for (const side of ['a', 'b']) {
      $('#title-' + side).textContent = title(side);
      $('#story-' + side).innerHTML = storyFor(results[side]).map((x) => `<li>${x}</li>`).join('');
    }
    const wa = waitMinutes(a), wb = waitMinutes(b);
    let v = '';
    if (Math.max(wa, wb) > 30 && Math.abs(wa - wb) > 0.1 * Math.max(wa, wb)) {
      const better = wa < wb ? 'A' : 'B', worse = wa < wb ? wb : wa, best = Math.min(wa, wb);
      v = `🏆 ${better} wins: its pods waited ${Math.min(99, Math.round((1 - best / worse) * 100))}% less (${int(best)} vs ${int(worse)} pod-minutes).`;
    }
    const ca = a.summary.totalCost, cb = b.summary.totalCost;
    const bothHappy = !v;
    if (bothHappy && Math.abs(ca - cb) / Math.max(ca, cb) > 0.2) {
      const cheap = ca < cb ? 'A' : 'B', na = a.summary.peakNodes, nb = b.summary.peakNodes;
      v = `🤝 Both keep pods happy, but ${cheap} needs fewer servers (${Math.min(na, nb)} vs ${Math.max(na, nb)}) and is ${Math.round((1 - Math.min(ca, cb) / Math.max(ca, cb)) * 100)}% cheaper.`;
    } else if (bothHappy) {
      const better = a.summary.avgIdle < b.summary.avgIdle ? 'A' : 'B';
      v = `🤝 Both keep pods happy. ${better} holds fewer spare addresses (${int(Math.min(a.summary.avgIdle, b.summary.avgIdle))} vs ${int(Math.max(a.summary.avgIdle, b.summary.avgIdle))}), leaving more room to grow.`;
    } else if (Math.abs(ca - cb) / Math.max(ca, cb) > 0.1) {
      const cheap = ca < cb ? 'A' : 'B', pct = Math.round((1 - Math.min(ca, cb) / Math.max(ca, cb)) * 100);
      const cheapWaitedMore = (cheap === 'A' ? wa > wb * 2 : wb > wa * 2) && Math.max(wa, wb) > 30;
      v += cheapWaitedMore ? ` ${cheap} looks ${pct}% cheaper, but only because many of its pods never got to run.` : ` ${cheap} is also ${pct}% cheaper.`;
    }
    $('#verdict').textContent = v;
  }

  // --- charts + log -------------------------------------------------------------

  let syncing = false;
  function renderCharts() {
    if (!results) return;
    const { a, b } = results;
    const duration = state.scenario.durationHours;
    const series = (get) => [{ label: 'A', cls: 'a', values: a.samples.map(get) }, { label: 'B', cls: 'b', values: b.samples.map(get) }];
    const base = { duration, sampleEvery: SAMPLE_EVERY, height: 160 };
    hover.clear();
    hover.pinned = false;
    const n = (v) => Math.round(v).toLocaleString();
    KCharts.lineChart($('#chart-waiting'), Object.assign({}, base, { title: '⏳ Pods waiting (for an address or a server)', series: series((s) => s.waiting + s.pending), minMax: 1, yFormat: n, tipFormat: n }));
    KCharts.lineChart($('#chart-free'), Object.assign({}, base, { title: '⬜ Free addresses left in the subnet', series: series((s) => s.free), minMax: 1, yFormat: n, tipFormat: n }));
    KCharts.lineChart($('#chart-spare'), Object.assign({}, base, { title: '🟨 Spare addresses held by servers', series: series((s) => s.idle), minMax: 1, yFormat: n, tipFormat: n }));
    KCharts.lineChart($('#chart-servers'), Object.assign({}, base, { title: '🖥️ Servers running', series: series((s) => s.nodes), minMax: 1, yFormat: n, tipFormat: n }));
    hover.subs.add((t) => { if (t !== null && !syncing) setFrame(Math.round(t / SNAPSHOT_EVERY), true); });
  }

  function renderLogs() {
    $('#filters').innerHTML = LOG_KINDS.map(([k, l]) => `<button type="button" class="chip" data-kind="${k}" aria-pressed="${k === logKind}">${l}</button>`).join('');
    for (const side of ['a', 'b']) {
      const entries = results[side].log.filter((l) => logKind === 'all' || l.kind === logKind || (logKind === 'error' && l.kind === 'warn'));
      const shown = entries.slice(0, 1500);
      $('#log-' + side).innerHTML = (shown.map((l) => `<div data-t="${l.t}"><span class="t">${clock(l.t, true)}</span><span class="k">${l.kind}</span><span>${esc(l.msg)}</span></div>`).join('') ||
        '<div class="empty">Nothing here.</div>') + (entries.length > shown.length ? `<div class="empty">… ${entries.length - shown.length} more</div>` : '');
    }
  }

  // --- glossary -----------------------------------------------------------------

  function renderGlossary(query) {
    const q = query.trim().toLowerCase();
    $('#glossary-body').innerHTML = KCniGlossary.map((g) => {
      const terms = g.terms.filter((t) => !q || (t.term + ' ' + t.body).toLowerCase().includes(q));
      return terms.length ? `<h3>${g.group}</h3>` + terms.map((t) => `<dl id="term-${t.id}"><dt>${t.term}</dt><dd>${t.body}</dd>${t.example ? `<dd class="example">${t.example}</dd>` : ''}</dl>`).join('') : '';
    }).join('') || '<p class="muted">No matching words.</p>';
  }
  function openGlossary(id) {
    const wasOpen = document.body.classList.contains('glossary-open');
    if (!id && wasOpen) return closeGlossary();
    document.body.classList.add('glossary-open');
    $('#glossary').setAttribute('aria-hidden', 'false');
    if (!wasOpen) setTimeout(redraw, 260);
    if (!id) return;
    if ($('#glossary-search').value) { $('#glossary-search').value = ''; renderGlossary(''); }
    const el = document.getElementById('term-' + id);
    if (!el) return;
    $('#glossary').scrollTo({ top: el.offsetTop - $('.g-sticky').offsetHeight - 8, behavior: wasOpen ? 'smooth' : 'auto' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }
  function closeGlossary() {
    if (!document.body.classList.contains('glossary-open')) return;
    document.body.classList.remove('glossary-open');
    $('#glossary').setAttribute('aria-hidden', 'true');
    setTimeout(redraw, 260);
  }
  function redraw() { if (results) { renderCharts(); setFrame(frame); } }

  // --- wiring -------------------------------------------------------------------

  function init() {
    readColors();
    state = loadHash() || fromPreset(KCniPresets[0].id);
    renderLegend();
    renderInputs();
    renderGlossary('');

    document.addEventListener('input', (e) => {
      if (e.target.id === 'scrub') { stop(); setFrame(Number(e.target.value)); return; }
      if (e.target.tagName !== 'SELECT') onInput(e, false);
    });
    document.addEventListener('change', (e) => {
      if (e.target.dataset.action) return onAction(e.target);
      if (e.target.dataset.path) onInput(e, true);
    });
    document.addEventListener('click', (e) => {
      const term = e.target.closest('[data-term]');
      if (term) { e.preventDefault(); openGlossary(term.dataset.term); return; }
      const story = e.target.closest('[data-story]');
      if (story) { state = fromPreset(story.dataset.story); renderInputs(); run(); return; }
      if (e.target.closest('button[data-action]')) onAction(e.target.closest('button[data-action]'));
      const chip = e.target.closest('.chip');
      if (chip) { logKind = chip.dataset.kind; renderLogs(); }
      const line = e.target.closest('.log div[data-t]');
      if (line) { stop(); setFrame(Math.round(Number(line.dataset.t) / SNAPSHOT_EVERY)); $('#play').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    });
    $('#play').addEventListener('click', play);
    $('#toggle-settings').addEventListener('click', (e) => {
      const s = $('#settings');
      s.hidden = !s.hidden;
      e.target.setAttribute('aria-expanded', String(!s.hidden));
      e.target.textContent = s.hidden ? '⚙️ Change the settings' : '⚙️ Hide the settings';
    });
    $('#add-workload').addEventListener('click', () => {
      state.scenario.workloads.push({ name: 'app-' + (state.scenario.workloads.length + 1), cpu: 250, mem: 512, shape: { type: 'steady', replicas: 20 } });
      renderWorkloads();
      scheduleRun();
    });
    $('#copy-link').addEventListener('click', (e) => {
      saveHash();
      navigator.clipboard.writeText(location.href).then(() => { e.target.textContent = '✅ Link copied'; setTimeout(() => { e.target.textContent = '🔗 Share'; }, 1500); });
    });
    $('#glossary-close').addEventListener('click', closeGlossary);
    $('#glossary-search').addEventListener('input', (e) => renderGlossary(e.target.value));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGlossary(); });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColors(); redraw(); });
    let rt = null;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(redraw, 150); });
    run();
  }

  init();
})();
