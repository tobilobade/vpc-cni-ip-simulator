/* Scenario presets: a shared workload plus two VPC CNI setups (A vs B) to compare. */
(function (root) {
  'use strict';

  const DS = { cpu: 150, mem: 200 };

  function cni(overrides) {
    return Object.assign({
      subnetPrefix: 24, instanceType: 'm5.xlarge', mode: 'secondary',
      warmEniTarget: 1, warmIpTarget: 0, minIpTarget: 0, warmPrefixTarget: 1, minNodes: 2,
    }, overrides);
  }

  root.KCniPresets = [
    {
      id: 'warm-eni',
      name: 'Spare IPs fill up the subnet',
      description: 'By default, every server grabs a whole extra network card\'s worth of IPs "just in case" (WARM_ENI_TARGET=1). In a small /24 subnet, those spare IPs run out fast, so new servers can\'t start and pods wait. B asks for only 2 spare IPs per server (WARM_IP_TARGET=2), so the same subnet fits far more pods.',
      scenario: {
        durationHours: 12, daemonset: DS, otherIps: 0,
        workloads: [{ name: 'web', cpu: 250, mem: 512, shape: { type: 'daily', min: 20, max: 200, peakHour: 6 } }],
      },
      a: cni({ subnetPrefix: 24 }),
      b: cni({ subnetPrefix: 24, warmIpTarget: 2, minIpTarget: 5 }),
    },
    {
      id: 'max-pods',
      name: 'Max pods per server: secondary IPs vs prefix delegation',
      description: 'Small servers can only hold a few IPs, so an m5.large runs at most 29 pods, even when the pods are tiny. Prefix delegation gives each slot 16 IPs instead of 1, raising the limit to 110. The same pods fit on about a third of the servers.',
      scenario: {
        durationHours: 12, daemonset: DS, otherIps: 0,
        workloads: [{ name: 'api', cpu: 20, mem: 64, shape: { type: 'daily', min: 100, max: 400, peakHour: 6 } }],
      },
      a: cni({ subnetPrefix: 20, instanceType: 'm5.large' }),
      b: cni({ subnetPrefix: 20, instanceType: 'm5.large', mode: 'prefix' }),
    },
    {
      id: 'fragmented',
      name: 'Prefix delegation in a busy subnet',
      description: 'Other things (databases, load balancers) already use 150 scattered IPs in this subnet. Prefix delegation needs blocks of 16 IPs in a row (/28). There are plenty of free IPs, but almost no free blocks, so B\'s pods get stuck. A uses single IPs and is fine. The fix is a fresh subnet or a subnet CIDR reservation for prefixes.',
      scenario: {
        durationHours: 12, daemonset: DS, otherIps: 150,
        workloads: [{ name: 'web', cpu: 100, mem: 256, shape: { type: 'daily', min: 20, max: 150, peakHour: 6 } }],
      },
      a: cni({ subnetPrefix: 23, warmIpTarget: 3, minIpTarget: 5 }),
      b: cni({ subnetPrefix: 23, mode: 'prefix' }),
    },
    {
      id: 'burst',
      name: 'Traffic bursts: too few spare IPs',
      description: 'Jobs jump from 10 to 120 pods every 30 minutes. With only 1 spare IP per server (A), most new pods wait while the CNI asks AWS for more IPs. Keeping 30 spare IPs (B) lets pods start right away, at the cost of holding more IPs.',
      scenario: {
        durationHours: 4, daemonset: DS, otherIps: 0,
        workloads: [{ name: 'jobs', cpu: 100, mem: 256, shape: { type: 'spiky', base: 10, peak: 120, everyMin: 30, forMin: 10 } }],
      },
      a: cni({ subnetPrefix: 21, instanceType: 'm5.4xlarge', warmIpTarget: 1 }),
      b: cni({ subnetPrefix: 21, instanceType: 'm5.4xlarge', warmIpTarget: 30 }),
    },
    {
      id: 'bigger-subnet',
      name: 'Running out: /24 vs a bigger /21 subnet',
      description: 'The same busy app on a small /24 subnet (A, 251 usable IPs) and a /21 subnet (B, 2,043 IPs). A runs out at mid-day, and pods can\'t start until traffic drops. In real clusters, the usual fix is adding a secondary CIDR (such as 100.64.0.0/16) with custom networking.',
      scenario: {
        durationHours: 12, daemonset: DS, otherIps: 0,
        workloads: [{ name: 'web', cpu: 250, mem: 512, shape: { type: 'daily', min: 50, max: 400, peakHour: 6 } }],
      },
      a: cni({ subnetPrefix: 24, instanceType: 'm5.2xlarge' }),
      b: cni({ subnetPrefix: 21, instanceType: 'm5.2xlarge' }),
    },
  ];
})(typeof window !== 'undefined' ? window : globalThis);
