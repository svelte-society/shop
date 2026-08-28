export type ShopConfig = {
	readonly contact: {
		readonly supportEmail: string;
		readonly adminEmail: string;
		readonly sellerEmail: string;
	};
	readonly email: {
		readonly fromName: string;
		readonly fromAddress: string;
	};
	readonly styria: {
		readonly brandName: string;
	};
	readonly sellerPolicy: {
		readonly legalName: string;
		readonly registrationNumber: string;
		readonly vatNumber: string;
		readonly addressLine1: string;
		readonly postalCode: string;
		readonly city: string;
		readonly country: string;
		readonly deliveryEstimateEu: string;
		readonly deliveryEstimateAsia: string;
		readonly effectiveDate: string;
	};
	readonly browser: {
		readonly catalogImageOrigins: readonly string[];
		readonly societyAssetOrigins: readonly string[];
	};
};

export const SHOP_CONFIG = {
	contact: {
		supportEmail: 'merch@sveltesociety.dev',
		adminEmail: 'merch@sveltesociety.dev',
		sellerEmail: 'merch@sveltesociety.dev'
	},
	email: {
		fromName: 'Svelte Society Shop',
		fromAddress: 'merch@sveltesociety.dev'
	},
	styria: {
		brandName: 'Svelte Society'
	},
	sellerPolicy: {
		legalName: 'Svelte Summit AB',
		registrationNumber: '559490-8336',
		vatNumber: 'SE559490833601',
		addressLine1: 'Hummelhaga 13',
		postalCode: '153 95',
		city: 'Järna',
		country: 'Sweden',
		deliveryEstimateEu:
			'Estimated delivery: usually 5–7 business days. Delivery times are estimates and aren’t guaranteed.',
		deliveryEstimateAsia:
			'Production normally takes 1–5 business days, followed by roughly 6–10 business days in transit',
		effectiveDate: '2026-07-19'
	},
	browser: {
		catalogImageOrigins: ['https://raw.githubusercontent.com', 'https://wsrv.nl'],
		societyAssetOrigins: []
	}
} as const satisfies ShopConfig;
