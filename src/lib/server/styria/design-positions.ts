const STYRIA_DESIGN_POSITIONS = {
	printing_front: 'Printing Front',
	printing_back: 'Printing Back',
	printing_left_sleeve: 'Printing Left Sleeve',
	printing_right_sleeve: 'Printing Right Sleeve',
	embroidery_left_chest: 'Embroidery Left Chest',
	embroidery_centre_chest: 'Embroidery Centre Chest',
	embroidery_right_chest: 'Embroidery Right Chest',
	embroidery_left_sleeve: 'Embroidery Left Sleeve',
	embroidery_right_sleeve: 'Embroidery Right Sleeve'
} as const;

export function styriaDesignPositionForMetadataSlug(slug: string): string {
	return STYRIA_DESIGN_POSITIONS[slug as keyof typeof STYRIA_DESIGN_POSITIONS] ?? slug;
}

export function isStyriaDesignPosition(value: string): boolean {
	return Object.values(STYRIA_DESIGN_POSITIONS).includes(
		value as (typeof STYRIA_DESIGN_POSITIONS)[keyof typeof STYRIA_DESIGN_POSITIONS]
	);
}
