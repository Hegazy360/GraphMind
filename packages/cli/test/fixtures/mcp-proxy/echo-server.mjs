// The security audit's echo server (security/src/proxy-peer.ts): every
// newline-framed frame from stdin is written back to stdout byte-for-byte.
const chunks = [];
process.stdin.on('data', (chunk) => {
  let buf = Buffer.concat([chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0), chunk]);
  chunks.length = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a);
    if (nl === -1) break;
    process.stdout.write(Buffer.concat([buf.subarray(0, nl), Buffer.from('\n')]));
    buf = buf.subarray(nl + 1);
  }
  if (buf.length > 0) chunks.push(buf);
});
process.stdin.on('end', () => process.exit(0));
