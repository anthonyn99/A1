# MAGI cloud engine: setup runbook

This is Track M in [magi-plan.md](magi-plan.md) §8. It puts the engine Tony
already runs onto an always-on free Oracle Cloud VM, so `magi.html` works on
the phones with the PC off. It's written for the Claude session that does the
work. Tony only does Step 1.

**Status (2026-10-19): ON HOLD.** Tony is deciding between a home box, Oracle
with the main accounts kept PC-only, and this plan as written (the account-risk
question; see [magi-plan.md](magi-plan.md) §0). Nothing has been provisioned,
and no account has signed in from a server.

---

## Step 1: Tony (about 15 minutes, once)

1. **Create the account.** Go to <https://signup.cloud.oracle.com> and sign
   up.
   - **Home region:** choose **US West (Phoenix)**, or **San Jose** if Phoenix
     isn't offered. The home region can't be changed later, and Always Free
     VMs only exist there. Ashburn often runs out of free ARM capacity.
   - **Card:** Oracle asks for a card to verify identity. Always Free
     resources are never charged.
2. **Upgrade to Pay As You Go.** Billing → Upgrade and Manage Payment →
   Pay As You Go. This keeps Oracle from reclaiming the VM when MAGI is idle
   for a week. It still costs $0 while we stay inside Always Free.
3. **Add a budget alert.** Billing → Budgets → Create Budget: $1 per month,
   alert at 1% to your email. If anything ever starts costing money, you'll
   hear about it the same day.
4. **Make an API key.** Profile (top right) → My profile → API keys → Add API
   key → Generate API key pair.
   - Download the private key and save it as
     `C:\Users\antho\.oci\oci_api_key.pem`.
   - Copy the "Configuration file preview" text into
     `C:\Users\antho\.oci\config`, and change its `key_file=` line to
     `key_file=C:\Users\antho\.oci\oci_api_key.pem`.
5. Tell Claude "the Oracle account is ready".

The private key never goes into chat or the repo. Claude reads it only through
the OCI CLI on this PC.

---

## Step 2: Claude provisions the VM (M0)

1. Install the OCI CLI into its own venv, outside A1, and check the account
   with `oci iam region list`.
2. Create these with the CLI:
   - A VCN with an internet gateway and a public subnet.
   - Security-list ingress for TCP 22 (from Tony's IP only) and TCP 443.
   - A **reserved public IP**.
   - **VM.Standard.A1.Flex** with 2 OCPU / 12 GB and Ubuntu 24.04 (aarch64),
     a 100 GB boot volume (inside the 200 GB Always Free allowance), and a new
     SSH key pair stored at `C:\Users\antho\.ssh\magi_cloud`.

   "Out of host capacity" is normal for free ARM. Retry every few minutes, or
   try another availability domain, and never pick a paid shape.
3. On the VM:
   - Open 443 in iptables. Oracle's Ubuntu image rejects everything except 22
     by default.
   - Install Google Chrome for ARM64 Linux (confirm it has shipped; otherwise
     use Chromium and set `browser.channel: chromium` for this engine only).
   - Install Xvfb, x11vnc, noVNC, Python 3.12+, Node 22, git, and the Claude
     Code and Codex CLIs.
4. Clone A1 onto the VM, start the engine as it is
   (`--profile tony`, headful on Xvfb), and bring up noVNC temporarily over an
   SSH tunnel only. Nothing is exposed publicly in M0.

## Step 3: the per-unit go/no-go test (M0)

For each unit, Tony signs in through noVNC: he types the passwords and
answers any 2FA. Claude then asks each unit one question.

| Unit | Signs in | No endless bot check | Answers | Seconds | Verdict |
|---|---|---|---|---|---|
| ChatGPT | | | | | |
| Claude (free) | | | | | |
| Claude (Pro) | | | | | |
| Gemini | | | | | |
| Perplexity | | | | | |
| Grok | | | | | |
| DeepSeek | | | | | |
| Claude Code CLI login | | n/a | | | |
| Codex CLI login | | n/a | | | |

Also record the time for one full council question with every unit ticked,
and the VM's peak memory during it.

**Gate:**
- A unit that fails is marked **PC only**. M3 greys it out on the cloud
  engine, and it keeps working on the PC engine.
- If ChatGPT **and** both Claudes fail, stop and report to Tony before M1.

## Later steps

M1 to M8 are in [magi-plan.md](magi-plan.md) §8 "Track M". From M2 on, this
file becomes the real runbook (`magi/cloud/setup.sh`, Caddy and sslip.io,
systemd units), and this section gets rewritten as each step is built.
