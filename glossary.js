/* Plain-language word helper. `id` is referenced by data-term="..." buttons. */
(function (root) {
  'use strict';

  root.KCniGlossary = [
    {
      group: 'The basics',
      terms: [
        { id: 'pod', term: 'Pod', body: 'One copy of an app. Like a person who needs a home.' },
        { id: 'node', term: 'Server (node)', body: 'A computer that runs pods. It needs one address for itself too.' },
        {
          id: 'ip', term: 'Address (IP)',
          body: 'Every pod needs its own address so others can find it, just like every house needs a house number.',
          example: 'Something like <code>10.0.0.37</code>. Each one is a square on the map.',
        },
        {
          id: 'subnet', term: 'Subnet',
          body: 'The street where all the addresses live. It has a fixed number of addresses and can\'t grow.',
          example: '<b>/24</b> = 256 addresses, <b>/22</b> = 1,024, <b>/20</b> = 4,096. Smaller number after the slash = bigger street.',
        },
        { id: 'reserved', term: 'AWS reserved', body: 'AWS always keeps 5 addresses in every subnet for itself (the first 4 and the last one). Nobody else can use them.' },
        { id: 'other', term: 'Used by other things', body: 'Databases, load balancers and other servers in the same subnet also take addresses.' },
      ],
    },
    {
      group: 'How addresses are handed out',
      terms: [
        {
          id: 'cni', term: 'VPC CNI (aws-node)',
          body: 'The helper on every server that hands out addresses to pods. It asks AWS for addresses ahead of time, so pods can start quickly.',
        },
        {
          id: 'eni', term: 'ENI (network card)',
          body: 'A network card in the server. Each card holds a fixed number of addresses, and each server type can have only so many cards.',
          example: 'An m5.xlarge has up to 4 cards with 15 addresses each. One address per card belongs to the card itself.',
        },
        {
          id: 'spare', term: 'Spare addresses (warm pool)',
          body: 'Addresses a server grabs <b>before</b> it needs them, so new pods don\'t have to wait. But while they sit there, nobody else can use them.',
        },
        {
          id: 'warmEni', term: 'WARM_ENI_TARGET',
          body: 'The default setting. It keeps a whole spare network card full of addresses on every server. Fast, but it can waste a lot of addresses.',
          example: '1 pod on an m5.xlarge can hold 28 addresses: 14 on the first card + 14 spare on a second card.',
        },
        {
          id: 'warmIp', term: 'WARM_IP_TARGET',
          body: 'Keep exactly this many spare addresses per server. It wastes fewer addresses, but if it\'s too low, pods wait during busy moments.',
        },
        {
          id: 'minIp', term: 'MINIMUM_IP_TARGET',
          body: 'Always hold at least this many addresses on each server, even when it\'s quiet. It helps with sudden bursts.',
        },
        {
          id: 'prefix', term: 'Prefix delegation',
          body: 'Instead of single addresses, each card slot gets a <b>block of 16 addresses in a row</b> (a /28). Servers can run many more pods.',
          example: 'An m5.large goes from 29 pods to 110. But the subnet needs empty blocks of 16 in a row.',
        },
        {
          id: 'warmPrefix', term: 'WARM_PREFIX_TARGET',
          body: 'With prefix delegation: how many completely empty blocks of 16 each server keeps as spares.',
        },
        {
          id: 'maxPods', term: 'Max pods',
          body: 'The most pods one server can run. It depends on how many addresses its cards can hold. Two spots go to system pods (aws-node, kube-proxy) that use the server\'s own address.',
        },
      ],
    },
    {
      group: 'When things go wrong',
      terms: [
        {
          id: 'waiting', term: 'Pod waiting for an address',
          body: 'The pod has a server, but no address yet. In Kubernetes it shows as <code>ContainerCreating</code> with "failed to assign an IP address to container".',
        },
        {
          id: 'pending', term: 'Pod waiting for a server',
          body: 'There\'s no server with room for the pod (<code>Pending</code>). This happens when a new server can\'t start, for example because the subnet has no address left for it.',
        },
        {
          id: 'full', term: 'Subnet full',
          body: 'Every address is taken. New servers can\'t start, and servers can\'t get more addresses for pods. AWS calls this <code>InsufficientFreeAddressesInSubnet</code>.',
        },
        {
          id: 'fragmented', term: 'No free blocks (fragmented)',
          body: 'There are free addresses, but they\'re scattered, so there\'s no empty run of 16 in a row for prefix delegation. AWS says <code>InsufficientCidrBlocks</code>.',
          example: 'Like a cinema with 50 empty seats but nowhere for a group of 16 to sit together.',
        },
        {
          id: 'fixes', term: 'Common fixes',
          body: 'Lower the spare addresses (WARM_IP_TARGET), use a bigger subnet, add a second address range (secondary CIDR with custom networking), or use prefix delegation in a clean subnet (with a CIDR reservation).',
        },
      ],
    },
  ];
})(window);
