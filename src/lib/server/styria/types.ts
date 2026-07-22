export type StyriaOrderPayload = {
	external_id: string;
	brandName: string;
	comment: string;
	shipping_address: {
		firstName: string;
		lastName: string;
		company: string;
		address1: string;
		address2: string;
		city: string;
		county: string;
		postcode: string;
		country: string;
		phone1: string;
	};
	shipping: { shippingMethod: 'courier' };
	items: Array<{
		pn: string;
		quantity: number;
		retailPrice: number;
		description: string;
		designs: Record<string, string>;
		mockups?: Record<string, string>;
	}>;
};

export type StyriaOrder = {
	id: string;
	external_id: string | null;
	created_at: string;
	status: string;
	deleted: boolean;
	shipping_address: {
		country: string;
	};
	shipping: {
		shippingMethod: string;
		trackingNumber: string | null;
		shiped_at: string | null;
	};
	items: Array<{
		pn: string;
		quantity: number;
		retailPrice: number;
		description: string;
		designs: Record<string, string>;
		mockups?: Record<string, string>;
	}>;
};
