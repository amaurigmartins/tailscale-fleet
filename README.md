# tailscale-fleet

Toolkit for turning a pile of Linux machines, Windows boxes, VMware guests, remote workstations, and corporate-managed nonsense into one private Tailscale realm without needing root on the client machine.

Current `ts` version: **4.0.1**

The executable is simply:

```text
ts
```

because I am not typing `tailscale-user-rootless-proxy-rdp-fleet-controller-final-v7.sh` for the rest of my life.

## Why this exists

The original problem was simple:

- corporate Rocky Linux workstation;
- no root;
- remote Windows machines;
- Windows VMs under VMware;
- need SSH, RDP, file transfer, and sane machine-to-machine access;
- Tailscale's normal Linux install wants root because it creates a TUN interface and system routes;
- VMware/KRDC/etc. somehow managed to make **Ctrl+C on Linux → Ctrl+V on Windows** feel like an advanced distributed-systems research problem.

So `ts` does the useful parts itself:

```text
Rocky / rootless Linux
        |
        | userspace tailscaled
        | SOCKS5/HTTP 127.0.0.1:1055
        |
        +---- ts ssh ---- tailscale nc ----------> fleet host :22
        |
        +---- RDP bridge 127.77.0.x:3389 --------> Windows :3389
        |          |
        |          +---- FreeRDP
        |                +clipboard
        |                /dynamic-resolution
        |
        +---- native Tailscale CLI passthrough
```

The Windows VMs and machines can run normal privileged Tailscale. The weirdness stays concentrated on the corporate Linux machine, where it belongs.

---

## Repository layout

Recommended private repo:

```text
tailscale-fleet/
├── ts
├── rdp.tsv
├── ssh-keys.tsv
├── fleet.tsv
└── README.md
```

The repo is configuration source material. Runtime installation is separate:

```text
~/.local/bin/ts
```

Canonical local configuration is:

```text
~/.config/ts/
├── rdp.tsv
├── ssh-keys.tsv
├── fleet.tsv
└── backups/
```

The Tailscale binaries and persistent node identity live under:

```text
~/.local/share/tailscale-user/
├── bin/
├── state/
└── rdp/
```

The controller private key lives here:

```text
~/.ssh/ts-fleet-ed25519
```

**Never put that private key in Git.** Public keys are public. Private keys are the bit where cryptography stops being decorative.

---

# Installation

## Fresh rootless Linux machine

From the cloned private repo:

```bash
chmod +x ts
./ts self-install
hash -r

ts config install --from .
ts setup MACHINE_NAME
```

Example:

```bash
ts setup taylor
```

`ts setup`:

1. installs `ts` into `~/.local/bin/ts`;
2. downloads the latest stable static Tailscale binaries;
3. verifies the downloaded archive SHA-256;
4. starts `tailscaled` in userspace networking mode;
5. uses `systemd --user` when available, otherwise a `nohup` fallback;
6. authenticates the node;
7. starts the RDP bridge if RDP bindings exist.

The normal daemon is equivalent to:

```text
tailscaled
    --tun=userspace-networking
    --statedir=~/.local/share/tailscale-user/state
    --socket=<user runtime socket>
    --socks5-server=127.0.0.1:1055
    --outbound-http-proxy-listen=127.0.0.1:1055
```

No sudo. No TUN device. No system-wide installation.

Authentication state is persistent. Browser authentication is **not** required every time the daemon restarts. Reauthentication happens only when Tailscale actually requires it, or after things such as `logout`, state deletion, key expiry, or `purge`.

An auth key may be supplied non-interactively:

```bash
TAILSCALE_AUTHKEY=tskey-... ts setup MACHINE_NAME
```

Do not paste permanent auth keys into random shell history because even I have limits.

---

# Daily commands

```bash
ts status
ts doctor

ts start
ts stop
ts restart

ts up
ts down
ts logout

ts ping MACHINE
ts netcheck
ts ip -4
ts whois 100.x.y.z

ts version
ts update
```

Anything `ts` does not implement itself is forwarded to the bundled Tailscale CLI through the private daemon socket.

Examples:

```bash
ts ip -4
ts whois 100.92.252.75
ts file cp thing.zip hostname-vmware:
```

This is intentional. `ts` is a control layer, not a doomed attempt to reimplement the entire Tailscale CLI in Bash.

---

# Rootless networking: important limitation

Userspace Tailscale does **not** install a normal OS route to the tailnet.

Therefore this may not work directly from arbitrary applications:

```bash
ssh badasspc
curl http://100.x.y.z/
xfreerdp /v:badasspc
```

The operating system has no `tailscale0` interface.

Use the mechanisms provided by `ts` instead:

```bash
ts ssh ...
ts rdp ...
ts nc ...
```

or expose the userspace proxy environment:

```bash
eval "$(ts proxy-env)"
```

which exports SOCKS5/HTTP proxy variables pointing to:

```text
127.0.0.1:1055
```

Applications must actually honor those proxy variables. Software remains software.

---

# RDP

This is one of the main reasons this thing exists.

`ts` gives each remote RDP machine its own loopback address:

```text
127.77.0.1:3389 -> badasspc:3389
127.77.0.2:3389 -> hostname-vmware:3389
127.77.0.3:3389 -> kubuntu-whatever:3389
...
```

All bindings can keep the normal RDP port because each machine gets a different loopback IP. This is considerably less stupid than remembering whether port `13392` was PSCAD, COMSOL, Brazil, or something created while sleep deprived.

## Add an RDP machine

Normal case:

```bash
ts rdp add badasspc --user Username
```

`TARGET` defaults to `NAME`.

Another machine:

```bash
ts rdp add hostname-vmware \
    --user 'DOMAIN-NAME\user'
```

Use an alias when desired:

```bash
ts rdp add aliasname badasspc \
    --user Username
```

Explicit target IP with a real certificate identity:

```bash
ts rdp add aliasname 100.92.252.75 \
    --user Username \
    --server-name badasspc
```

Useful options:

```text
--user USER
--server-name NAME
--ip 127.x.x.x
--port PORT
--rdp-arg ARG
--clear-rdp-args
```

Defaults:

```text
TARGET       = NAME
local IP     = first free 127.77.0.x
local port   = 3389
remote port  = 3389
server name  = TARGET
```

MagicDNS machine names are preferred over hard-coded Tailscale IPs.

## Connect

```bash
ts rdp badasspc
ts rdp hostname-vmware
```

`ts` finds `xfreerdp3`, `xfreerdp`, or `wlfreerdp` and launches it with sane defaults:

```text
+clipboard
/dynamic-resolution
```

Yes, **clipboard redirection is enabled by default**. This project refuses to accept a world where a VM/remote-desktop stack cannot reliably move text from Ctrl+C to Ctrl+V across two computers. We put humans on the fucking Moon.

## RDP certificates

The TCP connection is actually made to something such as:

```text
127.77.0.1:3389
```

but the server certificate belongs to:

```text
badasspc
```

`ts` handles that correctly. It tells FreeRDP to validate the actual remote server name while using TOFU for the normal self-signed Windows RDP certificate.

It does **not** blindly use `/cert:ignore`.

If the Tailscale target and Windows certificate name differ:

```bash
ts rdp add aliasname 100.92.252.75 \
    --server-name badasspc
```

## Pass arbitrary FreeRDP options

Anything after the machine name can be relayed to FreeRDP:

```bash
ts rdp kubuntu -- -rfx
ts rdp kubuntu -- -rfx /f
ts rdp badasspc -- /f
```

Invocation-specific arguments are appended last so they can override `ts` defaults.

This is deliberate. I am not releasing `ts` v4.0.2 every time FreeRDP or xrdp develops a new personality disorder.

## Persistent per-machine FreeRDP options

For the Kubuntu/xrdp machine with the old RemoteFX resize bug:

```bash
ts rdp args kubuntu -- -rfx
```

Then normal use remains:

```bash
ts rdp kubuntu
```

Inspect:

```bash
ts rdp args kubuntu
```

Clear:

```bash
ts rdp args kubuntu --clear
```

The persistent argument vector is stored internally as base64-encoded JSON in `rdp.tsv`. Do not hand-edit that field unless decoding command-line arguments for recreation sounds like a meaningful evening.

## Manage the bridge

```bash
ts rdp list

ts rdp start
ts rdp stop
ts rdp restart
ts rdp status

ts rdp rm MACHINE
```

`ts start` also starts configured RDP bindings.

---

# SSH

Rootless Tailscale cannot transparently route normal OpenSSH, so `ts` uses:

```text
ssh
  |
  +-- ProxyCommand
        |
        +-- tailscale nc HOST 22
```

Usage:

```bash
ts ssh user@machine
```

All normal SSH arguments are accepted:

```bash
ts ssh -v user@not4games
ts ssh -L 8080:localhost:8080 user@not4games
```

The SSH server must actually exist on the destination. `ts` can bend networking around corporate restrictions; it cannot SSH into a machine with no SSH daemon because physics has not yet been deprecated.

---

# Fleet configuration

There are three independent registries:

```text
rdp.tsv        RDP endpoints
ssh-keys.tsv   SSH public identities and authorization scope
fleet.tsv      machines managed over SSH
```

They intentionally are **not** treated as equivalent.

A machine can be:

- an RDP endpoint but not an SSH-managed host;
- an SSH-managed Linux host with no RDP;
- a key owner without being a managed destination;
- all of the above.

Trying to infer all of that from one hostname column is how configuration formats become archaeological sites.

## Inspect configuration

```bash
ts config path
ts config show

ts config key list
ts config host list
```

---

# `ts config install`

From the private `tailscale-fleet` repo:

```bash
ts config install
```

By default, the current directory is the source.

Explicit source:

```bash
ts config install --from ~/src/tailscale-fleet
```

Dry-run:

```bash
ts config install --from . --dry-run
```

The installer:

- reads repository configuration;
- reads existing `~/.config/ts` configuration;
- checks known legacy locations;
- migrates old RDP record formats;
- merges equivalent records;
- deduplicates SSH keys by actual public-key material;
- unions compatible SSH authorization scopes;
- validates loopback addresses, ports, host definitions, key formats, etc.;
- aborts on real conflicts;
- makes timestamped backups before replacing existing configuration;
- writes files atomically with restrictive permissions;
- restarts the RDP bridge when its registry changed and the bridge was already running;
- is idempotent.

Running this repeatedly is supposed to be boring:

```bash
ts config install
ts config install
ts config install
```

Boring configuration management is good configuration management.

**`config install` does not propagate SSH keys to remote machines.**

That is a separate operation:

```bash
ts config push --all
```

It also does not automatically commit local registry changes back to Git.

---

# Private Git repo workflow

Recommended repository:

```text
tailscale-fleet/
├── ts
├── rdp.tsv
├── ssh-keys.tsv
├── fleet.tsv
└── README.md
```

Install/merge from Git:

```bash
git pull
ts config install --from .
```

Changes made with commands such as:

```bash
ts rdp add ...
ts config key ...
ts config host ...
```

modify the canonical files under:

```text
~/.config/ts/
```

They do **not** automatically modify or commit the files in the Git checkout.

Until an explicit export command exists, copy the canonical registries back before committing:

```bash
cp ~/.config/ts/rdp.tsv .
cp ~/.config/ts/ssh-keys.tsv .
cp ~/.config/ts/fleet.tsv .

git diff
git add rdp.tsv ssh-keys.tsv fleet.tsv
git commit
git push
```

This is intentionally explicit. Automatically `git push`-ing access-control changes from a networking script would be the kind of clever idea that becomes an incident report.

---

# Fleet hosts

Register an SSH-managed Linux host:

```bash
ts config host add not4games \
    --user username \
    --os linux
```

Register Windows:

```bash
ts config host add badasspc \
    --user Username \
    --os windows
```

If `TARGET` differs from the logical name:

```bash
ts config host add NAME TARGET \
    --user USER \
    --os linux
```

List:

```bash
ts config host list
```

Remove:

```bash
ts config host rm NAME
```

`fleet.tsv` stores:

```text
NAME|TARGET|SSH_USER|OS
```

Despite the `.tsv` suffix, the registry is currently pipe-delimited. Naming things remains one of computer science's least solved problems.

---

# SSH public-key registry

Add a key literally:

```bash
ts config key add machine-name \
    'ssh-ed25519 AAAA... comment'
```

Add from a public-key file:

```bash
ts config key add machine-name \
    @~/.ssh/id_ed25519.pub
```

Authorize it on selected fleet hosts:

```bash
ts config key add machine-name \
    @~/.ssh/id_ed25519.pub \
    --on host1,host2
```

Change scope:

```bash
ts config key scope machine-name host1,host2
```

Authorize everywhere:

```bash
ts config key scope machine-name '*'
```

Keep the key in inventory but authorize it nowhere:

```bash
ts config key scope machine-name '-'
```

List:

```bash
ts config key list
```

Remove:

```bash
ts config key rm machine-name
```

`ssh-keys.tsv` stores:

```text
NAME|TYPE|PUBLIC_KEY_DATA|COMMENT|TARGETS
```

Only public keys belong here.

---

# Controller key

Initialize one dedicated administrative key on the main controller:

```bash
ts config controller init johnnycage
```

Default without a name:

```bash
ts config controller init
```

This creates:

```text
~/.ssh/ts-fleet-ed25519
~/.ssh/ts-fleet-ed25519.pub
```

The public key is registered automatically with scope:

```text
*
```

The private key **never** goes under `~/.config/ts`.

That separation is what makes the config directory suitable for a private Git repository.

---

# Push SSH authorization to the fleet

One host:

```bash
ts config push badasspc
```

Everything:

```bash
ts config push --all
```

Alias:

```bash
ts config sync --all
```

The controller connects over Tailscale + SSH and manages only this block:

```text
# BEGIN ts managed keys
...
# END ts managed keys
```

Existing manually managed `authorized_keys` entries outside that block are preserved.

On Linux:

```text
~/.ssh/authorized_keys
```

On Windows:

- normal user: `%USERPROFILE%\.ssh\authorized_keys`
- administrator: `%ProgramData%\ssh\administrators_authorized_keys`

The Windows administrative path gets the required ACL handling.

## Bootstrap rule

The first push to a new machine still requires **some existing way to SSH into it**:

- password;
- previously installed key;
- other accepted SSH credential.

There is no magical protocol by which a machine with zero trust relationship accepts a new administrative key merely because I glare at it.

After the controller key has been propagated, later pushes should be passwordless.

---

# Full-mesh SSH

To make every machine key trusted by every registered fleet destination:

```bash
ts config key scope hostname-vmware '*'
ts config key scope not4games '*'
ts config key scope badasspc '*'
ts config key scope hostname-zbook '*'

ts config push --all
```

Conceptually:

```text
badasspc      <------> hostname-vmware
     ^                       ^
     | \                   / |
     |   \               /   |
     |     \           /     |
     v       \       /       v
hostname-zbook  <------> not4games
```

This creates the **authorization policy** for full mesh.

It does not manufacture missing private keys on source machines, start missing SSH servers, or test every possible N² source/destination pair.

---

# Check controller access

One host:

```bash
ts config check badasspc
```

All registered hosts:

```bash
ts config check --all
```

This verifies **passwordless SSH from the controller to each fleet host**.

It is not an exhaustive pairwise full-mesh test.

---

# Apply managed keys locally

For a Linux host that already has the configuration locally:

```bash
ts config apply
```

or explicitly:

```bash
ts config apply HOSTNAME
```

This updates the local user's `~/.ssh/authorized_keys` managed block.

Remote fleet propagation should normally use:

```bash
ts config push ...
```

---

# Taildrop / file transfer

Native Tailscale file commands are available through passthrough.

Send:

```bash
ts file cp results.zip hostname-vmware:
```

Receive using the native CLI semantics:

```bash
ts file get .
```

There is deliberately no separate file-transfer subsystem in `ts`. Taildrop already exists. Reimplementing it would be engineering cosplay.

For command/control, configuration deployment still uses SSH because SSH gives deterministic remote paths, execution, permissions, and validation.

---

# Lifecycle and destructive commands

Update only the bundled Tailscale binaries:

```bash
ts update
```

Install a specific Tailscale version:

```bash
ts install VERSION
```

Show versions:

```bash
ts version
```

Remove Tailscale binaries and user services **while preserving node identity and `ts` configuration**:

```bash
ts uninstall
```

Nuclear option:

```bash
ts purge
```

`purge` removes:

- Tailscale binaries;
- persistent Tailscale node state;
- `~/.config/ts`;
- RDP configuration;
- fleet/key registries.

After `purge`, expect to authenticate the Tailscale node again.

Do not type `purge` recreationally.

---

# `ts doctor`

Run:

```bash
ts doctor
```

It reports the state of:

- Tailscale binaries;
- `tailscaled`;
- Python 3;
- FreeRDP;
- RDP bindings;
- RDP bridge;
- SSH-key registry;
- fleet registry;
- controller key.

It is a sanity check, not divine revelation.

---

# Useful machine setup pattern

## Main rootless controller

```bash
git clone <PRIVATE_REPO_URL> tailscale-fleet
cd tailscale-fleet

chmod +x ts
./ts self-install
hash -r

ts config install --from .
ts setup taylor

ts config controller init taylor

ts config push --all
ts config check --all
```

The first `push --all` may prompt for remote SSH credentials until the controller key has been installed.

## Add another Windows VM

Install normal Tailscale inside the Windows VM and enable whatever services are needed, typically OpenSSH Server and/or RDP.

Then on the controller:

```bash
ts config host add hostname-vmware \
    --user Username \
    --os windows

ts rdp add hostname-vmware \
    --user 'DOMAIN-NAME\user'

ts config key scope hostname-vmware '*'

ts config push --all
```

Then:

```bash
ts ping hostname-vmware
ts rdp hostname-vmware
```

## Add a Linux fleet machine

```bash
ts config host add not4games \
    --user username \
    --os linux

ts config key scope not4games '*'

ts config push --all
ts config check --all
```

SSH:

```bash
ts ssh user@not4games
```

---

# Environment variables

```text
TAILSCALE_USER_HOME
    Tailscale state root.
    Default: ~/.local/share/tailscale-user

TAILSCALE_USER_PROXY_ADDR
    Userspace SOCKS5/HTTP listener.
    Default: 127.0.0.1:1055

TAILSCALE_AUTHKEY
    Optional auth key used by setup/up.

TS_RDP_CONFIG
    Alternate RDP registry.

TS_SSH_KEYS_CONFIG
    Alternate SSH public-key registry.

TS_FLEET_CONFIG
    Alternate fleet registry.

TS_FLEET_IDENTITY
    Alternate controller private-key path.
    Default: ~/.ssh/ts-fleet-ed25519
```

---

# Command cheat sheet

```bash
# Help / diagnostics
ts help
ts status
ts doctor
ts version

# Tailscale lifecycle
ts setup HOSTNAME
ts start
ts stop
ts restart
ts up
ts down
ts logout
ts update

# Native Tailscale
ts ping HOST
ts netcheck
ts ip -4
ts whois IP
ts nc HOST PORT
ts file cp FILE HOST:
ts file get DIR

# SSH
ts ssh user@host

# RDP
ts rdp add NAME [TARGET] --user USER
ts rdp add NAME TARGET --server-name CERT_NAME
ts rdp list
ts rdp NAME
ts rdp NAME -- /f
ts rdp args NAME -- -rfx
ts rdp args NAME --clear
ts rdp rm NAME
ts rdp start
ts rdp stop
ts rdp restart
ts rdp status

# Config installation / migration
ts config install
ts config install --from DIR
ts config install --from DIR --dry-run
ts config path
ts config show

# Fleet
ts config host add NAME [TARGET] --user USER --os linux|windows
ts config host list
ts config host rm NAME

# SSH public keys
ts config key add NAME @key.pub --on '*'
ts config key scope NAME '*'
ts config key scope NAME host1,host2
ts config key scope NAME '-'
ts config key list
ts config key rm NAME

# Controller
ts config controller init [NAME]

# Authorization deployment
ts config apply [HOSTNAME]
ts config push HOST
ts config push --all
ts config sync --all
ts config check HOST
ts config check --all

# Proxy environment for arbitrary proxy-aware programs
eval "$(ts proxy-env)"

# Removal
ts uninstall
ts purge
```

---

# Design principles

1. **No sudo on the rootless workstation.**
2. **One command: `ts`.**
3. **Use native Tailscale functionality whenever possible instead of cloning it badly.**
4. **Keep machine inventory declarative.**
5. **Preserve existing SSH authorization outside the managed block.**
6. **Do not silently resolve configuration conflicts.**
7. **Do not disable RDP certificate validation merely because loopback bridging makes hostname verification inconvenient.**
8. **Pass arbitrary FreeRDP arguments through rather than hard-code every future workaround.**
9. **Private controller keys never enter the config repo.**
10. **Clipboard must fucking work.**

That last one is not negotiable.
