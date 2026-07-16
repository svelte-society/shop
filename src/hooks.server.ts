import { building } from '$app/environment';
import { env } from '$env/dynamic/private';
import type { Handle } from '@sveltejs/kit';
import {
	applicationLifecycle,
	type ApplicationLifecycle,
	type ApplicationStartOptions
} from '$lib/server/app.server';

export function createApplicationHandle(
	application: ApplicationLifecycle,
	options: ApplicationStartOptions
): Handle {
	let started = false;
	let startup: ReturnType<ApplicationLifecycle['start']> | undefined;

	return async ({ event, resolve }) => {
		if (!started) {
			const activeStartup = (startup ??= application.start(options));
			try {
				await activeStartup;
				started = true;
			} catch (error) {
				if (startup === activeStartup) startup = undefined;
				throw error;
			}
		}
		return resolve(event);
	};
}

export const handle: Handle = createApplicationHandle(applicationLifecycle, {
	environment: env,
	building,
	test: process.env.NODE_ENV === 'test'
});
