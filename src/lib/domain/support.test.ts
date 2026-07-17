import { describe, expect, it } from 'vitest';
import { isConciseSupportText } from './support';

describe('concise support text privacy', () => {
	it.each([
		'123 Main St',
		'10 Downing Rd',
		'42 Park Ave.',
		'9 Oak Ln',
		'7 Cedar Dr',
		'1 Sunset Blvd',
		'PO Box 123',
		'P.O. Box 456',
		'Post Office Box 789'
	])('rejects a common abbreviated or PO-box address: %s', (value) => {
		expect(isConciseSupportText(value, 160)).toBe(false);
	});

	it.each([
		'Roadmap item 10 reviewed',
		'First review completed for ticket 123',
		'Standard replacement approved for case 123',
		'PO review completed for case 123'
	])('does not treat an address-token substring as an address: %s', (value) => {
		expect(isConciseSupportText(value, 160)).toBe(true);
	});
});
