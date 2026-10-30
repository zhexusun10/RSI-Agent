import type { ContentRevision } from "../../src/shared/hash.ts";
import type {
	PreflightCheckResult,
	PreflightReport,
} from "../../src/shared/preflight.ts";
import type {
	ReloadApplyPlan,
	ReloadApplyResult,
	ReloadPreflightInput,
} from "../../src/control/reload.ts";

export function makeReport(
	options: {
		ok?: boolean;
		candidateId?: string;
		generation?: number;
		digest?: ContentRevision;
		errors?: readonly string[];
	} = {},
): PreflightReport {
	const ok = options.ok ?? true;
	const check = (errors: readonly string[]): PreflightCheckResult => ({
		ok,
		durationMs: 1,
		errors,
	});
	return {
		candidateId: options.candidateId ?? "candidate-1",
		generation: options.generation ?? 2,
		digest: options.digest ?? "sha256:abc",
		staticSyntaxCheck: check(options.errors ?? []),
		mockLoad: check([]),
		ok,
		completedAtMs: 1,
	};
}

export class RecordingPreflight {
	readonly calls: ReloadPreflightInput[] = [];
	report: PreflightReport;
	beforeResolve: (() => void | Promise<void>) | undefined;

	constructor(report = makeReport()) {
		this.report = report;
	}

	async preflight(input: ReloadPreflightInput): Promise<PreflightReport> {
		this.calls.push(input);
		if (this.beforeResolve) await this.beforeResolve();
		return this.report;
	}
}

export class RecordingApply {
	readonly plans: ReloadApplyPlan[] = [];
	calls = 0;
	failWith: unknown | undefined;
	beforeResolve: (() => void | Promise<void>) | undefined;

	async apply(plan: ReloadApplyPlan): Promise<ReloadApplyResult> {
		this.calls += 1;
		this.plans.push(plan);
		if (this.beforeResolve) await this.beforeResolve();
		if (this.failWith !== undefined) throw this.failWith;
		return {
			generation: plan.approvedGeneration,
			detail: `applied ${plan.report.candidateId}`,
			attemptId: `attempt-${this.calls}`,
		};
	}
}

export function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}
