import assert from "node:assert/strict";
import test from "node:test";
import {
	assertNoHiddenWritableOverlap,
	assertNoProtectedHiddenOverlap,
	assertNoProtectedWritableOverlap,
	decodeMountInfoField,
	findMountAliasTargets,
	isPosixWithin,
	minimalRoots,
	normalizeSandboxPath,
	parseMountInfo,
	pathsOverlap,
} from "../../src/sandbox/path-safety.ts";

const MOUNT_INFO = [
	"22 1 0:21 / / rw,relatime - overlay overlay rw,lowerdir=/lower,upperdir=/upper",
	"30 22 0:30 /real/pi /mnt/pi-alias rw,relatime - ext4 /dev/sda1 rw",
	"31 22 0:31 /real/state/snapshots /mnt/snap rw,relatime - ext4 /dev/sda1 rw",
	"32 22 0:32 / /proc rw,relatime - proc proc rw",
	"33 22 0:33 / /sys rw,relatime - sysfs sysfs rw",
	"34 22 0:34 / /data/with\\040space rw,relatime - tmpfs tmpfs rw",
].join("\n");

test("mountinfo escapes and records are parsed without pseudo-filesystem aliases", () => {
	const entries = parseMountInfo(MOUNT_INFO);
	assert.equal(entries.length, 6);
	assert.equal(decodeMountInfoField("/data/with\\040space"), "/data/with space");
	assert.equal(entries.find((entry) => entry.mountPoint === "/data/with space")?.fsType, "tmpfs");
	assert.deepEqual(
		findMountAliasTargets(["/real/pi"], entries).filter((path) => path.startsWith("/proc")),
		[],
	);
});

test("bind-mount aliases of a protected root are discovered", () => {
	const entries = parseMountInfo(MOUNT_INFO);
	const aliases = findMountAliasTargets(["/real/pi"], entries);
	assert.equal(aliases.includes("/mnt/pi-alias"), true);
	assert.equal(aliases.includes("/tmp/real/pi"), false);

	const parentAliases = findMountAliasTargets(["/real/state"], entries);
	assert.equal(parentAliases.includes("/mnt/snap"), true);
});

test("hidden state aliases are discovered through bind mounts", () => {
	const entries = parseMountInfo(MOUNT_INFO);
	const aliases = findMountAliasTargets(["/real/state/snapshots"], entries);
	assert.equal(aliases.includes("/mnt/snap"), true);
});

test("overlap checks reject writable re-exposure of protected and hidden trees", () => {
	assert.throws(
		() => assertNoProtectedWritableOverlap(["/app/pi"], ["/app/pi/editing"], []),
		(error: unknown) => (error as { code?: string }).code === "SANDBOX_ALIAS_RISK",
	);
	assert.throws(
		() => assertNoProtectedWritableOverlap(["/app/pi"], ["/workspace"], ["/app/pi/copy"]),
		(error: unknown) => (error as { code?: string }).code === "SANDBOX_ALIAS_RISK",
	);
	assert.throws(
		() => assertNoHiddenWritableOverlap(["/state"], ["/state/workspace"], []),
		(error: unknown) => (error as { code?: string }).code === "SANDBOX_ALIAS_RISK",
	);
	assert.throws(
		() => assertNoProtectedHiddenOverlap(["/app/pi"], ["/app/pi/state"]),
		(error: unknown) => (error as { code?: string }).code === "SANDBOX_ALIAS_RISK",
	);
	assert.doesNotThrow(() =>
		assertNoProtectedWritableOverlap(["/app/pi"], ["/workspace"], ["/workspace"]),
	);
});

test("minimal roots remove nested hidden paths and preserve unrelated paths", () => {
	assert.deepEqual(minimalRoots(["/state/snapshots", "/state", "/logs", "/state/control"]), [
		"/logs",
		"/state",
	]);
});

test("sandbox paths are absolute POSIX paths with no traversal", () => {
	assert.equal(normalizeSandboxPath("/a//b", "path"), "/a/b");
	assert.equal(normalizeSandboxPath("/", "root filesystem"), "/");
	assert.throws(
		() => normalizeSandboxPath("relative/path", "path"),
		(error: unknown) => (error as { code?: string }).code === "SANDBOX_INVALID",
	);
	assert.throws(
		() => normalizeSandboxPath("/a/../b", "path"),
		(error: unknown) => (error as { code?: string }).code === "SANDBOX_INVALID",
	);
	assert.throws(
		() => normalizeSandboxPath("/a\u0000b", "path"),
		(error: unknown) => (error as { code?: string }).code === "SANDBOX_INVALID",
	);
	assert.equal(isPosixWithin("/a", "/a/b"), true);
	assert.equal(isPosixWithin("/a", "/ab"), false);
	assert.equal(pathsOverlap("/a/b", "/a/b/c"), true);
});
