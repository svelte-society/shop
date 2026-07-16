import { createHash } from 'node:crypto';

function sha1(value: string): string {
	return createHash('sha1').update(value, 'utf8').digest('hex');
}

export function signPost(body: string, secret: string): string {
	return sha1(body + secret);
}

export function signGet(queryWithoutSignature: string, secret: string): string {
	return sha1(queryWithoutSignature + secret);
}
