import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import WithdrawalPage from './+page.svelte';

const data = { csrfToken: 'csrf-test', itemRowCount: 1 };
const fields = {
	fullName: 'Ada Lovelace',
	receiptEmail: 'ada@example.test',
	enteredOrderReference: 'ORDER-2042',
	scope: 'specific_items' as const,
	itemDescriptions: ['Community Tee'],
	itemQuantities: ['2']
};

describe('withdrawal page', () => {
	it('uses persistent labels, semantic groups, native scope radios, and one specific-item row', async () => {
		render(WithdrawalPage, { data, form: { fields, itemRowCount: 1 } });
		await expect
			.element(page.getByRole('heading', { level: 1, name: 'Submit a withdrawal notice' }))
			.toBeVisible();
		for (const legend of ['Your details', 'Purchase', 'Withdrawal scope']) {
			await expect.element(page.getByRole('group', { name: legend })).toBeVisible();
		}
		await expect.element(page.getByLabelText('Full name')).toBeVisible();
		await expect.element(page.getByLabelText('Receipt email')).toBeVisible();
		await expect.element(page.getByLabelText('Order reference')).toBeVisible();
		await expect.element(page.getByRole('radio', { name: 'The whole purchase' })).toBeVisible();
		await expect.element(page.getByRole('radio', { name: 'Specific items' })).toBeChecked();
		await expect.element(page.getByLabelText('Item description 1', { exact: true })).toBeVisible();
		await expect.element(page.getByLabelText('Quantity 1')).toBeVisible();
	});

	it('enhances item add and remove through twenty rows while preserving entered values', async () => {
		render(WithdrawalPage, { data, form: { fields, itemRowCount: 1 } });
		await expect
			.element(page.getByLabelText('Item description 1', { exact: true }))
			.toHaveValue('Community Tee');
		const add = page.getByRole('button', { name: 'Add another item' });
		await expect.element(add).toHaveAttribute('type', 'submit');
		for (let index = 1; index < 20; index += 1) {
			(add.element() as HTMLButtonElement).click();
			await expect
				.element(page.getByLabelText(`Item description ${index + 1}`, { exact: true }))
				.toBeVisible();
		}
		await expect.element(page.getByLabelText('Item description 20', { exact: true })).toBeVisible();
		await expect.element(add).toBeDisabled();
		(page.getByRole('button', { name: 'Remove item 20' }).element() as HTMLButtonElement).click();
		await expect
			.element(page.getByLabelText('Item description 20', { exact: true }))
			.not.toBeInTheDocument();
		await expect
			.element(page.getByLabelText('Item description 1', { exact: true }))
			.toHaveValue('Community Tee');
	});

	it('focuses a row added by the server during initial hydration', async () => {
		render(WithdrawalPage, {
			data,
			form: {
				fields: {
					...fields,
					itemDescriptions: ['Community Tee', ''],
					itemQuantities: ['2', '1']
				},
				itemRowCount: 2
			}
		});
		const addedRow = page.getByLabelText('Item description 2', { exact: true });
		await expect.element(addedRow).toBeVisible();
		expect(document.activeElement).toBe(addedRow.element());
	});

	it('places adjacent errors under preserved controls and links them from a focusable summary', async () => {
		render(WithdrawalPage, {
			data,
			form: {
				fields,
				itemRowCount: 1,
				errorSummary: true,
				errors: {
					fullName: 'Enter your full name.',
					receiptEmail: 'Enter a valid email address.',
					scope: 'Choose the whole purchase or specific items.',
					'itemDescription-0': 'Describe this item.',
					'itemQuantity-0': 'Enter a quantity from 1 to 99.'
				}
			}
		});
		const summary = page.getByRole('alert');
		await expect.element(summary).toHaveAttribute('id', 'withdrawal-errors');
		expect(document.activeElement).toBe(summary.element());
		await expect
			.element(summary.getByRole('link', { name: 'Enter your full name.' }))
			.toHaveAttribute('href', '#fullName');
		await expect.element(page.getByLabelText('Full name')).toHaveValue('Ada Lovelace');
		await expect
			.element(summary.getByRole('link', { name: 'Choose the whole purchase or specific items.' }))
			.toHaveAttribute('href', '#scope');
		expect(document.querySelector('#scope')).not.toBeNull();
		expect(document.querySelector('#receiptEmail-error')?.textContent).toBe(
			'Enter a valid email address.'
		);
		for (const name of ['itemDescription', 'itemQuantity']) {
			const control = document.querySelector(`#${name}-0`);
			expect(control).toHaveAttribute('aria-describedby', `${name}-0-error`);
			expect(control).toHaveAttribute('aria-invalid', 'true');
			expect(document.querySelector(`#${name}-0-error`)).not.toBeNull();
		}
	});

	it('renders and focuses generic secure action failures', async () => {
		render(WithdrawalPage, {
			data,
			form: {
				message: 'Withdrawal notices are temporarily unavailable. Try again shortly.'
			}
		});
		const summary = page.getByRole('alert');
		await expect.element(summary).toHaveAttribute('id', 'withdrawal-errors');
		await expect
			.element(
				summary.getByText('Withdrawal notices are temporarily unavailable. Try again shortly.', {
					exact: true
				})
			)
			.toBeVisible();
		expect(document.activeElement).toBe(summary.element());
	});

	it('reviews every canonical value with explicit submission-only confirmation', async () => {
		render(WithdrawalPage, {
			data,
			form: {
				fields,
				itemRowCount: 1,
				review: { ...fields, items: [{ description: 'Community Tee', quantity: 2 }] }
			}
		});
		await expect
			.element(page.getByRole('heading', { level: 2, name: 'Review and confirm' }))
			.toBeVisible();
		for (const value of [
			'Ada Lovelace',
			'ada@example.test',
			'ORDER-2042',
			'Specific items',
			'2 × Community Tee'
		]) {
			await expect.element(page.getByText(value, { exact: true })).toBeVisible();
		}
		await expect
			.element(
				page.getByText(
					'Submitting this notice does not confirm eligibility, approval, or a refund.',
					{ exact: true }
				)
			)
			.toBeVisible();
		await expect
			.element(page.getByText('Email my withdrawal receipt to ada@example.test', { exact: true }))
			.toBeVisible();
		await expect
			.element(
				page.getByText('I confirm that I want to withdraw from this purchase.', { exact: true })
			)
			.toBeVisible();
		await expect
			.element(page.getByRole('button', { name: 'Confirm withdrawal from purchase' }))
			.toBeVisible();
	});

	it.each([
		['delivered', 'A receipt was emailed to the address you entered.'],
		['queued', 'Your receipt email is queued. You can download it now.'],
		[
			'failed',
			'Email could not be sent. Your withdrawal notice is safely recorded. Download the receipt now.'
		]
	] as const)('renders the restrained %s success trust state', async (deliveryState, message) => {
		const createdAt = '2026-07-17T12:00:00.000Z';
		render(WithdrawalPage, {
			data,
			form: {
				success: true,
				result: {
					reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
					createdAt,
					scope: 'specific_items',
					enteredOrderReference: 'ORDER-2042',
					deliveryState
				}
			}
		});
		await expect
			.element(page.getByRole('heading', { level: 1, name: 'Withdrawal notice received.' }))
			.toBeVisible();
		await expect
			.element(page.getByText('WDR-AAAAAAAAAAAAAAAAAAAAAA', { exact: true }))
			.toBeVisible();
		await expect.element(page.getByText('ORDER-2042', { exact: true })).toBeVisible();
		await expect.element(page.getByText('Specific items', { exact: true })).toBeVisible();
		await expect.element(page.getByText(message, { exact: true })).toBeVisible();
		const liveRegion = page.getByText(message, { exact: true }).element().closest('[aria-live]');
		expect(liveRegion).toHaveAttribute('aria-live', 'polite');
		const downloadLink = page.getByRole('link', { name: 'Download withdrawal receipt' });
		await expect
			.element(downloadLink)
			.toHaveAttribute('href', '/withdraw/receipt/WDR-AAAAAAAAAAAAAAAAAAAAAA');
		await expect.element(downloadLink).toHaveAttribute('data-sveltekit-reload', '');
		const localizedTime = new Intl.DateTimeFormat(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			timeZone: 'UTC',
			timeZoneName: 'short'
		}).format(new Date(createdAt));
		await expect
			.element(page.getByText(localizedTime, { exact: true }))
			.toHaveAttribute('datetime', createdAt);
		expect(document.body.textContent).not.toMatch(
			/withdrawal approved|refund (?:issued|started|confirmed)/iu
		);
	});
});
