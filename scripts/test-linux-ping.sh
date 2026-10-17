#!/usr/bin/env bash
# Disposable network namespace only; never alter the host's ping range/firewall.
set -euo pipefail
if [[ ${1:-} != --inside ]]; then
  test "$(uname -s)" = Linux
  test "$(id -u)" != 0
  executable=$(cargo test --locked --no-run --message-format=json | python3 -c '
import json,sys
for line in sys.stdin:
    record=json.loads(line)
    if record.get("profile", {}).get("test") and record.get("executable"):
        print(record["executable"])
')
  test -x "$executable"
  exec sudo unshare --net -- bash "$0" --inside "$executable" "$(id -u)" "$(id -g)"
fi
executable=$2
service_uid=$3
service_gid=$4
ip link set lo up
sysctl -qw net.ipv6.conf.all.disable_ipv6=0
sysctl -qw net.ipv6.conf.lo.disable_ipv6=0
sysctl -qw net.ipv4.ping_group_range='1 0'
sysctl -qw net.ipv4.icmp_ratelimit=0
sysctl -qw net.ipv6.icmp.ratelimit=0
# Rust's exact name includes the module path. All runs must execute one test.
run_test() {
  echo "Linux socket integration: $1"
  ICMP_LINUX_TEST_MODE=$1 "$executable" linux::tests::linux_socket_integration --ignored --exact --nocapture
}
run_user() {
  echo "Linux socket integration: $1"
  ICMP_LINUX_TEST_MODE=$1 setpriv --reuid="$service_uid" --regid="$service_gid" --clear-groups \
    --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs \
    "$executable" linux::tests::linux_socket_integration --ignored --exact --nocapture
}
run_test raw
run_user denied
sysctl -qw "net.ipv4.ping_group_range=$service_gid $service_gid"
run_user echo
iptables -A INPUT -p icmp --icmp-type echo-request -j DROP
ip6tables -A INPUT -p ipv6-icmp --icmpv6-type echo-request -j DROP
run_user drop
# Sixteen probes per family, exactly three wire attempts each.
test "$(iptables -nvx -L INPUT | awk '$3 == "DROP" {print $1}')" = 48
test "$(ip6tables -nvx -L INPUT | awk '$3 == "DROP" {print $1}')" = 48
iptables -F INPUT
ip6tables -F INPUT
iptables -A INPUT -p icmp --icmp-type echo-request -j REJECT --reject-with icmp-host-prohibited
ip6tables -A INPUT -p ipv6-icmp --icmpv6-type echo-request -j REJECT --reject-with icmp6-adm-prohibited
run_user reject
# A matched negative must stop after the first request.
test "$(iptables -nvx -L INPUT | awk '$3 == "REJECT" {print $1}')" = 16
test "$(ip6tables -nvx -L INPUT | awk '$3 == "REJECT" {print $1}')" = 16
