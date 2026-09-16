/**
 * Plain words for how a child process ended.
 *
 * On POSIX a crash arrives as a signal name. On Windows there is no signal:
 * the process "exits" with an NTSTATUS code such as 3221225477
 * (0xC0000005, an access violation) and `signal` is null. Node reports it as
 * a plain number, which is meaningless to anyone who has not memorised the
 * table, so the common ones are named here.
 */

const NTSTATUS_NAMES: Readonly<Record<number, string>> = {
  0xc0000005: 'STATUS_ACCESS_VIOLATION',
  0xc0000017: 'STATUS_NO_MEMORY',
  0xc000001d: 'STATUS_ILLEGAL_INSTRUCTION',
  0xc0000094: 'STATUS_INTEGER_DIVIDE_BY_ZERO',
  0xc00000fd: 'STATUS_STACK_OVERFLOW',
  0xc0000135: 'STATUS_DLL_NOT_FOUND',
  0xc0000139: 'STATUS_ENTRYPOINT_NOT_FOUND',
  0xc000013a: 'STATUS_CONTROL_C_EXIT',
  0xc0000142: 'STATUS_DLL_INIT_FAILED',
  0xc0000374: 'STATUS_HEAP_CORRUPTION',
  0xc0000409: 'STATUS_STACK_BUFFER_OVERRUN',
  0xc0000417: 'STATUS_INVALID_CRUNTIME_PARAMETER',
};

/**
 * The NTSTATUS name for an exit code, if it is one. Node may hand the code
 * over as the unsigned 32-bit value or as its signed twin (-1073741819 for
 * 0xC0000005); both are recognised.
 */
export function ntstatusName(code: number | null): string | undefined {
  if (code === null || !Number.isInteger(code)) return undefined;
  const unsigned = code < 0 ? code + 0x1_0000_0000 : code;
  if (unsigned < 0xc000_0000 || unsigned > 0xffff_ffff) return undefined;
  return NTSTATUS_NAMES[unsigned];
}

/** "the MCP server exited with code 1" / "... was killed by SIGSEGV" / with an NTSTATUS name. */
export function describeExit(exit: { code: number | null; signal: string | null }): string {
  if (exit.signal !== null) return `the MCP server was killed by ${exit.signal}`;
  const code = exit.code ?? 0;
  const name = ntstatusName(code);
  return name === undefined
    ? `the MCP server exited with code ${code}`
    : `the MCP server exited with code ${code} (${name} — it crashed)`;
}
