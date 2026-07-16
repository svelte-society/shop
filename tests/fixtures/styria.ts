import type { StyriaOrder, StyriaOrderPayload } from '$lib/server/styria/types';

export function styriaPayloadFixture(): StyriaOrderPayload {
	return {
		external_id: 'cs_test_checkout_123',
		brandName: 'Svelte Society',
		comment: 'Approved Svelte Society fulfillment',
		shipping_address: {
			firstName: 'Ada',
			lastName: 'Lovelace',
			company: 'Analytical Engines AB',
			address1: 'Sveltegatan 5',
			address2: 'Suite 3',
			city: 'Stockholm',
			county: 'Stockholm',
			postcode: '111 22',
			country: 'Sweden',
			phone1: '+46 70 123 45 67'
		},
		shipping: { shippingMethod: 'courier' },
		items: [
			{
				pn: 'STYRIA-TEE-M',
				quantity: 2,
				retailPrice: 27.99,
				description: 'Design reference: society-community-v1',
				designs: {
					back: 'https://cdn.example.test/designs/community-back.svg',
					front: 'https://cdn.example.test/designs/community-front.svg'
				}
			}
		]
	};
}

export function styriaOrderFixture(overrides: Partial<StyriaOrder> = {}): StyriaOrder {
	return {
		id: '1042',
		external_id: 'cs_test_checkout_123',
		created_at: '2026-07-16T10:00:00+02:00',
		status: 'received',
		deleted: false,
		shipping_address: { country: 'Sweden' },
		shipping: {
			shippingMethod: 'courier',
			trackingNumber: null,
			shiped_at: null
		},
		items: [
			{
				pn: 'STYRIA-TEE-M',
				quantity: 2,
				retailPrice: 27.99,
				description: 'Design reference: society-community-v1',
				designs: {
					back: 'https://cdn.example.test/designs/community-back.svg',
					front: 'https://cdn.example.test/designs/community-front.svg'
				}
			}
		],
		...overrides
	};
}
