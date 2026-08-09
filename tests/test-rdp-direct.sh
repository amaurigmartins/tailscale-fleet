#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TS="$ROOT/ts"
FIXTURES="$ROOT/tests/fixtures"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ts-rdp-direct-tests.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

export XDG_CONFIG_HOME="$TEST_ROOT/config"
export TAILSCALE_USER_HOME="$TEST_ROOT/state"
export PATH="$FIXTURES:$PATH"
export MOCK_FREERDP_LOG="$TEST_ROOT/freerdp.log"
export MOCK_FREERDP_STDIN_LOG="$TEST_ROOT/freerdp-stdin.log"
export MOCK_SECRET_STORE="$TEST_ROOT/rdp-secret"
export MOCK_SSH_LOG="$TEST_ROOT/ssh.log"
export MOCK_VIRSH_STATE="$TEST_ROOT/virsh-state"
export MOCK_VIRSH_LOG="$TEST_ROOT/virsh.log"
export MOCK_VIRSH_DOMIFLIST="$TEST_ROOT/domiflist"
export MOCK_VIRSH_ADDR_DIR="$TEST_ROOT/addresses"
export MOCK_VIRSH_USERNET="$TEST_ROOT/usernet"
export MOCK_VMRUN_STATE="$TEST_ROOT/vmrun-state"
export MOCK_VMRUN_LOG="$TEST_ROOT/vmrun.log"
export MOCK_VMRUN_VMX="$TEST_ROOT/windows.vmx"
export MOCK_VMWARE_IP="172.16.20.44"

mkdir -p "$MOCK_VIRSH_ADDR_DIR"
: > "$MOCK_VIRSH_LOG"
: > "$MOCK_VIRSH_USERNET"
: > "$MOCK_VMRUN_LOG"
printf 'running\n' > "$MOCK_VIRSH_STATE"
printf 'running\n' > "$MOCK_VMRUN_STATE"
touch "$MOCK_VMRUN_VMX"

pass_count=0
fail() { printf 'not ok - %s\n' "$*" >&2; exit 1; }
pass() { pass_count=$((pass_count + 1)); printf 'ok %d - %s\n' "$pass_count" "$1"; }
assert_contains() {
    local file="$1" expected="$2"
    grep -Fqx -- "$expected" "$file" || fail "expected '$expected' in $file"
}
assert_text_contains() {
    local value="$1" expected="$2"
    grep -Fq -- "$expected" <<<"$value" || fail "expected output to contain '$expected'"
}
run_launch() {
    : > "$MOCK_FREERDP_LOG"
    bash -c '
        source "$1"
        shift
        direct_tcp_ready() { return 0; }
        rdp_launch "$@"
    ' bash "$TS" "$@"
}

"$TS" rdp add windows windows.tail.example --user Alice --server-name windows-cert >/dev/null

"$TS" rdp direct set windows --address 127.0.0.1 --port 13389 >/dev/null
run_launch windows --direct -- /f
assert_contains "$MOCK_FREERDP_LOG" '/v:127.0.0.1:13389'
assert_contains "$MOCK_FREERDP_LOG" '/server-name:windows-cert'
assert_contains "$MOCK_FREERDP_LOG" '/f'
pass 'static direct endpoint launches FreeRDP'

printf 'test-password\ntest-password\n' | "$TS" rdp credential set windows >/dev/null
status="$("$TS" rdp credential status windows)"
assert_text_contains "$status" 'stored in desktop keyring'
run_launch windows --direct
assert_contains "$MOCK_FREERDP_LOG" '/from-stdin:force'
[[ "$(cat "$MOCK_FREERDP_STDIN_LOG")" == 'test-password' ]] \
    || fail 'stored RDP password was not delivered through FreeRDP stdin'
"$TS" rdp credential forget windows >/dev/null
[[ ! -e "$MOCK_SECRET_STORE" ]] || fail 'RDP credential was not removed'
pass 'RDP credential uses the desktop keyring and FreeRDP stdin'

cat > "$MOCK_VIRSH_DOMIFLIST" <<'EOF_DOMIFLIST'
 Interface   Type      Source    Model    MAC
-------------------------------------------------------------
 vnet0       network   default   virtio   52:54:00:aa:00:01
EOF_DOMIFLIST
cat > "$MOCK_VIRSH_ADDR_DIR/lease" <<'EOF_LEASE'
 Name   MAC address          Protocol   Address
-------------------------------------------------------------------------------
 vnet0  52:54:00:aa:00:01    ipv4       192.168.122.55/24
EOF_LEASE
: > "$MOCK_VIRSH_ADDR_DIR/agent"
: > "$MOCK_VIRSH_ADDR_DIR/arp"
"$TS" rdp direct set windows --libvirt-domain windows-dev --libvirt-uri qemu:///system >/dev/null
run_launch windows --direct
assert_contains "$MOCK_FREERDP_LOG" '/v:192.168.122.55:13389'
pass 'libvirt endpoint discovers the guest address'

"$TS" rdp direct set windows --libvirt-user-domain windows-dev --libvirt-uri qemu:///system \
    --host-address 127.0.0.1 --port 13389 --guest-port 3389 --netdev hostnet0 >/dev/null
"$TS" rdp direct lifecycle set windows --libvirt-domain windows-dev --libvirt-uri qemu:///system \
    --start-policy on-demand --boot-timeout 2 >/dev/null
: > "$MOCK_VIRSH_LOG"
: > "$MOCK_VIRSH_USERNET"
printf 'shut off\n' > "$MOCK_VIRSH_STATE"
export MOCK_FREERDP_SHUTDOWN_STATE="$MOCK_VIRSH_STATE"
run_launch windows --direct --wait-for-shutdown
unset MOCK_FREERDP_SHUTDOWN_STATE
assert_contains "$MOCK_FREERDP_LOG" '/v:127.0.0.1:13389'
assert_text_contains "$(sed -n '1,$p' "$MOCK_VIRSH_LOG")" 'start windows-dev'
assert_text_contains "$(sed -n '1,$p' "$MOCK_VIRSH_LOG")" \
    'qemu-monitor-command windows-dev --hmp hostfwd_add hostnet0 tcp:127.0.0.1:13389-:3389'
[[ "$(sed -n '1p' "$MOCK_VIRSH_STATE")" == 'shut off' ]] || fail 'shutdown wait returned before the VM stopped'
if grep -Fqx -- '--wait-for-shutdown' "$MOCK_FREERDP_LOG"; then
    fail '--wait-for-shutdown was passed to FreeRDP'
fi
pass 'libvirt user networking starts the VM, creates its forward, and waits for shutdown'

"$TS" config host add windows windows-dev --user Alice --os windows >/dev/null
if "$TS" config enroll windows > "$TEST_ROOT/enroll-error" 2>&1; then
    fail 'config enroll accepted an implicit authorization target'
fi
assert_text_contains "$(cat "$TEST_ROOT/enroll-error")" 'requires explicit --on'
if "$TS" config enroll windows --on windows > "$TEST_ROOT/enroll-error" 2>&1; then
    fail 'config enroll accepted a sole self-authorization target'
fi
assert_text_contains "$(cat "$TEST_ROOT/enroll-error")" 'cannot enroll'
pass 'SSH enrollment requires explicit non-self authorization targets'

"$TS" ssh direct set windows --libvirt-user-domain windows-dev --libvirt-uri qemu:///system \
    --host-address 127.0.0.1 --port 10022 --guest-port 22 --netdev hostnet0 \
    --start-policy on-demand --boot-timeout 2 >/dev/null
: > "$MOCK_VIRSH_LOG"
: > "$MOCK_VIRSH_USERNET"
printf 'shut off\n' > "$MOCK_VIRSH_STATE"
bash -c '
    source "$1"
    direct_tcp_ready() { return 0; }
    ssh_direct_launch windows
' bash "$TS"
assert_contains "$MOCK_SSH_LOG" '-p'
assert_contains "$MOCK_SSH_LOG" '10022'
assert_contains "$MOCK_SSH_LOG" 'Alice@127.0.0.1'
assert_text_contains "$(sed -n '1,$p' "$MOCK_VIRSH_LOG")" \
    'qemu-monitor-command windows-dev --hmp hostfwd_add hostnet0 tcp:127.0.0.1:10022-:22'
pass 'direct SSH starts the VM and creates its localhost forward'

"$TS" rdp direct set windows --vmx "$MOCK_VMRUN_VMX" --port 3389 >/dev/null
"$TS" rdp direct lifecycle set windows --vmx "$MOCK_VMRUN_VMX" --start-policy manual >/dev/null
run_launch windows --direct
assert_contains "$MOCK_FREERDP_LOG" '/v:172.16.20.44:3389'
pass 'VMware endpoint discovers the guest address'

printf '1..%d\n' "$pass_count"
