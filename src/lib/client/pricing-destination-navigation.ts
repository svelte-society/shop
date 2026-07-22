import { goto, invalidate } from '$app/navigation';

type RecoveryDependencies = {
	invalidate: typeof invalidate;
	goto: typeof goto;
	assign: (returnTo: string) => void;
};

const browserRecoveryDependencies: RecoveryDependencies = {
	invalidate,
	goto,
	assign: (returnTo) => globalThis.location.assign(returnTo)
};

export async function recoverPricingDestination(
	returnTo: string,
	dependencies: RecoveryDependencies = browserRecoveryDependencies
): Promise<boolean> {
	try {
		await dependencies.invalidate('app:pricing-destination');
		return true;
	} catch {
		try {
			await dependencies.goto(returnTo, { invalidateAll: true });
		} catch {
			dependencies.assign(returnTo);
		}
		return false;
	}
}
