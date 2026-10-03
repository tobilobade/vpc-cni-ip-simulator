/*
 * VPC CNI IP simulator — engine.
 *
 * A discrete-time model of how the Amazon VPC CNI (aws-node / ipamd) hands out subnet IPs
 * to EKS nodes and pods. Pure logic, no DOM: runs in the browser, a Web Worker, or `jsc`.
 *
 * Each tick (5s):
 *   1. workloads reconcile to their desired replica count (deleted pods' IPs cool down 30s)
 *   2. launching nodes become Ready; pods nominated to them start waiting for an IP
 *   3. kube-scheduler binds pending pods (respecting max pods); the autoscaler launches
 *      nodes for the rest — each launch needs a free subnet IP for the node itself
 *   4. ipamd on every node tops up / trims its warm pool of IPs (or /28 prefixes)
 *   5. pods waiting on a node get an IP if one is ready
 *   6. empty nodes are scaled down after 10 minutes; metrics are recorded
 */
(function (root) {
  'use strict';

  const STEP = 5;
  const NODE_STARTUP = 60;       // launch -> Ready
  const IP_ASSIGN_DELAY = 5;     // AssignPrivateIpAddresses round trip
  const ENI_ATTACH_DELAY = 15;   // Create + AttachNetworkInterface
  const IP_COOLDOWN = 30;        // ipamd IP_COOLDOWN_PERIOD default
  const SCALE_DOWN_AFTER = 600;  // cluster-autoscaler scale-down-unneeded-time default
  const SAMPLE_EVERY = 60;
  const SNAPSHOT_EVERY = 600;
  const MAX_LOG = 20000;
  const NOTE_COOLDOWN = 1800;
  const PREFIX_SIZE = 16;        // prefix delegation hands out /28 blocks
  const AWS_RESERVED = 5;        // first 4 and last address of every subnet
  const VM_MEMORY_OVERHEAD = 0.075;
  const HOST_NETWORK_PODS = 2;
  const WARMUP = 300;

  // ENI limits from the EC2 docs (max ENIs, IPv4 addresses per ENI). Prices: us-east-1 on-demand.
  const INSTANCES = [
    { name: 't3.medium', cpu: 2, mem: 4, enis: 3, ips: 6, price: 0.0416 },
    { name: 't3.large', cpu: 2, mem: 8, enis: 3, ips: 12, price: 0.0832 },
    { name: 'm5.large', cpu: 2, mem: 8, enis: 3, ips: 10, price: 0.096 },
    { name: 'm5.xlarge', cpu: 4, mem: 16, enis: 4, ips: 15, price: 0.192 },
    { name: 'm5.2xlarge', cpu: 8, mem: 32, enis: 4, ips: 15, price: 0.384 },
    { name: 'm5.4xlarge', cpu: 16, mem: 64, enis: 8, ips: 30, price: 0.768 },
    { name: 'm5.8xlarge', cpu: 32, mem: 128, enis: 8, ips: 30, price: 1.536 },
  ];

  // Subnet map categories.
  const CAT = { FREE: 0, RESERVED: 1, OTHER: 2, SYSTEM: 3, POD: 4, IDLE: 5 };
  // Subnet address states.
  const S_FREE = 0, S_RESERVED = 1, S_OTHER = 2, S_PRIMARY = 3, S_POD_SLOT = 4;

  // Max pods per node as EKS computes it. Secondary IPs: one IP per pod, minus each ENI's
  // primary, +2 for host-network pods (aws-node, kube-proxy). Prefix mode: capped at 110 / 250.
  function maxPodsFor(t, mode) {
    const secondary = t.enis * (t.ips - 1) + 2;
    if (mode !== 'prefix') return secondary;
    return Math.min(t.cpu >= 30 ? 250 : 110, t.enis * (t.ips - 1) * PREFIX_SIZE + 2);
  }

  function kubeReservedCpu(cores) {
    let m = 60;
    if (cores > 1) m += 10;
    if (cores > 2) m += 5 * Math.min(cores - 2, 2);
    if (cores > 4) m += 2.5 * (cores - 4);
    return m;
  }

  function desiredReplicas(shape, t) {
    const h = t / 3600;
    switch (shape.type) {
      case 'steady': return shape.replicas;
      case 'daily': {
        const f = (1 + Math.cos((2 * Math.PI * (h - shape.peakHour)) / 24)) / 2;
        return Math.round(shape.min + (shape.max - shape.min) * f);
      }
      case 'spiky': return (t / 60) % shape.everyMin < shape.forMin ? shape.peak : shape.base;
      case 'step': return h < shape.atHour ? shape.from : shape.to;
      default: throw new Error('unknown shape ' + shape.type);
    }
  }

  // Small deterministic PRNG so A and B see the same "other" addresses and runs repeat exactly.
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function bySizeDesc(a, b) { return b.cpu - a.cpu || b.mem - a.mem || a.id - b.id; }

  // ---------------------------------------------------------------------------

  // EC2 picks free addresses from the subnet; we pick pseudo-randomly, which also produces
  // the fragmentation that makes /28 prefixes hard to find in a busy subnet.
  function Subnet(prefixLen, otherUsed, rand) {
    this.prefixLen = prefixLen;
    this.size = Math.pow(2, 32 - prefixLen);
    this.state = new Uint8Array(this.size);
    for (const i of [0, 1, 2, 3, this.size - 1]) this.state[i] = S_RESERVED;
    this.usable = this.size - AWS_RESERVED;
    this.free = this.usable;
    this.rand = rand;
    let n = Math.min(otherUsed || 0, this.free);
    while (n > 0) {
      const i = Math.floor(rand() * this.size);
      if (this.state[i] === S_FREE) { this.state[i] = S_OTHER; this.free--; n--; }
    }
  }

  Subnet.prototype.allocIp = function (kind) {
    if (!this.free) return -1;
    let i = Math.floor(this.rand() * this.size);
    while (this.state[i] !== S_FREE) i = (i + 1) % this.size;
    this.state[i] = kind;
    this.free--;
    return i;
  };

  Subnet.prototype.allocPrefix = function () {
    const blocks = this.size / PREFIX_SIZE;
    const start = Math.floor(this.rand() * blocks);
    for (let k = 0; k < blocks; k++) {
      const base = ((start + k) % blocks) * PREFIX_SIZE;
      let ok = true;
      for (let j = 0; j < PREFIX_SIZE; j++) if (this.state[base + j] !== S_FREE) { ok = false; break; }
      if (!ok) continue;
      for (let j = 0; j < PREFIX_SIZE; j++) this.state[base + j] = S_POD_SLOT;
      this.free -= PREFIX_SIZE;
      return base;
    }
    return -1;
  };

  Subnet.prototype.release = function (i) {
    this.state[i] = S_FREE;
    this.free++;
  };

  Subnet.prototype.freeBlocks = function () {
    let n = 0;
    for (let base = 0; base < this.size; base += PREFIX_SIZE) {
      let ok = true;
      for (let j = 0; j < PREFIX_SIZE; j++) if (this.state[base + j] !== S_FREE) { ok = false; break; }
      if (ok) n++;
    }
    return n;
  };

  function ipString(i) { return `10.0.${Math.floor(i / 256)}.${i % 256}`; }

  // ---------------------------------------------------------------------------

  function normalize(cfg) {
    const c = Object.assign({
      subnetPrefix: 24, instanceType: 'm5.xlarge', mode: 'secondary',
      warmEniTarget: 1, warmIpTarget: 0, minIpTarget: 0, warmPrefixTarget: 1, minNodes: 2, maxNodes: 1000,
    }, cfg);
    for (const k of ['subnetPrefix', 'warmEniTarget', 'warmIpTarget', 'minIpTarget', 'warmPrefixTarget', 'minNodes', 'maxNodes']) {
      c[k] = Math.max(0, Math.floor(Number(c[k]) || 0));
    }
    if (c.subnetPrefix < 16 || c.subnetPrefix > 28) throw new Error('subnet size must be between /16 and /28');
    c.usesIpTargets = c.warmIpTarget > 0 || c.minIpTarget > 0;
    // With no IP targets, a warm ENI / prefix target of 0 would mean pods never get IPs.
    if (!c.usesIpTargets) { c.warmEniTarget = Math.max(1, c.warmEniTarget); c.warmPrefixTarget = Math.max(1, c.warmPrefixTarget); }
    return c;
  }

  function Sim(config, scenario) {
    this.cfg = normalize(config);
    this.sc = scenario;
    const type = INSTANCES.find((t) => t.name === this.cfg.instanceType);
    if (!type) throw new Error('unknown instance type ' + this.cfg.instanceType);
    this.type = type;
    this.maxPods = maxPodsFor(type, this.cfg.mode);
    this.podSlots = this.maxPods - HOST_NETWORK_PODS; // aws-node + kube-proxy use the node's own IP
    const ds = scenario.daemonset || { cpu: 150, mem: 200 };
    this.allocCpu = type.cpu * 1000 - kubeReservedCpu(type.cpu) - ds.cpu;
    this.allocMem = Math.floor(type.mem * 1024 * (1 - VM_MEMORY_OVERHEAD)) - (255 + 11 * this.maxPods) - 100 - ds.mem;
    this.rand = mulberry32(scenario.seed || 7);
    this.subnet = new Subnet(this.cfg.subnetPrefix, scenario.otherIps || 0, this.rand);
    this.t = 0;
    this.nodes = [];
    this.live = [];
    this.nodeById = new Map();
    this.pods = new Map();
    this.wls = scenario.workloads
      .filter((w) => !w.onlyIn || !config.side || w.onlyIn === config.side)
      .map((w, i) => Object.assign({}, w, { idx: i, pods: new Set() }));
    this.nextPodId = 1;
    this.nextNodeId = 1;
    this.nextEniId = 1;
    this.log = [];
    this.notes = new Map();
    this.samples = [];
    this.snapshots = [];
    this.counts = { pending: 0, nominated: 0, creating: 0, running: 0 };
    this.stats = { cost: 0, waitingPodSeconds: 0, pendingPodSeconds: 0, launchFailures: 0, ipErrors: 0, prefixErrors: 0, enisAttached: 0, nodesLaunched: 0,
      launchBlockedSeconds: 0, prefixBlockedSeconds: 0 };
    this.blocked = { launch: false, prefix: false };
  }

  Sim.prototype.emit = function (kind, msg) {
    if (this.log.length < MAX_LOG) this.log.push({ t: this.t, kind, msg });
  };

  Sim.prototype.note = function (key, kind, msg) {
    if (!msg) return;
    const prev = this.notes.get(key);
    if (prev && prev.msg === msg && this.t - prev.t < NOTE_COOLDOWN) return;
    this.notes.set(key, { msg, t: this.t });
    this.emit(kind, msg);
  };

  Sim.prototype.run = function () {
    const end = this.sc.durationHours * 3600;
    for (let i = 0; i < this.cfg.minNodes; i++) this.launchNode();
    for (this.t = 0; this.t <= end; this.t += STEP) this.tick();
    return this.result();
  };

  Sim.prototype.tick = function () {
    this.reconcileWorkloads();
    this.progressNodes();
    this.schedule();
    for (const n of this.live) if (n.state === 'ready') this.ipamd(n);
    this.assignIps();
    this.scaleDown();
    this.account();
  };

  // --- pods -------------------------------------------------------------------

  Sim.prototype.setState = function (p, state) {
    this.counts[p.state]--;
    p.state = state;
    this.counts[state]++;
  };

  Sim.prototype.createPod = function (wl) {
    const p = { id: this.nextPodId++, wl: wl.idx, cpu: wl.cpu, mem: wl.mem, node: null, ip: null, state: 'pending', created: this.t };
    this.counts.pending++;
    this.pods.set(p.id, p);
    wl.pods.add(p.id);
  };

  Sim.prototype.deletePod = function (p) {
    if (p.ip) { p.ip.pod = null; p.ip.coolUntil = this.t + IP_COOLDOWN; }
    if (p.node !== null) {
      const n = this.nodeById.get(p.node);
      n.pods.delete(p.id);
      n.cpu -= p.cpu;
      n.mem -= p.mem;
      if (!n.pods.size) n.emptySince = this.t;
    }
    this.counts[p.state]--;
    this.pods.delete(p.id);
    this.wls[p.wl].pods.delete(p.id);
  };

  Sim.prototype.bind = function (p, n) {
    p.node = n.id;
    n.pods.add(p.id);
    n.cpu += p.cpu;
    n.mem += p.mem;
    n.emptySince = null;
    this.setState(p, n.state === 'ready' ? 'creating' : 'nominated');
    p.waitingSince = this.t;
  };

  Sim.prototype.reconcileWorkloads = function () {
    const rank = { pending: 0, nominated: 1, creating: 2, running: 3 };
    for (const wl of this.wls) {
      const desired = Math.max(0, desiredReplicas(wl.shape, this.t));
      const current = wl.pods.size;
      if (desired > current) {
        for (let i = current; i < desired; i++) this.createPod(wl);
      } else if (desired < current) {
        // ReplicaSet scale-down: pods that aren't running yet go first, then the newest.
        const pods = [...wl.pods].map((id) => this.pods.get(id));
        pods.sort((a, b) => rank[a.state] - rank[b.state] || b.created - a.created || b.id - a.id);
        for (const p of pods.slice(0, current - desired)) this.deletePod(p);
      }
    }
  };

  // --- nodes ------------------------------------------------------------------

  Sim.prototype.launchNode = function () {
    if (this.live.length >= this.cfg.maxNodes) return null;
    const addr = this.subnet.allocIp(S_PRIMARY);
    if (addr < 0) {
      this.stats.launchFailures++;
      this.blocked.launch = true;
      this.note('launch', 'error', 'node launch failed: InsufficientFreeAddressesInSubnet (the node itself needs an IP and the subnet is full)');
      return null;
    }
    const id = this.nextNodeId++;
    const n = {
      id, name: 'node-' + id, createdAt: this.t, readyAt: this.t + NODE_STARTUP, terminatedAt: null, state: 'launching',
      ip: addr, enis: [{ id: this.nextEniId++, primary: addr, slots: 0, readyAt: this.t, isPrimary: true }],
      ips: [], pods: new Set(), cpu: 0, mem: 0, emptySince: this.t, endReason: null,
    };
    this.nodes.push(n);
    this.live.push(n);
    this.nodeById.set(id, n);
    this.stats.nodesLaunched++;
    this.emit('node', `${n.name}/${this.type.name} launched with IP ${ipString(addr)}`);
    return n;
  };

  Sim.prototype.terminate = function (n, reason) {
    for (const ip of n.ips) this.subnet.release(ip.addr);
    for (const e of n.enis) this.subnet.release(e.primary);
    const released = n.ips.length + n.enis.length;
    n.ips = [];
    n.enis = [];
    n.state = 'terminated';
    n.terminatedAt = this.t;
    n.endReason = reason;
    this.live = this.live.filter((x) => x !== n);
    this.emit('node', `${n.name} terminated (${reason}), released ${released} IPs back to the subnet`);
  };

  Sim.prototype.progressNodes = function () {
    for (const n of this.live) {
      if (n.state !== 'launching' || this.t < n.readyAt) continue;
      n.state = 'ready';
      for (const id of n.pods) { const p = this.pods.get(id); this.setState(p, 'creating'); p.waitingSince = this.t; }
    }
  };

  Sim.prototype.fits = function (n, p) {
    return n.pods.size < this.podSlots && this.allocCpu - n.cpu >= p.cpu && this.allocMem - n.mem >= p.mem;
  };

  // kube-scheduler doesn't know about IPs: it happily places pods on nodes that have none left.
  Sim.prototype.schedule = function () {
    if (!this.counts.pending) return;
    const pending = [];
    for (const p of this.pods.values()) if (p.state === 'pending') pending.push(p);
    pending.sort(bySizeDesc);
    const ready = this.live.filter((n) => n.state === 'ready');
    const launching = this.live.filter((n) => n.state === 'launching');
    const leftover = [];
    for (const p of pending) {
      let best = null, bestScore = -Infinity;
      for (const n of ready) {
        if (!this.fits(n, p)) continue;
        const score = (this.allocCpu - n.cpu) / this.allocCpu + (this.podSlots - n.pods.size) / this.podSlots; // LeastAllocated-ish
        if (score > bestScore) { best = n; bestScore = score; }
      }
      if (best) { this.bind(p, best); continue; }
      const nominated = launching.find((n) => this.fits(n, p));
      if (nominated) { this.bind(p, nominated); continue; }
      leftover.push(p);
    }
    // Autoscaler: launch as many nodes as the leftover pods need.
    for (const p of leftover) {
      if (p.cpu > this.allocCpu || p.mem > this.allocMem) {
        this.note('toobig:' + p.wl, 'warn', `pods of ${this.wls[p.wl].name} are bigger than a ${this.type.name} node`);
        continue;
      }
      let n = launching.find((x) => this.fits(x, p));
      if (!n) {
        n = this.launchNode();
        if (!n) break;
        launching.push(n);
      }
      this.bind(p, n);
    }
  };

  Sim.prototype.scaleDown = function () {
    for (const n of this.live.slice()) {
      if (this.live.length <= this.cfg.minNodes) return;
      if (n.state === 'ready' && !n.pods.size && n.emptySince !== null && this.t - n.emptySince >= SCALE_DOWN_AFTER) {
        this.terminate(n, 'empty for 10m, scaled down');
      }
    }
  };

  // --- ipamd ------------------------------------------------------------------

  Sim.prototype.attachEni = function (n) {
    if (n.enis.length >= this.type.enis) return null;
    const addr = this.subnet.allocIp(S_PRIMARY);
    if (addr < 0) {
      this.stats.ipErrors++;
      this.note('subnet:' + n.id, 'error', `${n.name}: can't attach another ENI: InsufficientFreeAddressesInSubnet`);
      return null;
    }
    const e = { id: this.nextEniId++, primary: addr, slots: 0, readyAt: this.t + ENI_ATTACH_DELAY, isPrimary: false };
    n.enis.push(e);
    this.stats.enisAttached++;
    this.emit('eni', `${n.name}: attaching ENI #${n.enis.length} (${this.type.name} allows ${this.type.enis})`);
    return e;
  };

  Sim.prototype.detachEni = function (n, e) {
    this.subnet.release(e.primary);
    n.enis = n.enis.filter((x) => x !== e);
    this.emit('eni', `${n.name}: detached a spare ENI, released its IPs`);
  };

  Sim.prototype.ipReadyAt = function (e) { return Math.max(e.readyAt, this.t + IP_ASSIGN_DELAY); };

  // Secondary-IP mode: add up to `count` IPs, filling ENIs before attaching new ones.
  Sim.prototype.addIps = function (n, count) {
    const slotsPerEni = this.type.ips - 1;
    let added = 0;
    while (added < count) {
      let e = n.enis.find((x) => x.slots < slotsPerEni);
      if (!e) e = this.attachEni(n);
      if (!e) break;
      while (added < count && e.slots < slotsPerEni) {
        const addr = this.subnet.allocIp(S_POD_SLOT);
        if (addr < 0) {
          this.stats.ipErrors++;
          this.note('subnet:' + n.id, 'error', `${n.name}: ipamd couldn't get more IPs: InsufficientFreeAddressesInSubnet`);
          return added;
        }
        n.ips.push({ addr, eni: e, pod: null, coolUntil: 0, readyAt: this.ipReadyAt(e), prefix: -1 });
        e.slots++;
        added++;
      }
    }
    return added;
  };

  Sim.prototype.idle = function (ip) { return ip.pod === null && ip.coolUntil <= this.t && ip.readyAt <= this.t; };

  Sim.prototype.dropEmptyEnis = function (n) {
    for (const e of n.enis.slice()) if (!e.isPrimary && e.slots === 0) this.detachEni(n, e);
  };

  Sim.prototype.ipamd = function (n) {
    if (this.cfg.mode === 'prefix') return this.ipamdPrefix(n);
    const c = this.cfg, slotsPerEni = this.type.ips - 1;
    let used = 0;
    for (const ip of n.ips) if (ip.pod !== null) used++;
    const total = n.ips.length;

    if (c.usesIpTargets) {
      // WARM_IP_TARGET / MINIMUM_IP_TARGET: keep exactly enough spare IPs.
      const target = Math.max(c.minIpTarget, used + c.warmIpTarget);
      if (target > total) this.addIps(n, target - total);
      else if (target < total) {
        let excess = total - target;
        const spare = n.ips.filter((ip) => this.idle(ip)).reverse(); // newest ENIs first
        const drop = new Set();
        for (const ip of spare) { if (!excess) break; drop.add(ip); excess--; }
        if (drop.size) {
          for (const ip of drop) { this.subnet.release(ip.addr); ip.eni.slots--; }
          n.ips = n.ips.filter((ip) => !drop.has(ip));
          this.dropEmptyEnis(n);
        }
      }
      return;
    }

    // WARM_ENI_TARGET (the default): ENIs are filled completely, and ipamd keeps
    // WARM_ENI_TARGET ENIs' worth of free IPs on top of what pods use.
    const want = c.warmEniTarget * slotsPerEni;
    let free = total - used;
    let missing = 0;
    for (const e of n.enis) missing += slotsPerEni - e.slots;
    if (missing) free += this.addIps(n, missing); // top up ENIs that aren't full yet
    while (free < want && n.enis.length < this.type.enis) {
      const before = n.ips.length;
      const e = this.attachEni(n);
      if (!e) break;
      this.addIpsToEni(n, e, slotsPerEni);
      free += n.ips.length - before;
      if (n.ips.length === before) break;
    }
    for (let k = n.enis.length - 1; k >= 1; k--) {
      const e = n.enis[k];
      const ips = n.ips.filter((ip) => ip.eni === e);
      if (!ips.every((ip) => this.idle(ip)) || free - ips.length < want) continue;
      for (const ip of ips) this.subnet.release(ip.addr);
      n.ips = n.ips.filter((ip) => ip.eni !== e);
      e.slots = 0;
      free -= ips.length;
      this.detachEni(n, e);
    }
  };

  Sim.prototype.addIpsToEni = function (n, e, count) {
    for (let i = 0; i < count; i++) {
      const addr = this.subnet.allocIp(S_POD_SLOT);
      if (addr < 0) {
        this.stats.ipErrors++;
        this.note('subnet:' + n.id, 'error', `${n.name}: ipamd couldn't fill the new ENI: InsufficientFreeAddressesInSubnet`);
        return;
      }
      n.ips.push({ addr, eni: e, pod: null, coolUntil: 0, readyAt: this.ipReadyAt(e), prefix: -1 });
      e.slots++;
    }
  };

  // Prefix delegation: each ENI slot holds a /28 (16 IPs) instead of a single IP.
  Sim.prototype.ipamdPrefix = function (n) {
    const c = this.cfg, slotsPerEni = this.type.ips - 1;
    const prefixes = new Map();
    let used = 0;
    for (const ip of n.ips) {
      if (!prefixes.has(ip.prefix)) prefixes.set(ip.prefix, { eni: ip.eni, ips: [] });
      prefixes.get(ip.prefix).ips.push(ip);
      if (ip.pod !== null) used++;
    }
    let target;
    if (c.usesIpTargets) target = Math.ceil(Math.max(c.minIpTarget, used + c.warmIpTarget) / PREFIX_SIZE);
    else {
      let busy = 0;
      for (const p of prefixes.values()) if (!p.ips.every((ip) => this.idle(ip))) busy++;
      target = busy + c.warmPrefixTarget;
    }
    if (target > prefixes.size) {
      let need = target - prefixes.size;
      while (need > 0) {
        let e = n.enis.find((x) => x.slots < slotsPerEni);
        if (!e) e = this.attachEni(n);
        if (!e) return;
        const base = this.subnet.allocPrefix();
        if (base < 0) {
          this.stats.prefixErrors++;
          this.blocked.prefix = true;
          this.note('prefix:' + n.id, 'error', `${n.name}: InsufficientCidrBlocks: no free /28 block left, although the subnet still has ${this.subnet.free} free IPs (they're scattered)`);
          return;
        }
        const readyAt = this.ipReadyAt(e);
        for (let j = 0; j < PREFIX_SIZE; j++) n.ips.push({ addr: base + j, eni: e, pod: null, coolUntil: 0, readyAt, prefix: base });
        e.slots++;
        need--;
        this.emit('eni', `${n.name}: assigned prefix ${ipString(base)}/28 (16 IPs)`);
      }
    } else if (target < prefixes.size) {
      let excess = prefixes.size - target;
      const drop = new Set();
      for (const [base, p] of [...prefixes].reverse()) {
        if (!excess) break;
        if (!p.ips.every((ip) => this.idle(ip))) continue;
        drop.add(base);
        for (const ip of p.ips) this.subnet.release(ip.addr);
        p.eni.slots--;
        excess--;
      }
      if (drop.size) {
        n.ips = n.ips.filter((ip) => !drop.has(ip.prefix));
        this.dropEmptyEnis(n);
      }
    }
  };

  Sim.prototype.assignIps = function () {
    if (!this.counts.creating) return;
    for (const n of this.live) {
      if (n.state !== 'ready') continue;
      let waiting = 0;
      let free = null, next = 0;
      for (const id of n.pods) {
        const p = this.pods.get(id);
        if (p.state !== 'creating') continue;
        if (free === null) free = n.ips.filter((ip) => this.idle(ip)); // oldest ENIs / prefixes first
        const ip = free[next++];
        if (!ip) { waiting++; continue; }
        ip.pod = p.id;
        p.ip = ip;
        this.setState(p, 'running');
      }
      if (waiting) this.note('waiting:' + n.id, 'waiting', `${n.name}: ${waiting} pod(s) stuck in ContainerCreating: "failed to assign an IP address to container"`);
    }
  };

  // --- metrics ----------------------------------------------------------------

  Sim.prototype.account = function () {
    let price = 0;
    for (const n of this.live) price += this.type.price;
    this.stats.cost += (price * STEP) / 3600;
    if (this.t >= WARMUP) { // the cluster's own start-up isn't counted as waiting
      this.stats.waitingPodSeconds += this.counts.creating * STEP;
      this.stats.pendingPodSeconds += (this.counts.pending + this.counts.nominated) * STEP;
    }
    if (this.blocked.launch) this.stats.launchBlockedSeconds += STEP;
    if (this.blocked.prefix) this.stats.prefixBlockedSeconds += STEP;
    this.blocked.launch = this.blocked.prefix = false;
    if (this.t % SAMPLE_EVERY === 0) {
      let podIps = 0, idle = 0, system = 0;
      for (const n of this.live) {
        system += n.enis.length;
        for (const ip of n.ips) if (ip.pod !== null) podIps++; else idle++;
      }
      this.samples.push({
        t: this.t, nodes: this.live.length, costHr: price, used: this.subnet.usable - this.subnet.free, free: this.subnet.free,
        podIps, idle, system, waiting: this.counts.creating, pending: this.counts.pending + this.counts.nominated,
      });
    }
    if (this.t % SNAPSHOT_EVERY === 0) this.snapshots.push({ t: this.t, cells: this.snapshot() });
  };

  Sim.prototype.snapshot = function () {
    const st = this.subnet.state, cells = new Uint8Array(st.length);
    for (let i = 0; i < st.length; i++) {
      cells[i] = st[i] === S_FREE ? CAT.FREE : st[i] === S_RESERVED ? CAT.RESERVED : st[i] === S_OTHER ? CAT.OTHER
        : st[i] === S_PRIMARY ? CAT.SYSTEM : CAT.IDLE;
    }
    for (const n of this.live) for (const ip of n.ips) if (ip.pod !== null) cells[ip.addr] = CAT.POD;
    return cells;
  };

  Sim.prototype.result = function () {
    const s = this.samples;
    const max = (k) => Math.max(0, ...s.map((x) => x[k]));
    const avg = (k) => s.reduce((a, x) => a + x[k], 0) / s.length;
    return {
      durationHours: this.sc.durationHours,
      subnet: { prefixLen: this.cfg.subnetPrefix, size: this.subnet.size, usable: this.subnet.usable },
      maxPods: this.maxPods,
      type: this.type,
      summary: {
        totalCost: this.stats.cost,
        peakUsed: max('used'),
        peakUsedPct: max('used') / this.subnet.usable,
        minFree: Math.min(...s.map((x) => x.free)),
        avgIdle: avg('idle'),
        peakIdle: max('idle'),
        peakWaiting: Math.max(0, ...s.filter((x) => x.t >= WARMUP).map((x) => x.waiting + x.pending)),
        waitingPodMinutes: this.stats.waitingPodSeconds / 60,
        pendingPodMinutes: this.stats.pendingPodSeconds / 60,
        avgNodes: avg('nodes'),
        peakNodes: max('nodes'),
        maxPods: this.maxPods,
        podSlots: this.podSlots,
        subnetFullMinutes: s.filter((x) => x.free === 0).length * SAMPLE_EVERY / 60,
        launchBlockedMinutes: this.stats.launchBlockedSeconds / 60,
        prefixBlockedMinutes: this.stats.prefixBlockedSeconds / 60,
        enisAttached: this.stats.enisAttached,
        nodesLaunched: this.stats.nodesLaunched,
      },
      samples: s,
      snapshots: this.snapshots,
      nodes: this.nodes.map((n) => ({ id: n.id, name: n.name, createdAt: n.createdAt, readyAt: n.readyAt, terminatedAt: n.terminatedAt, endReason: n.endReason })),
      log: this.log,
    };
  };

  function simulate(config, scenario) { return new Sim(config, scenario).run(); }

  root.KCni = { Sim, simulate, desiredReplicas, maxPodsFor, INSTANCES, CAT, PREFIX_SIZE, STEP, ipString };
})(typeof window !== 'undefined' ? window : globalThis);
