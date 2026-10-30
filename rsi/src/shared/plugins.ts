import { createRequire } from "node:module";
import { RsiError } from "./errors.ts";
import type { ContentRevision } from "./hash.ts";

const requireFromHere = createRequire(import.meta.url);

/** A pinned npm Pi package verified from its published manifest. */
export interface VerifiedPluginPin {
	readonly packageName: string;
	readonly version: string;
	readonly piSpec: `npm:${string}@${string}`;
	readonly extension: string;
	readonly integrity: string;
	readonly peerDependencies: Readonly<Record<string, string>>;
}

/** The two plugins required by the product contract. They load only inside the Worker. */
export const REQUIRED_PLUGIN_PINS = Object.freeze([
	{
		packageName: "pi-continuity",
		version: "0.3.1",
		piSpec: "npm:pi-continuity@0.3.1",
		extension: "extensions/index.ts",
		integrity:
			"sha512-bd7IB76n6XvMfYmYS+IaD9crjPqgTCujQmVdlEjiHatOAnUPwsDUZzrAXIBXdM1kNMQyb16giPE2CrGc9cZxlg==",
		peerDependencies: {
			"@earendil-works/pi-coding-agent": "*",
			"@earendil-works/pi-ai": "*",
		} as Readonly<Record<string, string>>,
	},
	{
		packageName: "pi-better-web-search",
		version: "0.1.7",
		piSpec: "npm:pi-better-web-search@0.1.7",
		extension: "extensions/index.ts",
		integrity:
			"sha512-8SVVhpl2eGzvCN0ooJVXU/pSgogU92xnBGi3AosUuyiFQM1fC88zPlvLb4oJ7CeFneaOj0qRRNoKraU3W3vlLg==",
		peerDependencies: {
			"@earendil-works/pi-ai": "*",
			"@earendil-works/pi-coding-agent": "*",
			typebox: "*",
		} as Readonly<Record<string, string>>,
	},
] satisfies readonly VerifiedPluginPin[]);

export const REQUIRED_PLUGIN_SPECS = REQUIRED_PLUGIN_PINS.map((pin) => pin.piSpec);

export interface VerifiedPiSdkDependency {
	readonly packageName: string;
	readonly version: string;
	readonly integrity: string;
}

/** Direct Pi SDK dependencies that were checked against the npm registry. */
export const VERIFIED_PI_SDK_DEPENDENCIES: readonly VerifiedPiSdkDependency[] = Object.freeze([
	{
		packageName: "@earendil-works/pi-coding-agent",
		version: "1.4.0",
		integrity:
			"sha512-Z41LpZ3yYHSC/UUps6Mr39UMFPwH8elhJBG9DY1P7kuzsE5qSK/6eMj2EHzO5evJRQWLbKSqUMw+4nCNtIyiQg==",
	},
	{
		packageName: "@earendil-works/pi-ai",
		version: "1.4.0",
		integrity:
			"sha512-hQM/C4+1w8rHYACzDDf+0vQMnEnpzIop1tptIERVgR3ZeT/hHSzBNG8PaWPgxWQjqSeKCyBZSyp8uTT6eKK1pQ==",
	},
	{
		packageName: "@earendil-works/pi-agent-core",
		version: "1.4.0",
		integrity:
			"sha512-PoKY84SKUwnt7S5QBZaGUqfNO1kjP3KHpHUA9QpFTj4cOjaVWMYIcBPJ6FDRCdE8Zen9OSECQUd0uUfVgtSmgA==",
	},
]);

export interface InstalledPackageManifest {
	readonly name: string;
	readonly version: string;
	readonly pi?: { readonly extensions?: readonly string[] };
}

/** Validate the installed manifest; this does not execute the package. */
export function assertInstalledPluginManifest(
	pin: VerifiedPluginPin,
	manifest: InstalledPackageManifest,
): void {
	if (manifest.name !== pin.packageName || manifest.version !== pin.version) {
		throw new RsiError(
			"PLUGIN_MANIFEST_MISMATCH",
			`Expected ${pin.packageName}@${pin.version}, found ${manifest.name}@${manifest.version}.`,
		);
	}
	const extensions = manifest.pi?.extensions ?? [];
	if (!extensions.includes(`./${pin.extension}`)) {
		throw new RsiError(
			"PLUGIN_MANIFEST_MISMATCH",
			`${pin.packageName}@${pin.version} does not declare ./${pin.extension} in its pi manifest.`,
		);
	}
}

/** Resolve the extension entry shipped by an installed package without importing it. */
export function resolveInstalledPluginExtension(pin: VerifiedPluginPin): string {
	try {
		return requireFromHere.resolve(`${pin.packageName}/${pin.extension}`);
	} catch (error) {
		throw new RsiError(
			"PLUGIN_MANIFEST_MISMATCH",
			`Could not resolve installed ${pin.packageName}@${pin.version} extension ${pin.extension}.`,
			{ cause: error },
		);
	}
}

export interface PluginCandidate {
	readonly candidateId: string;
	readonly generation: number;
	readonly path: string;
	readonly digest: ContentRevision;
	readonly packages: readonly VerifiedPluginPin[];
	readonly createdAtMs: number;
	readonly readOnly: true;
	/**
	 * Absolute extension entry paths as seen by the Worker. The Supervisor maps
	 * immutable snapshot paths into the sandbox namespace before sending a
	 * control.reload request. Omitted for legacy candidates.
	 */
	readonly entryPaths?: readonly string[];
}

export interface LkgSnapshot {
	readonly generation: number;
	readonly candidateId: string;
	readonly digest: ContentRevision;
	readonly path: string;
	readonly healthyTurns: number;
	readonly verifiedAtMs: number;
}
