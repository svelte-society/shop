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

	return async ({ event, resolve }) => {
		if (!started) {
			application.start(options);
			started = true;
		}
		return resolve(event);
	};
}

export const handle: Handle = createApplicationHandle(applicationLifecycle, {
	environment: env,
	building,
	test: process.env.NODE_ENV === 'test'
});
