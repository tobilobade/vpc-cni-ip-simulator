/* Run: ./test.sh  (uses Node if installed, otherwise macOS JavaScriptCore `jsc`) */
(function () {
  'use strict';
  const { Sim, simulate, maxPodsFor, INSTANCES } = KCni;
  const out = typeof print === 'function' ? print : console.log;
  let passed = 0, failed = 0;
  function test(name, fn) {
    try { fn(); passed++; out('  ok   ' + name); } catch (e) { failed++; out('  FAIL ' + name + '\n       ' + e.message); }
  }
  function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
  const type = (n) => INSTANCES.find((t) => t.name === n);
  const scen = (workloads, o) => Object.assign({ durationHours: 3, daemonset: { cpu: 150, mem: 200 }, otherIps: 0, workloads }, o);
  const wl = (shape, o) => Object.assign({ name: 'app', cpu: 250, mem: 512, shape }, o);
  const last = (r) => r.samples[r.samples.length - 1];

  // Runs a sim and checks IP bookkeeping on every tick.
  function runChecked(cfg, sc) {
    const s = new Sim(cfg, sc);
    const orig = s.tick.bind(s);
    s.tick = function () {
      orig();
      let owned = 0;
      const seen = new Set();
      for (const n of s.live) {
        owned += n.ips.length + n.enis.length;
        assert(n.enis.length <= s.type.enis, `${n.name} has too many ENIs`);
        assert(n.pods.size <= s.podSlots, `${n.name} over max pods`);
        for (const e of n.enis) {
          const slots = new Set(n.ips.filter((ip) => ip.eni === e).map((ip) => ip.prefix >= 0 ? 'p' + ip.prefix : ip.addr)).size;
          assert(slots === e.slots && e.slots <= s.type.ips - 1, `${n.name} ENI slot accounting wrong at t=${s.t}`);
        }
        for (const ip of n.ips) {
          assert(!seen.has(ip.addr), `IP ${ip.addr} handed out twice`);
          seen.add(ip.addr);
          if (ip.pod !== null) assert(s.pods.get(ip.pod).ip === ip, 'pod/IP link broken');
        }
      }
      const otherAndReserved = s.subnet.size - s.subnet.usable + (s.sc.otherIps || 0);
      assert(owned + otherAndReserved + s.subnet.free === s.subnet.size, `subnet accounting drift at t=${s.t}`);
      for (const p of s.pods.values()) if (p.state === 'running') assert(p.ip && p.ip.pod === p.id, 'running pod without IP');
    };
    return s.run();
  }

  out('engine tests');

  test('max pods matches the EKS formula', () => {
    assert(maxPodsFor(type('m5.large'), 'secondary') === 29);
    assert(maxPodsFor(type('m5.xlarge'), 'secondary') === 58);
    assert(maxPodsFor(type('m5.4xlarge'), 'secondary') === 234);
    assert(maxPodsFor(type('t3.medium'), 'secondary') === 17);
    assert(maxPodsFor(type('m5.large'), 'prefix') === 110);
    assert(maxPodsFor(type('m5.8xlarge'), 'prefix') === 250);
  });

  test('every pod runs when the subnet is big enough', () => {
    const r = runChecked({ subnetPrefix: 20, instanceType: 'm5.xlarge' }, scen([wl({ type: 'steady', replicas: 60 })]));
    assert(last(r).waiting === 0 && last(r).pending === 0, 'pods not running');
  });

  test('default WARM_ENI_TARGET keeps a whole spare ENI per node', () => {
    const r = runChecked({ subnetPrefix: 20, instanceType: 'm5.xlarge', minNodes: 1 }, scen([wl({ type: 'steady', replicas: 3 })]));
    // 3 pods on one m5.xlarge: primary ENI full (14) + one spare ENI (14) = 28 IPs, 25 idle.
    assert(last(r).nodes === 1, 'nodes ' + last(r).nodes);
    assert(last(r).podIps === 3 && last(r).idle === 25, `podIps ${last(r).podIps} idle ${last(r).idle}`);
  });

  test('WARM_IP_TARGET keeps only the requested spare IPs', () => {
    const r = runChecked({ subnetPrefix: 20, instanceType: 'm5.xlarge', minNodes: 1, warmIpTarget: 2 }, scen([wl({ type: 'steady', replicas: 3 })]));
    assert(last(r).idle === 2, 'idle ' + last(r).idle);
  });

  test('MINIMUM_IP_TARGET sets a floor', () => {
    const r = runChecked({ subnetPrefix: 20, instanceType: 'm5.xlarge', minNodes: 1, warmIpTarget: 1, minIpTarget: 10 }, scen([wl({ type: 'steady', replicas: 3 })]));
    assert(last(r).podIps + last(r).idle === 10, 'total ' + (last(r).podIps + last(r).idle));
  });

  test('exhausted subnet leaves pods stuck in ContainerCreating', () => {
    const r = runChecked({ subnetPrefix: 26, instanceType: 'm5.xlarge' }, scen([wl({ type: 'steady', replicas: 80 })]));
    assert(r.summary.subnetFullMinutes > 0, 'subnet should fill');
    assert(last(r).waiting > 0, 'expected pods waiting for an IP');
    assert(r.log.some((l) => /InsufficientFreeAddressesInSubnet/.test(l.msg)));
  });

  test('exhausted subnet blocks new nodes, leaving pods pending', () => {
    const r = runChecked({ subnetPrefix: 27, instanceType: 'm5.xlarge' }, scen([wl({ type: 'step', from: 10, to: 80, atHour: 1 })]));
    assert(r.summary.launchBlockedMinutes > 0, 'launches should be blocked');
    assert(last(r).pending > 0, 'expected pending pods');
  });

  test('prefix delegation hands out /28 blocks and raises max pods', () => {
    const r = runChecked({ subnetPrefix: 20, instanceType: 'm5.large', mode: 'prefix', minNodes: 1 }, scen([wl({ type: 'steady', replicas: 60 }, { cpu: 20, mem: 64 })]));
    assert(r.maxPods === 110 && last(r).nodes === 1, 'nodes ' + last(r).nodes);
    assert((last(r).podIps + last(r).idle) % 16 === 0, 'IPs should come in 16s');
    assert(last(r).waiting === 0);
  });

  test('prefix delegation fails in a fragmented subnet', () => {
    const sc = scen([wl({ type: 'steady', replicas: 20 }, { cpu: 100, mem: 256 })], { otherIps: 150 });
    const sec = runChecked({ subnetPrefix: 23, instanceType: 'm5.xlarge', warmIpTarget: 3 }, sc);
    const pfx = runChecked({ subnetPrefix: 23, instanceType: 'm5.xlarge', mode: 'prefix' }, sc);
    assert(last(sec).waiting === 0, 'secondary mode should cope');
    assert(last(pfx).waiting > 0 && pfx.summary.prefixBlockedMinutes > 0, 'prefix mode should be stuck');
    assert(pfx.log.some((l) => /InsufficientCidrBlocks/.test(l.msg)));
  });

  test('low WARM_IP_TARGET makes pods wait during bursts', () => {
    const sc = scen([wl({ type: 'spiky', base: 10, peak: 120, everyMin: 30, forMin: 10 }, { cpu: 100, mem: 256 })]);
    const low = simulate({ subnetPrefix: 21, instanceType: 'm5.4xlarge', warmIpTarget: 1 }, sc);
    const high = simulate({ subnetPrefix: 21, instanceType: 'm5.4xlarge', warmIpTarget: 30 }, sc);
    assert(low.summary.waitingPodMinutes > high.summary.waitingPodMinutes * 5, `${low.summary.waitingPodMinutes} vs ${high.summary.waitingPodMinutes}`);
  });

  test('empty nodes scale down and return their IPs', () => {
    const r = runChecked({ subnetPrefix: 22, instanceType: 'm5.xlarge', minNodes: 1 }, scen([wl({ type: 'step', from: 60, to: 0, atHour: 1 })]));
    assert(last(r).nodes === 1, 'nodes ' + last(r).nodes);
    assert(r.nodes.some((n) => n.terminatedAt !== null));
  });

  test('all presets run and stay consistent', () => {
    for (const p of KCniPresets) for (const side of ['a', 'b']) {
      const t0 = Date.now();
      const r = runChecked(Object.assign({ side }, p[side]), p.scenario);
      out(`       ${p.id}/${side}: peak ${r.summary.peakUsed}/${r.subnet.usable} IPs, ${Math.round(r.summary.waitingPodMinutes)} pod-min waiting, ${Date.now() - t0}ms`);
    }
  });

  out(`\n${passed} passed, ${failed} failed`);
  if (failed) throw new Error('tests failed');
})();
