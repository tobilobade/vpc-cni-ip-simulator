# 🏘️ Pod Address Simulator

**See how EKS hands out IP addresses to pods, and what happens when they run out.**

Every pod needs its own IP from your VPC subnet. The Amazon VPC CNI also keeps *spare* IPs ready on every node, so new pods start fast. Those spares can quietly fill a subnet. This simulator shows it as a colour map of every address in the subnet, animated over a day, comparing two CNI setups side by side.

**Run it:** open `index.html`, or host the folder as a static site (e.g. GitHub Pages). No build step, no dependencies.

## Stories included

| Story | What you'll see |
|---|---|
| 🟨 Spare IPs fill up the subnet | Default `WARM_ENI_TARGET=1` hoards IPs; `WARM_IP_TARGET` fixes it |
| 📦 Max pods per server | Prefix delegation fits the same pods on ~⅓ of the nodes |
| 🧩 Prefix delegation in a busy subnet | Free IPs everywhere, but no free `/28` block → pods stuck |
| 🚀 Traffic bursts | Too few warm IPs → pods wait in `ContainerCreating` |
| 📏 /24 vs /21 | Running out vs having room |

Everything is explained in plain words: press **📖 What do the words mean?** or any **?**.

## What it models

- Real EC2 ENI limits per instance type and the EKS max-pods formula (secondary IPs and prefix mode).
- ipamd warm-pool behaviour: `WARM_ENI_TARGET`, `WARM_IP_TARGET`, `MINIMUM_IP_TARGET`, `WARM_PREFIX_TARGET`, 30s IP cooldown, EC2 API delays.
- kube-scheduler placing pods without knowing about IPs (→ `ContainerCreating`), nodes needing their own IP to launch, scale-down of empty nodes.
- Random address placement, which is what makes `/28` prefixes hard to find in busy subnets (`InsufficientCidrBlocks`).

Not modelled: custom networking / secondary CIDRs, security groups for pods, IPv6, multiple subnets.

It's for building intuition, not exact numbers.

## Tests

```sh
./test.sh   # Node if installed, otherwise macOS's built-in JavaScriptCore
```

## Files

`engine.js` (simulation, no DOM) · `worker.js` (runs it off the main thread) · `presets.js` · `glossary.js` · `charts.js` · `app.js` · `index.html` · `styles.css`

Sister project: [Karpenter Consolidation Simulator](https://github.com/tobilobade/karpenter-consolidation-sim).
