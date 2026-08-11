#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TS="$ROOT/ts"
FIXTURES="$ROOT/tests/fixtures"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ts-mount-acl-tests.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

export HOME="$TEST_ROOT/home"
export XDG_CONFIG_HOME="$TEST_ROOT/config"
export TAILSCALE_USER_HOME="$TEST_ROOT/state"
export TS_MOUNT_ROOT="$TEST_ROOT/fleet-mounts"
export TS_FUSE_DEVICE="$TEST_ROOT/fuse"
export PATH="$FIXTURES:$PATH"
export MOCK_SSHFS_LOG="$TEST_ROOT/sshfs.log"
export MOCK_MOUNT_STATE="$TEST_ROOT/mount-state"
export MOCK_FUSERMOUNT_LOG="$TEST_ROOT/fusermount.log"
export MOCK_SSH_LOG="$TEST_ROOT/ssh.log"

mkdir -p "$HOME"
touch "$TS_FUSE_DEVICE" "$MOCK_SSHFS_LOG" "$MOCK_MOUNT_STATE" "$MOCK_FUSERMOUNT_LOG"
chmod 600 "$TS_FUSE_DEVICE"

pass_count=0
fail() { printf 'not ok - %s\n' "$*" >&2; exit 1; }
pass() { pass_count=$((pass_count + 1)); printf 'ok %d - %s\n' "$pass_count" "$1"; }
assert_line() {
    local file="$1" expected="$2"
    grep -Fqx -- "$expected" "$file" || fail "expected '$expected' in $file"
}
assert_contains() {
    local value="$1" expected="$2"
    grep -Fq -- "$expected" <<< "$value" || fail "expected output to contain '$expected'"
}
assert_not_contains() {
    local value="$1" unwanted="$2"
    if grep -Fq -- "$unwanted" <<< "$value"; then fail "output unexpectedly contains '$unwanted'"; fi
}
expect_failure() {
    local output_file="$1"; shift
    if "$@" > "$output_file" 2>&1; then fail "command unexpectedly succeeded: $*"; fi
}

"$TS" config host add win win.tail.example --user Alice --os windows >/dev/null
"$TS" config host add linux linux.tail.example --user Lin --os linux >/dev/null
"$TS" mount add linux home --remote /home/Lin >/dev/null
"$TS" mount add win drive_d --drive d >/dev/null
"$TS" mount add win projects --remote /D:/Projects --user ProjectUser >/dev/null
assert_line "$XDG_CONFIG_HOME/ts/mounts.tsv" 'linux|home|/home/Lin|'
assert_line "$XDG_CONFIG_HOME/ts/mounts.tsv" 'win|drive_d|/D:/|'
assert_line "$XDG_CONFIG_HOME/ts/mounts.tsv" 'win|projects|/D:/Projects|ProjectUser'
list_output="$("$TS" mount list)"
assert_contains "$list_output" 'Alice (fleet)'
assert_contains "$list_output" 'ProjectUser'
pass 'mount registry adds generic paths, drive shorthand, inherited users, and overrides'

"$TS" mount add win drive_d --remote /D:/Updated >/dev/null
[[ "$(awk -F '|' '$1 == "win" && $2 == "drive_d" {count++} END {print count+0}' "$XDG_CONFIG_HOME/ts/mounts.tsv")" -eq 1 ]] \
    || fail 'mount update created a duplicate record'
assert_line "$XDG_CONFIG_HOME/ts/mounts.tsv" 'win|drive_d|/D:/Updated|'
"$TS" mount add win drive_d --drive D >/dev/null
expect_failure "$TEST_ROOT/bad-drive" "$TS" mount add win broken --drive DD
assert_contains "$(cat "$TEST_ROOT/bad-drive")" 'one alphabetic letter'
expect_failure "$TEST_ROOT/unknown-host" "$TS" mount add missing data --remote /data
assert_contains "$(cat "$TEST_ROOT/unknown-host")" 'unknown fleet host'
expect_failure "$TEST_ROOT/traversal" "$TS" mount add win ../escape --remote /D:/
assert_contains "$(cat "$TEST_ROOT/traversal")" 'mount share must match'
pass 'mount updates are unique and invalid drives, hosts, and traversal are rejected'

derived="$(bash -c 'source "$1"; TS_MOUNT_ROOT=/tmp/fleet; mount_local_path host1 drive_d' bash "$TS")"
[[ "$derived" == /tmp/fleet/host1/drive_d ]] || fail "unexpected mount path: $derived"
actual_derived="$(bash -c 'source "$1"; TS_MOUNT_ROOT=/tmp/fleet; mount_actual_path host1 drive_d' bash "$TS")"
[[ "$actual_derived" == '/tmp/fleet/host1/drive_d on host1' ]] \
    || fail "unexpected Files-facing mount path: $actual_derived"
pass 'canonical and Files-facing mountpoint derivation is deterministic'

: > "$MOCK_SSHFS_LOG"
: > "$MOCK_MOUNT_STATE"
"$TS" mount win drive_d -- -o cache=yes >/dev/null
assert_line "$MOCK_SSHFS_LOG" 'Alice@win.tail.example:/D:/'
assert_line "$MOCK_SSHFS_LOG" "$TS_MOUNT_ROOT/win/drive_d on win"
assert_line "$MOCK_SSHFS_LOG" "ProxyCommand=$TS nc %h %p"
assert_line "$MOCK_SSHFS_LOG" reconnect
assert_line "$MOCK_SSHFS_LOG" ServerAliveInterval=15
assert_line "$MOCK_SSHFS_LOG" ServerAliveCountMax=3
assert_line "$MOCK_SSHFS_LOG" fsname=tailscale-fleet/win/drive_d
[[ "$(tail -n 2 "$MOCK_SSHFS_LOG")" == $'-o\ncache=yes' ]] \
    || fail 'invocation SSHFS arguments were not appended last'
if grep -Fqx -- sudo "$MOCK_SSHFS_LOG"; then fail 'mount command invoked sudo'; fi
[[ -L "$TS_MOUNT_ROOT/win/drive_d" ]] || fail 'canonical mount path is not a compatibility symlink'
[[ "$(readlink "$TS_MOUNT_ROOT/win/drive_d")" == 'drive_d on win' ]] \
    || fail 'compatibility symlink does not target the Files-facing mountpoint'
before_lines="$(wc -l < "$MOCK_SSHFS_LOG")"
"$TS" mount win drive_d >/dev/null
[[ "$(wc -l < "$MOCK_SSHFS_LOG")" -eq "$before_lines" ]] \
    || fail 'already-mounted invocation called sshfs again'
state_output="$("$TS" mounts)"
assert_contains "$state_output" 'drive_d'
assert_contains "$state_output" 'mounted'
assert_contains "$state_output" 'projects'
assert_contains "$state_output" 'unmounted'
pass 'SSHFS command construction, passthrough, runtime state, and mount idempotency work'

"$TS" unmount win drive_d >/dev/null
[[ ! -s "$MOCK_MOUNT_STATE" ]] || fail 'unmount did not clear synthetic mount state'
before_lines="$(wc -l < "$MOCK_FUSERMOUNT_LOG")"
"$TS" unmount win drive_d >/dev/null
[[ "$(wc -l < "$MOCK_FUSERMOUNT_LOG")" -eq "$before_lines" ]] \
    || fail 'already-unmounted invocation called fusermount again'
pass 'managed unmount is safe and idempotent'

rm -f -- "$TS_MOUNT_ROOT/win/drive_d"
rmdir -- "$TS_MOUNT_ROOT/win/drive_d on win"
mkdir -p -- "$TS_MOUNT_ROOT/win/drive_d"
printf '%s|fuse.sshfs|%s\n' \
    "$TS_MOUNT_ROOT/win/drive_d" 'tailscale-fleet/win/drive_d' > "$MOCK_MOUNT_STATE"
: > "$MOCK_SSHFS_LOG"
legacy_output="$("$TS" mount win drive_d 2>&1)"
assert_contains "$legacy_output" 'legacy Files label'
[[ ! -s "$MOCK_SSHFS_LOG" ]] || fail 'legacy active mount was mounted a second time'
assert_contains "$("$TS" mounts)" 'mounted-legacy-label'
"$TS" unmount win drive_d >/dev/null
"$TS" mount win drive_d >/dev/null
[[ -L "$TS_MOUNT_ROOT/win/drive_d" ]] || fail 'legacy mountpoint was not migrated to a symlink'
assert_line "$MOCK_MOUNT_STATE" "$TS_MOUNT_ROOT/win/drive_d on win|fuse.sshfs|tailscale-fleet/win/drive_d"
"$TS" unmount win drive_d >/dev/null
pass 'legacy mounts remain manageable and migrate after explicit unmount/remount'

"$TS" mount add win drive_c --drive C >/dev/null
"$TS" mount add win drive_f --drive F >/dev/null
: > "$MOCK_MOUNT_STATE"
: > "$MOCK_SSHFS_LOG"
export MOCK_SSHFS_FAIL_SHARE=drive_c
expect_failure "$TEST_ROOT/batch-failure" "$TS" mount --all
unset MOCK_SSHFS_FAIL_SHARE
assert_line "$MOCK_MOUNT_STATE" "$TS_MOUNT_ROOT/linux/home on linux|fuse.sshfs|tailscale-fleet/linux/home"
assert_line "$MOCK_MOUNT_STATE" "$TS_MOUNT_ROOT/win/drive_d on win|fuse.sshfs|tailscale-fleet/win/drive_d"
assert_line "$MOCK_MOUNT_STATE" "$TS_MOUNT_ROOT/win/drive_f on win|fuse.sshfs|tailscale-fleet/win/drive_f"
assert_contains "$(cat "$TEST_ROOT/batch-failure")" 'mount failed for win/drive_c'
"$TS" unmount --all >/dev/null
pass 'global batch mount continues after failure and global unmount processes every share'

printf '%s|ext4|/dev/mock\n' "$TS_MOUNT_ROOT/win/drive_d on win" > "$MOCK_MOUNT_STATE"
expect_failure "$TEST_ROOT/occupied" "$TS" mount win drive_d
assert_contains "$(cat "$TEST_ROOT/occupied")" 'occupied by an incompatible filesystem'
: > "$MOCK_MOUNT_STATE"
pass 'incompatible mountpoints are refused'

touch "$TS_MOUNT_ROOT/win/drive_d on win/local-data"
expect_failure "$TEST_ROOT/local-data" "$TS" mount win drive_d
assert_contains "$(cat "$TEST_ROOT/local-data")" 'refusing to hide local data'
[[ -f "$TS_MOUNT_ROOT/win/drive_d on win/local-data" ]] || fail 'local mountpoint data was removed'
rm -f -- "$TS_MOUNT_ROOT/win/drive_d on win/local-data"
pass 'Files-facing compatibility migration never hides or deletes local data'

INSTALL_ROOT="$TEST_ROOT/install-case"
mkdir -p "$INSTALL_ROOT/home" "$INSTALL_ROOT/old-source" "$INSTALL_ROOT/new-source" "$INSTALL_ROOT/conflict-source"
for source in old-source new-source conflict-source; do
    touch "$INSTALL_ROOT/$source/rdp.tsv" "$INSTALL_ROOT/$source/ssh-keys.tsv"
    printf 'host1|host1.tail|User1|windows\n' > "$INSTALL_ROOT/$source/fleet.tsv"
done
HOME="$INSTALL_ROOT/home" XDG_CONFIG_HOME="$INSTALL_ROOT/config" TAILSCALE_USER_HOME="$INSTALL_ROOT/state" \
    "$TS" config install --from "$INSTALL_ROOT/old-source" >/dev/null
[[ -f "$INSTALL_ROOT/config/ts/mounts.tsv" && ! -s "$INSTALL_ROOT/config/ts/mounts.tsv" ]] \
    || fail 'old installation without mounts.tsv was not normalized to an empty registry'
printf 'host1|drive_d|/D:/|\n' > "$INSTALL_ROOT/new-source/mounts.tsv"
printf '%s|fuse.sshfs|%s\n' \
    "$TS_MOUNT_ROOT/win/drive_d" 'tailscale-fleet/win/drive_d' > "$MOCK_MOUNT_STATE"
mount_state_before="$(cat "$MOCK_MOUNT_STATE")"
HOME="$INSTALL_ROOT/home" XDG_CONFIG_HOME="$INSTALL_ROOT/config" TAILSCALE_USER_HOME="$INSTALL_ROOT/state" \
    "$TS" config install --from "$INSTALL_ROOT/new-source" >/dev/null
[[ "$(cat "$MOCK_MOUNT_STATE")" == "$mount_state_before" ]] \
    || fail 'config install altered active mount runtime state'
assert_line "$INSTALL_ROOT/config/ts/mounts.tsv" 'host1|drive_d|/D:/|'
backup_count="$(find "$INSTALL_ROOT/config/ts/backups" -mindepth 1 -maxdepth 1 -type d | wc -l)"
[[ "$backup_count" -ge 1 ]] || fail 'config install did not back up existing portable config'
backup_mount="$(find "$INSTALL_ROOT/config/ts/backups" -mindepth 2 -maxdepth 2 -name mounts.tsv | head -n 1)"
[[ -n "$backup_mount" ]] || fail 'config backup did not include mounts.tsv'
HOME="$INSTALL_ROOT/home" XDG_CONFIG_HOME="$INSTALL_ROOT/config" TAILSCALE_USER_HOME="$INSTALL_ROOT/state" \
    "$TS" config install --from "$INSTALL_ROOT/new-source" >/dev/null
[[ "$(find "$INSTALL_ROOT/config/ts/backups" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq "$backup_count" ]] \
    || fail 'idempotent config install created an unnecessary backup'
printf 'host1|drive_d|/E:/|\n' > "$INSTALL_ROOT/conflict-source/mounts.tsv"
expect_failure "$TEST_ROOT/config-conflict" env \
    HOME="$INSTALL_ROOT/home" XDG_CONFIG_HOME="$INSTALL_ROOT/config" TAILSCALE_USER_HOME="$INSTALL_ROOT/state" \
    "$TS" config install --from "$INSTALL_ROOT/conflict-source"
assert_contains "$(cat "$TEST_ROOT/config-conflict")" 'conflicting mount definition'
pass 'config install merges, validates, backs up, conflicts, and remains idempotent with mounts.tsv'

saved="$TEST_ROOT/saved"
mkdir -p "$saved"
touch "$XDG_CONFIG_HOME/ts/rdp.tsv"
"$TS" config save "$saved" >/dev/null
cmp "$XDG_CONFIG_HOME/ts/mounts.tsv" "$saved/mounts.tsv" >/dev/null \
    || fail 'config save omitted or changed mounts.tsv'
assert_contains "$("$TS" config show)" 'mount-registry:'
pass 'portable config save/show includes the mount registry'

translate_output="$(bash -c 'source "$1"; windows_remote_to_native /C:/; windows_remote_to_native /D:/Projects; windows_remote_to_native /F:/a/b' bash "$TS")"
[[ "$translate_output" == $'C:\\\nD:\\Projects\nF:\\a\\b' ]] \
    || fail "unexpected Windows path translation: $translate_output"
if bash -c 'source "$1"; windows_remote_to_native /srv/data' bash "$TS" >/dev/null 2>&1; then
    fail 'unsupported remote path was translated to Windows syntax'
fi
pass 'only supported OpenSSH Windows drive paths translate to native paths'

acl_test() {
    bash -c '
        source "$1"
        shift
        fleet_ssh_base() { local -n result=$1; result=(ssh); }
        acl_command "$@"
    ' bash "$TS" "$@"
}
decode_acl_command() {
    local command encoded
    command="$(tail -n 1 "$MOCK_SSH_LOG")"
    encoded="${command##* }"
    python3 - "$encoded" <<'PY_DECODE_ACL'
import base64, sys
print(base64.b64decode(sys.argv[1]).decode("utf-16le"), end="")
PY_DECODE_ACL
}
decoded_acl_path() {
    python3 - "$1" <<'PY_DECODE_PATH'
import base64, re, sys
script = sys.argv[1]
match = re.search(r"^\$pathPayload = '([^']+)'$", script, re.MULTILINE)
if not match:
    raise SystemExit("path payload missing")
print(base64.b64decode(match.group(1)).decode("utf-8"), end="")
PY_DECODE_PATH
}

acl_test grant win drive_d >/dev/null
acl_script="$(decode_acl_command)"
[[ "$(decoded_acl_path "$acl_script")" == 'D:\' ]] || fail 'ACL alias did not resolve to D:\'
assert_contains "$(tail -n 1 "$MOCK_SSH_LOG")" 'powershell.exe -NoProfile -NonInteractive -OutputFormat Text -ExecutionPolicy Bypass -EncodedCommand'
assert_contains "$acl_script" '[Security.Principal.WindowsIdentity]::GetCurrent()'
assert_contains "$acl_script" '$sid = $identity.User.Value'
assert_contains "$acl_script" '$grant = "*$($sid):(OI)(CI)F"'
assert_contains "$acl_script" '& icacls.exe $path /grant:r $grant /T /C'
assert_contains "$acl_script" '$takeOwnership = $false'
assert_contains "$acl_script" 'remote Windows SSH session is not elevated'
assert_contains "$acl_script" '`r and `n'
assert_not_contains "$acl_script" 'LocalAccountTokenFilterPolicy'
assert_not_contains "$acl_script" 'Set-ItemProperty'
acl_test show win projects >/dev/null
acl_script="$(decode_acl_command)"
[[ "$(decoded_acl_path "$acl_script")" == 'D:\Projects' ]] \
    || fail 'ACL alias with a nested Windows remote did not translate'
assert_line "$MOCK_SSH_LOG" 'ProjectUser'
pass 'ACL grant resolves aliases and constructs SID-based, recursive, preserving encoded PowerShell'

for windows_path in 'D:\Projects' 'D:\My Projects' 'D:\A&B' "D:\O'Brien" 'D:\(test)' 'D:\Unicode-λ'; do
    acl_test show win "$windows_path" >/dev/null
    acl_script="$(decode_acl_command)"
    [[ "$(decoded_acl_path "$acl_script")" == "$windows_path" ]] \
        || fail "ACL path did not survive encoding: $windows_path"
    if grep -Fq -- "$windows_path" "$MOCK_SSH_LOG"; then
        fail "raw ACL path leaked into the remote shell command: $windows_path"
    fi
done
pass 'spaces, apostrophes, ampersands, parentheses, and Unicode survive ACL payload encoding'

acl_test grant win drive_d --take-ownership >/dev/null
acl_script="$(decode_acl_command)"
assert_contains "$acl_script" '$takeOwnership = $true'
assert_contains "$acl_script" '& takeown.exe /F $path /R /D Y'
takeown_line="$(grep -nF '& takeown.exe' <<< "$acl_script" | cut -d: -f1)"
icacls_line="$(grep -nF '& icacls.exe $path /grant:r' <<< "$acl_script" | cut -d: -f1)"
(( takeown_line < icacls_line )) || fail 'takeown was not ordered before icacls'
pass 'ownership escalation is explicit and precedes ACL mutation'

: > "$MOCK_SSH_LOG"
expect_failure "$TEST_ROOT/system-guard" acl_test grant win drive_c
assert_contains "$(cat "$TEST_ROOT/system-guard")" '--system-drive'
[[ ! -s "$MOCK_SSH_LOG" ]] || fail 'system-drive guard ran a remote command'
acl_test grant win drive_c --system-drive >/dev/null
acl_test grant win 'C:\Users\Alice\Projects' >/dev/null
acl_test grant win drive_c --system-drive --take-ownership >/dev/null
pass 'whole C drive requires an independent explicit system-drive acknowledgement'

: > "$MOCK_SSH_LOG"
expect_failure "$TEST_ROOT/os-guard" acl_test grant linux 'D:\Data'
assert_contains "$(cat "$TEST_ROOT/os-guard")" 'windows fleet host'
[[ ! -s "$MOCK_SSH_LOG" ]] || fail 'OS guard constructed a Windows remote command for Linux'
pass 'Windows ACL operations reject Linux fleet hosts before transport construction'

export MOCK_SSH_MODE=acl-unelevated
expect_failure "$TEST_ROOT/unelevated" acl_test grant win drive_d
unset MOCK_SSH_MODE
assert_contains "$(cat "$TEST_ROOT/unelevated")" 'remote Windows SSH session is not elevated'
assert_contains "$(cat "$TEST_ROOT/unelevated")" 'cannot modify ACL for D:\'
pass 'unelevated remote ACL sessions fail clearly without changing Windows policy'

doctor_output="$("$TS" doctor 2>&1 || true)"
assert_contains "$doctor_output" 'sshfs'
assert_contains "$doctor_output" 'fusermount3'
assert_contains "$doctor_output" '/dev/fuse'
assert_contains "$doctor_output" 'configured-mounts'
assert_contains "$doctor_output" 'active-fleet-mounts'
pass 'doctor reports optional SSHFS/FUSE capability and fleet mount counts'

printf '1..%d\n' "$pass_count"
