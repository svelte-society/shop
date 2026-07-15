import { redirect } from '@sveltejs/kit';
import { parsePublicConfig, type PublicConfig } from '$lib/config/public';

type StorefrontGuardOptions = {
	whenDisabled?: 'redirect' | 'opening-soon';
};

/** Call before private configuration or provider work in every commerce server handler. */
export function requireStorefront(
	runtimeEnv: Record<string, string | undefined>,
	options: StorefrontGuardOptions = {}
): PublicConfig {
	const config = parsePublicConfig(runtimeEnv);

	if (!config.storefrontEnabled && options.whenDisabled !== 'opening-soon') redirect(307, '/');

	return config;
}
