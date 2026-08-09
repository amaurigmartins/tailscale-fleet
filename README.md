# tailscale-fleet

Toolkit for turning a pile of Linux machines, Windows boxes, VMware guests, remote workstations, QEMU self-inflicted suffering, and corporate-managed nonsense into one private Tailscale realm without needing root on the client machine.

Current `ts` version: **4.2.0**

The executable is simply:

```text
ts
```

because I am not typing `tailscale-user-rootless-proxy-rdp-fleet-controller-final-v7.sh` for the rest of my life.

## What the heck is this about?

The original problem was simple:

- corporate Rocky Linux workstation;
- no root;
- remote Windows machines;
- Windows VMs under VMware;
- need SSH, RDP, file transfer, and sane machine-to-machine access;
- Tailscale's normal Linux install wants root because it creates a TUN interface and system routes;
- VMware/KRDC/etc. somehow managed to make **Ctrl+C on Linux → Ctrl+V on Windows** feel like a crackpot distributed-systems research problem.

So `ts` does the useful parts itself:

```text
Rocky / rootless Linux
        |
        | userspace tailscaled
        | SOCKS5/HTTP 127.0.0.1:1055
        |
        +---- ts ssh ---- tailscale nc ----------> fleet host :22
        |       |
        |       +---- --direct ------------------> local QEMU guest :22
        |
        +---- Tailscale Serve :22 <--------------- fleet return SSH
        |
        +---- RDP bridge 127.77.0.x:3389 --------> Windows :3389
        |          |
        |          +---- FreeRDP
        |                +clipboard
        |                /dynamic-resolution
        |                desktop keyring -> /from-stdin
        |
        +---- explicit direct RDP ----------------> local/LAN VM :3389
                   +-- address, libvirt, or VMware endpoint
                   +-- optional independent VM lifecycle
        |
        +---- native Tailscale CLI passthrough
```

The Windows VMs and machines can run normal privileged Tailscale. The weirdness stays concentrated on the corporate Linux machine, where it belongs.

---

## Repository layout

Tracked source files:

```text
tailscale-fleet/
├── ts
├── README.md
├── .gitignore
├── ssh-keys.tsv.sample
└── tests/
```

The same checkout may contain these deliberately ignored, machine-specific
configuration sources:

```text
tailscale-fleet/
├── rdp.tsv
├── ssh-keys.tsv
├── fleet.tsv
├── rdp-direct.tsv
├── ssh-direct.tsv
└── credentials.tsv
```

The repo is configuration source material. Runtime installation is separate:

```text
~/.local/bin/ts
```

Canonical local configuration is:

```text
~/.config/ts/
├── rdp.tsv
├── rdp-direct.tsv       # host-local; never imported from the repo
├── ssh-direct.tsv       # host-local; never imported from the repo
├── ssh-keys.tsv
├── fleet.tsv
├── credentials.tsv      # optional bootstrap passwords; never imported
└── backups/
```

The Tailscale binaries and persistent node identity live under:

```text
~/.local/share/tailscale-user/
├── bin/
├── state/
└── rdp/
```

An optional dedicated controller private key lives here after
`ts config controller init`:

```text
~/.ssh/ts-fleet-ed25519
```

**Never put that private key in Git.** Public keys are public. Private keys are the bit where cryptography stops being decorative.

---

# Installation

## Fresh rootless Linux machine

From the cloned repo:

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

Another machine (note the nonsensical `DOMAIN-NAME` quirk of Windows RDP):

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

## Passwordless RDP with the desktop keyring

RDP uses the Windows account password through NLA/CredSSP; it does not use SSH
keys. Passwordless launch requires `secret-tool` (from libsecret) and a working
desktop Secret Service such as GNOME Keyring. Store the current password once:

```bash
ts rdp credential set amauri-qemu
ts rdp credential set barbara-vostro
```

The command reads and confirms the password without echoing it. Check or remove
an entry without ever printing the secret:

```bash
ts rdp credential status amauri-qemu
ts rdp credential forget amauri-qemu
```

When a credential exists, `ts rdp NAME` and `ts rdp NAME --direct` retrieve it
with `secret-tool` and deliver it to FreeRDP using `/from-stdin:force`. The
password is not placed in the repository, environment, command arguments, or
logs. An explicit FreeRDP authentication argument such as `/p:`, `/pth:`, or
`/from-stdin` overrides the keyring integration.

There is no bidirectional password synchronization. Windows stores no
recoverable plaintext password, so Windows remains the authentication authority
and the keyring contains an encrypted client-side copy. After changing a
Windows password, run `ts rdp credential set NAME` again. GNOME Keyring normally
unlocks with the Linux desktop login.

If `secret-tool` is absent or no entry exists, normal FreeRDP password prompting
continues to work. Keyring entries are outside `~/.config/ts`, so `ts uninstall`
and `ts purge` deliberately do not erase them; use `ts rdp credential forget
NAME` when removal is intended.

## Direct RDP to a local VM

The normal command remains the portable Tailscale route:

```bash
ts rdp windows
```

Use `--direct` only when you explicitly want a host-local or LAN route:

```bash
ts rdp windows --direct
```

There is no automatic route selection and no silent fallback. If a direct mapping is missing or cannot be resolved, the command fails instead of quietly taking the Tailscale path.

The direct model separates two concerns:

```text
endpoint provider   where FreeRDP connects
lifecycle provider which VM may be checked, started, or stopped
```

That distinction matters for QEMU user-mode networking. A Windows guest can be managed by libvirt while RDP is exposed through a host port forward:

```bash
ts rdp direct set windows \
    --libvirt-user-domain win11 \
    --libvirt-uri qemu:///system \
    --host-address 127.0.0.1 \
    --port 13389 \
    --guest-port 3389 \
    --netdev hostnet0

ts rdp direct lifecycle set windows \
    --libvirt-domain win11 \
    --libvirt-uri qemu:///system \
    --start-policy on-demand \
    --boot-timeout 180

ts rdp windows --direct
```

`libvirt-user` is the provider for QEMU's user-mode network backend. With `on-demand`, this single RDP command starts a stopped VM headlessly, checks the live QEMU network state, injects the host forward if it is missing, waits for Windows RDP, and launches FreeRDP. The forward is runtime state and is therefore recreated after a host or guest restart. Repeated invocations reuse an exact existing forward. Closing FreeRDP never stops the VM.

When shutting Windows down from inside the RDP session, keep the invoking terminal occupied until libvirt confirms the guest is fully off:

```bash
ts rdp windows --direct --wait-for-shutdown
```

This mode supervises FreeRDP instead of replacing `ts` with it. After RDP exits, it waits without a timeout for the configured lifecycle provider to report the VM stopped. Merely closing the RDP window does not shut down the VM, so use this option only when the session is expected to end with a guest shutdown; `Ctrl-C` cancels the wait.

The `--netdev` value is QEMU's user-network backend ID, commonly `hostnet0` in libvirt-generated command lines. `--port` is the host loopback port; `--guest-port` is the Windows RDP port. This provider deliberately does not rewrite persistent libvirt XML.

The default lifecycle policy is `manual`. Under that policy, a stopped managed VM produces an error:

```bash
ts rdp direct lifecycle set windows \
    --libvirt-domain win11 \
    --start-policy manual
```

Explicit lifecycle controls are available independently of connecting:

```bash
ts rdp direct start windows
ts rdp direct stop windows     # graceful shutdown request
```

### Endpoint providers

For a libvirt-managed guest whose LAN address is reachable from the host:

```bash
ts rdp direct set windows \
    --libvirt-domain win11 \
    --libvirt-uri qemu:///system \
    --mac 52:54:00:12:34:56
```

Address discovery tries libvirt lease, guest-agent, and ARP data in that order. It only accepts addresses belonging to an attached libvirt NIC, rejects loopback, link-local, zero-net, and Tailscale CGNAT addresses, and refuses to guess when multiple usable interfaces remain. Configure `--mac` to resolve such ambiguity.

For VMware Workstation:

```bash
ts rdp direct set windows \
    --vmx "$HOME/vmware/windows/windows.vmx"
```

The VMX path must be absolute. `vmrun` checks that exact VM and obtains its address through VMware Tools.

For an explicit host name or IPv4 address:

```bash
ts rdp direct set windows --address 192.168.50.25 --port 3389
```

Inspect or remove mappings with:

```bash
ts rdp direct list
ts rdp direct show windows
ts rdp direct lifecycle rm windows
ts rdp direct rm windows
```

Direct transport changes only FreeRDP's `/v:` destination. Username handling, certificate/server identity, TOFU, clipboard, dynamic resolution, persistent arguments, and invocation arguments remain the same as the normal route.

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

This is deliberate. I am not releasing a new `ts` version every time FreeRDP or xrdp develops a new personality disorder.

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

There are three portable registries and two host-local direct-transport registries:

```text
rdp.tsv          portable RDP identities and Tailscale endpoints
ssh-keys.tsv     client login public keys copied to authorized_keys
fleet.tsv        SSH destinations: target, login user, and OS
rdp-direct.tsv   local direct-RDP hypervisor mappings; never shared
ssh-direct.tsv   local direct-SSH hypervisor mappings; never shared
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
- ignores `rdp-direct.tsv`, `ssh-direct.tsv`, and `credentials.tsv` in the source and preserves local copies;
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

# Git workflow and publication boundary

The default `.gitignore` keeps all live fleet inventory out of Git:

```text
rdp.tsv
ssh-keys.tsv
fleet.tsv
rdp-direct.tsv
ssh-direct.tsv
credentials.tsv
```

Those ignored files may still live in the checkout and be consumed by
`ts config install --from .`; Git simply does not publish them. The tracked
repository contains the reusable CLI, documentation, tests, and a fake sample.

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

To refresh the ignored local source copies, use:

```bash
cp ~/.config/ts/rdp.tsv .
cp ~/.config/ts/ssh-keys.tsv .
cp ~/.config/ts/fleet.tsv .
```

They remain ignored. If inventory versioning is desired, use a separate private
configuration repository or deliberately change the ignore policy after
reviewing every field. Do not casually force-add the files.

Do not copy `~/.config/ts/rdp-direct.tsv` or `ssh-direct.tsv` into the repository. VMX paths, libvirt URIs, domain names, and host port forwards describe one hypervisor host rather than the fleet. `ts config install` deliberately refuses to import them. Bootstrap credentials are likewise host-local and ignored.

This is intentionally explicit. Automatically `git push`-ing access-control changes from a networking script would be the kind of clever idea that becomes an incident report.

## Public repository safety

The tracked source tree is designed to be publishable. The following must never
be committed:

- `credentials.tsv` or any password export;
- Tailscale auth keys, API keys, node state, or state backups;
- SSH private keys, including `~/.ssh/id_ed25519` and
  `~/.ssh/ts-fleet-ed25519`;
- desktop-keyring exports;
- live `~/.config/ts` backups or hypervisor definitions containing local paths.

`ssh-keys.tsv` contains public keys rather than private secrets, but publishing
it still discloses fleet names, usernames, authorization scope, and stable
identifiers. `fleet.tsv`, `rdp.tsv`, and the direct registries similarly reveal
network topology and local machine details. They remain ignored for privacy and
operational compartmentalization, not because every field is a credential.

The tracked code and examples intentionally retain personal deployment aliases
such as `amauri-zbook`, `amauri-qemu`, and `barbara-vostro`, plus the local login
name `amartins`. They grant no access, but they do disclose naming/topology
information. Replace them before publication if anonymity matters.

Before changing visibility or publishing a new commit, verify the boundary:

```bash
git status --short --ignored
git ls-files
gitleaks git --redact .      # when gitleaks is installed
```

Secret scanning does not make an accidentally committed secret safe. If one ever
enters Git history, revoke or rotate it first; deleting the current file is not
enough.

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

# SSH login-key registry

`ssh-keys.tsv` contains only client/user login public keys. These keys answer
"may this user log in?" and are copied into `authorized_keys`.

SSH server host keys answer "is this the same SSH server?" They are handled by
OpenSSH's `known_hosts` and must never be added to this registry.

```text
client private key                 destination
~/.ssh/id_ed25519                 ~/.ssh/authorized_keys
         │                                  ▲
         └── id_ed25519.pub ────────────────┘

server host public key ──────────► client ~/.ssh/known_hosts
```

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

Only client login public keys belong here. Private keys and server host keys do not.

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

The first push to a new machine requires its current login password or another
existing SSH credential. For temporary passwords, create a gitignored file with
mode `0600`:

```text
amauri-qemu|TEMPORARY_WINDOWS_PASSWORD
barbara-vostro|TEMPORARY_WINDOWS_PASSWORD
```

Then bootstrap only the hosts listed in that file:

```bash
chmod 600 credentials.tsv
ts config bootstrap --all --credentials ./credentials.tsv
```

Passwords are read by SSH through `SSH_ASKPASS`; they are not placed in command
arguments, copied remotely, added to the key registry, or printed. Delete the
file after successful bootstrap.

After the ZBook key is accepted, enroll each machine's standard user login key
for passwordless return SSH:

```bash
ts config enroll HOST --hub amauri-zbook
```

Enrollment creates `~/.ssh/id_ed25519` (or `%USERPROFILE%\.ssh\id_ed25519`)
only when it is missing, retrieves only the `.pub` half, scopes it to
`amauri-zbook`, and updates the ZBook's managed `authorized_keys` block.

The lower-level first-contact alternatives remain:

- password;
- previously installed key;
- other accepted SSH credential.

There is no magical protocol by which a machine with zero trust relationship accepts a new administrative key merely because I glare at it.

After the controller key has been propagated, later pushes should be passwordless.

---

# ZBook hub-and-spoke SSH

The personal fleet policy is intentionally simple:

```text
amauri-zbook login key:  targets=*
remote login key:        targets=amauri-zbook
```

That gives:

```text
ZBook ──SSH/RDP──► every fleet machine
every fleet machine ──SSH/file transfer──► ZBook
```

The rootless ZBook publishes its existing local SSH server privately through
Tailscale Serve:

```bash
tailscale serve --bg --tcp 22 tcp://127.0.0.1:22
```

It remains private to the tailnet. Remote machines connect normally:

```bash
ssh amartins@amauri-zbook
```

## Direct SSH to a local QEMU guest

Configure once on the enclosing host:

```bash
ts ssh direct set amauri-qemu \
    --libvirt-user-domain win11 \
    --libvirt-uri qemu:///system \
    --host-address 127.0.0.1 \
    --port 10022 \
    --guest-port 22 \
    --netdev hostnet0 \
    --start-policy on-demand
```

Then connect with:

```bash
ts ssh amauri-qemu --direct
```

Inspect or remove the host-local mapping with:

```bash
ts ssh direct show amauri-qemu
ts ssh direct list
ts ssh direct rm amauri-qemu
```

This lazily starts the VM, injects/reuses the QEMU localhost forward, waits for
Windows OpenSSH, and connects with the fleet login user. The reverse direct path
from this QEMU guest to its enclosing ZBook is `amartins@10.0.2.2:22`; it uses
the same login keys as the Tailscale path.

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

RDP passwords stored through `ts rdp credential set` live in the desktop
keyring rather than `~/.config/ts`; `purge` does not remove them. Forget those
entries explicitly when desired.

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
- availability of the desktop-keyring client used for stored RDP credentials;
- RDP bindings;
- RDP bridge;
- host-local direct RDP mappings;
- optional `virsh`, libvirt-connection, and `vmrun` capabilities;
- SSH-key registry;
- fleet registry;
- controller key.

It is a sanity check, not divine revelation.

Missing `virsh` or `vmrun` is informational and does not make the overall check fail. Those tools are required only when a configured direct provider uses them.

## Tests

The focused smoke tests cover static/direct RDP providers, lazy QEMU RDP and SSH
forwarding, shutdown waiting, VMware discovery, and desktop-keyring password
delivery through FreeRDP stdin. They use mocked `virsh`, `vmrun`, `ssh`,
`secret-tool`, and FreeRDP commands; they do not start real VMs, access the real
keyring, or touch live registries:

```bash
tests/test-rdp-direct.sh
```

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

TS_RDP_DIRECT_CONFIG
    Alternate host-local direct RDP registry.

TS_RDP_SECRET_SERVICE
    Desktop-keyring service name.
    Default: tailscale-fleet-rdp

TS_SSH_DIRECT_CONFIG
    Alternate host-local direct SSH registry.

TS_SSH_KEYS_CONFIG
    Alternate SSH login-public-key registry.

TS_FLEET_CREDENTIALS
    Bootstrap password file.
    Default: ~/.config/ts/credentials.tsv

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
ts ssh NAME --direct
ts ssh direct set NAME --libvirt-user-domain DOMAIN --libvirt-uri URI --port HOST_PORT
ts ssh direct show NAME
ts ssh direct list
ts ssh direct rm NAME

# RDP
ts rdp add NAME [TARGET] --user USER
ts rdp add NAME TARGET --server-name CERT_NAME
ts rdp list
ts rdp credential set NAME
ts rdp credential status NAME
ts rdp credential forget NAME
ts rdp NAME
ts rdp NAME -- /f
ts rdp NAME --direct
ts rdp NAME --direct -- /f
ts rdp args NAME -- -rfx
ts rdp args NAME --clear
ts rdp rm NAME
ts rdp start
ts rdp stop
ts rdp restart
ts rdp status

# Host-local direct RDP
ts rdp direct set NAME --address 127.0.0.1 --port 13389
ts rdp direct set NAME --libvirt-domain DOMAIN --libvirt-uri URI --mac MAC
ts rdp direct set NAME --libvirt-user-domain DOMAIN --libvirt-uri URI --port HOST_PORT
ts rdp direct set NAME --vmx /absolute/path/to/guest.vmx
ts rdp direct lifecycle set NAME --libvirt-domain DOMAIN --start-policy on-demand
ts rdp direct lifecycle rm NAME
ts rdp direct show NAME
ts rdp direct list
ts rdp direct start NAME
ts rdp direct stop NAME
ts rdp direct rm NAME

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

# SSH login public keys
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
ts config bootstrap HOST|--all --credentials ./credentials.tsv
ts config enroll HOST|--all --hub amauri-zbook
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
