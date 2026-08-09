#!/usr/bin/env bash
# ts - rootless Tailscale + private-realm CLI for managed Linux workstations.
#
# Single-user, no sudo, no TUN device. Tailscale runs in userspace mode.
# Adds declarative RDP bindings and FreeRDP launchers over the userspace SOCKS5 proxy.
set -Eeuo pipefail
umask 077

TS_NAME="ts"
TS_VERSION="4.4.0"
DAEMON_APP="tailscale-user"   # Preserve compatibility with the earlier installer/state.

BASE="${TAILSCALE_USER_HOME:-$HOME/.local/share/$DAEMON_APP}"
BIN_DIR="$BASE/bin"
STATE_DIR="$BASE/state"
LOG_FILE="$STATE_DIR/tailscaled.log"
PID_FILE="$STATE_DIR/tailscaled.pid"
PKG_BASE="https://pkgs.tailscale.com/stable"
PROXY_ADDR="${TAILSCALE_USER_PROXY_ADDR:-127.0.0.1:1055}"

TAILSCALE="$BIN_DIR/tailscale"
TAILSCALED="$BIN_DIR/tailscaled"

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/$TS_NAME"
RDP_CONFIG="${TS_RDP_CONFIG:-$CONFIG_HOME/rdp.tsv}"
RDP_DIRECT_CONFIG="${TS_RDP_DIRECT_CONFIG:-$CONFIG_HOME/rdp-direct.tsv}"
SSH_KEYS_CONFIG="${TS_SSH_KEYS_CONFIG:-$CONFIG_HOME/ssh-keys.tsv}"
SSH_DIRECT_CONFIG="${TS_SSH_DIRECT_CONFIG:-$CONFIG_HOME/ssh-direct.tsv}"
FLEET_CONFIG="${TS_FLEET_CONFIG:-$CONFIG_HOME/fleet.tsv}"
FLEET_CREDENTIALS="${TS_FLEET_CREDENTIALS:-$CONFIG_HOME/credentials.tsv}"
FLEET_IDENTITY="${TS_FLEET_IDENTITY:-$HOME/.ssh/ts-fleet-ed25519}"
RDP_SECRET_SERVICE="${TS_RDP_SECRET_SERVICE:-tailscale-fleet-rdp}"
CONFIG_BACKUP_KEEP="${TS_CONFIG_BACKUP_KEEP:-5}"
RDP_STATE="$BASE/rdp"
RDP_LOG="$RDP_STATE/bridge.log"
RDP_PID="$RDP_STATE/bridge.pid"
RDP_UNIT_NAME="ts-rdp.service"
RDP_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
RDP_UNIT_FILE="$RDP_UNIT_DIR/$RDP_UNIT_NAME"
SELF_INSTALL="$HOME/.local/bin/ts"

TS_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
TS_UNIT_FILE="$TS_UNIT_DIR/$DAEMON_APP.service"

SYSTEMD_MODE=0
RUNTIME_DIR=""
SOCKET=""

log() { printf '[%s] %s\n' "$TS_NAME" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

systemd_user_available() {
    have systemctl && systemctl --user show-environment >/dev/null 2>&1
}

select_runtime() {
    if systemd_user_available; then
        SYSTEMD_MODE=1
        RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/$DAEMON_APP"
    else
        SYSTEMD_MODE=0
        RUNTIME_DIR="$BASE/run"
    fi
    SOCKET="$RUNTIME_DIR/tailscaled.sock"
}

self_path() {
    local p
    p="$(command -v -- "$0" 2>/dev/null || true)"
    [[ -n "$p" ]] || p="$0"
    if have readlink; then
        readlink -f -- "$p" 2>/dev/null || printf '%s\n' "$p"
    else
        printf '%s\n' "$p"
    fi
}

install_self() {
    local src
    src="$(self_path)"
    mkdir -p "$(dirname "$SELF_INSTALL")"
    if [[ "$src" != "$SELF_INSTALL" ]]; then
        install -m 0755 "$src" "$SELF_INSTALL"
        log "installed CLI: $SELF_INSTALL"
    else
        chmod 0755 "$SELF_INSTALL"
    fi
}

arch_name() {
    case "$(uname -m)" in
        x86_64|amd64) printf 'amd64\n' ;;
        aarch64|arm64) printf 'arm64\n' ;;
        armv7l|armv7*) printf 'arm\n' ;;
        i386|i486|i586|i686) printf '386\n' ;;
        riscv64) printf 'riscv64\n' ;;
        *) die "unsupported CPU architecture: $(uname -m)" ;;
    esac
}

download_stdout() {
    local url="$1"
    if have curl; then
        curl -fsSL "$url"
    elif have wget; then
        wget -qO- "$url"
    else
        die "curl or wget is required"
    fi
}

download_file() {
    local url="$1" out="$2"
    if have curl; then
        curl -fL --retry 3 --retry-delay 1 -o "$out" "$url"
    elif have wget; then
        wget -O "$out" "$url"
    else
        die "curl or wget is required"
    fi
}

latest_version() {
    local arch html package version
    arch="$(arch_name)"
    html="$(download_stdout "$PKG_BASE/")"
    package="$({ printf '%s\n' "$html" \
        | grep -oE "tailscale_[0-9]+\\.[0-9]+\\.[0-9]+_${arch}\\.tgz" \
        | sort -Vu \
        | tail -n 1; } || true)"
    [[ -n "$package" ]] || die "could not determine latest stable Tailscale version"
    version="${package#tailscale_}"
    version="${version%_"${arch}".tgz}"
    printf '%s\n' "$version"
}

installed_version() {
    if [[ -x "$TAILSCALE" ]]; then
        "$TAILSCALE" version 2>/dev/null | sed -n '1p' || true
    fi
}

install_version() (
    local requested="${1:-latest}" arch version tmp tgz src url expected actual
    arch="$(arch_name)"
    if [[ "$requested" == "latest" ]]; then
        version="$(latest_version)"
    else
        version="$requested"
    fi

    if [[ "$(installed_version)" == "$version" ]]; then
        log "Tailscale $version already installed"
        return 0
    fi

    have tar || die "tar is required"
    have sha256sum || die "sha256sum is required"
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/ts.XXXXXX")"
    trap 'rm -rf -- "$tmp"' EXIT
    tgz="$tmp/tailscale_${version}_${arch}.tgz"
    url="$PKG_BASE/tailscale_${version}_${arch}.tgz"

    log "installing Tailscale $version ($arch) under $BASE"
    download_file "$url" "$tgz"

    expected="$(download_stdout "$url.sha256" | awk 'NR==1 {print $1}')"
    [[ "$expected" =~ ^[[:xdigit:]]{64}$ ]] \
        || die "invalid SHA-256 response for $url"
    actual="$(sha256sum "$tgz" | awk '{print $1}')"
    [[ "${actual,,}" == "${expected,,}" ]] \
        || die "SHA-256 mismatch for downloaded archive"

    tar -xzf "$tgz" -C "$tmp"
    src="$tmp/tailscale_${version}_${arch}"
    [[ -x "$src/tailscale" && -x "$src/tailscaled" ]] \
        || die "downloaded archive does not contain expected binaries"

    mkdir -p "$BIN_DIR" "$STATE_DIR"
    install -m 0755 "$src/tailscale" "$BIN_DIR/.tailscale.new"
    install -m 0755 "$src/tailscaled" "$BIN_DIR/.tailscaled.new"
    mv -f "$BIN_DIR/.tailscale.new" "$TAILSCALE"
    mv -f "$BIN_DIR/.tailscaled.new" "$TAILSCALED"
    printf '%s\n' "$version" > "$BASE/VERSION"
    log "installed: $($TAILSCALE version | sed -n '1p')"
)

write_ts_user_unit() {
    mkdir -p "$TS_UNIT_DIR" "$STATE_DIR"
    cat > "$TS_UNIT_FILE" <<EOF_UNIT
[Unit]
Description=Rootless Tailscale userspace daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
RuntimeDirectory=$DAEMON_APP
ExecStart=$TAILSCALED --tun=userspace-networking --statedir=$STATE_DIR --socket=%t/$DAEMON_APP/tailscaled.sock --socks5-server=$PROXY_ADDR --outbound-http-proxy-listen=$PROXY_ADDR
Restart=on-failure
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF_UNIT
    systemctl --user daemon-reload
}

wait_for_socket() {
    local i
    for i in {1..100}; do
        [[ -S "$SOCKET" ]] && return 0
        sleep 0.1
    done
    return 1
}

daemon_running_fallback() {
    [[ -f "$PID_FILE" ]] || return 1
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

start_daemon() {
    [[ -x "$TAILSCALED" ]] || install_version latest
    mkdir -p "$STATE_DIR"
    select_runtime

    if (( SYSTEMD_MODE )); then
        write_ts_user_unit
        systemctl --user enable --now "$DAEMON_APP.service"
    else
        mkdir -p "$RUNTIME_DIR"
        if daemon_running_fallback; then
            log "tailscaled already running (PID $(cat "$PID_FILE"))"
        else
            rm -f "$SOCKET" "$PID_FILE"
            nohup "$TAILSCALED" \
                --tun=userspace-networking \
                --statedir="$STATE_DIR" \
                --socket="$SOCKET" \
                --socks5-server="$PROXY_ADDR" \
                --outbound-http-proxy-listen="$PROXY_ADDR" \
                >>"$LOG_FILE" 2>&1 &
            printf '%s\n' "$!" > "$PID_FILE"
        fi
    fi

    wait_for_socket || {
        if (( SYSTEMD_MODE )); then
            systemctl --user --no-pager --full status "$DAEMON_APP.service" || true
        else
            tail -n 80 "$LOG_FILE" 2>/dev/null || true
        fi
        die "tailscaled did not create $SOCKET"
    }
    log "tailscaled ready; SOCKS5/HTTP proxy: $PROXY_ADDR"
}

stop_daemon() {
    select_runtime
    if (( SYSTEMD_MODE )); then
        systemctl --user stop "$DAEMON_APP.service" 2>/dev/null || true
    elif daemon_running_fallback; then
        local pid
        pid="$(cat "$PID_FILE")"
        kill "$pid" 2>/dev/null || true
        for _ in {1..50}; do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.1
        done
        kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE" "$SOCKET"
    log "tailscaled stopped"
}

ensure_daemon() {
    select_runtime
    [[ -S "$SOCKET" ]] || start_daemon
}

ts_cli() {
    ensure_daemon
    "$TAILSCALE" --socket="$SOCKET" "$@"
}

up_node() {
    local hostname_override="${1:-}"
    local -a args=(up)
    [[ -n "$hostname_override" ]] && args+=(--hostname="$hostname_override")
    [[ -n "${TAILSCALE_AUTHKEY:-}" ]] && args+=(--auth-key="$TAILSCALE_AUTHKEY")
    ts_cli "${args[@]}"
}

update_install() {
    local before latest was_running=0
    before="$(installed_version || true)"
    latest="$(latest_version)"
    if [[ "$before" == "$latest" ]]; then
        log "already current: $latest"
        return 0
    fi

    select_runtime
    [[ -S "$SOCKET" ]] && was_running=1
    (( was_running )) && stop_daemon
    install_version "$latest"
    (( was_running )) && start_daemon
}

proxy_env() {
    cat <<EOF_ENV
export ALL_PROXY='socks5://$PROXY_ADDR'
export all_proxy='socks5://$PROXY_ADDR'
export HTTP_PROXY='http://$PROXY_ADDR'
export http_proxy='http://$PROXY_ADDR'
export HTTPS_PROXY='http://$PROXY_ADDR'
export https_proxy='http://$PROXY_ADDR'
EOF_ENV
}

# Encode persistent FreeRDP arguments as base64(JSON-array) so the registry can
# preserve arbitrary argument boundaries without shell-eval nonsense.
encode_arg_vector() {
    have python3 || die "python3 is required"
    python3 - "$@" <<'PY_ARGS'
import base64, json, sys
payload = json.dumps(sys.argv[1:], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
print(base64.urlsafe_b64encode(payload).decode("ascii"))
PY_ARGS
}

decode_arg_vector_nul() {
    local encoded="${1:-}"
    [[ -n "$encoded" ]] || return 0
    have python3 || die "python3 is required"
    python3 - "$encoded" <<'PY_ARGS'
import base64, json, sys
try:
    raw = base64.urlsafe_b64decode(sys.argv[1].encode("ascii"))
    args = json.loads(raw.decode("utf-8"))
    if not isinstance(args, list) or not all(isinstance(x, str) for x in args):
        raise ValueError("not a string array")
except Exception as exc:
    raise SystemExit(f"invalid encoded FreeRDP argument vector: {exc}")
out = sys.stdout.buffer
for arg in args:
    out.write(arg.encode("utf-8") + b"\0")
PY_ARGS
}

format_arg_vector() {
    local encoded="${1:-}" arg first=1
    [[ -n "$encoded" ]] || { printf '%s' '-'; return 0; }
    local -a decoded=()
    mapfile -d '' -t decoded < <(decode_arg_vector_nul "$encoded")
    for arg in "${decoded[@]}"; do
        (( first )) || printf ' '
        printf '%q' "$arg"
        first=0
    done
    (( first )) && printf '%s' '-'
    return 0
}

# Encode provider-specific direct-RDP options without exposing shell syntax in
# the registry. The decoded fields are:
# endpoint_libvirt_uri, endpoint_mac, lifecycle_libvirt_uri, start_policy,
# boot_timeout, endpoint_address, endpoint_netdev, endpoint_guest_port.
encode_direct_options() {
    have python3 || die "python3 is required"
    python3 - "$@" <<'PY_DIRECT_OPTIONS'
import base64, json, sys

(
    endpoint_uri,
    mac,
    lifecycle_uri,
    start_policy,
    boot_timeout,
    endpoint_address,
    endpoint_netdev,
    endpoint_guest_port,
) = sys.argv[1:]
payload = {
    "boot_timeout": int(boot_timeout),
    "endpoint_libvirt_uri": endpoint_uri,
    "endpoint_mac": mac,
    "lifecycle_libvirt_uri": lifecycle_uri,
    "start_policy": start_policy,
    "endpoint_address": endpoint_address,
    "endpoint_netdev": endpoint_netdev,
    "endpoint_guest_port": int(endpoint_guest_port),
}
raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
print(base64.urlsafe_b64encode(raw).decode("ascii"))
PY_DIRECT_OPTIONS
}

decode_direct_options_nul() {
    local encoded="${1:-}"
    have python3 || die "python3 is required"
    python3 - "$encoded" <<'PY_DIRECT_OPTIONS'
import base64, json, sys

defaults = {
    "endpoint_libvirt_uri": "",
    "endpoint_mac": "",
    "lifecycle_libvirt_uri": "",
    "start_policy": "manual",
    "boot_timeout": 180,
    "endpoint_address": "127.0.0.1",
    "endpoint_netdev": "hostnet0",
    "endpoint_guest_port": 3389,
}
try:
    if sys.argv[1]:
        value = json.loads(base64.urlsafe_b64decode(sys.argv[1].encode("ascii")).decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("not an object")
        defaults.update(value)
    if defaults["start_policy"] not in {"manual", "on-demand"}:
        raise ValueError("invalid start_policy")
    timeout = int(defaults["boot_timeout"])
    if not 1 <= timeout <= 3600:
        raise ValueError("boot_timeout outside 1..3600")
    guest_port = int(defaults["endpoint_guest_port"])
    if not 1 <= guest_port <= 65535:
        raise ValueError("endpoint_guest_port outside 1..65535")
except Exception as exc:
    raise SystemExit(f"invalid encoded direct-RDP options: {exc}")

out = sys.stdout.buffer
for item in (
    str(defaults["endpoint_libvirt_uri"]),
    str(defaults["endpoint_mac"]),
    str(defaults["lifecycle_libvirt_uri"]),
    str(defaults["start_policy"]),
    str(timeout),
    str(defaults["endpoint_address"]),
    str(defaults["endpoint_netdev"]),
    str(guest_port),
):
    out.write(item.encode("utf-8") + b"\0")
PY_DIRECT_OPTIONS
}

DIRECT_ENDPOINT_URI=""
DIRECT_ENDPOINT_MAC=""
DIRECT_LIFECYCLE_URI=""
DIRECT_START_POLICY="manual"
DIRECT_BOOT_TIMEOUT="180"
DIRECT_ENDPOINT_ADDRESS="127.0.0.1"
DIRECT_ENDPOINT_NETDEV="hostnet0"
DIRECT_ENDPOINT_GUEST_PORT="3389"

decode_direct_options() {
    local -a fields=()
    mapfile -d '' -t fields < <(decode_direct_options_nul "${1:-}")
    DIRECT_ENDPOINT_URI="${fields[0]:-}"
    DIRECT_ENDPOINT_MAC="${fields[1]:-}"
    DIRECT_LIFECYCLE_URI="${fields[2]:-}"
    DIRECT_START_POLICY="${fields[3]:-manual}"
    DIRECT_BOOT_TIMEOUT="${fields[4]:-180}"
    DIRECT_ENDPOINT_ADDRESS="${fields[5]:-127.0.0.1}"
    DIRECT_ENDPOINT_NETDEV="${fields[6]:-hostnet0}"
    DIRECT_ENDPOINT_GUEST_PORT="${fields[7]:-3389}"
}

validate_registry_field() {
    local label="$1" value="$2"
    [[ "$value" != *'|'* && "$value" != *$'\n'* && "$value" != *$'\r'* ]] \
        || die "$label may not contain pipe or newline characters"
}

validate_direct_host() {
    local host="$1"
    [[ -n "$host" && "$host" != -* && "$host" =~ ^[A-Za-z0-9._-]+$ ]] \
        || die "invalid direct RDP host/address: $host"
}

normalize_mac() {
    local mac="${1,,}"
    [[ "$mac" =~ ^([0-9a-f]{2}:){5}[0-9a-f]{2}$ ]] \
        || die "invalid MAC address: $1"
    printf '%s\n' "$mac"
}

validate_boot_timeout() {
    if [[ ! "$1" =~ ^[0-9]+$ ]] || (( 10#$1 < 1 || 10#$1 > 3600 )); then
        die "boot timeout must be between 1 and 3600 seconds"
    fi
}

# -----------------------------------------------------------------------------
# RDP binding registry
# Pipe-delimited columns: name target local_ip username remote_port server_name freerdp_args_b64
# -----------------------------------------------------------------------------

ensure_rdp_config() {
    mkdir -p "$CONFIG_HOME" "$RDP_STATE"
    touch "$RDP_CONFIG"
    chmod 600 "$RDP_CONFIG" 2>/dev/null || true
}

rdp_has_bindings() {
    [[ -f "$RDP_CONFIG" ]] && grep -qEv '^[[:space:]]*(#|$)' "$RDP_CONFIG"
}

validate_rdp_name() {
    [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] \
        || die "RDP binding name must match [A-Za-z0-9._-]+"
}

validate_port() {
    if [[ ! "$1" =~ ^[0-9]+$ ]] || (( 10#$1 < 1 || 10#$1 > 65535 )); then
        die "invalid TCP port: $1"
    fi
}

validate_loopback_ip() {
    local ip="$1"
    have python3 || die "python3 is required for RDP bridging"
    python3 - "$ip" <<'PY' >/dev/null 2>&1 || die "RDP local IP must be inside 127.0.0.0/8: $ip"
import ipaddress, sys
ip = ipaddress.ip_address(sys.argv[1])
assert ip.version == 4 and ip in ipaddress.ip_network("127.0.0.0/8")
PY
}

rdp_record() {
    local name="$1"
    [[ -f "$RDP_CONFIG" ]] || return 1
    awk -F '|' -v n="$name" '$1 == n { print; found=1; exit } END { if (!found) exit 1 }' "$RDP_CONFIG"
}

rdp_auto_ip() {
    ensure_rdp_config
    local i ip
    for i in $(seq 1 254); do
        ip="127.77.0.$i"
        if ! awk -F '|' -v ip="$ip" '$3 == ip { found=1 } END { exit found ? 0 : 1 }' "$RDP_CONFIG"; then
            printf '%s\n' "$ip"
            return 0
        fi
    done
    die "automatic RDP loopback pool 127.77.0.1-254 exhausted"
}

rdp_bridge_running() {
    select_runtime
    if (( SYSTEMD_MODE )); then
        systemctl --user is-active --quiet "$RDP_UNIT_NAME" 2>/dev/null
    else
        [[ -f "$RDP_PID" ]] || return 1
        local pid
        pid="$(cat "$RDP_PID" 2>/dev/null || true)"
        [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
    fi
}

rdp_add() {
    ensure_rdp_config
    [[ $# -ge 1 ]] || die "usage: ts rdp add NAME [TARGET] [--user USER] [--server-name NAME] [--ip 127.x.x.x] [--port PORT] [--rdp-arg ARG ...]"

    local name="$1"; shift
    validate_rdp_name "$name"

    local old="" old_target="" old_ip="" old_user="" old_port="" old_server_name="" old_args_b64=""
    old="$(rdp_record "$name" 2>/dev/null || true)"
    if [[ -n "$old" ]]; then
        IFS='|' read -r _ old_target old_ip old_user old_port old_server_name old_args_b64 <<<"$old"
    fi

    local target="${old_target:-$name}"
    local ip="${old_ip:-}"
    local username="${old_user:-}"
    local port="${old_port:-3389}"
    local server_name="${old_server_name:-}"
    local args_b64="${old_args_b64:-}"
    local target_explicit=0
    local server_name_explicit=0
    local replace_args=0
    local -a new_rdp_args=()

    if [[ $# -gt 0 && "$1" != --* ]]; then
        target="$1"
        target_explicit=1
        shift
    fi

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --user)
                [[ $# -ge 2 ]] || die "--user requires a value"
                username="$2"; shift 2 ;;
            --server-name|--cert-name)
                [[ $# -ge 2 ]] || die "$1 requires a value"
                server_name="$2"; server_name_explicit=1; shift 2 ;;
            --ip)
                [[ $# -ge 2 ]] || die "--ip requires a value"
                ip="$2"; shift 2 ;;
            --port)
                [[ $# -ge 2 ]] || die "--port requires a value"
                port="$2"; shift 2 ;;
            --rdp-arg)
                [[ $# -ge 2 ]] || die "--rdp-arg requires a value"
                replace_args=1
                new_rdp_args+=("$2"); shift 2 ;;
            --clear-rdp-args)
                replace_args=1
                new_rdp_args=(); shift ;;
            *) die "unknown rdp add option: $1" ;;
        esac
    done

    # Certificate identity follows the real target unless explicitly overridden.
    if [[ -z "$server_name" || ( "$target_explicit" -eq 1 && "$server_name_explicit" -eq 0 ) ]]; then
        server_name="$target"
    fi
    if (( replace_args )); then
        if (( ${#new_rdp_args[@]} )); then args_b64="$(encode_arg_vector "${new_rdp_args[@]}")"; else args_b64=""; fi
    fi

    [[ -n "$ip" ]] || ip="$(rdp_auto_ip)"
    validate_loopback_ip "$ip"
    validate_port "$port"

    if awk -F '|' -v ip="$ip" -v n="$name" '$3 == ip && $1 != n { found=1 } END { exit found ? 0 : 1 }' "$RDP_CONFIG"; then
        die "local RDP address $ip is already assigned to another binding"
    fi

    local tmp
    tmp="$(mktemp "${TMPDIR:-/tmp}/ts-rdp.XXXXXX")"
    awk -F '|' -v n="$name" '$1 != n' "$RDP_CONFIG" > "$tmp" || true
    printf '%s|%s|%s|%s|%s|%s|%s\n' "$name" "$target" "$ip" "$username" "$port" "$server_name" "$args_b64" >> "$tmp"
    sort -t '|' -k1,1 "$tmp" > "$RDP_CONFIG"
    rm -f "$tmp"
    chmod 600 "$RDP_CONFIG" 2>/dev/null || true

    printf '%-18s -> %-28s local %s:3389' "$name" "$target:$port" "$ip"
    [[ -n "$username" ]] && printf ' user=%s' "$username"
    [[ "$server_name" != "$target" ]] && printf ' server-name=%s' "$server_name"
    if [[ -n "$args_b64" ]]; then printf ' args=%s' "$(format_arg_vector "$args_b64")"; fi
    printf '\n'

    if rdp_bridge_running; then
        rdp_restart
    fi
}
rdp_remove() {
    ensure_rdp_config
    [[ $# -eq 1 ]] || die "usage: ts rdp rm NAME"
    local name="$1"
    rdp_record "$name" >/dev/null 2>&1 || die "unknown RDP binding: $name"

    local tmp
    tmp="$(mktemp "${TMPDIR:-/tmp}/ts-rdp.XXXXXX")"
    awk -F '|' -v n="$name" '$1 != n' "$RDP_CONFIG" > "$tmp" || true
    mv "$tmp" "$RDP_CONFIG"
    chmod 600 "$RDP_CONFIG" 2>/dev/null || true
    log "removed RDP binding: $name"

    # A direct mapping is meaningful only as an alternate transport for an
    # existing portable RDP binding. Avoid leaving an unusable local record.
    if rdp_direct_record "$name" >/dev/null 2>&1; then
        rdp_direct_remove "$name"
    fi

    if rdp_bridge_running; then
        if rdp_has_bindings; then rdp_restart; else rdp_stop; fi
    fi
}

rdp_list() {
    ensure_rdp_config
    if ! rdp_has_bindings; then
        printf 'No RDP bindings. Add one with: ts rdp add NAME [TARGET]\n'
        return 0
    fi

    printf '%-18s %-30s %-18s %-22s %-6s %-24s %s\n' NAME TARGET LOCAL USER PORT SERVER_NAME RDP_ARGS
    printf '%-18s %-30s %-18s %-22s %-6s %-24s %s\n' '------------------' '------------------------------' '------------------' '----------------------' '------' '------------------------' '----------------'
    local name target ip username port server_name args_b64
    while IFS='|' read -r name target ip username port server_name args_b64; do
        [[ -n "$name" && "$name" != \#* ]] || continue
        server_name="${server_name:-$target}"
        printf '%-18s %-30s %-18s %-22s %-6s %-24s %s\n' \
            "$name" "$target" "$ip" "${username:--}" "${port:-3389}" "$server_name" "$(format_arg_vector "$args_b64")"
    done < "$RDP_CONFIG"
}
write_rdp_unit() {
    install_self
    mkdir -p "$RDP_UNIT_DIR" "$RDP_STATE"
    cat > "$RDP_UNIT_FILE" <<EOF_UNIT
[Unit]
Description=ts RDP bindings over rootless Tailscale
After=$DAEMON_APP.service

[Service]
Type=simple
ExecStart=$SELF_INSTALL _rdp-serve
Restart=on-failure
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF_UNIT
    systemctl --user daemon-reload
}

rdp_start() {
    ensure_rdp_config
    rdp_has_bindings || die "no RDP bindings configured; use 'ts rdp add NAME [TARGET]'"
    have python3 || die "python3 is required for RDP bridging"
    ensure_daemon
    mkdir -p "$RDP_STATE"
    select_runtime

    if rdp_bridge_running; then
        log "RDP bridge already running"
        return 0
    fi

    if (( SYSTEMD_MODE )); then
        write_rdp_unit
        systemctl --user enable --now "$RDP_UNIT_NAME"
    else
        rm -f "$RDP_PID"
        nohup "$(self_path)" _rdp-serve >>"$RDP_LOG" 2>&1 &
        printf '%s\n' "$!" > "$RDP_PID"
    fi

    for _ in {1..50}; do
        rdp_bridge_running && break
        sleep 0.1
    done
    rdp_bridge_running || {
        tail -n 80 "$RDP_LOG" 2>/dev/null || true
        die "RDP bridge failed to start"
    }
    log "RDP bridge ready"
}

rdp_stop() {
    select_runtime
    if (( SYSTEMD_MODE )); then
        systemctl --user stop "$RDP_UNIT_NAME" 2>/dev/null || true
    elif [[ -f "$RDP_PID" ]]; then
        local pid
        pid="$(cat "$RDP_PID" 2>/dev/null || true)"
        if [[ "$pid" =~ ^[0-9]+$ ]]; then
            kill "$pid" 2>/dev/null || true
            for _ in {1..30}; do
                kill -0 "$pid" 2>/dev/null || break
                sleep 0.1
            done
            kill -9 "$pid" 2>/dev/null || true
        fi
    fi
    rm -f "$RDP_PID"
    log "RDP bridge stopped"
}

rdp_restart() {
    rdp_stop
    rdp_start
}

rdp_status() {
    printf 'rdp-config: %s\n' "$RDP_CONFIG"
    if rdp_bridge_running; then
        printf 'rdp-bridge: running\n'
    else
        printf 'rdp-bridge: stopped\n'
    fi
    rdp_list
}

find_freerdp() {
    local candidate
    for candidate in xfreerdp3 xfreerdp wlfreerdp; do
        if have "$candidate"; then
            command -v "$candidate"
            return 0
        fi
    done
    return 1
}

rdp_args() {
    ensure_rdp_config
    [[ $# -ge 1 ]] || die "usage: ts rdp args NAME [-- ARGS...] | --clear"
    local name="$1"; shift
    local record target ip username port server_name args_b64
    record="$(rdp_record "$name" 2>/dev/null || true)"
    [[ -n "$record" ]] || die "unknown RDP binding: $name"
    IFS='|' read -r _ target ip username port server_name args_b64 <<<"$record"

    if [[ $# -eq 0 ]]; then
        format_arg_vector "$args_b64"
        printf '\n'
        return 0
    fi

    if [[ "$1" == "--clear" ]]; then
        [[ $# -eq 1 ]] || die "--clear takes no arguments"
        args_b64=""
    else
        [[ "$1" == "--" ]] && shift
        args_b64="$(encode_arg_vector "$@")"
    fi

    local tmp
    tmp="$(mktemp "${TMPDIR:-/tmp}/ts-rdp.XXXXXX")"
    awk -F '|' -v n="$name" '$1 != n' "$RDP_CONFIG" > "$tmp" || true
    printf '%s|%s|%s|%s|%s|%s|%s\n' "$name" "$target" "$ip" "$username" "${port:-3389}" "${server_name:-$target}" "$args_b64" >> "$tmp"
    sort -t '|' -k1,1 "$tmp" > "$RDP_CONFIG"
    rm -f "$tmp"
    chmod 600 "$RDP_CONFIG" 2>/dev/null || true
    log "persistent FreeRDP args for $name: $(format_arg_vector "$args_b64")"
}

ensure_rdp_direct_config() {
    mkdir -p "$CONFIG_HOME" "$(dirname "$RDP_DIRECT_CONFIG")"
    touch "$RDP_DIRECT_CONFIG"
    chmod 600 "$RDP_DIRECT_CONFIG" 2>/dev/null || true
}

# Host-local registry columns:
# name | endpoint_provider | endpoint_value | port |
# lifecycle_provider | lifecycle_value | provider_options_b64
# This file is intentionally outside config-install's portable merge set.

rdp_direct_has_mappings() {
    [[ -f "$RDP_DIRECT_CONFIG" ]] && grep -qEv '^[[:space:]]*(#|$)' "$RDP_DIRECT_CONFIG"
}

rdp_direct_count() {
    if [[ -f "$RDP_DIRECT_CONFIG" ]]; then
        awk '!/^[[:space:]]*(#|$)/ {count++} END {print count+0}' "$RDP_DIRECT_CONFIG"
    else
        printf '0\n'
    fi
}

rdp_direct_record() {
    local name="$1"
    [[ -f "$RDP_DIRECT_CONFIG" ]] || return 1
    awk -F '|' -v n="$name" '$1 == n { print; found=1; exit } END { if (!found) exit 1 }' "$RDP_DIRECT_CONFIG"
}

rdp_direct_write_record() {
    local name="$1" endpoint_provider="$2" endpoint_value="$3" port="$4"
    local lifecycle_provider="$5" lifecycle_value="$6" options_b64="$7" tmp sorted
    ensure_rdp_direct_config
    tmp="$(mktemp "$(dirname "$RDP_DIRECT_CONFIG")/.rdp-direct.XXXXXX")"
    sorted="$(mktemp "$(dirname "$RDP_DIRECT_CONFIG")/.rdp-direct-sort.XXXXXX")"
    awk -F '|' -v n="$name" '$1 != n' "$RDP_DIRECT_CONFIG" > "$tmp" || true
    printf '%s|%s|%s|%s|%s|%s|%s\n' \
        "$name" "$endpoint_provider" "$endpoint_value" "$port" \
        "$lifecycle_provider" "$lifecycle_value" "$options_b64" >> "$tmp"
    sort -t '|' -k1,1 "$tmp" > "$sorted"
    mv "$sorted" "$RDP_DIRECT_CONFIG"
    rm -f "$tmp"
    chmod 600 "$RDP_DIRECT_CONFIG" 2>/dev/null || true
}

rdp_direct_set() {
    [[ $# -ge 1 ]] || die "usage: ts rdp direct set NAME (--libvirt-user-domain DOMAIN | --libvirt-domain DOMAIN | --vmx PATH | --address HOST) [--port PORT]"
    local name="$1"; shift
    validate_rdp_name "$name"
    rdp_record "$name" >/dev/null 2>&1 \
        || die "unknown RDP binding '$name'; add it first with: ts rdp add $name [TARGET]"

    local old="" old_port="" lifecycle_provider="" lifecycle_value="" old_options=""
    old="$(rdp_direct_record "$name" 2>/dev/null || true)"
    if [[ -n "$old" ]]; then
        IFS='|' read -r _ _ _ old_port lifecycle_provider lifecycle_value old_options <<<"$old"
        decode_direct_options "$old_options"
    else
        DIRECT_ENDPOINT_URI=""
        DIRECT_ENDPOINT_MAC=""
        DIRECT_LIFECYCLE_URI=""
        DIRECT_START_POLICY="manual"
        DIRECT_BOOT_TIMEOUT="180"
        DIRECT_ENDPOINT_ADDRESS="127.0.0.1"
        DIRECT_ENDPOINT_NETDEV="hostnet0"
        DIRECT_ENDPOINT_GUEST_PORT="3389"
    fi

    local endpoint_provider="" endpoint_value="" port="${old_port:-3389}"
    local endpoint_uri="" endpoint_mac="" endpoint_address="127.0.0.1"
    local endpoint_netdev="hostnet0" endpoint_guest_port="3389" selectors=0 user_forward_options=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --libvirt-user-domain)
                [[ $# -ge 2 ]] || die "--libvirt-user-domain requires a value"
                endpoint_provider="libvirt-user"; endpoint_value="$2"; ((selectors+=1)); shift 2 ;;
            --libvirt-domain)
                [[ $# -ge 2 ]] || die "--libvirt-domain requires a value"
                endpoint_provider="libvirt"; endpoint_value="$2"; ((selectors+=1)); shift 2 ;;
            --vmx)
                [[ $# -ge 2 ]] || die "--vmx requires a value"
                endpoint_provider="vmware"; endpoint_value="$2"; ((selectors+=1)); shift 2 ;;
            --address)
                [[ $# -ge 2 ]] || die "--address requires a value"
                endpoint_provider="address"; endpoint_value="$2"; ((selectors+=1)); shift 2 ;;
            --libvirt-uri)
                [[ $# -ge 2 ]] || die "--libvirt-uri requires a value"
                endpoint_uri="$2"; shift 2 ;;
            --mac)
                [[ $# -ge 2 ]] || die "--mac requires a value"
                endpoint_mac="$(normalize_mac "$2")"; shift 2 ;;
            --host-address)
                [[ $# -ge 2 ]] || die "--host-address requires a value"
                endpoint_address="$2"; ((user_forward_options+=1)); shift 2 ;;
            --netdev)
                [[ $# -ge 2 ]] || die "--netdev requires a value"
                endpoint_netdev="$2"; ((user_forward_options+=1)); shift 2 ;;
            --guest-port)
                [[ $# -ge 2 ]] || die "--guest-port requires a value"
                endpoint_guest_port="$2"; ((user_forward_options+=1)); shift 2 ;;
            --port)
                [[ $# -ge 2 ]] || die "--port requires a value"
                port="$2"; shift 2 ;;
            *) die "unknown direct endpoint option: $1" ;;
        esac
    done
    (( selectors == 1 )) || die "choose exactly one endpoint: --libvirt-user-domain, --libvirt-domain, --vmx, or --address"
    validate_port "$port"
    validate_port "$endpoint_guest_port"
    validate_registry_field "direct endpoint" "$endpoint_value"
    validate_registry_field "libvirt URI" "$endpoint_uri"
    [[ "$endpoint_value" != -* ]] || die "direct endpoint values may not begin with '-'"
    case "$endpoint_provider" in
        libvirt|libvirt-user)
            [[ -n "$endpoint_value" ]] || die "libvirt domain may not be empty" ;;
        vmware)
            [[ "$endpoint_value" == /* ]] || die "VMX path must be absolute" ;;
        address)
            validate_direct_host "$endpoint_value"
            [[ -z "$endpoint_uri" ]] || die "--libvirt-uri is valid only with a libvirt endpoint"
            [[ -z "$endpoint_mac" ]] || die "--mac is valid only with --libvirt-domain" ;;
    esac
    if [[ "$endpoint_provider" != libvirt && -n "$endpoint_mac" ]]; then
        die "--mac is valid only with --libvirt-domain"
    fi
    if [[ "$endpoint_provider" != libvirt && "$endpoint_provider" != libvirt-user && -n "$endpoint_uri" ]]; then
        die "--libvirt-uri is valid only with a libvirt endpoint"
    fi
    if [[ "$endpoint_provider" == libvirt-user ]]; then
        validate_direct_host "$endpoint_address"
        [[ -n "$endpoint_netdev" && "$endpoint_netdev" != -* && "$endpoint_netdev" =~ ^[A-Za-z0-9._-]+$ ]] \
            || die "invalid QEMU user-network netdev: $endpoint_netdev"
    elif (( user_forward_options )); then
        die "--host-address, --netdev, and --guest-port are valid only with --libvirt-user-domain"
    fi

    # A provider-backed endpoint gets a matching manual lifecycle by default.
    # Updates preserve any independently configured lifecycle.
    if [[ -z "$old" ]]; then
        case "$endpoint_provider" in
            libvirt|libvirt-user)
                lifecycle_provider="libvirt"; lifecycle_value="$endpoint_value"; DIRECT_LIFECYCLE_URI="$endpoint_uri" ;;
            vmware)
                lifecycle_provider="vmware"; lifecycle_value="$endpoint_value" ;;
            address)
                lifecycle_provider="none"; lifecycle_value="" ;;
        esac
    fi
    DIRECT_ENDPOINT_URI="$endpoint_uri"
    DIRECT_ENDPOINT_MAC="$endpoint_mac"
    DIRECT_ENDPOINT_ADDRESS="$endpoint_address"
    DIRECT_ENDPOINT_NETDEV="$endpoint_netdev"
    DIRECT_ENDPOINT_GUEST_PORT="$endpoint_guest_port"
    local options_b64
    options_b64="$(encode_direct_options "$DIRECT_ENDPOINT_URI" "$DIRECT_ENDPOINT_MAC" \
        "$DIRECT_LIFECYCLE_URI" "$DIRECT_START_POLICY" "$DIRECT_BOOT_TIMEOUT" \
        "$DIRECT_ENDPOINT_ADDRESS" "$DIRECT_ENDPOINT_NETDEV" "$DIRECT_ENDPOINT_GUEST_PORT")"
    rdp_direct_write_record "$name" "$endpoint_provider" "$endpoint_value" "$port" \
        "${lifecycle_provider:-none}" "$lifecycle_value" "$options_b64"
    log "direct RDP endpoint '$name': $endpoint_provider $endpoint_value:$port"
}

rdp_direct_lifecycle_set() {
    [[ $# -ge 1 ]] || die "usage: ts rdp direct lifecycle set NAME (--libvirt-domain DOMAIN | --vmx PATH) [--start-policy manual|on-demand]"
    local name="$1"; shift
    local record endpoint_provider endpoint_value port options_b64
    record="$(rdp_direct_record "$name" 2>/dev/null || true)"
    [[ -n "$record" ]] || die "no direct RDP mapping for '$name'; configure its endpoint first"
    IFS='|' read -r _ endpoint_provider endpoint_value port _ _ options_b64 <<<"$record"
    decode_direct_options "$options_b64"

    local provider="" value="" lifecycle_uri="" policy="$DIRECT_START_POLICY" timeout="$DIRECT_BOOT_TIMEOUT" selectors=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --libvirt-domain)
                [[ $# -ge 2 ]] || die "--libvirt-domain requires a value"
                provider="libvirt"; value="$2"; ((selectors+=1)); shift 2 ;;
            --vmx)
                [[ $# -ge 2 ]] || die "--vmx requires a value"
                provider="vmware"; value="$2"; ((selectors+=1)); shift 2 ;;
            --libvirt-uri)
                [[ $# -ge 2 ]] || die "--libvirt-uri requires a value"
                lifecycle_uri="$2"; shift 2 ;;
            --start-policy)
                [[ $# -ge 2 ]] || die "--start-policy requires a value"
                policy="$2"; shift 2 ;;
            --start-on-connect)
                policy="on-demand"; shift ;;
            --boot-timeout)
                [[ $# -ge 2 ]] || die "--boot-timeout requires a value"
                timeout="$2"; shift 2 ;;
            *) die "unknown direct lifecycle option: $1" ;;
        esac
    done
    (( selectors == 1 )) || die "choose exactly one lifecycle provider: --libvirt-domain or --vmx"
    case "$policy" in manual|on-demand) ;; *) die "start policy must be manual or on-demand" ;; esac
    validate_boot_timeout "$timeout"
    validate_registry_field "lifecycle value" "$value"
    validate_registry_field "libvirt URI" "$lifecycle_uri"
    [[ -n "$value" && "$value" != -* ]] || die "invalid lifecycle value"
    if [[ "$provider" == vmware ]]; then
        [[ "$value" == /* ]] || die "VMX path must be absolute"
        [[ -z "$lifecycle_uri" ]] || die "--libvirt-uri is valid only with --libvirt-domain"
    fi
    options_b64="$(encode_direct_options "$DIRECT_ENDPOINT_URI" "$DIRECT_ENDPOINT_MAC" \
        "$lifecycle_uri" "$policy" "$timeout" "$DIRECT_ENDPOINT_ADDRESS" \
        "$DIRECT_ENDPOINT_NETDEV" "$DIRECT_ENDPOINT_GUEST_PORT")"
    rdp_direct_write_record "$name" "$endpoint_provider" "$endpoint_value" "${port:-3389}" \
        "$provider" "$value" "$options_b64"
    log "direct RDP lifecycle '$name': $provider $value ($policy)"
}

rdp_direct_lifecycle_remove() {
    [[ $# -eq 1 ]] || die "usage: ts rdp direct lifecycle rm NAME"
    local name="$1" record endpoint_provider endpoint_value port provider value options_b64
    record="$(rdp_direct_record "$name" 2>/dev/null || true)"
    [[ -n "$record" ]] || die "no direct RDP mapping for '$name'"
    IFS='|' read -r _ endpoint_provider endpoint_value port provider value options_b64 <<<"$record"
    decode_direct_options "$options_b64"
    options_b64="$(encode_direct_options "$DIRECT_ENDPOINT_URI" "$DIRECT_ENDPOINT_MAC" "" manual \
        "$DIRECT_BOOT_TIMEOUT" "$DIRECT_ENDPOINT_ADDRESS" "$DIRECT_ENDPOINT_NETDEV" \
        "$DIRECT_ENDPOINT_GUEST_PORT")"
    rdp_direct_write_record "$name" "$endpoint_provider" "$endpoint_value" "${port:-3389}" none "" "$options_b64"
    log "removed lifecycle provider from direct RDP mapping: $name"
}

rdp_direct_remove() {
    [[ $# -eq 1 ]] || die "usage: ts rdp direct rm NAME"
    local name="$1" tmp
    rdp_direct_record "$name" >/dev/null 2>&1 || die "no direct RDP mapping for '$name'"
    ensure_rdp_direct_config
    tmp="$(mktemp "$(dirname "$RDP_DIRECT_CONFIG")/.rdp-direct.XXXXXX")"
    awk -F '|' -v n="$name" '$1 != n' "$RDP_DIRECT_CONFIG" > "$tmp" || true
    mv "$tmp" "$RDP_DIRECT_CONFIG"
    chmod 600 "$RDP_DIRECT_CONFIG" 2>/dev/null || true
    log "removed direct RDP mapping: $name"
}

direct_virsh_base() {
    local -n command_ref="$1"
    local uri="$2"
    command_ref=(virsh)
    [[ -n "$uri" ]] && command_ref+=(--connect "$uri")
}

direct_libvirt_state() {
    local domain="$1" uri="$2" output
    have virsh || return 127
    local -a command
    direct_virsh_base command "$uri"
    if ! output="$("${command[@]}" domstate "$domain" 2>/dev/null)"; then return 1; fi
    awk 'NF {gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print tolower($0); exit}' <<<"$output"
}

direct_vmware_running() {
    local vmx="$1" output
    have vmrun || return 127
    output="$(vmrun list 2>/dev/null)" || return 1
    grep -Fxq -- "$vmx" <<<"$output"
}

direct_lifecycle_state() {
    local provider="$1" value="$2" uri="$3" state
    case "$provider" in
        none|'') printf 'unmanaged\n' ;;
        libvirt)
            if state="$(direct_libvirt_state "$value" "$uri")"; then printf '%s\n' "$state"; else return $?; fi ;;
        vmware)
            if direct_vmware_running "$value"; then printf 'running\n'; else
                local rc=$?; (( rc == 1 )) && printf 'shut off\n' || return "$rc"
            fi ;;
        *) return 2 ;;
    esac
}

direct_lifecycle_prepare() {
    local provider="$1" value="$2" uri="$3" policy="$4" state rc
    [[ "$provider" != none && -n "$provider" ]] || return 0
    if state="$(direct_lifecycle_state "$provider" "$value" "$uri")"; then
        :
    else
        rc=$?
        (( rc == 127 )) && die "$([[ "$provider" == libvirt ]] && printf virsh || printf vmrun) is required for the configured lifecycle provider"
        die "unable to query $provider lifecycle state for '$value'"
    fi
    [[ "$state" != running ]] || return 0
    [[ "$policy" == on-demand ]] \
        || die "$provider VM '$value' is not running (state: $state); start it or configure --start-policy on-demand"
    case "$provider" in
        libvirt)
            local -a command
            direct_virsh_base command "$uri"
            "${command[@]}" start "$value" >/dev/null \
                || die "failed to start libvirt domain '$value'" ;;
        vmware)
            vmrun start "$value" nogui >/dev/null \
                || die "failed to start VMware VM '$value'" ;;
    esac
    log "started $provider VM '$value' on demand"
}

# QEMU user-mode host forwards are runtime state. Ensure the requested forward
# exists after every VM start, and verify it because HMP can report errors as
# successful command invocations.
direct_prepare_libvirt_user() {
    local domain="$1" uri="$2" host="$3" host_port="$4" guest_port="$5" netdev="$6"
    local state output specification monitor_ready=0
    have virsh || die "virsh is required for libvirt-user direct endpoints"
    state="$(direct_libvirt_state "$domain" "$uri" 2>/dev/null || true)"
    [[ "$state" == running ]] \
        || die "libvirt domain '$domain' must be running before its QEMU user-network forward can be prepared"

    local -a command
    direct_virsh_base command "$uri"
    for _ in {1..40}; do
        if output="$("${command[@]}" qemu-monitor-command "$domain" --hmp "info usernet" 2>/dev/null)"; then
            monitor_ready=1
            break
        fi
        sleep 0.25
    done
    (( monitor_ready )) || die "unable to inspect QEMU user networking for libvirt domain '$domain'"
    if awk -v host="$host" -v hp="$host_port" -v gp="$guest_port" \
        '$1 == "TCP[HOST_FORWARD]" && $3 == host && $4 == hp && $6 == gp {found=1} END {exit !found}' <<<"$output"; then
        return 0
    fi
    if awk -v host="$host" -v hp="$host_port" \
        '$1 == "TCP[HOST_FORWARD]" && $3 == host && $4 == hp {found=1} END {exit !found}' <<<"$output"; then
        die "QEMU user-network port $host:$host_port is already forwarded to a different guest port"
    fi

    specification="hostfwd_add $netdev tcp:${host}:${host_port}-:${guest_port}"
    "${command[@]}" qemu-monitor-command "$domain" --hmp "$specification" >/dev/null 2>&1 || true
    output="$("${command[@]}" qemu-monitor-command "$domain" --hmp "info usernet" 2>/dev/null)" \
        || die "unable to verify QEMU user-network forward for libvirt domain '$domain'"
    awk -v host="$host" -v hp="$host_port" -v gp="$guest_port" \
        '$1 == "TCP[HOST_FORWARD]" && $3 == host && $4 == hp && $6 == gp {found=1} END {exit !found}' <<<"$output" \
        || die "failed to create QEMU user-network forward $host:$host_port -> guest :$guest_port on $netdev"
    log "prepared QEMU user-network forward $host:$host_port -> '$domain':$guest_port"
}

direct_prepare_endpoint() {
    local provider="$1" value="$2" port="$3" endpoint_uri="$4"
    local endpoint_address="$5" endpoint_netdev="$6" endpoint_guest_port="$7"
    case "$provider" in
        libvirt-user)
            direct_prepare_libvirt_user "$value" "$endpoint_uri" "$endpoint_address" \
                "$port" "$endpoint_guest_port" "$endpoint_netdev" ;;
    esac
}

DIRECT_RESOLVED_HOST=""
DIRECT_RESOLVED_SOURCE=""
DIRECT_RESOLVE_ERROR=""

direct_filter_libvirt_addresses() {
    local allowed_macs="$1" wanted_mac="$2"
    python3 -c '
import ipaddress, re, sys
allowed = set(filter(None, sys.argv[1].lower().split(",")))
wanted = sys.argv[2].lower()
cgnat = ipaddress.ip_network("100.64.0.0/10")
zero = ipaddress.ip_network("0.0.0.0/8")
found = set()
for line in sys.stdin:
    match = re.search(r"(?i)(?:[0-9a-f]{2}:){5}[0-9a-f]{2}", line)
    if not match:
        continue
    mac = match.group(0).lower()
    if mac not in allowed or (wanted and mac != wanted):
        continue
    for token in line.split():
        try:
            interface = ipaddress.ip_interface(token)
        except ValueError:
            continue
        ip = interface.ip
        if ip.version != 4 or ip in zero or ip.is_loopback or ip.is_link_local or ip in cgnat:
            continue
        found.add((str(ip), mac))
for ip, mac in sorted(found, key=lambda item: (ipaddress.ip_address(item[0]), item[1])):
    print(f"{ip}|{mac}")
' "$allowed_macs" "$wanted_mac"
}

direct_resolve_libvirt() {
    local domain="$1" uri="$2" wanted_mac="$3" state output source allowed_macs=""
    have virsh || { DIRECT_RESOLVE_ERROR="virsh is required for libvirt direct endpoints"; return 1; }
    have python3 || { DIRECT_RESOLVE_ERROR="python3 is required for direct endpoint validation"; return 1; }
    if ! state="$(direct_libvirt_state "$domain" "$uri")"; then
        DIRECT_RESOLVE_ERROR="unable to query libvirt domain '$domain'"
        return 1
    fi
    if [[ "$state" != running ]]; then
        DIRECT_RESOLVE_ERROR="libvirt domain '$domain' is not running (state: $state)"
        return 1
    fi
    local -a command macs=() candidates=()
    direct_virsh_base command "$uri"
    if ! output="$("${command[@]}" domiflist "$domain" 2>/dev/null)"; then
        DIRECT_RESOLVE_ERROR="unable to inspect interfaces for libvirt domain '$domain'"
        return 1
    fi
    mapfile -t macs < <(awk '{v=tolower($NF); if (v ~ /^([0-9a-f][0-9a-f]:){5}[0-9a-f][0-9a-f]$/) print v}' <<<"$output" | sort -u)
    (( ${#macs[@]} )) || { DIRECT_RESOLVE_ERROR="libvirt domain '$domain' exposes no identifiable NICs"; return 1; }
    allowed_macs="$(IFS=,; printf '%s' "${macs[*]}")"
    if [[ -n "$wanted_mac" ]]; then
        local found=0 mac
        for mac in "${macs[@]}"; do [[ "$mac" == "$wanted_mac" ]] && found=1; done
        (( found )) || { DIRECT_RESOLVE_ERROR="configured MAC $wanted_mac is not attached to libvirt domain '$domain'"; return 1; }
    fi

    for source in lease agent arp; do
        if ! output="$("${command[@]}" domifaddr "$domain" --source "$source" 2>/dev/null)"; then
            continue
        fi
        mapfile -t candidates < <(direct_filter_libvirt_addresses "$allowed_macs" "$wanted_mac" <<<"$output")
        if (( ${#candidates[@]} == 1 )); then
            IFS='|' read -r DIRECT_RESOLVED_HOST _ <<<"${candidates[0]}"
            DIRECT_RESOLVED_SOURCE="$source"
            return 0
        fi
        if (( ${#candidates[@]} > 1 )); then
            DIRECT_RESOLVE_ERROR="multiple direct IPv4 interfaces found for '$domain' from $source: ${candidates[*]}; configure --mac"
            return 1
        fi
    done
    DIRECT_RESOLVE_ERROR="unable to determine a direct address for libvirt domain '$domain'; install/enable qemu-guest-agent or configure an explicit --address/--mac mapping"
    return 1
}

direct_resolve_vmware() {
    local vmx="$1" output
    have vmrun || { DIRECT_RESOLVE_ERROR="vmrun is required for VMware direct endpoints"; return 1; }
    have python3 || { DIRECT_RESOLVE_ERROR="python3 is required for direct endpoint validation"; return 1; }
    if ! direct_vmware_running "$vmx"; then
        DIRECT_RESOLVE_ERROR="VMware VM '$vmx' is not running"
        return 1
    fi
    if ! output="$(vmrun getGuestIPAddress "$vmx" 2>/dev/null)"; then
        DIRECT_RESOLVE_ERROR="VMware Tools did not provide an address for '$vmx'"
        return 1
    fi
    local resolved
    resolved="$(python3 - "$output" <<'PY_VMWARE_IP'
import ipaddress, re, sys
text = sys.argv[1]
valid = []
for token in re.findall(r"(?:\d{1,3}\.){3}\d{1,3}", text):
    try:
        ip = ipaddress.ip_address(token)
    except ValueError:
        continue
    if ip.version != 4 or ip in ipaddress.ip_network("0.0.0.0/8") or ip.is_loopback or ip.is_link_local or ip in ipaddress.ip_network("100.64.0.0/10"):
        continue
    if str(ip) not in valid:
        valid.append(str(ip))
if len(valid) != 1:
    raise SystemExit(1)
print(valid[0])
PY_VMWARE_IP
)" || {
        DIRECT_RESOLVE_ERROR="VMware Tools returned no unique usable direct IPv4 address for '$vmx'"
        return 1
    }
    DIRECT_RESOLVED_HOST="$resolved"
    DIRECT_RESOLVED_SOURCE="vmware-tools"
}

direct_resolve_endpoint() {
    local provider="$1" value="$2" endpoint_uri="$3" endpoint_mac="$4" endpoint_address="${5:-127.0.0.1}"
    DIRECT_RESOLVED_HOST=""
    DIRECT_RESOLVED_SOURCE=""
    DIRECT_RESOLVE_ERROR=""
    case "$provider" in
        address)
            DIRECT_RESOLVED_HOST="$value"; DIRECT_RESOLVED_SOURCE="configured" ;;
        libvirt)
            direct_resolve_libvirt "$value" "$endpoint_uri" "$endpoint_mac" ;;
        libvirt-user)
            DIRECT_RESOLVED_HOST="$endpoint_address"; DIRECT_RESOLVED_SOURCE="qemu-user-forward" ;;
        vmware)
            direct_resolve_vmware "$value" ;;
        *)
            DIRECT_RESOLVE_ERROR="unknown direct endpoint provider: $provider"; return 1 ;;
    esac
}

direct_tcp_ready() {
    python3 - "$1" "$2" <<'PY_TCP_READY' >/dev/null 2>&1
import socket, sys
with socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=0.4):
    pass
PY_TCP_READY
}

direct_wait_for_ready() {
    local provider="$1" value="$2" port="$3" endpoint_uri="$4" endpoint_mac="$5" timeout="$6"
    local endpoint_address="${7:-127.0.0.1}"
    local deadline=$((SECONDS + timeout)) last_error=""
    log "waiting up to ${timeout}s for direct RDP endpoint"
    while (( SECONDS <= deadline )); do
        if direct_resolve_endpoint "$provider" "$value" "$endpoint_uri" "$endpoint_mac" "$endpoint_address"; then
            if direct_tcp_ready "$DIRECT_RESOLVED_HOST" "$port"; then return 0; fi
            last_error="TCP ${DIRECT_RESOLVED_HOST}:$port is not accepting connections"
        else
            last_error="$DIRECT_RESOLVE_ERROR"
        fi
        sleep 1
    done
    die "direct RDP endpoint did not become ready within ${timeout}s: $last_error (the VM was left running)"
}

direct_wait_for_shutdown() {
    local provider="$1" value="$2" uri="$3" state rc
    [[ "$provider" != none && -n "$provider" ]] \
        || die "--wait-for-shutdown requires a configured VM lifecycle provider"
    log "RDP ended; waiting for $provider VM '$value' to shut off"
    while true; do
        if state="$(direct_lifecycle_state "$provider" "$value" "$uri")"; then
            case "$state" in
                'shut off'|shutoff|stopped)
                    log "$provider VM '$value' is fully shut off"
                    return 0 ;;
            esac
        else
            rc=$?
            (( rc == 127 )) && die "$([[ "$provider" == libvirt ]] && printf virsh || printf vmrun) is required for --wait-for-shutdown"
            die "unable to query $provider lifecycle state for '$value' while waiting for shutdown"
        fi
        sleep 1
    done
}

rdp_direct_control() {
    [[ $# -eq 2 ]] || die "usage: ts rdp direct start|stop NAME"
    local action="$1" name="$2" record ep ev port provider value options_b64
    record="$(rdp_direct_record "$name" 2>/dev/null || true)"
    [[ -n "$record" ]] || die "no direct RDP mapping for '$name'"
    IFS='|' read -r _ ep ev port provider value options_b64 <<<"$record"
    decode_direct_options "$options_b64"
    [[ "$provider" != none && -n "$provider" ]] || die "direct RDP mapping '$name' has no lifecycle provider"
    case "$provider:$action" in
        libvirt:start)
            have virsh || die "virsh is required for the configured lifecycle provider"
            if [[ "$(direct_libvirt_state "$value" "$DIRECT_LIFECYCLE_URI" 2>/dev/null || true)" == running ]]; then
                log "libvirt domain '$value' is already running"
            else
                local -a command
                direct_virsh_base command "$DIRECT_LIFECYCLE_URI"
                "${command[@]}" start "$value" >/dev/null || die "failed to start libvirt domain '$value'"
                log "started libvirt domain '$value'"
            fi ;;
        libvirt:stop)
            have virsh || die "virsh is required for the configured lifecycle provider"
            local -a command
            direct_virsh_base command "$DIRECT_LIFECYCLE_URI"
            "${command[@]}" shutdown "$value" >/dev/null || die "failed to request shutdown for libvirt domain '$value'"
            log "requested graceful shutdown of libvirt domain '$value'" ;;
        vmware:start)
            have vmrun || die "vmrun is required for the configured lifecycle provider"
            if direct_vmware_running "$value"; then log "VMware VM '$value' is already running"; else
                vmrun start "$value" nogui >/dev/null || die "failed to start VMware VM '$value'"
                log "started VMware VM '$value'"
            fi ;;
        vmware:stop)
            have vmrun || die "vmrun is required for the configured lifecycle provider"
            vmrun stop "$value" soft >/dev/null || die "failed to request shutdown for VMware VM '$value'"
            log "requested graceful shutdown of VMware VM '$value'" ;;
        *) die "unsupported direct lifecycle operation: $provider $action" ;;
    esac
}

rdp_direct_show() {
    [[ $# -eq 1 ]] || die "usage: ts rdp direct show NAME"
    local name="$1" record endpoint_provider endpoint_value port lifecycle_provider lifecycle_value options_b64 state
    record="$(rdp_direct_record "$name" 2>/dev/null || true)"
    [[ -n "$record" ]] || die "no direct RDP mapping for '$name'"
    IFS='|' read -r _ endpoint_provider endpoint_value port lifecycle_provider lifecycle_value options_b64 <<<"$record"
    decode_direct_options "$options_b64"
    printf 'Name:          %s\n' "$name"
    printf 'Endpoint:      %s\n' "$endpoint_provider"
    printf 'Endpoint value: %s\n' "$endpoint_value"
    printf 'Port:          %s\n' "${port:-3389}"
    [[ -n "$DIRECT_ENDPOINT_URI" ]] && printf 'Endpoint URI:  %s\n' "$DIRECT_ENDPOINT_URI"
    [[ -n "$DIRECT_ENDPOINT_MAC" ]] && printf 'Endpoint MAC:  %s\n' "$DIRECT_ENDPOINT_MAC"
    if [[ "$endpoint_provider" == libvirt-user ]]; then
        printf 'Host address:  %s\n' "$DIRECT_ENDPOINT_ADDRESS"
        printf 'Guest port:    %s\n' "$DIRECT_ENDPOINT_GUEST_PORT"
        printf 'QEMU netdev:   %s\n' "$DIRECT_ENDPOINT_NETDEV"
    fi
    printf 'Lifecycle:     %s%s\n' "${lifecycle_provider:-none}" "$([[ -n "$lifecycle_value" ]] && printf ' %s' "$lifecycle_value")"
    printf 'Start policy:  %s\n' "$DIRECT_START_POLICY"
    printf 'Boot timeout:  %ss\n' "$DIRECT_BOOT_TIMEOUT"
    if [[ "$lifecycle_provider" != none && -n "$lifecycle_provider" ]]; then
        if state="$(direct_lifecycle_state "$lifecycle_provider" "$lifecycle_value" "$DIRECT_LIFECYCLE_URI" 2>/dev/null)"; then
            printf 'VM state:      %s\n' "$state"
        else
            printf 'VM state:      unavailable\n'
        fi
    fi
    if direct_resolve_endpoint "$endpoint_provider" "$endpoint_value" "$DIRECT_ENDPOINT_URI" "$DIRECT_ENDPOINT_MAC" "$DIRECT_ENDPOINT_ADDRESS"; then
        printf 'Resolved:      %s:%s (%s)\n' "$DIRECT_RESOLVED_HOST" "${port:-3389}" "$DIRECT_RESOLVED_SOURCE"
    else
        printf 'Resolved:      unavailable (%s)\n' "$DIRECT_RESOLVE_ERROR"
    fi
}

rdp_direct_list() {
    ensure_rdp_direct_config
    if ! rdp_direct_has_mappings; then
        printf 'No direct RDP mappings. Add one with: ts rdp direct set NAME --address HOST\n'
        return 0
    fi
    printf '%-18s %-12s %-36s %-6s %-12s %-36s %s\n' NAME ENDPOINT VALUE PORT LIFECYCLE VALUE POLICY
    local name ep ev port lp lv options_b64
    while IFS='|' read -r name ep ev port lp lv options_b64; do
        [[ -n "$name" && "$name" != \#* ]] || continue
        decode_direct_options "$options_b64"
        printf '%-18s %-12s %-36s %-6s %-12s %-36s %s\n' \
            "$name" "$ep" "$ev" "${port:-3389}" "${lp:-none}" "${lv:--}" "$DIRECT_START_POLICY"
    done < "$RDP_DIRECT_CONFIG"
}

rdp_direct_lifecycle_command() {
    local action="${1:-show}"; shift || true
    case "$action" in
        set) rdp_direct_lifecycle_set "$@" ;;
        rm|remove|clear) rdp_direct_lifecycle_remove "$@" ;;
        show) rdp_direct_show "$@" ;;
        help|-h|--help) rdp_usage ;;
        *) die "unknown direct lifecycle command: $action" ;;
    esac
}

rdp_direct_command() {
    local action="${1:-list}"; shift || true
    case "$action" in
        set) rdp_direct_set "$@" ;;
        show) rdp_direct_show "$@" ;;
        list|ls) rdp_direct_list ;;
        rm|remove|del|delete) rdp_direct_remove "$@" ;;
        lifecycle) rdp_direct_lifecycle_command "$@" ;;
        start|stop) rdp_direct_control "$action" "$@" ;;
        help|-h|--help) rdp_usage ;;
        *) die "unknown direct RDP command: $action" ;;
    esac
}

rdp_credential_username() {
    local name="$1" override="${2:-}" record username
    record="$(rdp_record "$name" 2>/dev/null || true)"
    [[ -n "$record" ]] || die "unknown RDP binding '$name'"
    IFS='|' read -r _ _ _ username _ <<<"$record"
    if [[ -n "$override" ]]; then username="$override"; fi
    [[ -n "$username" ]] || die "RDP binding '$name' has no configured username"
    printf '%s\n' "$username"
}

rdp_credential_lookup() {
    local name="$1" username="$2" default_username secret
    have secret-tool || return 1
    if secret="$(secret-tool lookup service "$RDP_SECRET_SERVICE" machine "$name" username "$username" 2>/dev/null)" \
        && [[ -n "$secret" ]]; then
        printf '%s' "$secret"
        return
    fi
    # Read the pre-4.4 machine-only entry for the binding's default user.
    default_username="$(rdp_credential_username "$name")"
    [[ "$username" == "$default_username" ]] || return 1
    secret="$(secret-tool lookup service "$RDP_SECRET_SERVICE" machine "$name" 2>/dev/null)" \
        || return 1
    [[ -n "$secret" ]] || return 1
    printf '%s' "$secret"
}

rdp_credential_set() {
    [[ $# -ge 1 ]] || die "usage: ts rdp credential set NAME [--user USER]"
    have secret-tool || die "secret-tool is required (provided by libsecret)"
    local name="$1" username="" password confirmation; shift
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --user) [[ $# -ge 2 ]] || die "--user requires a value"; username="$2"; shift 2 ;;
            *) die "unknown RDP credential set option: $1" ;;
        esac
    done
    username="$(rdp_credential_username "$name" "$username")"

    printf 'Windows password for %s (%s): ' "$name" "$username" >&2
    IFS= read -r -s password || die "unable to read password"
    printf '\nRepeat password: ' >&2
    IFS= read -r -s confirmation || die "unable to read password confirmation"
    printf '\n' >&2
    [[ -n "$password" ]] || die "password cannot be empty"
    [[ "$password" == "$confirmation" ]] || die "passwords do not match"

    if printf '%s' "$password" | secret-tool store \
        --label="ts RDP: $name ($username)" \
        service "$RDP_SECRET_SERVICE" machine "$name" username "$username"; then
        password="" confirmation=""
        log "stored RDP credential for '$name' user '$username' in the desktop keyring"
    else
        password="" confirmation=""
        die "failed to store RDP credential for '$name' in the desktop keyring"
    fi
}

rdp_credential_status() {
    [[ $# -ge 1 ]] || die "usage: ts rdp credential status NAME [--user USER]"
    local name="$1" username=""; shift
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --user) [[ $# -ge 2 ]] || die "--user requires a value"; username="$2"; shift 2 ;;
            *) die "unknown RDP credential status option: $1" ;;
        esac
    done
    username="$(rdp_credential_username "$name" "$username")"
    have secret-tool || die "secret-tool is required (provided by libsecret)"
    if rdp_credential_lookup "$name" "$username" >/dev/null; then
        printf '%s [%s]: stored in desktop keyring\n' "$name" "$username"
    else
        printf '%s [%s]: not stored\n' "$name" "$username"
        return 1
    fi
}

rdp_credential_forget() {
    [[ $# -ge 1 ]] || die "usage: ts rdp credential forget NAME [--user USER]"
    local name="$1" username="" default_username; shift
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --user) [[ $# -ge 2 ]] || die "--user requires a value"; username="$2"; shift 2 ;;
            *) die "unknown RDP credential forget option: $1" ;;
        esac
    done
    username="$(rdp_credential_username "$name" "$username")"
    have secret-tool || die "secret-tool is required (provided by libsecret)"
    default_username="$(rdp_credential_username "$name")"
    if ! secret-tool clear service "$RDP_SECRET_SERVICE" machine "$name" username "$username" >/dev/null; then
        if [[ "$username" != "$default_username" ]] \
            || ! secret-tool clear service "$RDP_SECRET_SERVICE" machine "$name" >/dev/null; then
            die "failed to remove RDP credential for '$name' user '$username' from the desktop keyring"
        fi
    elif [[ "$username" == "$default_username" ]]; then
        secret-tool clear service "$RDP_SECRET_SERVICE" machine "$name" >/dev/null 2>&1 || true
    fi
    log "removed RDP credential for '$name' user '$username' from the desktop keyring"
}

rdp_credential_command() {
    local action="${1:-status}"; shift || true
    case "$action" in
        set) rdp_credential_set "$@" ;;
        status|show) rdp_credential_status "$@" ;;
        forget|rm|remove|delete) rdp_credential_forget "$@" ;;
        help|-h|--help) rdp_usage ;;
        *) die "unknown RDP credential command: $action" ;;
    esac
}

rdp_launch() {
    [[ $# -ge 1 ]] || die "usage: ts rdp MACHINE [--user USER] [--direct] [--wait-for-shutdown] [--] [extra FreeRDP arguments...]"
    local name="$1"; shift
    local direct=0 wait_for_shutdown=0 saw_separator=0 selected_user=""
    local -a extra=()
    while [[ $# -gt 0 ]]; do
        if (( saw_separator )); then
            extra+=("$1"); shift; continue
        fi
        case "$1" in
            --direct) direct=1; shift ;;
            --wait-for-shutdown) wait_for_shutdown=1; shift ;;
            --user) [[ $# -ge 2 ]] || die "--user requires a value"; selected_user="$2"; shift 2 ;;
            --) saw_separator=1; shift ;;
            *) extra+=("$1"); shift ;;
        esac
    done
    (( ! wait_for_shutdown || direct )) \
        || die "--wait-for-shutdown is available only with --direct"

    local record target ip username port server_name args_b64
    record="$(rdp_record "$name" 2>/dev/null || true)"
    [[ -n "$record" ]] || die "unknown RDP binding '$name'; add it with: ts rdp add $name [TARGET]"
    IFS='|' read -r _ target ip username port server_name args_b64 <<<"$record"
    username="${selected_user:-$username}"
    [[ -n "$username" ]] || die "RDP binding '$name' has no username; configure one or pass --user USER"
    server_name="${server_name:-$target}"

    local freerdp
    freerdp="$(find_freerdp || true)"
    [[ -n "$freerdp" ]] || die "FreeRDP client not found (expected xfreerdp3, xfreerdp, or wlfreerdp)"

    local dial_host="$ip" dial_port=3389 route="Tailscale bridge"
    if (( direct )); then
        local direct_record endpoint_provider endpoint_value direct_port lifecycle_provider lifecycle_value options_b64
        direct_record="$(rdp_direct_record "$name" 2>/dev/null || true)"
        [[ -n "$direct_record" ]] || die "no direct RDP mapping for '$name'; configure one with: ts rdp direct set $name --address HOST"
        IFS='|' read -r _ endpoint_provider endpoint_value direct_port lifecycle_provider lifecycle_value options_b64 <<<"$direct_record"
        decode_direct_options "$options_b64"
        if (( wait_for_shutdown )) && [[ "$lifecycle_provider" == none || -z "$lifecycle_provider" ]]; then
            die "--wait-for-shutdown requires a configured VM lifecycle provider"
        fi
        direct_lifecycle_prepare "${lifecycle_provider:-none}" "$lifecycle_value" "$DIRECT_LIFECYCLE_URI" "$DIRECT_START_POLICY"
        direct_prepare_endpoint "$endpoint_provider" "$endpoint_value" "${direct_port:-3389}" \
            "$DIRECT_ENDPOINT_URI" "$DIRECT_ENDPOINT_ADDRESS" "$DIRECT_ENDPOINT_NETDEV" \
            "$DIRECT_ENDPOINT_GUEST_PORT"
        if [[ "$DIRECT_START_POLICY" == on-demand ]]; then
            direct_wait_for_ready "$endpoint_provider" "$endpoint_value" "${direct_port:-3389}" \
                "$DIRECT_ENDPOINT_URI" "$DIRECT_ENDPOINT_MAC" "$DIRECT_BOOT_TIMEOUT" "$DIRECT_ENDPOINT_ADDRESS"
        else
            direct_resolve_endpoint "$endpoint_provider" "$endpoint_value" "$DIRECT_ENDPOINT_URI" "$DIRECT_ENDPOINT_MAC" "$DIRECT_ENDPOINT_ADDRESS" \
                || die "$DIRECT_RESOLVE_ERROR"
        fi
        dial_host="$DIRECT_RESOLVED_HOST"
        dial_port="${direct_port:-3389}"
        route="direct/$endpoint_provider ($DIRECT_RESOLVED_SOURCE)"
    else
        rdp_start
    fi

    local -a persistent=() user_args=()
    [[ -n "$args_b64" ]] && mapfile -d '' -t persistent < <(decode_arg_vector_nul "$args_b64")
    user_args=("${persistent[@]}" "${extra[@]}")

    local -a args=("/v:${dial_host}:${dial_port}" +clipboard /dynamic-resolution)
    [[ -n "$username" ]] && args+=("/u:$username")

    # The TCP connection may terminate at a loopback bridge/direct endpoint,
    # but TLS/NLA must validate the actual Windows host. User arguments are
    # examined first and then appended last, so they can override our defaults.
    local help_text has_server_override=0 has_cert_policy=0 has_auth_override=0 arg
    help_text="$("$freerdp" /help 2>&1 || true)"
    for arg in "${user_args[@]}"; do
        case "$arg" in
            /server-name:*|/cert-name:*|/cert:name:*) has_server_override=1 ;;
        esac
        case "$arg" in
            /cert:*|/cert-tofu|/cert-ignore|/cert-deny) has_cert_policy=1 ;;
        esac
        case "${arg,,}" in
            /u:*|/username:*|/p:*|/password:*|/from-stdin*|/pth:*|/pass-the-hash:*) has_auth_override=1 ;;
        esac
    done

    if (( ! has_server_override )); then
        if grep -q '/server-name:' <<<"$help_text"; then
            args+=("/server-name:$server_name")
        elif grep -q '/cert-name:' <<<"$help_text"; then
            args+=("/cert-name:$server_name")
        elif grep -q '/cert:' <<<"$help_text"; then
            args+=("/cert:name:$server_name")
        else
            die "installed FreeRDP exposes no certificate/server-name override; cannot safely validate $server_name while dialing $ip"
        fi
    fi

    if (( ! has_cert_policy )); then
        if grep -q '/cert:' <<<"$help_text"; then
            args+=("/cert:tofu")
        elif grep -q '/cert-tofu' <<<"$help_text"; then
            args+=("/cert-tofu")
        else
            die "installed FreeRDP exposes no TOFU certificate option"
        fi
    fi

    local stored_password=""
    if (( ! has_auth_override )) && stored_password="$(rdp_credential_lookup "$name" "$username")"; then
        grep -q '/from-stdin' <<<"$help_text" \
            || die "stored RDP credentials require FreeRDP /from-stdin support"
        args+=(/from-stdin:force)
        log "using RDP credential for '$name' user '$username' from the desktop keyring"
    fi

    # Persistent per-machine options first, invocation-specific options last.
    # Example: ts rdp kubuntu -- -rfx /f
    args+=("${persistent[@]}" "${extra[@]}")

    log "RDP $name -> ${dial_host}:${dial_port} via $route (server-name $server_name)"
    if (( wait_for_shutdown )); then
        local freerdp_status
        if [[ -n "$stored_password" ]]; then
            if printf '%s\n' "$stored_password" | "$freerdp" "${args[@]}"; then
                freerdp_status=0
            else
                freerdp_status=$?
            fi
            stored_password=""
        else
            if "$freerdp" "${args[@]}"; then
                freerdp_status=0
            else
                freerdp_status=$?
            fi
        fi
        direct_wait_for_shutdown "$lifecycle_provider" "$lifecycle_value" "$DIRECT_LIFECYCLE_URI"
        return "$freerdp_status"
    fi
    if [[ -n "$stored_password" ]]; then
        local freerdp_status
        if printf '%s\n' "$stored_password" | "$freerdp" "${args[@]}"; then
            freerdp_status=0
        else
            freerdp_status=$?
        fi
        stored_password=""
        return "$freerdp_status"
    fi
    exec "$freerdp" "${args[@]}"
}
rdp_command() {
    local sub="${1:-list}"
    shift || true
    case "$sub" in
        add) rdp_add "$@" ;;
        rm|remove|del|delete) rdp_remove "$@" ;;
        args|options|opts) rdp_args "$@" ;;
        credential|credentials|cred) rdp_credential_command "$@" ;;
        direct) rdp_direct_command "$@" ;;
        list|ls) rdp_list ;;
        start) rdp_start ;;
        stop) rdp_stop ;;
        restart) rdp_restart ;;
        status) rdp_status ;;
        help|-h|--help) rdp_usage ;;
        *) rdp_launch "$sub" "$@" ;;
    esac
}
rdp_usage() {
    cat <<'EOF_RDP'
Usage:
  ts rdp add NAME [TARGET] [--user USER] [--server-name NAME] [--ip 127.x.x.x] [--port PORT]
  ts rdp add NAME ... [--rdp-arg ARG ...] [--clear-rdp-args]
  ts rdp args NAME [-- ARGS...]     Replace persistent per-machine FreeRDP arguments
  ts rdp args NAME --clear         Clear persistent arguments
  ts rdp credential set NAME [--user USER]       Store one Windows account password
  ts rdp credential status NAME [--user USER]    Report whether that password is stored
  ts rdp credential forget NAME [--user USER]    Remove that stored password
  ts rdp rm NAME
  ts rdp list
  ts rdp start|stop|restart|status
  ts rdp MACHINE [--user USER] [--] [extra FreeRDP args...]
  ts rdp MACHINE [--user USER] --direct [--wait-for-shutdown] [--] [extra FreeRDP args...]

Direct endpoint (explicit; never selected automatically):
  ts rdp direct set NAME --address HOST [--port PORT]
  ts rdp direct set NAME --libvirt-domain DOMAIN [--libvirt-uri URI] [--mac MAC] [--port PORT]
  ts rdp direct set NAME --libvirt-user-domain DOMAIN [--libvirt-uri URI]
      [--host-address ADDRESS] [--port HOST_PORT] [--guest-port PORT] [--netdev ID]
  ts rdp direct set NAME --vmx /absolute/path/to/guest.vmx [--port PORT]
  ts rdp direct show|rm NAME
  ts rdp direct list

Independent VM lifecycle:
  ts rdp direct lifecycle set NAME --libvirt-domain DOMAIN [--libvirt-uri URI]
      [--start-policy manual|on-demand] [--boot-timeout SECONDS]
  ts rdp direct lifecycle set NAME --vmx /absolute/path/to/guest.vmx
      [--start-policy manual|on-demand] [--boot-timeout SECONDS]
  ts rdp direct lifecycle rm NAME
  ts rdp direct start|stop NAME

Defaults:
  TARGET       NAME (MagicDNS name is ideal)
  local IP     first free 127.77.0.x address
  remote port  3389
  server name  TARGET (override only when the Windows TLS identity differs)
  local port   always 3389, on the machine's dedicated loopback address

FreeRDP arguments after MACHINE are relayed verbatim and appended after ts defaults,
so invocation-specific options can override defaults without modifying ts. Persistent
machine-specific options can be stored with `ts rdp args`.

Examples:
  ts rdp add brazil-main --user Amauri
  ts rdp add win-pscad --user 'DOMAIN\\amauri'
  ts rdp add win-comsol --ip 127.77.0.20
  ts rdp add brazil 100.92.252.75 --server-name example-i9 --user 'AMAURI-I9\amauri'
  ts rdp args kubuntu -- -rfx
  ts rdp credential set kubuntu
  ts rdp credential set kubuntu --user 'WINDOWS\\Engineer'
  ts rdp kubuntu
  ts rdp kubuntu --user 'WINDOWS\\Engineer'
  ts rdp direct set kubuntu --libvirt-user-domain win11 --libvirt-uri qemu:///system --port 13389
  ts rdp direct lifecycle set kubuntu --libvirt-domain win11 --libvirt-uri qemu:///system --start-policy on-demand
  ts rdp kubuntu --direct
  ts rdp kubuntu --direct --wait-for-shutdown
  ts rdp kubuntu -- -rfx /f
  ts rdp win-pscad /f
EOF_RDP
}
# Internal bridge daemon. One process binds every configured loopback address.
rdp_serve_internal() {
    ensure_rdp_config
    have python3 || die "python3 is required for RDP bridging"
    rdp_has_bindings || die "RDP bridge has no configured bindings"

    exec python3 - "$RDP_CONFIG" "$PROXY_ADDR" <<'PY'
import csv
import ipaddress
import signal
import socket
import struct
import sys
import threading

config_path = sys.argv[1]
proxy_spec = sys.argv[2]

try:
    proxy_host, proxy_port_s = proxy_spec.rsplit(":", 1)
    proxy_port = int(proxy_port_s)
except Exception as exc:
    raise SystemExit(f"invalid proxy address {proxy_spec!r}: {exc}")

bindings = []
with open(config_path, newline="", encoding="utf-8") as f:
    for row in csv.reader(f, delimiter="|"):
        if not row or row[0].lstrip().startswith("#"):
            continue
        while len(row) < 5:
            row.append("")
        name, target, local_ip, username, remote_port = row[:5]
        bindings.append((name, target, local_ip, int(remote_port or "3389")))

if not bindings:
    raise SystemExit("no RDP bindings configured")

stop = threading.Event()
listeners = []


def recv_exact(sock, n):
    data = bytearray()
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            raise ConnectionError("unexpected EOF from SOCKS5 proxy")
        data.extend(chunk)
    return bytes(data)


def socks_connect(target, port):
    s = socket.create_connection((proxy_host, proxy_port), timeout=15)
    s.settimeout(None)
    s.sendall(b"\x05\x01\x00")
    if recv_exact(s, 2) != b"\x05\x00":
        s.close()
        raise ConnectionError("SOCKS5 proxy rejected no-authentication mode")

    try:
        addr = ipaddress.ip_address(target)
        atyp_addr = (b"\x01" if addr.version == 4 else b"\x04") + addr.packed
    except ValueError:
        encoded = target.encode("idna")
        if len(encoded) > 255:
            s.close()
            raise ValueError("hostname too long for SOCKS5")
        atyp_addr = b"\x03" + bytes([len(encoded)]) + encoded

    s.sendall(b"\x05\x01\x00" + atyp_addr + struct.pack("!H", port))
    ver, reply, _rsv, atyp = recv_exact(s, 4)
    if ver != 5:
        s.close()
        raise ConnectionError(f"invalid SOCKS5 response version {ver}")

    if atyp == 1:
        recv_exact(s, 4)
    elif atyp == 3:
        recv_exact(s, recv_exact(s, 1)[0])
    elif atyp == 4:
        recv_exact(s, 16)
    else:
        s.close()
        raise ConnectionError(f"invalid SOCKS5 address type {atyp}")
    recv_exact(s, 2)

    if reply != 0:
        s.close()
        raise ConnectionError(f"SOCKS5 CONNECT failed, reply={reply}")
    return s


def pump(src, dst):
    try:
        while not stop.is_set():
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except (ConnectionError, OSError):
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle(client, peer, name, target, remote_port):
    remote = None
    try:
        print(f"[{name}] {peer[0]}:{peer[1]} -> {target}:{remote_port}", flush=True)
        remote = socks_connect(target, remote_port)
        a = threading.Thread(target=pump, args=(client, remote), daemon=True)
        b = threading.Thread(target=pump, args=(remote, client), daemon=True)
        a.start(); b.start(); a.join(); b.join()
    except Exception as exc:
        print(f"[{name}] connection failed: {exc}", file=sys.stderr, flush=True)
    finally:
        try: client.close()
        except OSError: pass
        if remote is not None:
            try: remote.close()
            except OSError: pass


def serve(listener, name, target, remote_port):
    while not stop.is_set():
        try:
            client, peer = listener.accept()
        except OSError:
            break
        threading.Thread(
            target=handle,
            args=(client, peer, name, target, remote_port),
            daemon=True,
        ).start()


def shutdown(_signum=None, _frame=None):
    stop.set()
    for listener in listeners:
        try: listener.close()
        except OSError: pass


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

for name, target, local_ip, remote_port in bindings:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        listener.bind((local_ip, 3389))
        listener.listen(8)
    except OSError as exc:
        shutdown()
        raise SystemExit(f"cannot bind {local_ip}:3389 for {name}: {exc}")
    listeners.append(listener)
    print(f"[{name}] {local_ip}:3389 -> {target}:{remote_port} via SOCKS5 {proxy_spec}", flush=True)
    threading.Thread(target=serve, args=(listener, name, target, remote_port), daemon=True).start()

while not stop.wait(1.0):
    pass
PY
}

# -----------------------------------------------------------------------------
# SSH key / fleet configuration
#
# ssh-keys.tsv contains client LOGIN public keys copied to authorized_keys.
# It never contains SSH server host keys; those belong in known_hosts.
# Records accept pipe or tab separators:
#   name | key_type | public_key | comment/source | targets
# targets is '*', '-', or a comma-separated list of fleet host names. '-' means disabled/unscoped.
# This is intentionally compatible with the earlier five-column notes file:
#   NAME TYPE PUBLIC_KEY SOURCE AUTHORIZED_ON
#
# fleet.tsv is pipe-delimited:
#   name | target | ssh_user | os
# os is linux or windows.
# -----------------------------------------------------------------------------

ensure_config_registry() {
    mkdir -p "$CONFIG_HOME"
    touch "$SSH_KEYS_CONFIG" "$FLEET_CONFIG"
    chmod 600 "$SSH_KEYS_CONFIG" "$FLEET_CONFIG" 2>/dev/null || true
}

validate_config_name() {
    [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] \
        || die "config name must match [A-Za-z0-9._-]+"
}

config_key_record() {
    local name="$1"
    [[ -f "$SSH_KEYS_CONFIG" ]] || return 1
    awk -F '[|\t]' -v n="$name" '$1 == n { print; found=1; exit } END { if (!found) exit 1 }' "$SSH_KEYS_CONFIG"
}

config_key_add() {
    ensure_config_registry
    [[ $# -ge 2 ]] || die "usage: ts config key add NAME PUBLIC_KEY [--on HOST[,HOST...]]"
    local name="$1"; shift
    validate_config_name "$name"

    local key_spec="$1"; shift
    if [[ "$key_spec" == @* ]]; then
        local key_file="${key_spec#@}"
        [[ -r "$key_file" ]] || die "cannot read public key file: $key_file"
        key_spec="$(head -n 1 "$key_file")"
    fi

    local targets="-"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --on)
                [[ $# -ge 2 ]] || die "--on requires a value"
                targets="$2"; shift 2 ;;
            *) die "unknown config key add option: $1" ;;
        esac
    done

    local key_type key_data comment
    key_type="${key_spec%% *}"
    local rest="${key_spec#* }"
    [[ "$rest" != "$key_spec" ]] || die "invalid SSH public key"
    key_data="${rest%% *}"
    if [[ "$rest" == *' '* ]]; then comment="${rest#* }"; else comment="$name"; fi
    case "$key_type" in
        ssh-*|ecdsa-*|sk-*) ;;
        *) die "unsupported SSH public key type: $key_type" ;;
    esac
    [[ "$key_data" =~ ^[A-Za-z0-9+/=]+$ ]] || die "invalid SSH public key payload"
    [[ -n "$targets" ]] || targets="-"

    local tmp
    tmp="$(mktemp "${TMPDIR:-/tmp}/ts-keys.XXXXXX")"
    awk -F '[|\t]' -v n="$name" '$1 != n' "$SSH_KEYS_CONFIG" > "$tmp" || true
    printf '%s|%s|%s|%s|%s\n' "$name" "$key_type" "$key_data" "$comment" "$targets" >> "$tmp"
    sort -t '|' -k1,1 "$tmp" > "$SSH_KEYS_CONFIG"
    rm -f "$tmp"
    chmod 600 "$SSH_KEYS_CONFIG" 2>/dev/null || true
    log "registered SSH public key '$name' targets=$targets"
}

config_key_remove() {
    ensure_config_registry
    [[ $# -eq 1 ]] || die "usage: ts config key rm NAME"
    local name="$1" tmp
    config_key_record "$name" >/dev/null 2>&1 || die "unknown SSH key: $name"
    tmp="$(mktemp "${TMPDIR:-/tmp}/ts-keys.XXXXXX")"
    awk -F '[|\t]' -v n="$name" '$1 != n' "$SSH_KEYS_CONFIG" > "$tmp" || true
    mv "$tmp" "$SSH_KEYS_CONFIG"
    chmod 600 "$SSH_KEYS_CONFIG" 2>/dev/null || true
}

config_key_scope() {
    ensure_config_registry
    [[ $# -eq 2 ]] || die "usage: ts config key scope NAME HOST[,HOST...]|*|-"
    local name="$1" targets="$2" rec key_type key_data comment tmp
    rec="$(config_key_record "$name" 2>/dev/null || true)"
    [[ -n "$rec" ]] || die "unknown SSH key: $name"
    IFS=$'|\t' read -r _ key_type key_data comment _ <<< "$rec"
    [[ -n "$targets" ]] || targets="-"
    tmp="$(mktemp "${TMPDIR:-/tmp}/ts-keys.XXXXXX")"
    awk -F '[|\t]' -v n="$name" '$1 != n' "$SSH_KEYS_CONFIG" > "$tmp" || true
    printf '%s|%s|%s|%s|%s\n' "$name" "$key_type" "$key_data" "${comment:-$name}" "$targets" >> "$tmp"
    sort -t '|' -k1,1 "$tmp" > "$SSH_KEYS_CONFIG"
    rm -f "$tmp"
    chmod 600 "$SSH_KEYS_CONFIG" 2>/dev/null || true
    log "SSH key '$name' targets=$targets"
}

config_key_list() {
    ensure_config_registry
    printf '%-20s %-14s %-28s %s\n' NAME TYPE TARGETS COMMENT
    awk -F '[|\t]' '
        /^[[:space:]]*(#|$)/ {next}
        NF >= 3 {
            targets=$5; if (targets == "") targets="-";
            comment=$4; if (comment == "") comment=$1;
            printf "%-20s %-14s %-28s %s\n", $1, $2, targets, comment
        }
    ' "$SSH_KEYS_CONFIG"
}

config_keys_for_host() {
    local host="$1"
    ensure_config_registry
    awk -F '[|\t]' -v h="$host" '
        /^[[:space:]]*(#|$)/ {next}
        NF >= 3 {
            targets=$5; if (targets == "") targets="-";
            ok=(targets == "*");
            if (!ok) {
                n=split(targets,a,",");
                for (i=1;i<=n;i++) if (a[i] == h) ok=1;
            }
            if (ok) printf "%s %s ts:%s\n", $2, $3, $1;
        }
    ' "$SSH_KEYS_CONFIG"
}

fleet_record() {
    local name="$1"
    [[ -f "$FLEET_CONFIG" ]] || return 1
    awk -F '|' -v n="$name" '$1 == n { print; found=1; exit } END { if (!found) exit 1 }' "$FLEET_CONFIG"
}

config_host_add() {
    ensure_config_registry
    [[ $# -ge 1 ]] || die "usage: ts config host add NAME [TARGET] --user USER --os linux|windows"
    local name="$1"; shift
    validate_config_name "$name"
    local target="$name" user="" os=""
    if [[ $# -gt 0 && "$1" != --* ]]; then target="$1"; shift; fi
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --user)
                [[ $# -ge 2 ]] || die "--user requires a value"
                user="$2"; shift 2 ;;
            --os)
                [[ $# -ge 2 ]] || die "--os requires a value"
                os="${2,,}"; shift 2 ;;
            *) die "unknown config host add option: $1" ;;
        esac
    done
    [[ -n "$user" ]] || die "--user is required"
    case "$os" in linux|windows) ;; *) die "--os must be linux or windows" ;; esac

    local tmp
    tmp="$(mktemp "${TMPDIR:-/tmp}/ts-fleet.XXXXXX")"
    awk -F '|' -v n="$name" '$1 != n' "$FLEET_CONFIG" > "$tmp" || true
    printf '%s|%s|%s|%s\n' "$name" "$target" "$user" "$os" >> "$tmp"
    sort -t '|' -k1,1 "$tmp" > "$FLEET_CONFIG"
    rm -f "$tmp"
    chmod 600 "$FLEET_CONFIG" 2>/dev/null || true
    log "registered fleet host '$name' -> $user@$target ($os)"
}

config_host_remove() {
    ensure_config_registry
    [[ $# -eq 1 ]] || die "usage: ts config host rm NAME"
    local name="$1" tmp
    fleet_record "$name" >/dev/null 2>&1 || die "unknown fleet host: $name"
    tmp="$(mktemp "${TMPDIR:-/tmp}/ts-fleet.XXXXXX")"
    awk -F '|' -v n="$name" '$1 != n' "$FLEET_CONFIG" > "$tmp" || true
    mv "$tmp" "$FLEET_CONFIG"
    chmod 600 "$FLEET_CONFIG" 2>/dev/null || true
}

config_host_list() {
    ensure_config_registry
    printf '%-20s %-28s %-24s %s\n' NAME TARGET SSH_USER OS
    awk -F '|' '/^[[:space:]]*(#|$)/ {next} NF >= 4 {printf "%-20s %-28s %-24s %s\n", $1,$2,$3,$4}' "$FLEET_CONFIG"
}

config_controller_init() {
    ensure_config_registry
    have ssh-keygen || die "ssh-keygen is required"
    local name="${1:-$(hostname -s 2>/dev/null || printf controller)}"
    validate_config_name "$name"
    mkdir -p "$HOME/.ssh"
    chmod 700 "$HOME/.ssh"
    if [[ ! -f "$FLEET_IDENTITY" ]]; then
        ssh-keygen -q -t ed25519 -N '' -f "$FLEET_IDENTITY" -C "ts-fleet:$name"
        chmod 600 "$FLEET_IDENTITY"
        chmod 644 "$FLEET_IDENTITY.pub"
        log "created fleet controller key: $FLEET_IDENTITY"
    else
        [[ -f "$FLEET_IDENTITY.pub" ]] || ssh-keygen -y -f "$FLEET_IDENTITY" > "$FLEET_IDENTITY.pub"
        log "fleet controller key already exists: $FLEET_IDENTITY"
    fi
    config_key_add "controller-$name" "$(cat "$FLEET_IDENTITY.pub")" --on '*'
}

write_managed_authorized_keys_local() {
    local host_name="$1" auth="$HOME/.ssh/authorized_keys" tmp keys
    mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
    keys="$(config_keys_for_host "$host_name")"
    [[ -n "$keys" ]] || die "no SSH keys are authorized for host '$host_name'"
    tmp="$(mktemp "${TMPDIR:-/tmp}/ts-authkeys.XXXXXX")"
    if [[ -f "$auth" ]]; then
        awk '
            $0 == "# BEGIN ts managed keys" {skip=1; next}
            $0 == "# END ts managed keys" {skip=0; next}
            !skip {print}
        ' "$auth" > "$tmp"
    fi
    while [[ -s "$tmp" ]] && [[ "$(tail -c 1 "$tmp" | wc -l)" -eq 0 ]]; do printf '\n' >> "$tmp"; break; done
    {
        printf '# BEGIN ts managed keys\n'
        printf '%s\n' "$keys"
        printf '# END ts managed keys\n'
    } >> "$tmp"
    mv "$tmp" "$auth"
    chmod 600 "$auth"
    log "authorized managed keys locally for host '$host_name' in $auth"
}

fleet_proxy_cmd() {
    ensure_daemon
    local proxy_cmd
    printf -v proxy_cmd '%q --socket=%q nc %%h %%p' "$TAILSCALE" "$SOCKET"
    printf '%s\n' "$proxy_cmd"
}

fleet_ssh_base() {
    local -n _out="$1"
    local proxy_cmd
    proxy_cmd="$(fleet_proxy_cmd)"
    _out=(ssh -o "ProxyCommand=$proxy_cmd" -o StrictHostKeyChecking=accept-new)
    [[ -f "$FLEET_IDENTITY" ]] && _out+=(-i "$FLEET_IDENTITY")
    return 0
}

validate_fleet_credentials() {
    local path="$1" mode
    [[ -f "$path" && -r "$path" ]] || die "credentials file is not readable: $path"
    mode="$(stat -c '%a' "$path" 2>/dev/null || true)"
    [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "unable to inspect credentials file permissions: $path"
    (( (8#$mode & 077) == 0 )) || die "credentials file must not be accessible by group or others: chmod 600 $path"
    awk -F '|' '
        /^[[:space:]]*(#|$)/ {next}
        NF != 2 || $1 !~ /^[A-Za-z0-9._-]+$/ || $2 == "" {bad=1}
        END {exit bad}
    ' "$path" || die "invalid credentials file; expected NAME|PASSWORD with no pipe or newline in the password"
}

fleet_password_for_host() {
    local path="$1" wanted="$2" name password
    validate_fleet_credentials "$path"
    while IFS='|' read -r name password; do
        [[ -n "$name" && "$name" != \#* ]] || continue
        if [[ "$name" == "$wanted" ]]; then
            printf '%s\n' "$password"
            return 0
        fi
    done < "$path"
    return 1
}

fleet_ssh_run_script() {
    local host_name="$1" credentials="$2" script="$3"; shift 3
    if [[ -z "$credentials" ]]; then
        "$@" < "$script"
        return
    fi
    fleet_password_for_host "$credentials" "$host_name" >/dev/null \
        || die "credentials file has no password for fleet host '$host_name'"
    TS_FLEET_ASKPASS_MODE=1 \
    TS_FLEET_ASKPASS_FILE="$credentials" \
    TS_FLEET_ASKPASS_HOST="$host_name" \
    SSH_ASKPASS="$(self_path)" \
    SSH_ASKPASS_REQUIRE=force \
    DISPLAY="${DISPLAY:-ts-bootstrap}" \
        "$@" < "$script"
}

powershell_encode_file() {
    local path="$1"
    have python3 || die "python3 is required for Windows fleet operations"
    python3 - "$path" <<'PY_POWERSHELL_ENCODE'
import base64
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
print(base64.b64encode(text.encode("utf-16le")).decode("ascii"))
PY_POWERSHELL_ENCODE
}

config_push_linux() {
    local host_name="$1" target="$2" user="$3" credentials="${4:-}" keys script
    keys="$(config_keys_for_host "$host_name")"
    [[ -n "$keys" ]] || die "no SSH keys are authorized for host '$host_name'"
    script="$(mktemp "${TMPDIR:-/tmp}/ts-push-linux.XXXXXX")"
    cat > "$script" <<'EOS_LINUX'
set -eu
umask 077
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
auth="$HOME/.ssh/authorized_keys"
base="$(mktemp "${TMPDIR:-/tmp}/ts-authbase.XXXXXX")"
tmp="$(mktemp "${TMPDIR:-/tmp}/ts-authkeys.XXXXXX")"
keys="$(mktemp "${TMPDIR:-/tmp}/ts-keys.XXXXXX")"
trap 'rm -f "$base" "$tmp" "$keys"' EXIT HUP INT TERM
if [ -f "$auth" ]; then
    awk '
        $0 == "# BEGIN ts managed keys" {skip=1; next}
        $0 == "# END ts managed keys" {skip=0; next}
        !skip {print}
    ' "$auth" > "$base"
fi
cat > "$keys" <<'__TS_KEYS__'
EOS_LINUX
    printf '%s\n' "$keys" >> "$script"
    cat >> "$script" <<'EOS_LINUX'
__TS_KEYS__
{
    cat "$base"
    [ ! -s "$base" ] || printf '\n'
    printf '# BEGIN ts managed keys\n'
    cat "$keys"
    printf '# END ts managed keys\n'
} > "$tmp"
mv "$tmp" "$auth"
chmod 600 "$auth"
rm -f "$base" "$keys"
trap - EXIT HUP INT TERM
printf 'ts: authorized managed keys in %s\n' "$auth"
EOS_LINUX

    local -a ssh_cmd
    fleet_ssh_base ssh_cmd
    log "pushing SSH authorization -> $host_name ($user@$target, linux)"
    if fleet_ssh_run_script "$host_name" "$credentials" "$script" \
        "${ssh_cmd[@]}" -l "$user" "$target" 'bash -s'; then
        rm -f "$script"
        return 0
    else
        local rc=$?
        rm -f "$script"
        return "$rc"
    fi
}

config_push_windows() {
    local host_name="$1" target="$2" user="$3" credentials="${4:-}" keys payload script encoded
    keys="$(config_keys_for_host "$host_name")"
    [[ -n "$keys" ]] || die "no SSH keys are authorized for host '$host_name'"
    payload="$(printf '%s\n' "$keys" | python3 -c 'import base64,sys; print(base64.b64encode(sys.stdin.buffer.read()).decode())')"
    script="$(mktemp "${TMPDIR:-/tmp}/ts-push-win.XXXXXX.ps1")"
    {
        # Keep the PowerShell body in a quoted heredoc. An unquoted heredoc lets
        # Bash execute PowerShell backtick escapes such as `r and `n as command
        # substitutions while merely *constructing* the script. The payload is
        # base64, so embedding it in one single-quoted assignment is safe.
        printf "\$payload = '%s'\n" "$payload"
        cat <<'EOF_PS1'
$ErrorActionPreference = 'Stop'
$keysText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)).TrimEnd()
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    $path = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
    New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
} else {
    $dir = Join-Path $env:USERPROFILE '.ssh'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $path = Join-Path $dir 'authorized_keys'
}
$existing = if (Test-Path $path) { Get-Content -Raw -LiteralPath $path } else { '' }
$pattern = '(?ms)^# BEGIN ts managed keys\r?\n.*?^# END ts managed keys\r?\n?'
$base = [regex]::Replace($existing, $pattern, '').TrimEnd("`r", "`n")
$block = "# BEGIN ts managed keys`r`n" + $keysText + "`r`n# END ts managed keys`r`n"
$content = if ([string]::IsNullOrWhiteSpace($base)) { $block } else { $base + "`r`n`r`n" + $block }
Set-Content -LiteralPath $path -Value $content -Encoding Ascii -NoNewline
if ($isAdmin) {
    & icacls.exe $path /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed with exit code $LASTEXITCODE" }
}
Write-Output "ts: authorized managed keys in $path"
EOF_PS1
    } > "$script"
    encoded="$(powershell_encode_file "$script")"
    local -a ssh_cmd
    fleet_ssh_base ssh_cmd
    log "pushing SSH authorization -> $host_name ($user@$target, windows)"
    if fleet_ssh_run_script "$host_name" "$credentials" /dev/null \
        "${ssh_cmd[@]}" -l "$user" "$target" \
        "powershell.exe -NoProfile -NonInteractive -OutputFormat Text -ExecutionPolicy Bypass -EncodedCommand $encoded"; then
        rm -f "$script"
        return 0
    else
        local rc=$?
        rm -f "$script"
        return "$rc"
    fi
}

config_push_one() {
    local name="$1" credentials="${2:-}" rec target user os
    rec="$(fleet_record "$name" 2>/dev/null || true)"
    [[ -n "$rec" ]] || die "unknown fleet host '$name'; add it with: ts config host add $name --user USER --os linux|windows"
    IFS='|' read -r _ target user os <<< "$rec"
    case "$os" in
        linux) config_push_linux "$name" "$target" "$user" "$credentials" ;;
        windows) config_push_windows "$name" "$target" "$user" "$credentials" ;;
        *) die "invalid OS '$os' for fleet host '$name'" ;;
    esac
}

config_bootstrap() {
    [[ $# -ge 1 ]] || die "usage: ts config bootstrap HOST|--all [--credentials FILE]"
    local selector="$1" credentials="$FLEET_CREDENTIALS" name rc=0; shift
    local -a credential_hosts=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --credentials)
                [[ $# -ge 2 ]] || die "--credentials requires a file"
                credentials="$2"; shift 2 ;;
            *) die "unknown bootstrap option: $1" ;;
        esac
    done
    validate_fleet_credentials "$credentials"
    if [[ "$selector" == --all || "$selector" == all ]]; then
        mapfile -t credential_hosts < <(awk -F '|' '!/^[[:space:]]*(#|$)/ {print $1}' "$credentials")
        (( ${#credential_hosts[@]} )) || die "credentials file has no host records"
        for name in "${credential_hosts[@]}"; do
            if config_push_one "$name" "$credentials"; then
                log "bootstrap OK: $name"
            else
                log "bootstrap FAILED: $name"
                rc=1
            fi
        done
        return "$rc"
    fi
    config_push_one "$selector" "$credentials"
    log "bootstrap OK: $selector"
}

config_enroll_one() {
    local name="$1" targets="$2" rec target user os key_spec key_type key_data script encoded
    rec="$(fleet_record "$name" 2>/dev/null || true)"
    [[ -n "$rec" ]] || die "unknown fleet host '$name'"
    IFS='|' read -r _ target user os <<< "$rec"

    script="$(mktemp "${TMPDIR:-/tmp}/ts-enroll.XXXXXX")"
    local -a ssh_cmd
    fleet_ssh_base ssh_cmd
    case "$os" in
        linux)
            cat > "$script" <<'EOF_ENROLL_LINUX'
set -eu
name="$1"
umask 077
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
key="$HOME/.ssh/id_ed25519"
if [ ! -f "$key" ]; then
    ssh-keygen -q -t ed25519 -N '' -C "ts-login:$name" -f "$key"
fi
cat "$key.pub"
EOF_ENROLL_LINUX
            key_spec="$("${ssh_cmd[@]}" -o BatchMode=yes -l "$user" "$target" \
                'bash -s -- '"$(printf '%q' "$name")" < "$script" | awk '/^(ssh-|ecdsa-|sk-)/ {print; exit}')" ;;
        windows)
            # The dollar sign is PowerShell syntax and must remain literal here.
            # shellcheck disable=SC2016
            printf '$fleetName = %s\n' "$(printf "'%s'" "$name")" > "$script"
            cat >> "$script" <<'EOF_ENROLL_WINDOWS'
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:USERPROFILE '.ssh'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$key = Join-Path $dir 'id_ed25519'
if (-not (Test-Path -LiteralPath $key)) {
    & ssh-keygen.exe -q -t ed25519 -N '""' -C "ts-login:$fleetName" -f $key
    if ($LASTEXITCODE -ne 0) { throw "ssh-keygen failed with exit code $LASTEXITCODE" }
}
Get-Content -LiteralPath ($key + '.pub')
EOF_ENROLL_WINDOWS
            encoded="$(powershell_encode_file "$script")"
            key_spec="$("${ssh_cmd[@]}" -o BatchMode=yes -l "$user" "$target" \
                "powershell.exe -NoProfile -NonInteractive -OutputFormat Text -ExecutionPolicy Bypass -EncodedCommand $encoded" \
                | tr -d '\r' | awk '/^(ssh-|ecdsa-|sk-)/ && !found {line=$0; found=1} END {if (found) print line}')" ;;
        *) rm -f "$script"; die "invalid OS '$os' for fleet host '$name'" ;;
    esac
    rm -f "$script"
    [[ -n "$key_spec" ]] || die "failed to create or read the login public key for '$name'"
    read -r key_type key_data _ <<< "$key_spec"
    key_spec="$key_type $key_data ts-login:$name"
    config_key_add "$name" "$key_spec" --on "$targets"
    log "enrolled login identity from $name; authorized on $targets"
}

enroll_targets_without_source() {
    local source="$1" targets="$2" target result=""
    local -a target_items=()
    [[ "$targets" != '*' ]] || { printf '*\n'; return; }
    IFS=',' read -r -a target_items <<< "$targets"
    for target in "${target_items[@]}"; do
        [[ "$target" != "$source" ]] || continue
        if [[ -n "$result" ]]; then result+=","; fi
        result+="$target"
    done
    printf '%s\n' "$result"
}

config_enroll() {
    [[ $# -ge 1 ]] || die "usage: ts config enroll HOST|--all --on HOST[,HOST...]|*"
    local selector="$1" targets="" name target scoped_targets rc=0; shift
    local -a target_items=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --on) [[ $# -ge 2 ]] || die "--on requires authorization targets"; targets="$2"; shift 2 ;;
            *) die "unknown enroll option: $1" ;;
        esac
    done
    [[ -n "$targets" ]] || die "config enroll requires explicit --on HOST[,HOST...]|*"
    if [[ "$targets" != '*' ]]; then
        IFS=',' read -r -a target_items <<< "$targets"
        (( ${#target_items[@]} )) || die "--on requires at least one fleet host"
        for target in "${target_items[@]}"; do
            validate_config_name "$target"
            fleet_record "$target" >/dev/null 2>&1 || die "unknown authorization target '$target'"
        done
    fi
    if [[ "$selector" == --all || "$selector" == all ]]; then
        while IFS='|' read -r name _ <&3; do
            [[ -n "$name" && "$name" != \#* ]] || continue
            scoped_targets="$(enroll_targets_without_source "$name" "$targets")"
            if [[ -z "$scoped_targets" ]]; then
                log "enroll SKIPPED: $name is the sole authorization target"
                continue
            fi
            if config_enroll_one "$name" "$scoped_targets"; then
                log "enroll OK: $name"
            else
                log "enroll FAILED: $name"
                rc=1
            fi
        done 3< "$FLEET_CONFIG"
    else
        scoped_targets="$(enroll_targets_without_source "$selector" "$targets")"
        [[ -n "$scoped_targets" ]] \
            || die "cannot enroll '$selector' only onto itself; choose another --on target"
        config_enroll_one "$selector" "$scoped_targets"
    fi
    log "enrollment updated the key registry; apply or push the affected targets explicitly"
    return "$rc"
}

config_push() {
    ensure_config_registry
    [[ $# -eq 1 ]] || die "usage: ts config push HOST|--all"
    local selector="$1" rc=0 name
    if [[ "$selector" == "--all" || "$selector" == "all" ]]; then
        local found=0
        while IFS='|' read -r name _ <&3; do
            [[ -n "$name" && "$name" != \#* ]] || continue
            found=1
            if config_push_one "$name"; then
                log "push OK: $name"
            else
                log "push FAILED: $name"
                rc=1
            fi
        done 3< "$FLEET_CONFIG"
        (( found )) || die "fleet registry is empty"
        return "$rc"
    fi
    config_push_one "$selector"
}

config_check_one() {
    local name="$1" rec target user os
    rec="$(fleet_record "$name" 2>/dev/null || true)"
    [[ -n "$rec" ]] || die "unknown fleet host: $name"
    IFS='|' read -r _ target user os <<< "$rec"
    local -a ssh_cmd
    fleet_ssh_base ssh_cmd
    case "$os" in
        linux) "${ssh_cmd[@]}" -o BatchMode=yes -l "$user" "$target" 'printf ts-ok' ;;
        windows) "${ssh_cmd[@]}" -o BatchMode=yes -l "$user" "$target" 'powershell.exe -NoProfile -NonInteractive -Command "Write-Output ts-ok"' ;;
    esac
}

config_check() {
    ensure_config_registry
    [[ $# -eq 1 ]] || die "usage: ts config check HOST|--all"
    local selector="$1" rc=0 name
    if [[ "$selector" == "--all" || "$selector" == "all" ]]; then
        while IFS='|' read -r name _ <&3; do
            [[ -n "$name" && "$name" != \#* ]] || continue
            printf '%-20s ' "$name"
            if config_check_one "$name" >/dev/null 2>&1; then printf 'OK\n'; else printf 'FAILED\n'; rc=1; fi
        done 3< "$FLEET_CONFIG"
        return "$rc"
    fi
    config_check_one "$selector"
}

prune_config_backups() {
    local backup_root="$CONFIG_HOME/backups" snapshot index
    local -a snapshots=()
    if [[ ! "$CONFIG_BACKUP_KEEP" =~ ^[0-9]+$ ]] || (( 10#$CONFIG_BACKUP_KEEP < 1 )); then
        die "TS_CONFIG_BACKUP_KEEP must be a positive integer"
    fi
    [[ -d "$backup_root" ]] || return 0
    mapfile -t snapshots < <(
        find "$backup_root" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null \
            | awk '/^[0-9]{8}T[0-9]{6}(-[0-9]+)?$/' \
            | sort -rV
    )
    for (( index=10#$CONFIG_BACKUP_KEEP; index<${#snapshots[@]}; index++ )); do
        snapshot="${snapshots[$index]}"
        [[ "$snapshot" =~ ^[0-9]{8}T[0-9]{6}(-[0-9]+)?$ ]] \
            || die "refusing to prune unexpected backup name: $snapshot"
        rm -rf -- "${backup_root:?}/$snapshot"
        log "pruned old config backup: $backup_root/$snapshot"
    done
}

config_save() {
    [[ $# -le 1 ]] || die "usage: ts config save [TARGET_DIR]"
    local target_dir="${1:-.}" stage source destination basename changed=0
    [[ -d "$target_dir" ]] || die "config save target is not a directory: $target_dir"
    target_dir="$(cd "$target_dir" && pwd -P)"

    for source in "$RDP_CONFIG" "$SSH_KEYS_CONFIG" "$FLEET_CONFIG"; do
        [[ -f "$source" && -r "$source" ]] || die "portable config is missing or unreadable: $source"
    done

    stage="$(mktemp -d "$target_dir/.ts-config-save.XXXXXX")"
    trap 'rm -rf -- "$stage"' EXIT
    for source in "$RDP_CONFIG" "$SSH_KEYS_CONFIG" "$FLEET_CONFIG"; do
        basename="$(basename "$source")"
        install -m 0600 "$source" "$stage/$basename"
    done

    for source in "$stage/rdp.tsv" "$stage/ssh-keys.tsv" "$stage/fleet.tsv"; do
        basename="$(basename "$source")"
        destination="$target_dir/$basename"
        [[ ! -L "$destination" ]] || die "refusing to replace symlinked config target: $destination"
        if [[ -f "$destination" ]] && cmp -s "$source" "$destination"; then
            chmod 0600 "$destination"
            log "config save unchanged: $destination"
            continue
        fi
        install -m 0600 "$source" "$target_dir/.$basename.ts-save.tmp"
        mv -f -- "$target_dir/.$basename.ts-save.tmp" "$destination"
        log "config saved: $destination"
        changed=1
    done
    rm -rf -- "$stage"
    trap - EXIT
    (( changed )) || log "config save: target already matches installed portable configuration"
    log "host-local direct mappings, bootstrap credentials, keyring secrets, and Tailscale state were not exported"
}

config_install() {
    have python3 || die "python3 is required for config installation"

    local source_dir="$PWD" dry_run=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --from)
                [[ $# -ge 2 ]] || die "--from requires a directory"
                source_dir="$2"; shift 2 ;;
            --dry-run)
                dry_run=1; shift ;;
            *) die "unknown config install option: $1" ;;
        esac
    done
    [[ -d "$source_dir" ]] || die "config source directory does not exist: $source_dir"
    source_dir="$(cd "$source_dir" && pwd -P)"

    # Direct mappings contain host-specific hypervisor identifiers and are
    # deliberately excluded from portable fleet configuration.
    local host_local_file
    for host_local_file in rdp-direct.tsv ssh-direct.tsv credentials.tsv; do
        [[ ! -f "$source_dir/$host_local_file" ]] \
            || log "ignoring host-local $host_local_file from config source"
    done

    mkdir -p "$CONFIG_HOME"
    chmod 700 "$CONFIG_HOME" 2>/dev/null || true

    local stage
    stage="$(mktemp -d "${TMPDIR:-/tmp}/ts-config-install.XXXXXX")"
    # Expand the path now because stage is local to this function.
    # shellcheck disable=SC2064
    trap "rm -rf -- $(printf '%q' "$stage")" EXIT

    # Merge/validate entirely in staging. The canonical files are untouched if
    # any name/material/address conflict is found.
    python3 - "$source_dir" "$CONFIG_HOME" "$RDP_CONFIG" "$SSH_KEYS_CONFIG" "$FLEET_CONFIG" "$BASE" "$stage" <<'PY_CONFIG_INSTALL'
from __future__ import annotations
import base64
import ipaddress
import json
from pathlib import Path
import re
import sys

source_dir = Path(sys.argv[1]).resolve()
config_home = Path(sys.argv[2]).resolve()
rdp_target = Path(sys.argv[3]).expanduser().resolve()
keys_target = Path(sys.argv[4]).expanduser().resolve()
fleet_target = Path(sys.argv[5]).expanduser().resolve()
base = Path(sys.argv[6]).expanduser().resolve()
stage = Path(sys.argv[7]).resolve()
stage.mkdir(parents=True, exist_ok=True)

NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def split_record(line: str) -> list[str]:
    line = line.rstrip("\r\n")
    if "|" in line:
        return [x.strip() for x in line.split("|")]
    return [x.strip() for x in line.split("\t")]


def iter_records(path: Path):
    if not path.is_file():
        return
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        yield lineno, split_record(line)


def add_unique(out: list[Path], seen: set[Path], path: Path):
    try:
        key = path.resolve()
    except OSError:
        key = path.absolute()
    if key not in seen and path.is_file():
        seen.add(key)
        out.append(path)


def source_files(filename: str, target: Path) -> list[Path]:
    paths: list[Path] = []
    seen: set[Path] = set()
    # Installed state has precedence when deduplicating equivalent SSH keys.
    add_unique(paths, seen, target)
    for root in (source_dir, source_dir / "config", source_dir / ".config" / "ts"):
        add_unique(paths, seen, root / filename)
    # Known pre-controller locations. These are migration inputs only.
    for root in (base, Path.home() / ".local" / "share" / "ts"):
        add_unique(paths, seen, root / filename)
    return paths


def fail(msg: str):
    raise SystemExit(f"ts config install: {msg}")


def normalize_rdp(rec: list[str], origin: str):
    rec = rec + [""] * (7 - len(rec))
    name, target, local_ip, user, port, server_name, args_b64 = rec[:7]
    if not name or not NAME_RE.fullmatch(name):
        fail(f"invalid RDP name {name!r} in {origin}")
    target = target or name
    if not local_ip:
        fail(f"RDP binding {name!r} has no local IP in {origin}")
    try:
        ip = ipaddress.ip_address(local_ip)
        if ip.version != 4 or ip not in ipaddress.ip_network("127.0.0.0/8"):
            raise ValueError
    except ValueError:
        fail(f"RDP binding {name!r} has invalid loopback IP {local_ip!r} in {origin}")
    port = port or "3389"
    try:
        p = int(port)
        if not 1 <= p <= 65535:
            raise ValueError
    except ValueError:
        fail(f"RDP binding {name!r} has invalid remote port {port!r} in {origin}")
    server_name = server_name or target
    # Validate/canonicalize persistent FreeRDP arg payload when present.
    if args_b64:
        try:
            args = json.loads(base64.urlsafe_b64decode(args_b64.encode("ascii")).decode("utf-8"))
            if not isinstance(args, list) or not all(isinstance(x, str) for x in args):
                raise ValueError("not a string array")
            if args:
                args_b64 = base64.urlsafe_b64encode(
                    json.dumps(args, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                ).decode("ascii")
            else:
                args_b64 = ""
        except Exception as exc:
            fail(f"RDP binding {name!r} has invalid persistent-args payload in {origin}: {exc}")
    return (name, target, local_ip, user, str(p), server_name, args_b64)


def merge_rdp(paths: list[Path]):
    by_name = {}
    origins = {}
    for path in paths:
        for lineno, fields in iter_records(path):
            origin = f"{path}:{lineno}"
            rec = normalize_rdp(fields, origin)
            name = rec[0]
            if name in by_name and by_name[name] != rec:
                fail(f"conflicting RDP definition for {name!r}: {origins[name]} vs {origin}")
            by_name.setdefault(name, rec)
            origins.setdefault(name, origin)
    by_ip = {}
    for name, rec in by_name.items():
        ip = rec[2]
        if ip in by_ip and by_ip[ip] != name:
            fail(f"RDP local IP {ip} is assigned to both {by_ip[ip]!r} and {name!r}")
        by_ip[ip] = name
    return [by_name[k] for k in sorted(by_name)]


def normalize_targets(text: str) -> set[str]:
    text = (text or "-").strip()
    if text == "*":
        return {"*"}
    if text in ("", "-"):
        return set()
    vals = {x.strip() for x in text.split(",") if x.strip()}
    for val in vals:
        if not NAME_RE.fullmatch(val):
            fail(f"invalid SSH-key target name {val!r}")
    return vals


def targets_text(vals: set[str]) -> str:
    if "*" in vals:
        return "*"
    return ",".join(sorted(vals)) if vals else "-"


def merge_keys(paths: list[Path]):
    # Preserve the first name/comment encountered (installed config is first),
    # but deduplicate by public-key material and union authorization scopes.
    by_name = {}
    by_data = {}
    origin_by_name = {}
    ordered = []
    for path in paths:
        for lineno, fields in iter_records(path):
            origin = f"{path}:{lineno}"
            fields = fields + [""] * (5 - len(fields))
            name, key_type, key_data, comment, targets = fields[:5]
            if not name or not NAME_RE.fullmatch(name):
                fail(f"invalid SSH key name {name!r} in {origin}")
            if not key_type or not (key_type.startswith("ssh-") or key_type.startswith("ecdsa-") or key_type.startswith("sk-")):
                fail(f"invalid SSH key type for {name!r} in {origin}: {key_type!r}")
            if not re.fullmatch(r"[A-Za-z0-9+/=]+", key_data or ""):
                fail(f"invalid SSH key payload for {name!r} in {origin}")
            scopes = normalize_targets(targets)

            if name in by_name and by_name[name][1] != key_data:
                fail(f"SSH key name {name!r} refers to different key material: {origin_by_name[name]} vs {origin}")

            if key_data in by_data:
                canonical = by_data[key_data]
                if canonical[0] != key_type:
                    fail(f"same SSH key payload has conflicting types in {origin}")
                canonical[3].update(scopes)
                by_name[name] = canonical
                origin_by_name.setdefault(name, origin)
                continue

            record = [key_type, key_data, comment or name, scopes, name]
            by_data[key_data] = record
            by_name[name] = record
            origin_by_name[name] = origin
            ordered.append(record)

    result = []
    for key_type, key_data, comment, scopes, canonical_name in ordered:
        result.append((canonical_name, key_type, key_data, comment, targets_text(scopes)))
    return sorted(result, key=lambda x: x[0])


def normalize_fleet(fields: list[str], origin: str):
    fields = fields + [""] * (4 - len(fields))
    name, target, user, os_name = fields[:4]
    if not name or not NAME_RE.fullmatch(name):
        fail(f"invalid fleet host name {name!r} in {origin}")
    target = target or name
    if not user:
        fail(f"fleet host {name!r} has no SSH user in {origin}")
    os_name = os_name.lower()
    if os_name not in {"linux", "windows"}:
        fail(f"fleet host {name!r} has invalid OS {os_name!r} in {origin}")
    return (name, target, user, os_name)


def merge_fleet(paths: list[Path]):
    by_name = {}
    origins = {}
    for path in paths:
        for lineno, fields in iter_records(path):
            origin = f"{path}:{lineno}"
            rec = normalize_fleet(fields, origin)
            name = rec[0]
            if name in by_name and by_name[name] != rec:
                fail(f"conflicting fleet definition for {name!r}: {origins[name]} vs {origin}")
            by_name.setdefault(name, rec)
            origins.setdefault(name, origin)
    return [by_name[k] for k in sorted(by_name)]


rdp_paths = source_files("rdp.tsv", rdp_target)
key_paths = source_files("ssh-keys.tsv", keys_target)
fleet_paths = source_files("fleet.tsv", fleet_target)

rdp = merge_rdp(rdp_paths)
keys = merge_keys(key_paths)
fleet = merge_fleet(fleet_paths)

(stage / "rdp.tsv").write_text("".join("|".join(x) + "\n" for x in rdp), encoding="utf-8")
(stage / "ssh-keys.tsv").write_text("".join("|".join(x) + "\n" for x in keys), encoding="utf-8")
(stage / "fleet.tsv").write_text("".join("|".join(x) + "\n" for x in fleet), encoding="utf-8")

print(f"[ts] config source: {source_dir}", file=sys.stderr)
print(f"[ts] merged RDP bindings: {len(rdp)}", file=sys.stderr)
print(f"[ts] merged SSH login public keys: {len(keys)}", file=sys.stderr)
print(f"[ts] merged fleet hosts: {len(fleet)}", file=sys.stderr)
for label, paths in (("rdp", rdp_paths), ("ssh-keys", key_paths), ("fleet", fleet_paths)):
    if paths:
        print(f"[ts] {label} inputs: " + ", ".join(str(p) for p in paths), file=sys.stderr)
PY_CONFIG_INSTALL

    local rdp_changed=0 keys_changed=0 fleet_changed=0
    [[ -f "$RDP_CONFIG" ]] && cmp -s "$RDP_CONFIG" "$stage/rdp.tsv" || rdp_changed=1
    [[ -f "$SSH_KEYS_CONFIG" ]] && cmp -s "$SSH_KEYS_CONFIG" "$stage/ssh-keys.tsv" || keys_changed=1
    [[ -f "$FLEET_CONFIG" ]] && cmp -s "$FLEET_CONFIG" "$stage/fleet.tsv" || fleet_changed=1

    if (( ! rdp_changed && ! keys_changed && ! fleet_changed )); then
        (( dry_run )) || prune_config_backups
        log "config already installed and normalized; no changes"
        return 0
    fi

    if (( dry_run )); then
        log "dry run: validation/merge succeeded; no files changed"
        (( rdp_changed )) && log "would update: $RDP_CONFIG"
        (( keys_changed )) && log "would update: $SSH_KEYS_CONFIG"
        (( fleet_changed )) && log "would update: $FLEET_CONFIG"
        return 0
    fi

    local was_rdp_running=0
    if rdp_bridge_running; then was_rdp_running=1; fi

    local stamp backup_dir suffix=0
    stamp="$(date '+%Y%m%dT%H%M%S')"
    backup_dir="$CONFIG_HOME/backups/$stamp"
    while [[ -e "$backup_dir" ]]; do
        suffix=$((suffix + 1))
        backup_dir="$CONFIG_HOME/backups/${stamp}-$suffix"
    done
    mkdir -p "$backup_dir"
    chmod 700 "$CONFIG_HOME/backups" "$backup_dir" 2>/dev/null || true

    local backed_up=0 file
    for file in "$RDP_CONFIG" "$SSH_KEYS_CONFIG" "$FLEET_CONFIG"; do
        if [[ -f "$file" ]]; then
            cp -p -- "$file" "$backup_dir/$(basename "$file")"
            backed_up=1
        fi
    done
    (( backed_up )) && log "backup: $backup_dir" || rmdir "$backup_dir" 2>/dev/null || true

    mkdir -p "$(dirname "$RDP_CONFIG")" "$(dirname "$SSH_KEYS_CONFIG")" "$(dirname "$FLEET_CONFIG")"
    install -m 0600 "$stage/rdp.tsv" "$RDP_CONFIG"
    install -m 0600 "$stage/ssh-keys.tsv" "$SSH_KEYS_CONFIG"
    install -m 0600 "$stage/fleet.tsv" "$FLEET_CONFIG"
    chmod 700 "$CONFIG_HOME" 2>/dev/null || true

    log "config installed: $CONFIG_HOME"
    (( rdp_changed )) && log "updated RDP registry: $RDP_CONFIG"
    (( keys_changed )) && log "updated SSH-key registry: $SSH_KEYS_CONFIG"
    (( fleet_changed )) && log "updated fleet registry: $FLEET_CONFIG"

    if (( was_rdp_running && rdp_changed )); then
        rdp_restart
    fi
    prune_config_backups
}

config_show() {
    ensure_config_registry
    printf 'config-home:      %s\n' "$CONFIG_HOME"
    printf 'rdp-registry:     %s\n' "$RDP_CONFIG"
    printf 'rdp-direct-local: %s\n' "$RDP_DIRECT_CONFIG"
    printf 'ssh-login-keys:   %s\n' "$SSH_KEYS_CONFIG"
    printf 'ssh-direct-local: %s\n' "$SSH_DIRECT_CONFIG"
    printf 'credentials:      %s%s\n' "$FLEET_CREDENTIALS" "$([[ -f "$FLEET_CREDENTIALS" ]] && printf ' (present)' || printf ' (absent)')"
    printf 'fleet-registry:   %s\n' "$FLEET_CONFIG"
    printf 'controller-key:   %s%s\n' "$FLEET_IDENTITY" "$([[ -f "$FLEET_IDENTITY" ]] && printf ' (present)' || printf ' (absent)')"
    printf 'backup-retention: %s snapshots\n' "$CONFIG_BACKUP_KEEP"
}

config_usage() {
    cat <<'EOF_CONFIG'
Usage: ts config COMMAND ...

Install / migrate:
  ts config install [--from DIR] [--dry-run]
      Merge repository, current, and known legacy registries into ~/.config/ts.
      Validation happens before changes; conflicts abort; existing files are backed up.
      Host-local rdp-direct.tsv, ssh-direct.tsv, and credentials.tsv are never imported or overwritten.
  ts config save [TARGET_DIR]
      Export installed portable rdp.tsv, ssh-keys.tsv, and fleet.tsv. Default: current directory.

Registry:
  ts config path
  ts config show

SSH login public keys (copied to authorized_keys; never server host keys):
  ts config key add NAME 'ssh-ed25519 AAAA... comment' [--on HOST[,HOST...]]
  ts config key scope NAME HOST[,HOST...]|*|-
  ts config key add NAME @/path/to/key.pub [--on HOST[,HOST...]]
  ts config key rm NAME
  ts config key list

Fleet hosts:
  ts config host add NAME [TARGET] --user USER --os linux|windows
  ts config host rm NAME
  ts config host list

Controller / authorization:
  ts config controller init [NAME]   Create one private fleet key on this controller only
  ts config apply [HOSTNAME]         Apply managed keys to this Linux user's authorized_keys
  ts config push HOST                Push applicable keys to one host over Tailscale + SSH
  ts config push --all               Push applicable keys to every fleet host
  ts config bootstrap HOST|--all [--credentials FILE]
                                      First push using passwords from a mode-0600 file
  ts config enroll HOST|--all --on HOST[,HOST...]|*
                                      Create/read user login keys with explicit authorization targets
  ts config sync HOST|--all          Alias for push
  ts config check HOST|--all         Test passwordless controller SSH

The private controller key lives in ~/.ssh/ts-fleet-ed25519 and is NEVER stored
under ~/.config/ts. The config directory is therefore suitable for a private Git
repository. Push requires one existing SSH/password login path for first bootstrap.
EOF_CONFIG
}

config_command() {
    local sub="${1:-help}"; shift || true
    case "$sub" in
        install) config_install "$@" ;;
        save|export) config_save "$@" ;;
        path) printf '%s\n' "$CONFIG_HOME" ;;
        show) config_show ;;
        key)
            local op="${1:-list}"; shift || true
            case "$op" in
                add) config_key_add "$@" ;;
                rm|remove|del|delete) config_key_remove "$@" ;;
                scope) config_key_scope "$@" ;;
                list|ls) config_key_list ;;
                *) die "unknown config key command: $op" ;;
            esac ;;
        host)
            local op="${1:-list}"; shift || true
            case "$op" in
                add) config_host_add "$@" ;;
                rm|remove|del|delete) config_host_remove "$@" ;;
                list|ls) config_host_list ;;
                *) die "unknown config host command: $op" ;;
            esac ;;
        controller)
            local op="${1:-init}"; shift || true
            case "$op" in init) config_controller_init "$@" ;; *) die "unknown controller command: $op" ;; esac ;;
        apply)
            write_managed_authorized_keys_local "${1:-$(hostname -s)}" ;;
        push|sync) config_push "$@" ;;
        bootstrap) config_bootstrap "$@" ;;
        enroll) config_enroll "$@" ;;
        check) config_check "$@" ;;
        help|-h|--help) config_usage ;;
        *) die "unknown config command: $sub" ;;
    esac
}

# -----------------------------------------------------------------------------
# Direct SSH registry and convenience accessors
# -----------------------------------------------------------------------------

ensure_ssh_direct_config() {
    mkdir -p "$CONFIG_HOME"
    touch "$SSH_DIRECT_CONFIG"
    chmod 600 "$SSH_DIRECT_CONFIG" 2>/dev/null || true
}

ssh_direct_record() {
    local name="$1"
    [[ -f "$SSH_DIRECT_CONFIG" ]] || return 1
    awk -F '|' -v n="$name" '$1 == n {print; found=1; exit} END {if (!found) exit 1}' "$SSH_DIRECT_CONFIG"
}

ssh_direct_set() {
    [[ $# -ge 1 ]] || die "usage: ts ssh direct set NAME --libvirt-user-domain DOMAIN [OPTIONS]"
    local name="$1" domain="" uri="" host="127.0.0.1" host_port="10022"
    local guest_port="22" netdev="hostnet0" policy="on-demand" timeout="180" tmp sorted; shift
    validate_config_name "$name"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --libvirt-user-domain) [[ $# -ge 2 ]] || die "$1 requires a value"; domain="$2"; shift 2 ;;
            --libvirt-uri) [[ $# -ge 2 ]] || die "$1 requires a value"; uri="$2"; shift 2 ;;
            --host-address) [[ $# -ge 2 ]] || die "$1 requires a value"; host="$2"; shift 2 ;;
            --port) [[ $# -ge 2 ]] || die "$1 requires a value"; host_port="$2"; shift 2 ;;
            --guest-port) [[ $# -ge 2 ]] || die "$1 requires a value"; guest_port="$2"; shift 2 ;;
            --netdev) [[ $# -ge 2 ]] || die "$1 requires a value"; netdev="$2"; shift 2 ;;
            --start-policy) [[ $# -ge 2 ]] || die "$1 requires a value"; policy="$2"; shift 2 ;;
            --boot-timeout) [[ $# -ge 2 ]] || die "$1 requires a value"; timeout="$2"; shift 2 ;;
            *) die "unknown direct SSH option: $1" ;;
        esac
    done
    [[ -n "$domain" && "$domain" != -* ]] || die "--libvirt-user-domain is required"
    validate_direct_host "$host"
    validate_port "$host_port"
    validate_port "$guest_port"
    validate_boot_timeout "$timeout"
    case "$policy" in manual|on-demand) ;; *) die "start policy must be manual or on-demand" ;; esac
    [[ -n "$netdev" && "$netdev" != -* && "$netdev" =~ ^[A-Za-z0-9._-]+$ ]] \
        || die "invalid QEMU user-network netdev: $netdev"
    for value in "$domain" "$uri" "$host" "$netdev"; do validate_registry_field "direct SSH value" "$value"; done
    ensure_ssh_direct_config
    tmp="$(mktemp "$CONFIG_HOME/.ssh-direct.XXXXXX")"
    sorted="$(mktemp "$CONFIG_HOME/.ssh-direct-sort.XXXXXX")"
    awk -F '|' -v n="$name" '$1 != n' "$SSH_DIRECT_CONFIG" > "$tmp" || true
    printf '%s|libvirt-user|%s|%s|%s|%s|%s|%s|%s|%s\n' \
        "$name" "$domain" "$host" "$host_port" "$guest_port" "$netdev" "$uri" "$policy" "$timeout" >> "$tmp"
    sort -t '|' -k1,1 "$tmp" > "$sorted"
    mv "$sorted" "$SSH_DIRECT_CONFIG"
    rm -f "$tmp"
    chmod 600 "$SSH_DIRECT_CONFIG" 2>/dev/null || true
    log "direct SSH '$name': $host:$host_port -> $domain:$guest_port ($policy)"
}

ssh_direct_remove() {
    [[ $# -eq 1 ]] || die "usage: ts ssh direct rm NAME"
    local name="$1" tmp
    ssh_direct_record "$name" >/dev/null 2>&1 || die "no direct SSH mapping for '$name'"
    ensure_ssh_direct_config
    tmp="$(mktemp "$CONFIG_HOME/.ssh-direct.XXXXXX")"
    awk -F '|' -v n="$name" '$1 != n' "$SSH_DIRECT_CONFIG" > "$tmp" || true
    mv "$tmp" "$SSH_DIRECT_CONFIG"
    chmod 600 "$SSH_DIRECT_CONFIG" 2>/dev/null || true
    log "removed direct SSH mapping: $name"
}

ssh_direct_list() {
    ensure_ssh_direct_config
    printf '%-20s %-16s %-18s %-21s %-10s %s\n' NAME PROVIDER DOMAIN ENDPOINT POLICY URI
    local name provider domain host host_port guest_port netdev uri policy timeout
    while IFS='|' read -r name provider domain host host_port guest_port netdev uri policy timeout; do
        [[ -n "$name" && "$name" != \#* ]] || continue
        printf '%-20s %-16s %-18s %-21s %-10s %s\n' \
            "$name" "$provider" "$domain" "$host:$host_port->$guest_port" "$policy" "${uri:--}"
    done < "$SSH_DIRECT_CONFIG"
}

ssh_direct_show() {
    [[ $# -eq 1 ]] || die "usage: ts ssh direct show NAME"
    local record name="$1" provider domain host host_port guest_port netdev uri policy timeout state
    record="$(ssh_direct_record "$name" 2>/dev/null || true)"
    [[ -n "$record" ]] || die "no direct SSH mapping for '$name'"
    IFS='|' read -r _ provider domain host host_port guest_port netdev uri policy timeout <<< "$record"
    state="$(direct_libvirt_state "$domain" "$uri" 2>/dev/null || printf unavailable)"
    printf 'Name:          %s\nProvider:      %s\nDomain:        %s\nEndpoint:      %s:%s\nGuest port:    %s\nQEMU netdev:   %s\nLibvirt URI:   %s\nStart policy:  %s\nBoot timeout:  %ss\nVM state:      %s\n' \
        "$name" "$provider" "$domain" "$host" "$host_port" "$guest_port" "$netdev" "${uri:--}" "$policy" "$timeout" "$state"
}

ssh_direct_command() {
    local action="${1:-list}"; shift || true
    case "$action" in
        set) ssh_direct_set "$@" ;;
        rm|remove|del|delete) ssh_direct_remove "$@" ;;
        show) ssh_direct_show "$@" ;;
        list|ls) ssh_direct_list ;;
        help|-h|--help) ssh_usage ;;
        *) die "unknown direct SSH command: $action" ;;
    esac
}

ssh_direct_wait_ready() {
    local host="$1" port="$2" timeout="$3"
    local deadline=$((SECONDS + timeout))
    log "waiting up to ${timeout}s for direct SSH endpoint $host:$port"
    while (( SECONDS <= deadline )); do
        direct_tcp_ready "$host" "$port" && return 0
        sleep 1
    done
    die "direct SSH endpoint $host:$port did not become ready within ${timeout}s (the VM was left running)"
}

ssh_direct_launch() {
    [[ $# -ge 1 ]] || die "usage: ts ssh --direct NAME [SSH_OPTIONS] [-- REMOTE_COMMAND...]"
    local name="$1" record provider domain host host_port guest_port netdev uri policy timeout
    local fleet target user os saw_separator=0; shift
    local -a ssh_options=() remote_command=()
    while [[ $# -gt 0 ]]; do
        if (( saw_separator )); then remote_command+=("$1"); else
            case "$1" in --) saw_separator=1 ;; *) ssh_options+=("$1") ;; esac
        fi
        shift
    done
    record="$(ssh_direct_record "$name" 2>/dev/null || true)"
    [[ -n "$record" ]] || die "no direct SSH mapping for '$name'"
    IFS='|' read -r _ provider domain host host_port guest_port netdev uri policy timeout <<< "$record"
    [[ "$provider" == libvirt-user ]] || die "unsupported direct SSH provider: $provider"
    fleet="$(fleet_record "$name" 2>/dev/null || true)"
    [[ -n "$fleet" ]] || die "unknown fleet host '$name'"
    IFS='|' read -r _ target user os <<< "$fleet"
    direct_lifecycle_prepare libvirt "$domain" "$uri" "$policy"
    direct_prepare_libvirt_user "$domain" "$uri" "$host" "$host_port" "$guest_port" "$netdev"
    ssh_direct_wait_ready "$host" "$host_port" "$timeout"
    log "SSH $name -> $host:$host_port via direct/libvirt-user (user $user)"
    exec ssh -o "HostKeyAlias=$target" -o StrictHostKeyChecking=accept-new -p "$host_port" \
        "${ssh_options[@]}" "$user@$host" "${remote_command[@]}"
}

ts_ssh() {
    [[ $# -ge 1 ]] || die "usage: ts ssh [ssh arguments...] destination | ts ssh --direct NAME"
    have ssh || die "ssh client not found"
    if [[ "$1" == help || "$1" == -h || "$1" == --help ]]; then ssh_usage; return; fi
    if [[ "$1" == direct ]]; then ssh_direct_command "${@:2}"; return; fi
    if [[ "$1" == --direct ]]; then ssh_direct_launch "${@:2}"; return; fi
    if [[ $# -ge 2 && "$2" == --direct ]]; then
        local direct_name="$1"; shift 2
        ssh_direct_launch "$direct_name" "$@"
        return
    fi
    ensure_daemon
    local proxy_cmd
    printf -v proxy_cmd '%q --socket=%q nc %%h %%p' "$TAILSCALE" "$SOCKET"
    exec ssh -o "ProxyCommand=$proxy_cmd" "$@"
}

ssh_usage() {
    cat <<'EOF_SSH'
Usage:
  ts ssh [OPENSSH_ARGS...] USER@HOST
  ts ssh --direct NAME [SSH_OPTIONS...] [-- REMOTE_COMMAND...]
  ts ssh NAME --direct [SSH_OPTIONS...] [-- REMOTE_COMMAND...]

Direct QEMU user-network endpoint:
  ts ssh direct set NAME --libvirt-user-domain DOMAIN [--libvirt-uri URI]
      [--host-address ADDRESS] [--port HOST_PORT] [--guest-port PORT]
      [--netdev ID] [--start-policy manual|on-demand] [--boot-timeout SECONDS]
  ts ssh direct show|rm NAME
  ts ssh direct list
EOF_SSH
}

show_status() {
    select_runtime
    printf 'ts-version:   %s\n' "$TS_VERSION"
    printf 'ts-home:      %s\n' "$BASE"
    printf 'version:      %s\n' "$(installed_version || true)"
    printf 'daemon-mode:  %s\n' "$([[ $SYSTEMD_MODE -eq 1 ]] && printf 'systemd --user' || printf 'nohup fallback')"
    printf 'socket:       %s\n' "$SOCKET"
    printf 'proxy:        %s\n' "$PROXY_ADDR"
    if [[ -S "$SOCKET" && -x "$TAILSCALE" ]]; then
        printf '\n'
        "$TAILSCALE" --socket="$SOCKET" status || true
    else
        printf 'tailscaled:   stopped\n'
    fi
    printf '\n'
    if rdp_has_bindings; then
        printf 'RDP bridge:   %s\n' "$(rdp_bridge_running && printf running || printf stopped)"
        rdp_list
    else
        printf 'RDP bindings: none\n'
    fi
    printf 'Direct maps:   %s (host-local)\n' "$(rdp_direct_count)"
}

start_all() {
    start_daemon
    if rdp_has_bindings; then rdp_start; fi
}

stop_all() {
    rdp_stop || true
    stop_daemon
}

restart_all() {
    stop_all
    start_all
}

uninstall_program() {
    rdp_stop || true
    stop_daemon || true
    if systemd_user_available; then
        systemctl --user disable "$DAEMON_APP.service" 2>/dev/null || true
        systemctl --user disable "$RDP_UNIT_NAME" 2>/dev/null || true
        rm -f "$TS_UNIT_FILE" "$RDP_UNIT_FILE"
        systemctl --user daemon-reload || true
    fi
    rm -rf "$BIN_DIR" "$BASE/VERSION"
    log "Tailscale binaries/services removed; node identity and RDP config preserved"
}

purge_all() {
    uninstall_program
    rm -rf "$BASE" "$CONFIG_HOME"
    log "Tailscale state and ts configuration removed"
}

doctor() {
    select_runtime
    local rc=0
    printf '%-22s %s\n' CHECK RESULT
    printf '%-22s %s\n' '----------------------' '------------------------------'

    if [[ -x "$TAILSCALE" && -x "$TAILSCALED" ]]; then
        printf '%-22s %s\n' binaries OK
    else
        printf '%-22s %s\n' binaries MISSING; rc=1
    fi

    if [[ -S "$SOCKET" ]]; then
        printf '%-22s %s\n' tailscaled OK
    else
        printf '%-22s %s\n' tailscaled STOPPED; rc=1
    fi

    if have python3; then printf '%-22s %s\n' python3 OK; else printf '%-22s %s\n' python3 MISSING; rc=1; fi
    if find_freerdp >/dev/null 2>&1; then printf '%-22s %s\n' FreeRDP "$(basename "$(find_freerdp)")"; else printf '%-22s %s\n' FreeRDP MISSING; fi
    if have secret-tool; then printf '%-22s %s\n' RDP-keyring available; else printf '%-22s %s\n' RDP-keyring unavailable; fi
    if have virsh; then
        printf '%-22s %s\n' virsh available
        if virsh uri >/dev/null 2>&1; then
            printf '%-22s %s\n' libvirt-connection available
        else
            printf '%-22s %s\n' libvirt-connection unavailable
        fi
    else
        printf '%-22s %s\n' virsh unavailable
        printf '%-22s %s\n' libvirt-connection unavailable
    fi
    if have vmrun; then printf '%-22s %s\n' vmrun available; else printf '%-22s %s\n' vmrun unavailable; fi
    printf '%-22s %s\n' direct-rdp-mappings "$(rdp_direct_count)"

    if rdp_has_bindings; then
        printf '%-22s %s\n' rdp-bindings "$(grep -cEv '^[[:space:]]*(#|$)' "$RDP_CONFIG")"
        printf '%-22s %s\n' rdp-bridge "$(rdp_bridge_running && printf OK || printf STOPPED)"
    else
        printf '%-22s %s\n' rdp-bindings 0
    fi
    ensure_config_registry
    printf '%-22s %s
' ssh-keys "$(grep -cEv '^[[:space:]]*(#|$)' "$SSH_KEYS_CONFIG" 2>/dev/null || printf 0)"
    printf '%-22s %s
' fleet-hosts "$(grep -cEv '^[[:space:]]*(#|$)' "$FLEET_CONFIG" 2>/dev/null || printf 0)"
    printf '%-22s %s
' controller-key "$([[ -f "$FLEET_IDENTITY" ]] && printf OK || printf ABSENT)"
    return "$rc"
}

usage() {
    cat <<'EOF_USAGE'
Usage: ts COMMAND [ARGS]

Rootless Tailscale realm CLI. No sudo, no TUN device, no system-wide install.

Core:
  ts setup [HOSTNAME]       Install/update CLI + Tailscale, start, authenticate
  ts start|stop|restart     Start/stop Tailscale and configured RDP bindings
  ts status                 Combined Tailscale + RDP status
  ts up [HOSTNAME]          Authenticate/connect (TAILSCALE_AUTHKEY supported)
  ts down                   Disconnect without logging out
  ts logout                 Log out this node
  ts ping HOST              Native Tailscale ping (passthrough)
  ts netcheck               Native Tailscale netcheck (passthrough)
  ts nc HOST PORT           Native Tailscale netcat (passthrough)
  ts ssh [ARGS] DEST        OpenSSH through 'tailscale nc' as ProxyCommand
  ts ssh NAME --direct      Lazy direct SSH to a locally managed VM
  ts config ...             Fleet/key registry and authorization propagation
  ts config install [--from DIR]  Merge/migrate repo config into ~/.config/ts
  ts config save [TARGET_DIR]     Export portable config (default: current directory)
  ts proxy-env              Print proxy environment exports
  ts doctor                 Check local dependencies/runtime

RDP:
  ts rdp add NAME [TARGET] [--user USER] [--server-name NAME] [--ip 127.x.x.x] [--port PORT]
  ts rdp rm NAME
  ts rdp list
  ts rdp start|stop|restart|status
  ts rdp args NAME [-- ARGS...]   Persist per-machine FreeRDP options
  ts rdp credential set NAME [--user USER]      Save one Windows account password
  ts rdp credential status NAME [--user USER]   Check whether it is stored
  ts rdp credential forget NAME [--user USER]   Remove that stored password
  ts rdp MACHINE [--user USER] [--] [extra FreeRDP args...]
  ts rdp MACHINE [--user USER] --direct [--wait-for-shutdown] [--] [extra FreeRDP args...]
  ts rdp direct set NAME --address HOST [--port PORT]
  ts rdp direct set NAME --libvirt-domain DOMAIN [--libvirt-uri URI] [--mac MAC]
  ts rdp direct set NAME --libvirt-user-domain DOMAIN [--libvirt-uri URI] [--port HOST_PORT]
  ts rdp direct set NAME --vmx /absolute/path/to/guest.vmx
  ts rdp direct lifecycle set NAME --libvirt-domain DOMAIN --start-policy manual|on-demand
  ts rdp direct show|rm|start|stop NAME
  ts rdp direct list

Fleet configuration:
  ts config controller init [NAME]
  ts config key add NAME PUBLIC_KEY [--on HOST[,HOST...]]
  ts config host add NAME [TARGET] --user USER --os linux|windows
  ts config push HOST|--all
  ts config bootstrap HOST|--all --credentials FILE
  ts config enroll HOST|--all --on HOST[,HOST...]|*
  ts config check HOST|--all
  ts config help

Install/update:
  ts self-install           Copy this CLI to ~/.local/bin/ts
  ts install [VERSION]      Install Tailscale static binaries
  ts update                 Update Tailscale to latest stable
  ts version                Show ts version plus installed/latest Tailscale versions
  ts uninstall              Remove binaries/services, preserve state/config
  ts purge                  Remove binaries, node state, and ts configuration

Anything not handled above is forwarded to the bundled Tailscale CLI:
  ts ip -4
  ts whois 100.x.y.z
  ts file cp foo host:

Environment:
  TAILSCALE_USER_HOME        Tailscale state root (default: ~/.local/share/tailscale-user)
  TAILSCALE_USER_PROXY_ADDR  userspace SOCKS5/HTTP listener (default: 127.0.0.1:1055)
  TAILSCALE_AUTHKEY          optional auth key for setup/up
  TS_RDP_CONFIG              alternate RDP registry path
  TS_RDP_DIRECT_CONFIG       alternate host-local direct RDP registry path
  TS_RDP_SECRET_SERVICE      desktop-keyring service name (default: tailscale-fleet-rdp)
  TS_SSH_KEYS_CONFIG         alternate SSH login-public-key registry path
  TS_SSH_DIRECT_CONFIG       alternate host-local direct SSH registry path
  TS_FLEET_CREDENTIALS       bootstrap password file (default: ~/.config/ts/credentials.tsv)
  TS_FLEET_CONFIG            alternate fleet host registry path
  TS_FLEET_IDENTITY          controller private key (default: ~/.ssh/ts-fleet-ed25519)
  TS_CONFIG_BACKUP_KEEP      retained config-install snapshots (default: 5)
EOF_USAGE
}

main() {
    local cmd="${1:-help}"
    shift || true
    select_runtime

    case "$cmd" in
        setup)
            install_self
            install_version latest
            start_daemon
            up_node "${1:-}"
            if rdp_has_bindings; then rdp_start; fi
            ;;
        self-install)
            install_self
            ;;
        install)
            install_version "${1:-latest}"
            ;;
        update)
            update_install
            ;;
        start)
            start_all
            ;;
        stop)
            stop_all
            ;;
        restart)
            restart_all
            ;;
        status)
            show_status
            ;;
        doctor)
            doctor
            ;;
        up)
            up_node "${1:-}"
            ;;
        down)
            ts_cli down
            ;;
        logout)
            ts_cli logout
            ;;
        proxy-env)
            proxy_env
            ;;
        config)
            config_command "$@"
            ;;
        ssh)
            ts_ssh "$@"
            ;;
        rdp)
            rdp_command "$@"
            ;;
        uninstall)
            uninstall_program
            ;;
        purge)
            purge_all
            ;;
        version)
            printf 'ts:        %s\n' "$TS_VERSION"
            printf 'tailscale: %s\n' "$(installed_version || printf 'not installed')"
            printf 'latest:    %s\n' "$(latest_version)"
            ;;
        _rdp-serve)
            rdp_serve_internal
            ;;
        help|-h|--help)
            usage
            ;;
        *)
            ts_cli "$cmd" "$@"
            ;;
    esac
}

if [[ "${TS_FLEET_ASKPASS_MODE:-0}" == 1 ]]; then
    fleet_password_for_host "${TS_FLEET_ASKPASS_FILE:?}" "${TS_FLEET_ASKPASS_HOST:?}" \
        || exit 1
    exit 0
fi

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
