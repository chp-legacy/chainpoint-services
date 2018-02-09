# chainpoint-node-audit-consumer-service

Audit Tierion Network Nodes that have registered
as being publicly available.

Audits performed include:

- Public availability at the registered URI
- Node reported local time within tolerances for NTP time sync
- Verify calculated Merkle root, including hourly server nonce, to attest to state of local calendar mirror.

Each audit will update the Node registration record with a
timestamp indicating last passing test run for that Node.
