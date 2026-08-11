# tailscale-fleet

Toolkit for turning a pile of Linux machines, Windows boxes, VMware guests, remote workstations, QEMU self-inflicted suffering, and corporate-managed nonsense into one private Tailscale realm without needing root on the client machine.

Current `ts` version: **4.5.2**

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
        +---- SSHFS/FUSE ------------------------> fleet host SFTP
        |       +-- ~/tailscale-fleet/MACHINE/SHARE on MACHINE
        |       +-- stable SHARE symlink -> SHARE on MACHINE
        |       +-- ProxyCommand: ts nc HOST 22
        |
        +---- Windows ACL control ---------------> PowerShell / icacls
        |       +-- current SSH identity SID
        |       +-- explicit ownership/system-drive guards
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
└── tests/
```

The same checkout may contain these deliberately ignored, machine-specific
configuration sources:

```text
tailscale-fleet/
├── rdp.tsv
├── ssh-keys.tsv
├── fleet.tsv
├── mounts.tsv
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
├── mounts.tsv           # portable declarative SSHFS shares
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

ts mounts
ts mount MACHINE --all
ts unmount MACHINE --all
ts acl show WINDOWS_MACHINE PATH_OR_SHARE

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
/title:FreeRDP: tailscale-fleet MACHINE
```

Yes, **clipboard redirection is enabled by default**. This project refuses to accept a world where a VM/remote-desktop stack cannot reliably move text from Ctrl+C to Ctrl+V across two computers. We put humans on the fucking Moon.

The window title uses the configured `ts` machine name rather than the bridge
or direct endpoint IP. Override it for one launch with, for example:

```bash
ts rdp badasspc -- '/title:Custom RDP session'
```

## Passwordless RDP with the desktop keyring

RDP uses the Windows account password through NLA/CredSSP; it does not use SSH
keys. Passwordless launch requires `secret-tool` (from libsecret) and a working
desktop Secret Service such as GNOME Keyring. Store the current password once:

```bash
ts rdp credential set windows-qemu
ts rdp credential set windows-laptop
```

Credentials are keyed by both machine and Windows username. Keep several users
for one machine and select one at launch:

```bash
ts rdp credential set windows-qemu --user Administrator
ts rdp credential set windows-qemu --user Engineer

ts rdp windows-qemu --user Administrator --direct
ts rdp windows-qemu --user Engineer --direct
```

Without `--user`, the username stored in `rdp.tsv` remains the default.
The selected value is the exact FreeRDP Windows identity; quote domain-qualified
forms such as `'WINDOWS-QEMU\Administrator'` in the shell.

The command reads and confirms the password without echoing it. Check or remove
an entry without ever printing the secret:

```bash
ts rdp credential status windows-qemu
ts rdp credential status windows-qemu --user Engineer
ts rdp credential forget windows-qemu
ts rdp credential forget windows-qemu --user Engineer
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

# Managed fleet filesystems

The rootless controller has no kernel Tailscale route, but SSHFS does not need
one. Its SFTP connection uses the same OpenSSH `ProxyCommand` transport as
`ts ssh`:

```text
ROOTLESS CONTROLLER

~/tailscale-fleet/
├── windows-box/
│   ├── drive_c -> drive_c on windows-box/
│   ├── drive_c on windows-box/        # FUSE mount shown by Files
│   ├── drive_d -> drive_d on windows-box/
│   ├── drive_d on windows-box/
│   ├── drive_f -> drive_f on windows-box/
│   └── drive_f on windows-box/
├── windows-vm/
│   ├── drive_c -> drive_c on windows-vm/
│   ├── drive_c on windows-vm/
│   ├── drive_d -> drive_d on windows-vm/
│   └── drive_d on windows-vm/
└── linux-machine/
    ├── home -> home on linux-machine/
    ├── home on linux-machine/
    ├── data -> data on linux-machine/
    └── data on linux-machine/

drive_c on windows-box
    |
    +-- SSHFS/FUSE
          |
          +-- SFTP / OpenSSH
                |
                +-- ProxyCommand: ts nc %h %p
                      |
                      +-- rootless userspace tailscaled
                            |
                            +-- Tailscale -> Windows OpenSSH -> C:\
```

No sudo, no TUN device, no assumption that the operating system can route to a
`100.x` address. FUSE mounts appear naturally in GNOME Files, and the local
namespace does not change according to whatever random directory seemed
available when the mount was first tested.

And apparently moving files between VMs in 2026 still requires personally
assembling a small distributed operating system because VM tooling remains
offended by the concept of convenient file access and functioning
Ctrl+C/Ctrl+V.

## Mount registry

`~/.config/ts/mounts.tsv` is portable declarative configuration:

```text
MACHINE|SHARE|REMOTE|USER
windows-box|drive_c|/C:/|
windows-box|drive_d|/D:/|User
linux-box|home|/home/user|
linux-box|data|/srv/data|
```

An empty `USER` inherits the SSH login user from `fleet.tsv`. A mount machine
must already exist there because its target, user, and OS metadata are part of
the transport. Both local paths are derived rather than stored:

```text
stable path:      ${TS_MOUNT_ROOT:-$HOME/tailscale-fleet}/MACHINE/SHARE
FUSE mountpoint:  ${TS_MOUNT_ROOT:-$HOME/tailscale-fleet}/MACHINE/SHARE on MACHINE
```

GNOME Files derives a local FUSE mount's sidebar name from the mountpoint
basename, so the real mountpoint produces names such as `drive_c on
windows-box`. The original `MACHINE/SHARE` path is retained as a relative
symlink, which keeps scripts, terminal navigation, and existing paths working.

Machine and share identifiers cannot contain `/`, `..`, or other traversal
syntax. `TS_MOUNT_ROOT` must be absolute.

Register a generic remote path:

```bash
ts mount add linux-box home --remote /home/user
ts mount add linux-box data --remote /srv/data --user another-login
```

Windows OpenSSH exposes drive roots through SFTP as `/C:/`, `/D:/`, and so on.
The shorthand validates and normalizes one drive letter:

```bash
ts mount add windows-box drive_c --drive C
ts mount add windows-box drive_d --drive D
ts mount add windows-box drive_f --drive F
```

Adding the same `MACHINE + SHARE` replaces that definition atomically instead
of making a duplicate. Inspect or remove definitions with:

```bash
ts mount list
ts mount rm windows-box drive_f
```

An active definition must be unmounted before it can be removed; otherwise the
live FUSE mount would become unmanaged and disappear from `ts mounts`.

## Mount and unmount

Mount one share, every share for a machine, or the complete registry:

```bash
ts mount windows-box drive_d
ts mount windows-box --all
ts mount --all
```

Every SSHFS connection includes:

```text
ProxyCommand=<current ts executable> nc %h %p
reconnect
ServerAliveInterval=15
ServerAliveCountMax=3
StrictHostKeyChecking=accept-new
```

The dedicated fleet identity is also used when present. Host-key verification
is not disabled. Invocation-specific SSHFS arguments go after `--` and are
appended after the defaults without `eval`:

```bash
ts mount windows-box drive_d -- -o cache=yes
```

Repeated mounting is idempotent. `ts` checks the actual mount table and the
fleet `fsname`; it does not mistake an existing empty directory for a live
filesystem. If some unrelated filesystem occupies either derived path, it
refuses to stack another mount there. It also refuses to replace or mount over
local data when creating the compatibility symlink.

Runtime inspection combines configuration with real OS mount state:

```bash
ts mounts
```

```text
MACHINE       SHARE      REMOTE   LOCAL                                      STATE
windows-box    drive_c    /C:/     ~/tailscale-fleet/windows-box/drive_c      mounted
windows-box    drive_d    /D:/     ~/tailscale-fleet/windows-box/drive_d      mounted
windows-box    drive_f    /F:/     ~/tailscale-fleet/windows-box/drive_f      unmounted
```

Unmounting is likewise single-share or batched and uses `fusermount3` (or the
compatible user FUSE tool) without sudo:

```bash
ts unmount windows-box drive_d
ts unmount windows-box --all
ts unmount --all
```

An already-unmounted share is a success. Mountpoint directories may remain;
`ts` never recursively deletes arbitrary content under the mount root. Batch
operations attempt every independent record, report individual failures, and
return failure if any item failed.

Mounts created by version 4.5.0 at the old `MACHINE/SHARE` mountpoint remain
fully manageable and appear in `ts mounts` as `mounted-legacy-label`. To adopt
the descriptive Files name without interrupting an active filesystem, explicitly
unmount and mount it once:

```bash
ts unmount windows-box drive_c
ts mount windows-box drive_c
```

The empty old mountpoint is then replaced with the compatibility symlink. No
mounted filesystem is changed automatically during upgrade or config install.

SSHFS, a compatible FUSE unmount command, and accessible `/dev/fuse` are needed
only for mounting. Their absence does not affect SSH, RDP, ACL inspection, or
native Tailscale passthrough.

---

# Remote Windows ACL control

Windows OpenSSH/SFTP can reach a drive while NTFS ACLs still hide parts of its
tree from the SSH account. `ts` can inspect or explicitly grant that same remote
SSH security principal Full Control:

```bash
ts acl show windows-box 'D:\Projects'
ts acl grant windows-box 'D:\Projects'
```

Mount aliases resolve exactly through `mounts.tsv`:

```bash
ts acl show windows-box drive_d
ts acl grant windows-box drive_d
```

For a definition such as `windows-box|drive_d|/D:/|`, `drive_d` becomes `D:\`.
Supported OpenSSH paths such as `/D:/Research` become `D:\Research`. Other
remote path formats are not guessed; provide a native Windows path explicitly.
There is no fuzzy alias matching.

ACL commands are accepted only for fleet hosts whose `fleet.tsv` OS is
`windows`. They run over the existing SSH -> `ts nc` -> rootless Tailscale
transport. There is no WinRM side channel.

## What grant changes

The remote PowerShell payload obtains the real current SSH identity and numeric
SID through Windows APIs. It passes the SID to `icacls.exe` in numeric form and
uses a replace-style grant equivalent to:

```text
SID:(OI)(CI)F /T /C
```

That grants Full Control to the requested tree, replaces repeat grants for only
that principal, and preserves unrelated ACEs. It does **not** reset the ACL,
disable inheritance globally, replace SYSTEM/Administrators/TrustedInstaller
entries, or infer a brittle `MACHINE\User` name.

Mutation requires an elevated remote SSH token. An unelevated session fails
before `takeown` or `icacls` mutation and reports the remote account. `ts` does
not disable UAC, change `LocalAccountTokenFilterPolicy`, or alter Windows
security policy. Remote-token filtering may explain an unelevated token; fixing
that policy remains an operator decision.

## Dangerous escalation flags

Normal grant never changes ownership. If ACL modification cannot succeed with
the current owner/control state, it fails. Ownership is available only with the
deliberately invasive flag:

```bash
ts acl grant windows-box drive_f --take-ownership
```

This runs recursive `takeown.exe` as the current SSH account before `icacls` and
reports that ownership changed. Review the target first.

Recursive Full Control over the exact `C:\` root includes Windows, Program
Files, system data, and service-owned paths, so it is refused unless separately
acknowledged:

```bash
ts acl grant windows-box drive_c --system-drive
```

An ordinary folder on C does not need that flag:

```bash
ts acl grant windows-box 'C:\Users\User\Projects'
```

Whole-C ownership escalation requires both acknowledgements:

```bash
ts acl grant windows-box drive_c \
    --system-drive \
    --take-ownership
```

`--take-ownership` and `--system-drive` are not convenience switches. They are
there so destructive scope cannot be reached by accident or implication.

## PowerShell transport safety

Paths with spaces, apostrophes, parentheses, `&`, and Unicode are encoded as
UTF-8/base64 data. The local script decodes that data inside PowerShell; the
complete script is then encoded as UTF-16LE/base64 and sent with:

```text
powershell.exe -NoProfile -NonInteractive -EncodedCommand PAYLOAD
```

No user path is interpolated into executable PowerShell source or a remote shell
quote maze. Quoted heredocs preserve PowerShell backticks, and neither mount nor
ACL code uses `eval`.

---

# Fleet configuration

There are four portable registries and two host-local direct-transport registries:

```text
rdp.tsv          portable RDP identities and Tailscale endpoints
ssh-keys.tsv     client login public keys copied to authorized_keys
fleet.tsv        SSH destinations: target, login user, and OS
mounts.tsv       declarative SSHFS shares; local mountpoints are derived
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

From the `tailscale-fleet` checkout:

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
- validates loopback addresses, ports, host definitions, key formats, mount
  identifiers, remote paths, and mount-to-fleet references;
- aborts on real conflicts;
- makes timestamped backups before replacing existing configuration and retains
  the newest five snapshots by default;
- writes files atomically with restrictive permissions;
- restarts the RDP bridge when its registry changed and the bridge was already running;
- never mounts, unmounts, or otherwise changes active FUSE runtime state;
- ignores `rdp-direct.tsv`, `ssh-direct.tsv`, and `credentials.tsv` in the source and preserves local copies;
- is idempotent.

Running this repeatedly is supposed to be boring:

```bash
ts config install
ts config install
ts config install
```

Boring configuration management is good configuration management.

Backup snapshots live under `~/.config/ts/backups`. Only timestamped snapshots
created by `ts` participate in pruning. Set `TS_CONFIG_BACKUP_KEEP` to another
positive integer when five is not the desired retention count.

**`config install` does not propagate SSH keys to remote machines.**

That is a separate operation:

```bash
ts config push --all
```

## Save installed portable configuration

Export the current installed portable registries back into the directory where
the command is run:

```bash
ts config save
```

Or name an existing target directory:

```bash
ts config save /path/to/tailscale-fleet
```

This atomically saves `rdp.tsv`, `ssh-keys.tsv`, `fleet.tsv`, and `mounts.tsv`
with mode `0600`. Unchanged files are left alone. It deliberately excludes host-local
`rdp-direct.tsv` and `ssh-direct.tsv`, bootstrap credentials, desktop-keyring
secrets, Tailscale state, and private SSH keys.

It also does not automatically commit local registry changes back to Git.

---

# Git workflow and publication boundary

The default `.gitignore` keeps all live fleet inventory out of Git:

```text
rdp.tsv
ssh-keys.tsv
fleet.tsv
mounts.tsv
rdp-direct.tsv
ssh-direct.tsv
credentials.tsv
```

Those ignored files may still live in the checkout and be consumed by
`ts config install --from .`; Git simply does not publish them. The tracked
repository contains the reusable CLI, documentation, and tests.

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
ts mount add ...
```

modify the canonical files under:

```text
~/.config/ts/
```

They do **not** automatically modify or commit the files in the Git checkout.

To refresh the ignored local source copies, run from the checkout:

```bash
ts config save
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
identifiers. `fleet.tsv`, `mounts.tsv`, `rdp.tsv`, and the direct registries similarly reveal
network topology and local machine details. They remain ignored for privacy and
operational compartmentalization, not because every field is a credential.

The tracked documentation uses generic example aliases. New examples should stay
generic so publishing the reusable source does not disclose a real deployment's
naming or topology.

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
windows-qemu|TEMPORARY_WINDOWS_PASSWORD
windows-laptop|TEMPORARY_WINDOWS_PASSWORD
```

Then bootstrap only the hosts listed in that file:

```bash
chmod 600 credentials.tsv
ts config bootstrap --all --credentials ./credentials.tsv
```

Passwords are read by SSH through `SSH_ASKPASS`; they are not placed in command
arguments, copied remotely, added to the key registry, or printed. Delete the
file after successful bootstrap.

After the controller key is accepted, enroll each machine's standard user login
key with explicit authorization targets:

```bash
ts config enroll HOST --on controller
ts config apply controller
```

Enrollment creates `~/.ssh/id_ed25519` (or `%USERPROFILE%\.ssh\id_ed25519`)
only when it is missing, retrieves only the `.pub` half, and scopes it to the
hosts named by `--on`. Enrollment changes the key registry; `config apply`
updates the current machine, while `config push` updates a remote target.

The lower-level first-contact alternatives remain:

- password;
- previously installed key;
- other accepted SSH credential.

There is no magical protocol by which a machine with zero trust relationship accepts a new administrative key merely because I glare at it.

After the controller key has been propagated, later pushes should be passwordless.

---

# Optional controller-and-spoke SSH policy

A controller-and-spoke deployment can choose this explicit policy:

```text
controller login key:  targets=*
remote login key:      targets=controller
```

That gives:

```text
Controller ──SSH/RDP──► every fleet machine
every fleet machine ──SSH/file transfer──► Controller
```

The rootless controller publishes its existing local SSH server privately through
Tailscale Serve:

```bash
tailscale serve --bg --tcp 22 tcp://127.0.0.1:22
```

It remains private to the tailnet. Remote machines connect normally:

```bash
ssh controller-user@controller
```

## Direct SSH to a local QEMU guest

Configure once on the enclosing host:

```bash
ts ssh direct set windows-qemu \
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
ts ssh windows-qemu --direct
```

Inspect or remove the host-local mapping with:

```bash
ts ssh direct show windows-qemu
ts ssh direct list
ts ssh direct rm windows-qemu
```

This lazily starts the VM, injects/reuses the QEMU localhost forward, waits for
Windows OpenSSH, and connects with the fleet login user. The reverse direct path
from this QEMU guest to its enclosing host is `controller-user@10.0.2.2:22`; it uses
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
- fleet/key/mount registries.

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
- optional `sshfs`, `fusermount3`/compatible FUSE, and `/dev/fuse` capability;
- configured and actually active fleet-mount counts;
- SSH-key registry;
- fleet registry;
- controller key.

It is a sanity check, not divine revelation.

Missing `virsh`, `vmrun`, SSHFS, or FUSE is informational and does not make the
overall check fail. Those tools are required only when their corresponding
direct or mount capability is used.

## Tests

The focused smoke tests cover static/direct RDP providers, lazy QEMU RDP and SSH
forwarding, shutdown waiting, VMware discovery, per-user desktop-keyring password
delivery through FreeRDP stdin, portable config export, and five-snapshot backup
retention. Mount/ACL tests cover registry replacement and merge conflicts,
deterministic paths, SSHFS construction and passthrough, real-state detection,
batch partial failures, encoded Unicode PowerShell payloads, SID grants,
ownership ordering, system-drive protection, OS guards, and elevation errors.
They also check that SSH enrollment cannot fall back to an implicit personal
hub. They use mocked `sshfs`, `findmnt`, `fusermount3`, `virsh`, `vmrun`, `ssh`,
`secret-tool`, and FreeRDP commands; they do not mount filesystems, contact a
Windows host, start real VMs, access the real keyring, or touch live registries:

```bash
tests/test-rdp-direct.sh
tests/test-mount-acl.sh
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

Register and mount its Windows drives once OpenSSH/SFTP is available:

```bash
ts mount add hostname-vmware drive_c --drive C
ts mount add hostname-vmware drive_d --drive D
ts mount add hostname-vmware drive_f --drive F

ts mount hostname-vmware --all
ts mounts
```

If NTFS permissions hide part of `drive_f`, inspect before changing it:

```bash
ts acl show hostname-vmware drive_f
ts acl grant hostname-vmware drive_f
```

The active SSHFS mount sees access changes without redefining the share. When
finished:

```bash
ts unmount hostname-vmware --all
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

TS_MOUNTS_CONFIG
    Alternate portable mount registry.

TS_MOUNT_ROOT
    Deterministic local fleet mount root.
    Default: ~/tailscale-fleet

TS_FLEET_IDENTITY
    Alternate controller private-key path.
    Default: ~/.ssh/ts-fleet-ed25519

TS_CONFIG_BACKUP_KEEP
    Number of timestamped config-install snapshots retained.
    Default: 5
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

# Managed SSHFS mounts
ts mount add MACHINE SHARE --remote PATH [--user USER]
ts mount add MACHINE SHARE --drive LETTER [--user USER]
ts mount rm MACHINE SHARE
ts mount list
ts mount MACHINE SHARE
ts mount MACHINE SHARE -- -o cache=yes
ts mount MACHINE --all
ts mount --all
ts mounts
ts unmount MACHINE SHARE
ts unmount MACHINE --all
ts unmount --all

# Remote Windows ACLs
ts acl show MACHINE PATH_OR_SHARE
ts acl grant MACHINE PATH_OR_SHARE
ts acl grant MACHINE PATH_OR_SHARE --take-ownership
ts acl grant MACHINE PATH_OR_SHARE --system-drive
ts acl grant MACHINE PATH_OR_SHARE --system-drive --take-ownership

# RDP
ts rdp add NAME [TARGET] --user USER
ts rdp add NAME TARGET --server-name CERT_NAME
ts rdp list
ts rdp credential set NAME
ts rdp credential set NAME --user USER
ts rdp credential status NAME
ts rdp credential forget NAME
ts rdp NAME
ts rdp NAME --user USER
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
ts config save [TARGET_DIR]
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
ts config enroll HOST|--all --on HOST[,HOST...]|*
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
10. **Mountpoints are derived; live FUSE state is inspected, not imagined.**
11. **Windows ACL changes are explicit, SID-based, and never silently take ownership.**
12. **User-controlled Windows paths travel as encoded data, not quote soup.**
13. **Clipboard must fucking work.**

That last one is not negotiable.
