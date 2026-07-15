import { redirect } from '@sveltejs/kit';
import { parsePublicConfig, type PublicConfig } from '$lib/config/public';

/** Call before private configuration or provider work in every commerce server handler. */
export function requireStorefront(runtimeEnv: Record<string, string | undefined>): PublicConfig {
	const config = parsePublicConfig(runtimeEnv);

	if (!config.storefrontEnabled) redirect(307, '/');

	return config;
}
