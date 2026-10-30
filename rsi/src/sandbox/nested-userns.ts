import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * File descriptor number that carries the nested-userns seccomp filter to
 * bubblewrap. bwrap reads the fd during argument parsing, before it creates any
 * namespaces, and installs the filter just before exec.
 */
export const SANDBOX_SECCOMP_FD = 3;

const SECCOMP_RET_KILL_PROCESS = 0x8000_0000;
const SECCOMP_RET_ERRNO = 0x0005_0000;
const SECCOMP_RET_ALLOW = 0x7fff_0000;
const EPERM = 1;
const ENOSYS = 38;

/** clone(2)/unshare(2) flag for a new user namespace. */
const CLONE_NEWUSER = 0x1000_0000;

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_JMP_JSET_K = 0x45;
const BPF_RET_K = 0x06;

const SECCOMP_DATA_NR = 0;
const SECCOMP_DATA_ARCH = 4;
const SECCOMP_DATA_ARG0_LO = 16;

interface SockFilter {
	readonly code: number;
	readonly jt: number;
	readonly jf: number;
	readonly k: number;
}

interface ArchSpec {
	readonly auditArch: number;
	readonly clone: number;
	readonly clone3: number;
	readonly unshare: number;
}

const ARCH_SPECS: Readonly<Partial<Record<NodeJS.Architecture, ArchSpec>>> = {
	x64: { auditArch: 0xc000_003e, clone: 56, clone3: 435, unshare: 272 },
	arm64: { auditArch: 0xc000_00b7, clone: 220, clone3: 435, unshare: 97 },
};

const CLEANUP_DIRS = new Set<string>();
let cleanupRegistered = false;

function registerCleanup(): void {
	if (cleanupRegistered) return;
	cleanupRegistered = true;
	process.once("exit", () => {
		for (const dir of CLEANUP_DIRS) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Best effort: /tmp is ephemeral anyway.
			}
		}
		CLEANUP_DIRS.clear();
	});
}

function errno(action: number, errno: number): number {
	return action | (errno & 0xffff);
}

/**
 * Compile a cBPF program that blocks creation of nested user namespaces inside
 * the sandbox while leaving every other syscall untouched.
 *
 * This is the portable replacement for bwrap `--disable-userns`, which needs a
 * writable `/proc/sys/user/max_user_namespaces`. Docker mounts /proc/sys
 * read-only for unprivileged containers, so that flag makes the documented
 * non-privileged deployment impossible. The seccomp filter is installed by
 * bwrap with `--seccomp FD` after it created the sandbox user namespace, so it
 * does not affect bwrap's own setup and needs no extra capability.
 *
 * `unshare(CLONE_NEWUSER)` and `clone(CLONE_NEWUSER, ...)` are rejected with
 * EPERM. `clone3` takes its flags in memory, which seccomp cannot inspect, so
 * it fails with ENOSYS; glibc and musl then fall back to `clone`, where the
 * flag check applies. This is the same compatibility approach used by other
 * seccomp sandboxes. A 32-bit compat ABI would use different syscall numbers
 * and could bypass the filter, so unknown architectures are killed outright;
 * the image and Worker are 64-bit only.
 */
export function buildNestedUsernsBlockFilter(arch: NodeJS.Architecture = process.arch): Buffer {
	const spec = ARCH_SPECS[arch];
	if (spec === undefined) {
		throw new Error(
			`No nested-userns seccomp filter is defined for architecture ${arch}; supported: x64, arm64.`,
		);
	}
	const program: SockFilter[] = [
		// Verify the syscall ABI before trusting the syscall number.
		{ code: BPF_LD_W_ABS, jt: 0, jf: 0, k: SECCOMP_DATA_ARCH },
		{ code: BPF_JMP_JEQ_K, jt: 1, jf: 0, k: spec.auditArch },
		{ code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_KILL_PROCESS },
		{ code: BPF_LD_W_ABS, jt: 0, jf: 0, k: SECCOMP_DATA_NR },

		// unshare(flags): reject only CLONE_NEWUSER.
		{ code: BPF_JMP_JEQ_K, jt: 0, jf: 4, k: spec.unshare },
		{ code: BPF_LD_W_ABS, jt: 0, jf: 0, k: SECCOMP_DATA_ARG0_LO },
		{ code: BPF_JMP_JSET_K, jt: 0, jf: 1, k: CLONE_NEWUSER },
		{ code: BPF_RET_K, jt: 0, jf: 0, k: errno(SECCOMP_RET_ERRNO, EPERM) },
		{ code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW },

		// clone(flags, ...): reject only CLONE_NEWUSER.
		{ code: BPF_JMP_JEQ_K, jt: 0, jf: 4, k: spec.clone },
		{ code: BPF_LD_W_ABS, jt: 0, jf: 0, k: SECCOMP_DATA_ARG0_LO },
		{ code: BPF_JMP_JSET_K, jt: 0, jf: 1, k: CLONE_NEWUSER },
		{ code: BPF_RET_K, jt: 0, jf: 0, k: errno(SECCOMP_RET_ERRNO, EPERM) },
		{ code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW },

		// clone3 flags live behind a pointer; force the clone fallback.
		{ code: BPF_JMP_JEQ_K, jt: 0, jf: 1, k: spec.clone3 },
		{ code: BPF_RET_K, jt: 0, jf: 0, k: errno(SECCOMP_RET_ERRNO, ENOSYS) },
		{ code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW },
	];

	const blob = Buffer.alloc(program.length * 8);
	program.forEach((instruction, index) => {
		const offset = index * 8;
		blob.writeUInt16LE(instruction.code, offset);
		blob.writeUInt8(instruction.jt, offset + 2);
		blob.writeUInt8(instruction.jf, offset + 3);
		blob.writeUInt32LE(instruction.k >>> 0, offset + 4);
	});
	return blob;
}

/**
 * Write the filter to a Supervisor-owned 0700 directory and return the path.
 * Each bwrap launch opens its own read-only descriptor, so the file offset is
 * always zero and concurrent launches cannot consume each other's filter.
 */
export function createNestedUsernsFilterFile(arch: NodeJS.Architecture = process.arch): string {
	const blob = buildNestedUsernsBlockFilter(arch);
	registerCleanup();
	const dir = mkdtempSync(join(tmpdir(), "rsi-userns-"));
	CLEANUP_DIRS.add(dir);
	const path = join(dir, "nested-userns.bpf");
	writeFileSync(path, blob, { mode: 0o400 });
	chmodSync(path, 0o400);
	return path;
}
